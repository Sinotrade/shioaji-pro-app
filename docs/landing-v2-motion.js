// landing-v2-motion.js — 官網 v2 連續捲動動效（#156）
// 只在 <html class="mo">（有 JS、沒有開「減少動態」）時啟用。
// 做法依 pm/design/landing-v2/motion-research.md：捲動值與畫面之間用時間校正的指數平滑追趕，
// 靜止時停掉 rAF；變數寫在實際動的元素上（@property inherits:false）；打字用逐字 opacity，不改文字內容。
(function () {
  'use strict';
  var root = document.documentElement;
  if (!root.classList.contains('mo')) return;

  var clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };
  var sm = function (t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
  var seg = function (p, a, b) { return sm((p - a) / (b - a)); };
  var desk = matchMedia('(min-width: 900px)');
  var vh = innerHeight;
  var absTop = function (el) { var r = el.getBoundingClientRect(); return r.top + scrollY; };
  var setv = function (el, k, v) {
    v = Math.round(v * 1000) / 1000;
    if (el['_' + k] !== v) { el['_' + k] = v; el.style.setProperty(k, String(v)); }
  };

  // ---------- 拆字：Intl.Segmenter、標點黏前字、詞不斷行、aria ----------
  var segm = ('Segmenter' in Intl) ? new Intl.Segmenter('zh-Hant', { granularity: 'word' }) : null;
  var PUNCT = /^[，。、；：？！」』）》〉,.;:?!)\]]+$/;
  function words(text) { return segm ? Array.from(segm.segment(text), function (x) { return x.segment; }) : text.split(/(\s+)/); }
  function split(el, mode, maskEach) {
    var src = el.dataset.src || el.textContent; el.dataset.src = src;
    if (!el.getAttribute('aria-label') && !el.closest('[aria-hidden="true"]') && !(el.parentElement && el.parentElement.closest('[aria-label]')) && !/^(SPAN)$/.test(el.tagName)) el.setAttribute('aria-label', src);
    var out = [], ws = words(src);
    for (var i = 0; i < ws.length; i++) { if (out.length && PUNCT.test(ws[i])) out[out.length - 1] += ws[i]; else out.push(ws[i]); }
    el.textContent = '';
    var ci = 0, units = [];
    out.forEach(function (w) {
      if (/^\s+$/.test(w)) { el.appendChild(document.createTextNode(' ')); return; }
      var box = document.createElement('span'); box.className = 'word'; box.setAttribute('aria-hidden', 'true');
      var latin = /[A-Za-z0-9]/.test(w);
      var us = mode === 'word' ? [w] : (latin ? Array.from(w) : Array.from(w).reduce(function (a, c) {
        if (a.length && PUNCT.test(c)) a[a.length - 1] += c; else a.push(c); return a; }, []));
      us.forEach(function (c) {
        var u = document.createElement('span'); u.className = 'u'; u.textContent = c; u.style.setProperty('--ci', ci++);
        if (maskEach) { var m = document.createElement('span'); m.className = 'mask'; m.appendChild(u); box.appendChild(m); } else box.appendChild(u);
        units.push(u);
      });
      el.appendChild(box);
    });
    return units;
  }
  // 打字：t ∈ [0,1] 依序點亮每個字
  function typer(el) {
    if (!el) return null;
    var units = split(el, 'char', false);
    return { units: units, last: -1, set: function (t) {
      var n = units.length, k = Math.round(t * n);
      if (k === this.last) return; this.last = k;
      for (var i = 0; i < n; i++) units[i].style.setProperty('--o', i < k ? '1' : '0');
    } };
  }

  // ---------- 首屏進場 ----------
  var hx = document.querySelector('.hx');
  function heroIntro() {
    if (!hx) return;
    var h1 = hx.querySelector('h1'), lines = [].slice.call(h1.querySelectorAll('.ln')), byWord = !desk.matches, maxEnd = 0;
    if (byWord) h1.classList.add('byword');
    lines.forEach(function (ln, li) {
      var us = split(ln, byWord ? 'word' : 'char', !byWord);
      us.forEach(function (u) { u.style.setProperty('--li', li); });
      var end = byWord ? li * 160 + (us.length - 1) * 70 + 60 + 900 : li * 140 + (us.length - 1) * 34 + 80 + 950;
      maxEnd = Math.max(maxEnd, end);
    });
    h1.removeAttribute('aria-hidden');
    hx.querySelector('.hx-copy').style.setProperty('--fd', Math.round(maxEnd * 0.55) + 'ms');
    var go = function () { requestAnimationFrame(function () { requestAnimationFrame(function () { root.classList.add('go'); }); }); };
    if (document.fonts && document.fonts.ready) Promise.race([document.fonts.ready, new Promise(function (r) { setTimeout(r, 400); })]).then(go); else go();
  }

  // ---------- 首屏捲動 ----------
  var H = null;
  if (hx) {
    H = {
      pin: hx.querySelector('.hx-pin'), stage: hx.querySelector('.hx-stage'), copy: hx.querySelector('.hx-copy'),
      app: hx.querySelector('.hx-app'), win: hx.querySelector('.hx-win'), base: hx.querySelector('.hx-base'),
      crops: [].slice.call(hx.querySelectorAll('.hx-crop')), agent: hx.querySelector('.hx-agent'),
      rows: [].slice.call(hx.querySelectorAll('.hx-agent [data-k]')), ma: hx.querySelector('.hx-ma'),
      legend: hx.querySelector('.hx-legend'), q: null, ready: false, top: 0, h: 1
    };
  }
  var darkMq = matchMedia('(prefers-color-scheme: dark)');
  function theme() { return root.dataset.theme || (darkMq.matches ? 'dark' : 'light'); }
  function syncCrops() {
    if (!H || !desk.matches) return;
    var t = theme(), imgs = H.crops.map(function (c) { return c.querySelector('img'); }), pend = [];
    H.ready = false;
    imgs.forEach(function (im) {
      var src = im.dataset.src.replace('THEME', t);
      if (im.getAttribute('src') !== src) im.src = src;
      if (im.decode) pend.push(im.decode().catch(function () {}));
    });
    Promise.all(pend).then(function () { H.ready = true; kick(); });
  }
  function heroWrite(p) {
    if (!H || !desk.matches) return;
    setv(H.copy, '--hc', seg(p, 0, 0.16));
    setv(H.app, '--hy', 1 - seg(p, 0, 0.22));
    setv(H.win, '--ht', 1 - seg(p, 0, 0.22));
    setv(H.agent, '--ha', seg(p, 0.27, 0.36));
    if (H.q) H.q.set(seg(p, 0.36, 0.52));
    var spans = [[0.52, 0.57], [0.55, 0.6], [0.7, 0.76]];
    H.rows.forEach(function (r, i) { var s = spans[i] || spans[2]; setv(r, '--r', seg(p, s[0], s[1])); });
    setv(H.ma, '--hm', seg(p, 0.62, 0.74));
    setv(H.stage, '--hs', seg(p, 0.8, 0.9));
    var hxv = H.ready ? seg(p, 0.88, 0.9) : 0, hx2 = H.ready ? seg(p, 0.89, 1) : 0;
    H.crops.forEach(function (c) { setv(c, '--hx', hxv); setv(c, '--hx2', hx2); });
    setv(H.base, '--hx', hxv); setv(H.ma, '--hx', hxv);
    setv(H.legend, '--hl', seg(p, 0.7, 0.76)); setv(H.legend, '--hx', hxv);
    setv(H.agent, '--hx2', hx2);
    H.app.classList.toggle('wc', p > 0.75);
  }

  // ---------- Agent 場景 ----------
  var sy = document.querySelector('.sy');
  var SY = null;
  if (sy) {
    var stage = sy.querySelector('.sy-stage');
    SY = { steps: [].slice.call(sy.querySelectorAll('.sy-step')).map(function (s) {
      var fig = s.querySelector('.sy-fig');
      if (fig && desk.matches) stage.appendChild(fig);
      fig.classList.add('demo', 'run');
      var ty = {};
      [].forEach.call(fig.querySelectorAll('.typed'), function (t) { if (t.id) ty[t.id] = typer(t); });
      [].forEach.call(fig.querySelectorAll('.kpi6 b'), function (b) { b.dataset.full = b.textContent; });
      var h2 = s.querySelector('.h2s'); if (h2) split(h2, 'word', false);
      return { el: s, fig: fig, ty: ty, caps: s.querySelectorAll('.caps li'), kind: fig.dataset.demo, top: 0, h: 1, last: -1 };
    }), active: -1, z: 0.1 };
  }
  function gate(fig, n) { for (var i = 1; i <= 8; i++) fig.classList.toggle('s' + i, i <= n); }
  function caps(st, n) { [].forEach.call(st.caps, function (li, i) { li.classList.toggle('on', i === n - 1); }); }
  function type(st, id, a, b, p) { var t = st.ty[id]; if (t) t.set(seg(p, a, b)); }
  function $(fig, q) { return fig.querySelector(q); }
  var fmt = function (v, src) {
    var dec = (src.split('.')[1] || '').replace(/[^0-9]/g, '').length;
    return src.replace(/[0-9][0-9,]*(\.[0-9]+)?/, v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec }));
  };
  var apply = {
    observe: function (st, p) {
      var f = st.fig, card = $(f, '#ob-card'), state = $(f, '#ob-state');
      if (!state.dataset.full) state.dataset.full = state.textContent;
      var open = p > 0.2 && p < 0.5, done = p >= 0.5, learned = p >= 0.68;
      card.classList.toggle('show', open);
      var txt = done ? '已開啟。每天 13:50 執行，僅分析，不會下單。' : state.dataset.full;
      if (state.textContent !== txt) state.textContent = txt;
      $(f, '#ob-tasks').classList.toggle('hide', learned);
      $(f, '#ob-skills').classList.toggle('hide', !learned);
      $(f, '#ob-t1').classList.toggle('on', !learned);
      $(f, '#ob-t2').classList.toggle('on', learned);
      var toast = $(f, '.toast');
      if (toast) { toast.querySelector('.tt').textContent = '學到新技能：早盤例行檢查'; toast.classList.toggle('show', learned && p < 0.95); }
      caps(st, learned ? 3 : open ? 2 : 1);
    },
    build: function (st, p) {
      var f = st.fig;
      type(st, 'bd-q', 0.04, 0.32, p);
      gate(f, p > 0.62 ? 3 : p > 0.4 ? 2 : 1);
      var line = $(f, '.ch .ind');
      if (line) { line.style.transition = 'none'; line.style.strokeDasharray = '2000'; line.style.strokeDashoffset = String(2000 * (1 - seg(p, 0.62, 0.82))); }
      caps(st, p > 0.62 ? 3 : p > 0.4 ? 2 : 1);
    },
    agent: function (st, p) {
      type(st, 'ag-q1', 0.04, 0.3, p);
      gate(st.fig, p > 0.6 ? 3 : p > 0.36 ? 2 : 1);
      caps(st, p > 0.78 ? 4 : p > 0.6 ? 3 : p > 0.36 ? 2 : 1);
    },
    quant: function (st, p) {
      var f = st.fig;
      $(f, '#bt-dlg').classList.toggle('show', p < 0.22);
      gate(f, p > 0.68 ? 4 : p > 0.28 ? 3 : 2);
      var k = seg(p, 0.3, 0.6), line = $(f, '.bt-res .eq-line');
      if (line) { line.style.transition = 'none'; line.style.strokeDashoffset = String(1000 * (1 - k)); }
      [].forEach.call(f.querySelectorAll('.kpi6 b'), function (b) {
        var src = b.dataset.full, m = src.match(/[0-9][0-9,]*(\.[0-9]+)?/);
        if (!m || /\(/.test(src)) return;
        var t = fmt(parseFloat(m[0].replace(/,/g, '')) * k, src);
        if (b.textContent !== t) b.textContent = t;
      });
      caps(st, p > 0.68 ? 4 : p > 0.3 ? 3 : p > 0.22 ? 2 : 1);
    },
    alloc: function (st, p) {
      type(st, 'al-q', 0.03, 0.22, p);
      var n = p > 0.82 ? 5 : p > 0.64 ? 4 : p > 0.44 ? 3 : p > 0.28 ? 2 : 1;
      gate(st.fig, n);
      var t = $(st.fig, '.alloc-t'); if (t) setv(t, '--k', seg(p, 0.44, 0.6));
      caps(st, n >= 5 ? 4 : n >= 4 ? 3 : n >= 2 ? 2 : 1);
    },
    brief: function (st, p) {
      var f = st.fig, logged = p >= 0.56;
      type(st, 'br-name', 0.03, 0.1, p);
      type(st, 'br-ins', 0.1, 0.36, p);
      $(f, '#br-form').classList.toggle('hide', logged);
      $(f, '#br-log').classList.toggle('hide', !logged);
      $(f, '#br-t1').classList.toggle('on', !logged);
      $(f, '#br-t2').classList.toggle('on', logged);
      var toast = $(f, '.toast');
      if (toast) { toast.querySelector('.tt').textContent = '盤前簡報：已完成，結論在「紀錄」'; toast.classList.toggle('show', logged && p < 0.9); }
      caps(st, logged ? 3 : p > 0.4 ? 2 : 1);
    }
  };
  // 捲動位置 → 連續的步驟座標 f（第 i 步內為 i..i+1）
  function syTarget() {
    if (!SY) return 0;
    var line = scrollY + vh * (desk.matches ? 0.5 : 0.68), n = SY.steps.length;
    if (line < SY.steps[0].top) return 0;
    for (var i = 0; i < n; i++) { var s = SY.steps[i]; if (line < s.top + s.h) return i + clamp((line - s.top) / s.h, 0, 1); }
    return n;
  }
  function syWrite(f) {
    if (!SY) return;
    var n = SY.steps.length, act = clamp(Math.floor(f), 0, n - 1), z = SY.z;
    if (act !== SY.active) {
      SY.steps.forEach(function (s, i) { s.el.classList.toggle('is-on', i === act); s.fig.classList.toggle('is-on', i === act); });
      SY.active = act;
    }
    SY.steps.forEach(function (st, i) {
      var inn = i === 0 ? 1 : seg(f, i - z, i + z), out = i === n - 1 ? 0 : seg(f, i + 1 - z, i + 1 + z);
      if (desk.matches) { setv(st.fig, '--in', inn); setv(st.fig, '--out', out); }
      var vis = desk.matches ? inn - out > 0.001 : i === act;
      if (!vis) return;
      var p = clamp((f - i) * 1.12, 0, 1);
      if (Math.abs(p - st.last) > 0.002 && apply[st.kind]) { apply[st.kind](st, p); st.last = p; }
    });
  }

  // ---------- 面板組成版面 ----------
  var asm = document.querySelector('[data-asm]');
  var A = null;
  if (asm) {
    var ps = [].slice.call(asm.querySelectorAll('.asm-p'));
    var seeds = [[-70, -40, -500, -14], [10, -90, -700, 8], [-30, 80, -400, -6], [80, -30, -600, 12], [70, 70, -300, -10], [40, 110, -500, 6]];
    ps.forEach(function (el, i) {
      var s = seeds[i % seeds.length];
      el.style.setProperty('--ax', s[0] + 'vw'); el.style.setProperty('--ay', s[1] + 'vh');
      el.style.setProperty('--az', s[2] + 'px'); el.style.setProperty('--ar', s[3] + 'deg');
    });
    A = { el: asm, ps: ps, tag: asm.querySelector('.asm-stage'), top: 0, h: 1, decoded: false };
  }
  function asmTarget() { return A ? clamp((scrollY + vh * 0.25 - A.top) / Math.max(1, A.h - vh * 0.6), 0, 1) : 0; }
  function asmWrite(p) {
    if (!A) return;
    if (!A.decoded && scrollY + vh * 2 > A.top) {
      A.decoded = true;
      A.ps.forEach(function (el) { var im = el.querySelector('img'); im.loading = 'eager'; if (im.decode) im.decode().catch(function () {}); });
    }
    A.ps.forEach(function (el, i) { setv(el, '--q', sm((p * 1.3 - i * 0.08) / 0.5)); });
    setv(A.tag, '--tag', seg(p, 0.74, 0.86));
  }

  // ---------- 平滑追趕迴圈 ----------
  var tracks = [
    { k: 9, get: function () { return H && desk.matches ? clamp((scrollY - H.top) / Math.max(1, H.h - vh), 0, 1) : 0; }, put: heroWrite },
    { k: 10, get: syTarget, put: syWrite },
    { k: 9, get: asmTarget, put: asmWrite }
  ];
  tracks.forEach(function (t) { t.cur = null; });
  var running = false, last = 0;
  function loop(now) {
    var dt = Math.min(0.05, (now - last) / 1000 || 0.016); last = now;
    var moving = false;
    tracks.forEach(function (t) {
      var target = t.get();
      if (t.cur === null) t.cur = target;
      var d = target - t.cur;
      if (Math.abs(d) > 0.0005) { t.cur += d * (1 - Math.exp(-t.k * dt)); moving = true; } else t.cur = target;
      t.put(t.cur);
    });
    if (moving) requestAnimationFrame(loop); else running = false;
  }
  function kick() { if (!running) { running = true; last = performance.now(); requestAnimationFrame(loop); } }

  // ---------- 一般卡片：觸發一次；大型示範視窗：原生 view() 或退回觸發一次 ----------
  function reveals() {
    var sel = '.safe-list li, .skills .card, .dl .card, .oss, .dl-steps li, .hero-points li, .map-wrap, .tu-player, .safe-shot, .faq details';
    var els = [].slice.call(document.querySelectorAll(sel));
    if (!(window.CSS && CSS.supports('animation-timeline: view()'))) els = els.concat([].slice.call(document.querySelectorAll('.feature > figure.demo:not(.sy-fig)')));
    if (!('IntersectionObserver' in window)) return;
    els.forEach(function (el) {
      var sib = el.parentElement ? [].indexOf.call(el.parentElement.children, el) : 0;
      el.style.setProperty('--si', Math.min(sib, 6));
      el.classList.add('rv');
    });
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
    }, { rootMargin: '0px 0px -15% 0px' });
    els.forEach(function (el) { io.observe(el); });
  }

  // ---------- 量測與啟動 ----------
  function measure() {
    vh = innerHeight;
    if (H) { H.top = absTop(H.pin); H.h = H.pin.offsetHeight; }
    if (SY) SY.steps.forEach(function (s) { s.top = absTop(s.el); s.h = s.el.offsetHeight; s.last = -1; });
    if (A) { A.top = absTop(A.el); A.h = A.el.offsetHeight; }
  }
  heroIntro();
  if (H) H.q = typer(document.getElementById('hx-q'));
  function init() {
    syncCrops();
    darkMq.addEventListener('change', syncCrops);
    new MutationObserver(syncCrops).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    reveals();
    measure(); tracks.forEach(function (t) { t.cur = null; }); kick();
    addEventListener('scroll', kick, { passive: true });
    addEventListener('resize', function () { measure(); kick(); });
    desk.addEventListener('change', function () { measure(); kick(); });
    addEventListener('load', function () { measure(); kick(); });
    if ('ResizeObserver' in window) { var t; new ResizeObserver(function () { clearTimeout(t); t = setTimeout(function () { measure(); kick(); }, 120); }).observe(document.body); }
    matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', function (e) { if (e.matches) location.reload(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

  // ---------- 申請 API Key 教學播放器 ----------
  function Tutorial(box) {
    var self = this;
    root.classList.add('tu-js');
    this.box = box;
    this.steps = [].slice.call(box.querySelectorAll('.tu-step'));
    this.cc = box.querySelector('[data-tu-cc]');
    this.n = box.querySelector('[data-tu-n]');
    this.where = box.querySelector('[data-tu-where]');
    this.playBtn = box.querySelector('[data-tu-play]');
    var segs = box.querySelector('[data-tu-segs]');
    this.segs = this.steps.map(function (s, i) {
      var b = document.createElement('button');
      b.type = 'button'; b.setAttribute('aria-label', '第 ' + (i + 1) + ' 步：' + s.querySelector('.tu-cap b').textContent);
      b.innerHTML = '<i></i>';
      b.addEventListener('click', function () { self.go(i); });
      segs.appendChild(b); return b;
    });
    this.steps.forEach(function (s) {
      [].forEach.call(s.querySelectorAll('.tu-type'), function (t) { t.dataset.full = t.dataset.text || ''; t.textContent = ''; });
    });
    box.querySelector('[data-tu-prev]').addEventListener('click', function () { self.go(Math.max(0, self.i - 1)); });
    box.querySelector('[data-tu-next]').addEventListener('click', function () { self.go(Math.min(self.steps.length - 1, self.i + 1)); });
    this.playBtn.addEventListener('click', function () { self.setPlaying(!self.playing); });
    this.visible = false; this.playing = true; this.i = -1;
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (es) { self.visible = es[0].isIntersecting; }, { threshold: 0.4 }).observe(box);
    } else this.visible = true;
    this.go(0);
    var last = performance.now();
    var loop = function (now) {
      var dt = (now - last) / 1000; last = now;
      if (self.playing && self.visible && !document.hidden) self.tick(Math.min(dt, 0.1));
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
  Tutorial.prototype.setPlaying = function (on) {
    this.playing = on;
    this.box.classList.toggle('paused', !on);
    this.playBtn.setAttribute('aria-label', on ? '暫停' : '播放');
  };
  Tutorial.prototype.go = function (i) {
    var s = this.steps[i];
    this.steps.forEach(function (x, k) { x.classList.toggle('is-on', k === i); });
    this.i = i; this.t = 0; this.cur = null;
    this.dur = parseFloat(s.dataset.dur || '7');
    this.cc.innerHTML = s.querySelector('.tu-cap').innerHTML;
    this.n.textContent = String(i + 1);
    this.where.textContent = s.dataset.where || '';
    this.segs.forEach(function (b, k) { b.style.setProperty('--f', k < i ? '1' : '0'); b.setAttribute('aria-current', k === i ? 'step' : 'false'); });
    [].forEach.call(s.querySelectorAll('.shown, .done, .hit'), function (e) { e.classList.remove('shown', 'done', 'hit'); });
    [].forEach.call(s.querySelectorAll('.tu-type'), function (e) { e.textContent = ''; });
    var scene = s.querySelector('.tu-scene');
    var old = scene.querySelector('.tu-cur'); if (old) old.remove();
    this.path = (s.dataset.path || '').split(',').filter(Boolean).map(function (w) {
      var a = w.split(':'); return { el: scene.querySelector(a[0]), t: parseFloat(a[1]), click: a[2] === 'c', done: false };
    }).filter(function (w) { return w.el; });
    if (this.path.length) {
      var c = document.createElement('div');
      c.className = 'tu-cur'; c.innerHTML = '<svg aria-hidden="true"><use href="#i-cursor"/></svg>';
      scene.appendChild(c); this.cur = c; this.scene = scene;
    }
    // 外框位置
    [].forEach.call(s.querySelectorAll('.tu-ring[data-for]'), function (r) {
      var tgt = s.querySelector(r.dataset.for), host = r.offsetParent || r.parentElement;
      if (!tgt) return;
      var a = tgt.getBoundingClientRect(), b = host.getBoundingClientRect();
      r.style.left = (a.left - b.left - 4) + 'px'; r.style.top = (a.top - b.top - 4) + 'px';
      r.style.width = (a.width + 8) + 'px'; r.style.height = (a.height + 8) + 'px';
    });
    this.tick(0);
  };
  Tutorial.prototype.pos = function (el) {
    var a = el.getBoundingClientRect(), b = this.scene.getBoundingClientRect();
    return { x: (a.left - b.left + a.width * 0.5) / b.width, y: (a.top - b.top + a.height * 0.6) / b.height };
  };
  Tutorial.prototype.tick = function (dt) {
    var s = this.steps[this.i], t = (this.t += dt);
    [].forEach.call(s.querySelectorAll('[data-t]'), function (e) {
      var on = t >= parseFloat(e.dataset.t);
      if (e.classList.contains('tu-type')) {
        var full = e.dataset.full, n = on ? Math.min(full.length, Math.floor((t - parseFloat(e.dataset.t)) * 14)) : 0;
        if (e.textContent.length !== n) e.textContent = full.slice(0, n);
      } else if (e.classList.contains('tu-tick') || e.classList.contains('tu-swap')) e.classList.toggle('done', on);
      else e.classList.toggle('shown', on);
    });
    if (this.cur && this.scene.offsetWidth) {
      var prev = { x: 0.86, y: 0.92 }, pt = 0, x = prev.x, y = prev.y;
      for (var k = 0; k < this.path.length; k++) {
        var w = this.path[k], to = this.pos(w.el), start = Math.max(pt, w.t - 0.8);
        if (t < start) { x = prev.x; y = prev.y; break; }
        var e = sm((t - start) / Math.max(0.01, w.t - start));
        x = prev.x + (to.x - prev.x) * e; y = prev.y + (to.y - prev.y) * e;
        if (t >= w.t && !w.done) {
          w.done = true;
          if (w.click) { this.cur.classList.remove('click'); void this.cur.offsetWidth; this.cur.classList.add('click'); }
          if (w.el.classList.contains('tu-hot')) w.el.classList.add('hit');
        }
        prev = to; pt = w.t;
        if (t < w.t) break;
      }
      this.cur.style.transform = 'translate(' + (x * this.scene.offsetWidth) + 'px,' + (y * this.scene.offsetHeight) + 'px)';
    }
    this.segs[this.i].style.setProperty('--f', String(clamp(t / this.dur, 0, 1)));
    if (t >= this.dur) {
      if (this.i < this.steps.length - 1) this.go(this.i + 1);
      else this.setPlaying(false);
    }
  };
  var tu = document.querySelector('[data-tu]');
  if (tu) {
    var start = function () { new Tutorial(tu); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  }
})();
