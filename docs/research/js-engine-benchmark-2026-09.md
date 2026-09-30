# 策略 JS 引擎比較（2026-09-30）

> 關聯：#194（原生引擎決策）。本文記錄使用者策略 JS 執行引擎的量測與結論。

## 結論與決策

- **即時策略執行**：QuickJS（rquickjs）嵌入 Rust 原生執行層。tick 延遲 p50 1.5 µs／p99 24 µs、+1 MB、可限時與限記憶體、無檔案／網路存取。
- **回測與參數最佳化**：留在網頁端 Web Worker 平行執行（引擎速度與原生 V8 相當），不另做 Rust 版回測核心、不引入 V8。
- **不採用**：Bun（外部程序，IPC 延遲高、預設開放 fs/net、無官方嵌入 API）、JavaScriptCore（Windows 需自維護 WebKit、停止失控策略需私有 API、無記憶體上限、版本隨 macOS 變動）、Boa（慢且無時間／記憶體限制）。
- 觸價、括號單、蛛網等固定規則由原生執行引擎以 Rust 實作，不經 JS。

---

## 量測報告

# JS engine spike: Shioaji Pro native (Rust/Tauri) execution and backtest engine

This is a throwaway benchmark (2026-09-30); nothing is merged. It was extended the same day with JavaScriptCore and with runs inside a webview (Chrome and WKWebView).

- **Source:**
  - `crates/`: one Rust host per engine, sharing `crates/common`. JSC is in `crates/bench-jsc` as raw FFI.
  - `js/strategy.js`: the single user strategy that every engine and page runs.
  - `js/bun_worker*.js`: the Bun side of the pipe protocol.
  - `web/`: `bench.html`, `chrome_bench.mjs` (playwright-core) and `WKBench.swift` (the WKWebView host).
  - `run.py` (orchestrator; `uv run run.py`, or `ONLY=a,b uv run run.py` to re-run some engines and merge) and `gen_md.py` (writes the tables).
- **Raw numbers:** `results.json`.

## Recommendation

**(a) Live execution (the trigger/tick path): QuickJS via `rquickjs`, in-process, on every platform.**
- A single tick is dominated by the host-to-engine crossing, not by JIT quality. QuickJS p50 is 1.5 us and p99 24 us, which ties V8 (1.5 / 28 us) and JSC (3.1 / 25 us).
- Cold start is 0.19 ms, memory +1 MB, binary +1 MB. The time limit and the memory limit both work, and the runtime is still usable afterwards.
- It has no fs, net or timers, it is pure C with no JIT, and it builds with MSVC for Windows x86_64.
- **Moving live execution out of the webview is the biggest win in this study.**
  - Today's in-webview tick path costs p50 117 us (WKWebView) or 166 us (Chrome/WebView2 stand-in) per call. p99 is 0.6-0.8 ms and the tail reaches 5-7 ms. That is 76-108x the in-process QuickJS p50.
  - The page's timers drop to about 1 per second as soon as the window is hidden or minimised, and `requestAnimationFrame` stops.
  - A `while(true){}` in a user strategy freezes the whole UI, because the webview has no execution-time or memory limit you control.
  - A page reload wipes the strategy's state.

**(b) Heavy backtests: V8 via `deno_core`, in-process, with the bar loop inside JS. Keep the backtest in the Rust core.**
- V8 runs the JS loop at 18 ns/bar light and 255 ns/bar heavy. Driving it from Rust one bar per call drops it to 283 ns/bar light, so the engine must push bars in whole arrays or chunks.
- Costs:
  - +42 MB binary and +34 MB RSS per isolate.
  - The `terminate_execution` watchdog and a near-heap-limit callback give time and memory limits, and both were verified.
  - `deno_core` churns quickly.
- Fallback without V8: QuickJS takes about 8 s for 1M bars of the heavy strategy.

**JavaScriptCore (system framework, macOS): as fast as V8, adds 0 MB, and is not worth a "JSC on Mac, V8 on Windows" split.**
- With JIT on, JSC matches V8: 276 vs 283 ns/bar host-driven, 16 vs 18 (light) and 239 vs 255 (heavy) ns/bar with the loop in JS. Results are bit-identical, and it adds 0 bytes because it is dynamically linked from the OS.
- Measured gotchas:
  1. **JIT is off unless the host binary is signed with hardened runtime plus `com.apple.security.cs.allow-jit`.** An unsigned or merely ad-hoc binary silently runs the LLInt interpreter (`useJIT=false`). There is no crash; it is just 19x slower on the heavy loop (4,537 vs 239 ns/bar) and about as slow as QuickJS.
  2. **The execution-time limit is private SPI.** `JSContextGroupSetExecutionTimeLimit` lives in `JSContextRefPrivate.h`; the symbol is exported, but you have to declare it yourself. With JIT and JSC's default signal-based VM traps, it **did not stop `while(true){}`**: the process hung for more than 20 s and had to be killed. Setting `JSC_usePollingTraps=true` in-process before the first VM makes it stop at about 209 ms with the context still reusable, at a cost of about +9% on the heavy loop.
  3. **There is no memory limit at all.** Nothing in the public C API provides one, and `dlsym` found no memory-limit symbol.
  4. **The engine version is whatever the user's macOS or Safari ships**: here JavaScriptCore 22625.1.29.11.27 on macOS 27.0 (26A428). You cannot pin it.
  5. **There are no maintained Rust bindings.** `rusty_jsc` 0.1.0 is stale, and `javascriptcore-rs` binds WebKitGTK on Linux, so the spike uses about 40 raw `extern` declarations.
- **Windows feasibility (researched, not built):**
  - There are no system JSC binaries on Windows. Options:
    - WebKit's own Windows port, built with clang-cl and CMake, or its `JSCOnly` port. Prebuilt archives exist only from the buildbot, with no stable releases.
    - Bun's fork `oven-sh/WebKit`, which publishes `bun-webkit-windows-amd64.tar.gz` static libraries at 385 MB compressed per autobuild. There were 3 non-preview autobuilds between 2026-09-24 and 2026-09-26, and Bun itself has moved to building JSC from source (bun PR #41330).
  - We would have to own a heavy C++ toolchain (ICU, bmalloc, WTF) and a fork's churn for no speed gain over V8.
- **The split saves about 42 MB on the Mac bundle only.** It costs two engines with different sandbox semantics (JSC has no heap cap, a private-SPI time limit and a polling-traps workaround), a doubled test matrix, the allow-jit entitlement, and an engine version that changes under you with OS updates.
- **Verdict:** if the 42 MB is the problem, use QuickJS for backtests on both platforms, or make V8 an optional download. Don't adopt JSC.

**Bun (external process): not recommended.**
- IPC round trips cost 4.6-17 us per call.
- It ships a 59 MB runtime with fs, net, `process` and `spawn` enabled by default.
- On the implementation-language question, the official README says it's "written in Rust and powered by JavaScriptCore": Bun moved from Zig to Rust (PR #33065 references #32621, which removed the Zig sources), and its JS engine is JavaScriptCore.

**Boa: reference only.** It is 4-5x slower than QuickJS on the light strategy and 3.8x slower on the heavy one (heavy: 27 us/bar), with no async interrupt and no heap cap.

**Strategy in the webview (today) vs native in-process:**

| | in-webview (WKWebView / Chrome) | native in-process (QuickJS live, V8 backtest) |
|---|---|---|
| Pure engine speed | Excellent: the JIT is always on because the WebContent process carries Apple's entitlements. JS loop at 13 / 12 ns/bar light and 217 / 209 ns/bar heavy | QuickJS 402 / 8,140; V8 18 / 255 ns/bar |
| Per-call boundary (the live path) | **117-166 us p50, 0.6-0.8 ms p99, 5-7 ms max** (cross-process IPC) | 1.5 us p50, 24-28 us p99 |
| Hidden or minimised window | Timers throttled to 1/s; rAF stops. After 360 s hidden (WKWebView), IPC-triggered calls still answered at 206 us p50. Chrome/WebView2 add "intensive" throttling (1/min) after 5 min hidden, per Chrome's docs | Unaffected (Rust thread) |
| Memory | WebContent 186 MB after the 1M-bar run (26 MB idle); Chrome renderer 465 MB | +1 MB (QuickJS) / +34 MB (V8) |
| Cold start | 130-154 ms (page or webview) | 0.19 ms / 3.3 ms |
| Runaway strategy | Freezes the UI; no time or memory limit from the host | Stopped at 200 ms; runtime reusable |
| State survival | Lost on reload, navigation or WebContent crash (jetsam) | Owned by the Rust core |
| Determinism | Bit-identical to the others | Bit-identical |

Keep the webview for charting and for the editor's "try it" preview. It is fast when data is handed over in one bulk array. Run live strategies and production backtests in the Rust core.

**Determinism:** every engine and both webviews reproduced the native-Rust fingerprint bit-for-bit. The fingerprint covers the action hash plus the f64 bits of cash, EMAs, ATR, stdev and n. The strategy uses only IEEE-exact operations; `Math.exp`, `log`, `pow` and `sin` are not guaranteed identical across engines, so cross-engine determinism needs a deterministic math shim or one engine per mode.

## Method

- Strategy: EMA(12/26) crossover, ATR(14) 3x trailing stop, long-only, with state held in JS. The "heavy" variant adds a naive 200-bar rolling stdev (two O(200) loops per bar).
- Bars: 1,000,000 seeded bars (xorshift64*, log random walk around 10,000, 0.01 tick). Every engine gets the same doubles, via exact JSON for Bun and via `web/bars.bin` for the pages.
- Host-driven: the host builds `{o,h,l,c,v,t}` and calls `onBar` once per bar. How each engine builds the object:
  - rquickjs: `Object::set`.
  - V8: `with_prototype_and_properties` plus a cached context.
  - JSC: `JSObjectMake` plus `JSObjectSetProperty` with cached `JSStringRef` keys.
  - Boa: `ObjectInitializer`.
  - Bun: one JSON line per bar, with a blocking wait for the reply.
- JS-loop: `runBatch(Float64Array, n)` runs inside the engine; JSC uses `JSObjectMakeTypedArrayWithBytesNoCopy`.
- Tick: 1,000 warm-up bars, then 10,000 timed single calls with seeded 0.1-2 ms gaps.
- Cold start: create the runtime (or spawn the process, or open the page or webview) and time until the first `onBar` result, in a fresh process each run.
- Build: `--release`, thin LTO, stripped, rustc 1.98.1, on an Apple M6 running macOS 27 arm64. The JSC JIT build is the same binary ad-hoc signed with `codesign -o runtime --entitlements allow-jit`, done by `run.py`.
- Webviews:
  - **Chrome** 154 runs headless via playwright-core (from `rqa/harness`), serving the page with `page.route` (no port).
  - **WKWebView** runs in a 140 KB Swift host serving the page over a `bench://` scheme handler (no port), with the window at 400x300.
  - For Chrome's hidden test, Playwright's default `--disable-background-timer-throttling` flags were removed. Even then the page stayed `visibilityState=visible` after minimising or opening a foreground tab: Playwright's per-page emulation keeps pages "visible". So Chrome and WebView2 hidden throttling is cited from the docs rather than measured.

## Results
Machine: Apple M6 (macOS-27.0-arm64-arm-64bit-Mach-O). Versions: rustc rustc 1.98.1 (48a229cea 2026-09-01), bun 1.4.2+744846f84, rquickjs 0.14.0, deno_core 0.412.0 (deno_v8 0.4.0 -> v8 crate 150.4.0), boa_engine 0.22.0, javascriptcore system JavaScriptCore.framework CFBundleVersion 22625.1.29.11.27 (macOS 27.0), chrome 154.0.8037.92, wkwebview WebKit.framework 22625.1.29.11.27

All numbers are medians of 3 fresh-process runs (cold start: 7). `native` is the same strategy hand-written in Rust (baseline, not a candidate).

### 1. Backtest, 1,000,000 bars

Host-driven = Rust calls `onBar({o,h,l,c,v,t})` once per bar (bar object built by host, crosses the boundary every bar). JS-loop = host hands the whole Float64Array to `runBatch()` once and the loop runs inside JS (for Bun: bars streamed over the pipe with no per-bar reply).

| engine | host-driven light: total s | ns/bar | host-driven heavy (200-bar stdev): total s | ns/bar | JS-loop light: total s | ns/bar | JS-loop heavy: total s | ns/bar |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| native | 0.008 | 8 | 0.138 | 138 | 0.008 | 8 | 0.172 | 172 |
| quickjs | 0.383 | 383 | 7.147 | 7147 | 0.402 | 402 | 8.140 | 8140 |
| v8 | 0.283 | 283 | 0.508 | 508 | 0.018 | 18 | 0.255 | 255 |
| jsc | 0.276 | 276 | 0.511 | 512 | 0.016 | 16 | 0.239 | 239 |
| jsc-nojit | 0.393 | 393 | 4.479 | 4479 | 0.214 | 214 | 4.537 | 4537 |
| boa | 1.397 | 1397 | 27.235 | 27235 | 2.033 | 2033 | 27.896 | 27896 |
| bun-sync | 4.567 | 4567 | 4.797 | 4797 | 0.294 | 294 | 0.384 | 384 |
| bun-async | 17.114 | 17114 | - | - | 0.327 | 327 | - | - |

### 2. Live tick path (10,000 single calls, 100 us to 2 ms seeded gaps, latency per call incl. boundary crossing)

| engine | p50 us | p99 us | p99.9 us | max us | mean us |
|---|---:|---:|---:|---:|---:|
| native | 0.04 | 0.62 | 5.8 | 62 | 0.12 |
| quickjs | 1.54 | 23.92 | 72.7 | 111 | 3.14 |
| v8 | 1.54 | 28.25 | 77.9 | 222 | 3.27 |
| jsc | 3.08 | 24.67 | 76.5 | 528 | 4.09 |
| jsc-nojit | 5.00 | 39.25 | 157.2 | 694 | 6.67 |
| boa | 5.04 | 56.25 | 102.3 | 792 | 8.27 |
| bun-sync | 11.83 | 78.58 | 141.5 | 336 | 16.84 |
| bun-async | 31.00 | 128.75 | 343.7 | 1814 | 38.54 |

### 3. Cold start (create engine/context or spawn process, load strategy, first `onBar` result)

| engine | cold start ms | host RSS right after, MB |
|---|---:|---:|
| native | 0.00 | 1.7 |
| quickjs | 0.19 | 2.7 |
| v8 | 3.26 | 17.9 |
| jsc | 3.67 | 10.7 |
| jsc-nojit | 3.03 | 9.0 |
| boa | 0.65 | 6.1 |
| bun-sync | 6.01 | 1.8 |
| bun-async | 5.59 | 1.8 |

### 4. Memory after backtest (MB)

The host holds the 1M bars itself (~46 MB as structs; JS-loop runs also hold a flat 46 MB f64 copy), so compare the delta column. For Bun the child's peak RSS is reported separately (whole Bun runtime).

| engine | host-driven light: host RSS before -> after (delta) | host-driven heavy delta | JS-loop light: peak host RSS | Bun child peak RSS (host-driven light / JS-loop light) |
|---|---|---:|---:|---|
| native | 47.5 -> 47.5 (+0.0) | +0.0 | 93.3 | - |
| quickjs | 47.5 -> 48.5 (+1.0) | +1.0 | 140.1 | - |
| v8 | 48.5 -> 82.1 (+33.6) | +34.4 | 161.5 | - |
| jsc | 51.5 -> 68.0 (+16.5) | +17.0 | 214.8 | - |
| jsc-nojit | 51.5 -> 63.9 (+12.4) | +12.4 | 156.5 | - |
| boa | 47.9 -> 55.9 (+8.0) | +8.0 | 145.6 | - |
| bun-sync | 47.5 -> 47.6 (+0.2) | +0.2 | 93.5 | 51.9 / 44.3 |
| bun-async | 47.5 -> 47.6 (+0.2) | +- | 93.5 | 40.4 / 44.8 |

### 5. Binary size (release, thin LTO, stripped, aarch64-apple-darwin)

| artifact | size MB | delta vs empty Rust host MB |
|---|---:|---:|
| empty Rust host (baseline) | 0.34 | +0.00 |
| host + system JavaScriptCore.framework (dynamically linked, ships with macOS) | 0.34 | +0.00 |
| host + rquickjs | 1.33 | +0.99 |
| host + boa_engine | 7.63 | +7.29 |
| host + deno_core/V8 | 42.29 | +41.95 |
| Bun runtime binary (shipped next to host, 1.4.2+744846f84) | 59.02 | +59.02 |

### 7. Determinism

Fingerprint = action-stream hash + f64 bit patterns of [cash, trades, emaFast, emaSlow, atr, stdev, n].

| workload | within-engine identical across runs | all engines == native Rust reference |
|---|---|---|
| backtest|light | native:yes, quickjs:yes, v8:yes, boa:yes, bun-sync:yes, bun-async:yes, jsc-nojit:yes, jsc:yes | yes (`fce602b6:c0e02b02edd0e4bb:40d1f34000000000:40c3feb425d30748:40c40029ba0d2408:403e793d4a2bca3a:0000000000000000:412e848000000000`) |
| backtest|heavy | native:yes, quickjs:yes, v8:yes, boa:yes, bun-sync:yes, jsc-nojit:yes, jsc:yes | yes (`fce602b6:c0e02b02edd0e4bb:40d1f34000000000:40c3feb425d30748:40c40029ba0d2408:403e793d4a2bca3a:40473601b46fff25:412e848000000000`) |
| batch|light | native:yes, quickjs:yes, v8:yes, boa:yes, bun-sync:yes, bun-async:yes, jsc-nojit:yes, jsc:yes, jsc-signaltraps:yes, chrome:yes, wkwebview:yes | yes (`fce602b6:c0e02b02edd0e4bb:40d1f34000000000:40c3feb425d30748:40c40029ba0d2408:403e793d4a2bca3a:0000000000000000:412e848000000000`) |
| batch|heavy | native:yes, quickjs:yes, v8:yes, boa:yes, bun-sync:yes, jsc-nojit:yes, jsc:yes, jsc-signaltraps:yes, chrome:yes, wkwebview:yes | yes (`fce602b6:c0e02b02edd0e4bb:40d1f34000000000:40c3feb425d30748:40c40029ba0d2408:403e793d4a2bca3a:40473601b46fff25:412e848000000000`) |
| tick action hash | native:520b47a1, quickjs:520b47a1, v8:520b47a1, boa:520b47a1, bun-sync:520b47a1, bun-async:520b47a1, jsc-nojit:520b47a1, jsc:520b47a1, jsc-signaltraps:520b47a1, chrome:520b47a1, wkwebview:520b47a1 | yes |

### 6. Runaway / limits probe (measured)

| engine | `while(true){}` stopped | stop after ms (200 ms budget) | engine usable afterwards | heap cap stopped allocation loop | engine usable after heap cap | globals present by default |
|---|---|---:|---|---|---|---|
| quickjs | True | 200 | True | True | True | Date, DateNow, random, eval, SharedArrayBuffer |
| v8 | True | 206 | True | True | True | Date, DateNow, random, Deno, eval, WebAssembly, SharedArrayBuffer |
| jsc | True | 209 | True | None | None | Date, DateNow, random, eval, WebAssembly, console |
| jsc-nojit | True | 210 | True | None | None | Date, DateNow, random, eval, WebAssembly, console |
| boa | True | 310 | True | False | None | Date, DateNow, random, eval, SharedArrayBuffer |
| bun-sync | True | 201 | False | None | None | Date, DateNow, random, setTimeout, fetch, require, process, Bun, eval, WebAssembly, SharedArrayBuffer |
| bun-async | True | 200 | False | None | None | Date, DateNow, random, setTimeout, fetch, require, process, Bun, eval, WebAssembly, SharedArrayBuffer |
| jsc-signaltraps | False | - | False | None | None |  |

### 8. Strategy inside a webview (today's approach: JS runs in the app frontend)

`chrome` = installed Google Chrome 154.0.8037.92 headless via playwright-core (stand-in for WebView2 on Windows, same V8/Blink). `wkwebview` = a 140 KB Swift WKWebView host (what Tauri uses on macOS), page served over a custom URL scheme like `tauri://`. Same `strategy.js`, same bars (read from `web/bars.bin`).

**Pure engine speed** (whole loop inside the page, timed with `performance.now()` in the page; WebKit coarsens it to 1 ms, so wkwebview light is +/-1 ns/bar):

| engine | JS-loop light ns/bar | JS-loop heavy ns/bar | fingerprint == native |
|---|---:|---:|---|
| chrome | 11.8 | 209 | yes |
| wkwebview | 13.0 | 217 | yes |
| (compare: v8 in-process / jsc in-process) | 17.6 / 15.6 | 255 / 239 | |

**Including the host<->webview boundary** (tick path: host sends one bar, waits for the action; 10,000 calls, same seeded gaps). chrome = `page.evaluate` over CDP (WebView2's `ExecuteScriptAsync`/`PostWebMessage` is the same kind of cross-process IPC). wkwebview = `evaluateJavaScript` in, `webkit.messageHandlers.postMessage` out (Tauri's event + invoke path).

| engine | p50 us | p99 us | p99.9 us | max us | mean us | vs in-process QuickJS p50 |
|---|---:|---:|---:|---:|---:|---:|
| chrome | 166 | 792 | 1983 | 7018 | 264 | 108x |
| wkwebview | 117 | 569 | 2161 | 5295 | 148 | 76x |

**Cold start and memory**

| engine | cold: new page/webview -> first onBar result, ms | browser launch ms (chrome only) | memory after 1M-bar JS-loop run |
|---|---:|---:|---|
| chrome | 130 | 166 | renderer RSS 465 MB, whole Chrome tree 1057 MB (JS heap 1.3 MB; the 48 MB bar buffer is off-heap) |
| wkwebview | 154 | - | WebContent RSS 186 MB (phys footprint 173 MB), host 74 MB; idle WebContent right after cold start 26 MB |

**Hidden / backgrounded page** (3 s probe: `setInterval(10 ms)` count, 0 ms `setTimeout` chain, rAF count; then 500 host->page ticks)

| engine / state | visibilityState | setInterval(10ms) fired (expected ~300) | max gap ms | 0ms-timeout chain | rAF | tick p50 / p99 us |
|---|---|---:|---:|---:|---:|---|
| chrome / visible | visible | 300 | 12 | 611 | 361 | 189 / 1283 |
| chrome / after background tab (Playwright) | visible | 252 | 26 | 295 | 289 | 190 / 1089 |
| wkwebview / visible | visible | 250 | 14 | 385 | 180 | 107 / 667 |
| wkwebview / window.orderOut (hidden, e.g. to tray) | hidden | 9 | 1000 | 13 | 0 | 200 / 1080 |
| wkwebview / window minimised | hidden | 8 | 1000 | 13 | 0 | 111 / 442 |
| wkwebview / hidden for 360 s first | hidden | 7 | 1044 | 13 | 0 | 206 / 1048 |

## Sandboxing notes (item 6)

| | QuickJS (rquickjs) | V8 (deno_core) | JavaScriptCore (system) | Bun (process) | Boa | In-webview |
|---|---|---|---|---|---|---|
| fs / net / timers | Absent (`Context::full` is pure ECMAScript; `Context::custom` can drop more) | Absent unless you register ops; delete `globalThis.Deno` | Absent. `console` and `WebAssembly` are present; no `SharedArrayBuffer`. SPI `JSGlobalContextSetEvalEnabled` can disable `eval` | **All present** (`fetch`, `Bun`, `process`, `require`, timers, `Bun.spawn`); needs OS-level sandboxing | Absent | Full web platform (`fetch`, timers, DOM, Tauri `invoke` bridge) |
| Deterministic `Date.now` / `Math.random` | Override and freeze after context creation | Same; plus `--random-seed` | Same (JS-level override) | Same | Same | Same, but shares the realm with UI code |
| Execution-time limit | `set_interrupt_handler`: **stopped at 200 ms, reusable** | `terminate_execution()` from a watchdog: **206 ms, reusable** | Private SPI `JSContextGroupSetExecutionTimeLimit`: **209 ms, reusable, but only with `JSC_usePollingTraps=true` once JIT is on**. With default signal traps plus JIT it **hung for more than 20 s** | Kill the process (0.5 ms), then respawn | Loop-iteration limit only | None from the host (Tauri or WebView2 can only reload or kill the webview) |
| Memory limit | `set_memory_limit`: **stopped, reusable** | `heap_limits` + near-heap-limit callback: **stopped, reusable** (without the callback V8 aborts the process) | **None** | OS limits only (Job Object / cgroup) | None | None (OS may jetsam the WebContent process) |
| Crash isolation | In-process (C) | In-process (V8 fatal errors abort) | In-process | Separate process | In-process, memory-safe | Separate WebContent/renderer process, but it is the UI |

rquickjs note: a `Persistent` handle must drop before the `Runtime`; otherwise it asserts at `JS_FreeRuntime`.

## JSC JIT under Tauri (measured and researched)

- **In-process JSC** (a `JSContext` inside the Tauri core process) gets JIT only when the app is signed with hardened runtime plus `com.apple.security.cs.allow-jit`.
  - Measured with `JSC_dumpOptions=2`:
    - unsigned or linker-signed: `useJIT=false`
    - ad-hoc: `useJIT=false`
    - hardened runtime without the entitlement: `useJIT=false`
    - hardened runtime + allow-jit: `useJIT=true`
  - `JSC_useJIT=false` on the unsigned binary changes nothing (4,492 vs 4,549 ns/bar), which confirms the JIT was already off.
  - allow-jit is the entitlement Apple defines for `mmap(MAP_JIT)` under the hardened runtime. Notarised Developer ID apps can carry it.
  - Not verified here: Mac App Store/App Sandbox review of allow-jit, and review of the private time-limit SPI. Private API use is a MAS rejection risk.
- **WKWebView** (Tauri's frontend) runs JS in Apple's `com.apple.WebKit.WebContent` XPC process, which carries its own JIT entitlement. The page ran at JIT speed (13 ns/bar light) from an unsigned Swift host. Tauri therefore needs **no** allow-jit for the webview; the entitlement is only needed if we embed JSC in the core.
- **JSC's JIT flags respect `JSC_*` environment options.** The host can set `JSC_usePollingTraps=true` in-process before the first VM. This is undocumented, and Apple could restrict options in future OS builds.

## JSC version drift

- System JSC = the OS WebKit: `JavaScriptCore.framework` CFBundleVersion **22625.1.29.11.27** on macOS 27.0 (build 26A428), the same build as `WebKit.framework` and Safari.
- It changes with every macOS or Safari update; security releases can bump it mid-cycle. An app cannot pin or bundle it (the system framework is in the shared cache).
- Consequences:
  - Performance, the SPI (execution-time limit, trap behaviour) and JIT defaults can change without an app release.
  - Minimum engine features are set by our minimum supported macOS.
  - Determinism for IEEE-exact code held here, but Math library changes across OS versions could alter transcendental results.

## Windows feasibility for JSC (researched, not built)

| Option | What it is | Size | Maintenance burden |
|---|---|---|---|
| WebKit Windows port ([docs.webkit.org/Ports/WindowsPort](https://docs.webkit.org/Ports/WindowsPort.html)) | Upstream port, 64-bit only, clang-cl + CMake (Ninja/VS); `WebKitRequirements` deps (ICU etc.) are auto-downloaded. Prebuilt zips only from the Windows-64-bit-Release buildbot archive | Full WebKit is hundreds of MB of build output; a JSC-only static link of JSC+WTF+bmalloc+ICU is estimated at tens of MB (not measured) | Very high: our own C++ toolchain, no stable releases, a small community port |
| `JSCOnly` port ([trac.webkit.org/wiki/JSCOnly](https://trac.webkit.org/wiki/JSCOnly)) | Upstream minimal-dependency port for building JSC alone | Same as above | High: build from source per WebKit revision; Windows is not a primary JSCOnly target |
| Bun's fork `oven-sh/WebKit` ([releases](https://github.com/oven-sh/WebKit/releases)) | Autobuilds publish `bun-webkit-windows-amd64.tar.gz` (385 MB compressed static libs; LTO 664 MB; arm64 366 MB), macOS arm64 210 MB | Linked into Bun's 59 MB (macOS) binary with Bun's own code, so JSC alone is well under that | High churn: 3 non-preview autobuilds in 2026-09-24..26; Bun now builds JSC from source in its own graph ([bun#41330](https://github.com/oven-sh/bun/pull/41330)). The fork targets Bun's needs and C++ internals, not the C API |
| V8 via `v8` crate (for comparison) | Prebuilt `librusty_v8` for `x86_64-pc-windows-msvc`, downloaded by the crate | +42 MB | Medium: crate churn, but a turnkey build |

## Cross-platform / Windows x86_64 (other engines)

- **rquickjs** bundles QuickJS-NG C sources with pregenerated bindings including `x86_64-pc-windows-msvc`. It needs no network at build time and has no JIT, so behaviour is identical everywhere.
- **deno_core / v8** downloads a prebuilt `librusty_v8` at build time (CI needs network or a `RUSTY_V8_ARCHIVE` mirror). It adds 42 MB and needs allow-jit on macOS if the V8 JIT runs in-process under the hardened runtime.
- **Bun** has an official `bun-windows-x64` build. It means shipping and signing a 59 MB runtime per platform and supervising a process.
- **Boa** is pure Rust (+7 MB) but slow.
- **Webviews**: WebView2 (Evergreen) on Windows and WKWebView on macOS. The engine version is controlled by Microsoft or Apple updates and can't be pinned.

## Sources

- Bun README ("written in Rust and powered by JavaScriptCore"): https://github.com/oven-sh/bun ; PR #33065 "docs: say Bun is written in Rust, not Zig"
- oven-sh/WebKit releases (asset sizes via the GitHub API, 2026-09-30): https://github.com/oven-sh/WebKit/releases ; bun PR #41330: https://github.com/oven-sh/bun/pull/41330
- WebKit Windows port: https://docs.webkit.org/Ports/WindowsPort.html ; JSCOnly: https://trac.webkit.org/wiki/JSCOnly
- Chrome timer throttling (1 s for hidden pages; once per minute after 5 min hidden with chained timers): https://developer.chrome.com/blog/timer-throttling-in-chrome-88
- WebView2 `IsVisible` (hidden WebView: "Chromium has code that throttles activities on the page"): https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2controller.isvisible
- Apple `com.apple.security.cs.allow-jit`: https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.cs.allow-jit

## Reproduce

```
export CARGO_TARGET_DIR=$PWD/target
cargo build --release --workspace
target/release/bench-native dumpbars web/bars.bin
(cd web && swiftc -O WKBench.swift -o wkbench)
# Bun: install into ./bun (its installer appends to ~/.zshrc; remove that afterwards)
uv run run.py && uv run gen_md.py
```
