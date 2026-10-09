// landing-v2-motion.js — 官網 v2 連續捲動動效（#156）
// 只在 <html class="mo">（有 JS、沒有開「減少動態」）時啟用。位置只在 resize／圖片載入時量測，
// 捲動時只寫 CSS 變數與少量 class，避免版面讀寫交錯。
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
  var setv = function (el, k, v) { el.style.setProperty(k, (Math.round(v * 1000) / 1000).toString()); };

  // ---------- 首屏 ----------
  var hx = document.querySelector('.hx');
  var H = null;
  if (hx) {
    var hq = document.getElementById('hx-q');
    H = {
      pin: hx.querySelector('.hx-pin'), stage: hx.querySelector('.hx-stage'),
      agent: hx.querySelector('.hx-agent'), rows: hx.querySelectorAll('.hx-agent [data-k]'),
      line: hx.querySelector('.hx-ma polyline'), q: hq, full: hq ? hq.textContent : '', top: 0, h: 1
    };
  }
  var darkMq = matchMedia('(prefers-color-scheme: dark)');
  function theme() { return root.dataset.theme || (darkMq.matches ? 'dark' : 'light'); }
  function syncCrops() {
    if (!hx || !desk.matches) return;
    var t = theme();
    [].forEach.call(hx.querySelectorAll('.hx-crop img[data-src]'), function (im) {
      var src = im.dataset.src.replace('THEME', t);
      if (im.getAttribute('src') !== src) im.src = src;
    });
  }
  syncCrops();
  darkMq.addEventListener('change', syncCrops);
  new MutationObserver(syncCrops).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  function heroFrame() {
    if (!H || !desk.matches) return;
    var p = clamp((scrollY - H.top) / Math.max(1, H.h - vh), 0, 1);
    var st = H.stage.style;
    setv(H.stage, '--hc', seg(p, 0, 0.22));
    setv(H.stage, '--hy', 1 - seg(p, 0, 0.3));
    setv(H.stage, '--ht', 1 - seg(p, 0.02, 0.32));
    setv(H.stage, '--ha', seg(p, 0.3, 0.35));
    var n = Math.round(H.full.length * seg(p, 0.33, 0.45));
    if (H.q && H.q.textContent.length !== n) H.q.textContent = H.full.slice(0, n);
    H.rows[0] && H.rows[0].classList.toggle('on', p > 0.47);
    H.rows[1] && H.rows[1].classList.toggle('on', p > 0.51);
    H.rows[2] && H.rows[2].classList.toggle('on', p > 0.6);
    setv(H.stage, '--hmm', seg(p, 0.5, 0.64));
    setv(H.stage, '--hl', seg(p, 0.6, 0.64));
    setv(H.stage, '--hs', seg(p, 0.64, 0.8));
    setv(H.stage, '--hx', seg(p, 0.8, 0.83));
    setv(H.stage, '--hx2', seg(p, 0.83, 1));
    void st;
  }

  // ---------- Agent 場景（捲動敘事） ----------
  var sy = document.querySelector('.sy');
  var SY = null;
  if (sy) {
    var stage = sy.querySelector('.sy-stage');
    var steps = [].slice.call(sy.querySelectorAll('.sy-step'));
    SY = { stage: stage, steps: steps.map(function (s) {
      var fig = s.querySelector('.sy-fig');
      if (fig && desk.matches) stage.appendChild(fig);
      fig.classList.add('demo', 'run');
      [].forEach.call(fig.querySelectorAll('.typed'), function (t) { t.dataset.full = t.dataset.full || t.textContent; });
      [].forEach.call(fig.querySelectorAll('.kpi6 b'), function (b) { b.dataset.full = b.textContent; });
      return { el: s, fig: fig, caps: s.querySelectorAll('.caps li'), kind: fig.dataset.demo, top: 0, h: 1, last: -1 };
    }), active: -1 };
  }
  function gate(fig, n) { for (var i = 1; i <= 8; i++) fig.classList.toggle('s' + i, i <= n); }
  function caps(st, n) { [].forEach.call(st.caps, function (li, i) { li.classList.toggle('on', i === n - 1); }); }
  function type(el, a, b, p) {
    if (!el) return;
    var full = el.dataset.full || '', n = Math.round(full.length * seg(p, a, b));
    if (el.textContent.length !== n) el.textContent = full.slice(0, n);
  }
  function $(fig, s) { return fig.querySelector(s); }
  var fmt = function (v, src) {
    var dec = (src.split('.')[1] || '').replace(/[^0-9]/g, '').length;
    var s = v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
    return src.replace(/[0-9][0-9,]*(\.[0-9]+)?/, s);
  };
  var apply = {
    observe: function (st, p) {
      var f = st.fig, card = $(f, '#ob-card'), state = $(f, '#ob-state');
      if (!state.dataset.full) state.dataset.full = state.textContent;
      var open = p > 0.2 && p < 0.5, done = p >= 0.5, learned = p >= 0.68;
      card.classList.toggle('show', open);
      state.textContent = done ? '已開啟。每天 13:50 執行，僅分析，不會下單。' : state.dataset.full;
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
      type($(f, '#bd-q'), 0.04, 0.32, p);
      gate(f, p > 0.62 ? 3 : p > 0.4 ? 2 : 1);
      var line = $(f, '.ch .ind');
      if (line) { line.style.strokeDasharray = '2000'; line.style.strokeDashoffset = String(2000 * (1 - seg(p, 0.62, 0.82))); }
      caps(st, p > 0.62 ? 3 : p > 0.4 ? 2 : 1);
    },
    agent: function (st, p) {
      var f = st.fig;
      type($(f, '#ag-q1'), 0.04, 0.3, p);
      gate(f, p > 0.6 ? 3 : p > 0.36 ? 2 : 1);
      caps(st, p > 0.78 ? 4 : p > 0.6 ? 3 : p > 0.36 ? 2 : 1);
    },
    quant: function (st, p) {
      var f = st.fig;
      $(f, '#bt-dlg').classList.toggle('show', p < 0.22);
      gate(f, p > 0.68 ? 4 : p > 0.28 ? 3 : 2);
      var k = seg(p, 0.3, 0.6);
      var line = $(f, '.bt-res .eq-line');
      if (line) { line.style.transition = 'none'; line.style.strokeDashoffset = String(1000 * (1 - k)); }
      [].forEach.call(f.querySelectorAll('.kpi6 b'), function (b) {
        var src = b.dataset.full, m = src.match(/[0-9][0-9,]*(\.[0-9]+)?/);
        if (!m || /\(/.test(src)) return;
        b.textContent = fmt(parseFloat(m[0].replace(/,/g, '')) * k, src);
      });
      caps(st, p > 0.68 ? 4 : p > 0.3 ? 3 : p > 0.22 ? 2 : 1);
    },
    alloc: function (st, p) {
      var f = st.fig;
      type($(f, '#al-q'), 0.03, 0.22, p);
      var n = p > 0.82 ? 5 : p > 0.64 ? 4 : p > 0.44 ? 3 : p > 0.28 ? 2 : 1;
      gate(f, n);
      var t = $(f, '.alloc-t'); if (t) setv(t, '--k', seg(p, 0.44, 0.6));
      caps(st, n >= 5 ? 4 : n >= 4 ? 3 : n >= 2 ? 2 : 1);
    },
    brief: function (st, p) {
      var f = st.fig, logged = p >= 0.56;
      type($(f, '#br-name'), 0.03, 0.1, p);
      type($(f, '#br-ins'), 0.1, 0.36, p);
      $(f, '#br-form').classList.toggle('hide', logged);
      $(f, '#br-log').classList.toggle('hide', !logged);
      $(f, '#br-t1').classList.toggle('on', !logged);
      $(f, '#br-t2').classList.toggle('on', logged);
      var toast = $(f, '.toast');
      if (toast) { toast.querySelector('.tt').textContent = '盤前簡報：已完成，結論在「紀錄」'; toast.classList.toggle('show', logged && p < 0.9); }
      caps(st, logged ? 3 : p > 0.4 ? 2 : 1);
    }
  };
  function syFrame() {
    if (!SY) return;
    var line = scrollY + vh * (desk.matches ? 0.5 : 0.68), act = -1;
    for (var i = 0; i < SY.steps.length; i++) {
      var s = SY.steps[i];
      if (line >= s.top && line < s.top + s.h) { act = i; break; }
    }
    if (act < 0) act = line < SY.steps[0].top ? 0 : SY.steps.length - 1;
    if (act !== SY.active) {
      SY.steps.forEach(function (s, i) {
        s.el.classList.toggle('is-on', i === act);
        s.fig.classList.toggle('is-on', i === act);
        s.fig.classList.toggle('is-past', i < act);
      });
      SY.active = act;
    }
    var st = SY.steps[act];
    var p = clamp((line - st.top) / st.h * 1.12, 0, 1);
    if (Math.abs(p - st.last) > 0.002 && apply[st.kind]) { apply[st.kind](st, p); st.last = p; }
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
    A = { el: asm, ps: ps, tag: asm.querySelector('.asm-stage'), top: 0, h: 1 };
  }
  function asmFrame() {
    if (!A) return;
    var p = clamp((scrollY + vh * 0.25 - A.top) / Math.max(1, A.h - vh * 0.6), 0, 1);
    A.ps.forEach(function (el, i) { setv(el, '--q', sm((p * 1.3 - i * 0.08) / 0.5)); });
    setv(A.tag, '--tag', seg(p, 0.74, 0.86));
  }

  // ---------- 通用捲動進場 ----------
  var SX = [];
  function collectSx() {
    var sel = '.feature > figure.demo, .safe-shot, .map-wrap, .skills .card, .dl .card, .oss, .tu-player, .dl-steps li, .hero-points li';
    [].forEach.call(document.querySelectorAll(sel), function (el) {
      if (el.closest('.sy-stage')) return;
      el.setAttribute('data-sx', '');
      SX.push({ el: el, top: 0, kind: 'sx' });
    });
    [].forEach.call(document.querySelectorAll('.safe-list li'), function (el) { SX.push({ el: el, top: 0, kind: 'sxi' }); });
  }
  function sxFrame() {
    for (var i = 0; i < SX.length; i++) {
      var o = SX[i], t = o.top - scrollY;
      if (t > vh * 1.2 || t < -vh) continue;
      var v = sm((vh - t) / (vh * (o.kind === 'sxi' ? 0.42 : 0.55)));
      if (o.v !== v) { setv(o.el, o.kind === 'sxi' ? '--sxi' : '--sx', v); o.v = v; }
    }
  }

  // ---------- 量測與迴圈 ----------
  function measure() {
    vh = innerHeight;
    if (H) { H.top = absTop(H.pin); H.h = H.pin.offsetHeight; }
    if (SY) SY.steps.forEach(function (s) { s.top = absTop(s.el); s.h = s.el.offsetHeight; s.last = -1; });
    if (A) { A.top = absTop(A.el); A.h = A.el.offsetHeight; }
    SX.forEach(function (o) {
      var prev = o.el.style.transform; o.el.style.transform = 'none';
      o.top = absTop(o.el); o.el.style.transform = prev; o.v = -1;
    });
  }
  var ticking = false;
  function frame() { ticking = false; heroFrame(); syFrame(); asmFrame(); sxFrame(); }
  function req() { if (!ticking) { ticking = true; requestAnimationFrame(frame); } }

  function init() {
    collectSx();
    measure(); frame();
    addEventListener('scroll', req, { passive: true });
    addEventListener('resize', function () { measure(); req(); });
    desk.addEventListener('change', function () { measure(); req(); });
    addEventListener('load', function () { measure(); req(); });
    if ('ResizeObserver' in window) { var t; new ResizeObserver(function () { clearTimeout(t); t = setTimeout(function () { measure(); req(); }, 120); }).observe(document.body); }
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
