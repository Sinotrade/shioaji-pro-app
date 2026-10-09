// landing-v2.js — 官網 v2 方向稿（#156）
// 每段示範動畫的 HTML 本身就是「最後一格」：JS 沒載入、或使用者開啟「減少動態」時，
// 看到的就是完整的靜態畫面。JS 只負責從頭依序播放、循環、暫停。
(function () {
  'use strict';
  var root = document.documentElement;
  root.classList.add('js-ready');

  // ---------- theme ----------
  var THEME_KEY = 'shioaji-pro-appearance';
  var darkMq = matchMedia('(prefers-color-scheme: dark)');
  function effectiveTheme() {
    return root.dataset.theme || (darkMq.matches ? 'dark' : 'light');
  }
  function syncShot() {
    Array.prototype.forEach.call(document.querySelectorAll('picture > source[media]'), function (source) {
      if (!root.dataset.theme) source.media = '(prefers-color-scheme: dark)';
      else source.media = root.dataset.theme === 'dark' ? 'all' : 'not all';
    });
  }
  function syncThemeBtn() {
    var btn = document.getElementById('theme-btn');
    if (btn) btn.setAttribute('aria-label', effectiveTheme() === 'dark' ? '切換成淺色' : '切換成深色');
  }
  syncShot();
  syncThemeBtn();
  darkMq.addEventListener('change', syncThemeBtn);
  var themeBtn = document.getElementById('theme-btn');
  if (themeBtn) {
    themeBtn.addEventListener('click', function () {
      var next = effectiveTheme() === 'dark' ? 'light' : 'dark';
      root.dataset.theme = next;
      try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* storage unavailable */ }
      syncShot();
      syncThemeBtn();
    });
  }

  // ---------- release links ----------
  fetch('https://api.github.com/repos/Sinotrade/shioaji-pro-app/releases/latest')
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (rel) {
      if (!rel || !rel.assets) return;
      var ver = rel.tag_name || '';
      var verEl = document.getElementById('ver');
      if (verEl && ver) verEl.textContent = ver;
      var dlVer = document.getElementById('dl-ver');
      if (dlVer) dlVer.textContent = ver;
      function asset(re) {
        for (var i = 0; i < rel.assets.length; i++) if (re.test(rel.assets[i].name)) return rel.assets[i].browser_download_url;
        return null;
      }
      function setLinks(id, list) {
        var box = document.getElementById(id);
        if (!box) return;
        var links = box.querySelectorAll('a');
        list.forEach(function (re, i) { var u = asset(re); if (u && links[i]) links[i].href = u; });
      }
      setLinks('dl-mac', [/aarch64\.dmg$/, /x64\.dmg$/]);
      setLinks('dl-win', [/\.msi$/, /setup\.exe$/i]);
      setLinks('dl-linux', [/\.AppImage$/, /\.deb$/, /\.rpm$/]);
      var ua = navigator.userAgent, url = null, label = null;
      if (/Macintosh/.test(ua)) { url = asset(/aarch64\.dmg$/); label = '下載 macOS 版（Apple Silicon）'; }
      else if (/Windows/.test(ua)) { url = asset(/\.msi$/); label = '下載 Windows 版'; }
      else if (/Linux/.test(ua) && !/Android/.test(ua)) { url = asset(/\.AppImage$/); label = '下載 Linux 版'; }
      if (url) {
        document.getElementById('cta-dl').href = url;
        document.getElementById('cta-dl').title = label;
      }
    })
    .catch(function () { /* keep releases page links */ });

  // ---------- demo engine ----------
  var reduce = matchMedia('(prefers-reduced-motion: reduce)');
  var STOP = {};

  function Demo(el, script, opts) {
    this.el = el;
    this.script = script;
    this.opts = opts || {};
    this.wins = Array.prototype.slice.call(el.querySelectorAll('.win'));
    this.saved = this.wins.map(function (w) { return w.innerHTML; });
    this.caps = document.querySelectorAll('.caps[data-for="' + el.dataset.demo + '"] li');
    this.cards = el.querySelectorAll('.step[data-cap]');
    this.btn = el.querySelector('.demo-ctrl');
    this.visible = false;
    this.paused = false;
    this.gen = 0;
    this.running = false;
    var self = this;
    el.classList.add('ready');
    if (this.btn) this.btn.addEventListener('click', function () { self.toggle(); });
  }
  Demo.prototype.$ = function (sel) { return this.el.querySelector(sel); };
  Demo.prototype.label = function () {
    if (!this.btn) return;
    var idle = !this.running;
    var showPlay = idle || this.paused;
    this.btn.setAttribute('aria-pressed', String(showPlay && !idle));
    this.btn.querySelector('span').textContent = showPlay ? '播放動畫' : '暫停動畫';
    this.el.classList.toggle('paused', this.running && this.paused);
    this.el.classList.toggle('idle', idle);
  };
  Demo.prototype.toggle = function () {
    if (!this.running) { this.paused = false; this.start(); }
    else this.paused = !this.paused;
    this.label();
  };
  Demo.prototype.wait = function (ms) {
    var self = this, gen = this.gen;
    return new Promise(function (resolve, reject) {
      var left = ms, last = performance.now();
      function tick(now) {
        if (gen !== self.gen) { reject(STOP); return; }
        if (!self.paused && self.visible && !document.hidden) left -= now - last;
        last = now;
        if (left <= 0) resolve();
        else if (self.paused || !self.visible || document.hidden) setTimeout(function () { tick(performance.now()); }, 250);
        else requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    });
  };
  Demo.prototype.reset = function () {
    var self = this;
    this.wins.forEach(function (w, i) { w.innerHTML = self.saved[i]; });
    for (var n = 1; n <= 8; n++) this.el.classList.remove('s' + n);
    this.el.className = this.el.className.replace(/\bqs-on-\d\b/g, '').trim();
    this.cap(0);
    this.cursor = null;
    if (this.opts.cursor) {
      Array.prototype.forEach.call(this.el.querySelectorAll('.cursor'), function (c) { c.remove(); });
      var stage = this.el.querySelector('.duo') || this.wins[0].querySelector('.stage');
      var c = document.createElement('div');
      c.className = 'cursor';
      c.innerHTML = '<svg aria-hidden="true"><use href="#i-cursor"/></svg>';
      stage.appendChild(c);
      this.cursor = c;
      this.stage = stage;
      this.placeXY(0.86, 0.92);
    }
  };
  Demo.prototype.gate = function (n) { for (var i = 1; i <= n; i++) this.el.classList.add('s' + i); };
  Demo.prototype.cap = function (n) {
    Array.prototype.forEach.call(this.caps, function (li, i) { li.classList.toggle('on', i === n - 1); });
    Array.prototype.forEach.call(this.cards, function (c) { c.classList.toggle('on', Number(c.dataset.cap) === n); });
  };
  Demo.prototype.step = function (n) { this.gate(n); this.cap(n); };
  Demo.prototype.placeXY = function (fx, fy) {
    var r = this.stage.getBoundingClientRect();
    this.cursor.style.setProperty('--cx', (r.width * fx).toFixed(1) + 'px');
    this.cursor.style.setProperty('--cy', (r.height * fy).toFixed(1) + 'px');
  };
  Demo.prototype.moveXY = function (fx, fy, ms) { this.placeXY(fx, fy); return this.wait(ms || 750); };
  Demo.prototype.move = function (target, fx, fy, ms) {
    var el = typeof target === 'string' ? this.$(target) : target;
    var r = this.stage.getBoundingClientRect(), t = el.getBoundingClientRect();
    if (!r.width || !r.height) return this.wait(ms || 750);
    var x = (t.left - r.left + t.width * (fx == null ? 0.5 : fx)) / r.width;
    var y = (t.top - r.top + t.height * (fy == null ? 0.5 : fy)) / r.height;
    return this.moveXY(x, y, ms);
  };
  Demo.prototype.click = function () {
    var c = this.cursor;
    c.classList.remove('click');
    void c.offsetWidth;
    c.classList.add('click');
    return this.wait(260);
  };
  Demo.prototype.toast = function (text, kind) {
    var t = this.$('.toast');
    if (!t) return;
    t.querySelector('.tt').textContent = text;
    t.classList.toggle('fill', kind === 'fill');
    t.classList.remove('show');
    void t.offsetWidth;
    t.classList.add('show');
  };
  Demo.prototype.type = function (el, text, cps) {
    var self = this, i = 0;
    el.textContent = '';
    el.classList.add('caret');
    var gap = 1000 / (cps || 22);
    function next() {
      if (i >= text.length) { el.classList.remove('caret'); return Promise.resolve(); }
      el.textContent += text[i++];
      return self.wait(gap).then(next);
    }
    return next();
  };
  Demo.prototype.start = function () {
    if (this.running) return;
    this.running = true;
    this.label();
    var self = this, gen = ++this.gen;
    (function loop() {
      if (gen !== self.gen) return;
      self.reset();
      self.el.classList.add('run');
      self.wait(500)
        .then(function () { return self.script(self); })
        .then(function () { return self.wait(2600); })
        .then(loop, function (e) { if (e !== STOP) { self.stop(); throw e; } });
    })();
  };
  Demo.prototype.stop = function () {
    this.gen++;
    this.running = false;
    this.el.classList.remove('run');
    var self = this;
    this.wins.forEach(function (w, i) { w.innerHTML = self.saved[i]; });
    for (var n = 1; n <= 8; n++) this.el.classList.remove('s' + n);
    this.el.className = this.el.className.replace(/\bqs-on-\d\b/g, '').trim();
    this.cap(0);
    this.label();
  };

  function rowOf(d, price) { return d.$('.fl-row[data-p="' + price + '"]'); }
  function seq(d, steps) {
    var p = Promise.resolve();
    steps.forEach(function (fn) { p = p.then(fn); });
    return p;
  }

  var scenes = {
    // 申請 API Key → 正式下單（步驟依官方文件）
    qs: [function (d) {
      var el = d.el;
      function scene(n) {
        for (var i = 1; i <= 6; i++) el.classList.remove('qs-on-' + i);
        el.classList.add('qs-on-' + n);
        d.step(n);
      }
      return seq(d, [
        function () { scene(1); return d.wait(2200); },
        function () { scene(2); return d.wait(2600); },
        function () { scene(3); return d.wait(3800); },
        function () { scene(4); return d.wait(2600); },
        function () { scene(5); return d.wait(3200); },
        function () { scene(6); return d.wait(3400); }
      ]);
    }, {}],

    flash: [function (d) {
      var arm = d.$('#fl-arm'), hl = d.$('.fl-hl'), buy = d.$('#fl-buy'), sell = d.$('#fl-sell'), hint = d.$('#fl-hint');
      function row(n) { hl.style.setProperty('--row', n); }
      arm.classList.remove('armed');
      row(5);
      buy.classList.add('gone'); buy.classList.remove('filled');
      d.cap(1);
      return seq(d, [
        function () { return d.move(arm, 0.5, 0.5); },
        function () { return d.click(); },
        function () { arm.classList.add('armed'); hint.classList.add('hide'); d.gate(1); return d.wait(800); },
        function () { row(4); return d.wait(500); },
        function () { row(5); return d.wait(500); },
        function () { d.step(2); return d.move(rowOf(d, 2545).querySelector('.bc'), 0.55, 0.5); },
        function () { return d.click(); },
        function () { buy.classList.remove('gone'); d.toast('委託・買 2,545・1 張'); return d.wait(1300); },
        function () { row(6); return d.wait(300); },
        function () { d.step(3); buy.classList.add('filled'); d.toast('成交・買 2,545・1 張', 'fill'); return d.wait(1900); },
        function () { d.step(4); row(5); return d.move(rowOf(d, 2560).querySelector('.sc'), 0.45, 0.5); },
        function () { return d.click(); },
        function () { sell.classList.remove('gone'); d.toast('委託・賣 2,560・1 張'); return d.wait(1200); },
        function () { return d.click(); },
        function () { sell.classList.add('gone'); d.toast('刪單・賣 2,560'); return d.wait(700); },
        function () { row(6); return d.moveXY(0.86, 0.95, 900); }
      ]);
    }, { cursor: true }],

    odd: [function (d) {
      var tk = d.$('#tk-win'), segs = d.$('#tk-unit').children, q = d.$('#tk-q'), ql = d.$('#tk-ql');
      var fo = d.$('#fo-win'), foLot = d.$('#fo-lot'), foOdd = d.$('#fo-odd');
      tk.classList.remove('odd'); segs[1].classList.remove('on'); segs[0].classList.add('on');
      q.textContent = '1'; ql.textContent = '數量張';
      fo.classList.remove('odd'); foOdd.classList.remove('on'); foLot.classList.add('on');
      d.cap(1);
      return seq(d, [
        function () { return d.move(segs[1]); },
        function () { return d.click(); },
        function () {
          segs[0].classList.remove('on'); segs[1].classList.add('on'); tk.classList.add('odd'); ql.textContent = '數量股';
          var box = d.$('#tk-qty'); box.classList.remove('flash'); void box.offsetWidth; box.classList.add('flash');
          d.gate(1); return d.wait(1200);
        },
        function () { d.step(2); return d.move(q, 0.6, 0.5); },
        function () { return d.click(); },
        function () { q.textContent = '3'; return d.wait(260); },
        function () { q.textContent = '35'; return d.wait(1400); },
        function () { d.step(3); return d.move(foOdd); },
        function () { return d.click(); },
        function () { foLot.classList.remove('on'); foOdd.classList.add('on'); fo.classList.add('odd'); return d.wait(2200); },
        function () { return d.moveXY(0.9, 0.96, 800); }
      ]);
    }, { cursor: true }],

    chart: [function (d) {
      var xh = d.$('#ch-xh'), order = d.$('#ch-order'), ot = d.$('#ch-otext'), oax = d.$('#ch-oax');
      var mode = d.$('#ch-mode'), stopBtn = d.$('#ch-stopbtn'), toolbarStage = d.el.querySelector('.win');
      order.style.transform = 'translateY(195px)';
      ot.textContent = '買 1 張 2,525'; oax.textContent = '2,525';
      d.gate(1);
      // 游標以 .win 為座標：讓工具列也點得到
      d.stage = toolbarStage;
      toolbarStage.appendChild(d.cursor);
      var svgTop = function (y) {
        var w = toolbarStage.getBoundingClientRect(), s = d.el.querySelector('.ch').getBoundingClientRect();
        return (s.top - w.top + s.height * (y / 330)) / w.height;
      };
      return seq(d, [
        function () { return d.wait(1300); },
        function () { d.cap(1); return d.move(mode); },
        function () { return d.click(); },
        function () { mode.classList.add('on'); return d.wait(600); },
        function () { d.cap(2); return d.moveXY(0.42, svgTop(195)); },
        function () { xh.classList.add('show'); return d.wait(500); },
        function () { return d.click(); },
        function () { xh.classList.remove('show'); mode.classList.remove('on'); d.gate(2); d.toast('委託・買 2,525・1 張'); return d.wait(1300); },
        function () { d.cap(3); return d.moveXY(0.62, svgTop(195)); },
        function () { d.cursor.classList.add('drag'); return d.wait(300); },
        function () {
          order.style.transform = 'translateY(180px)'; ot.textContent = '買 1 張 2,530'; oax.textContent = '2,530';
          return d.moveXY(0.62, svgTop(180), 650);
        },
        function () { d.cursor.classList.remove('drag'); d.toast('改價・2,530'); return d.wait(1200); },
        function () { d.cap(4); return d.move(stopBtn); },
        function () { return d.click(); },
        function () { stopBtn.classList.add('on'); return d.moveXY(0.42, svgTop(240)); },
        function () { return d.click(); },
        function () { d.gate(4); stopBtn.classList.remove('on'); d.toast('停損・2,510・1 張'); return d.moveXY(0.86, 0.94, 900); },
        function () { return d.wait(900); }
      ]);
    }, { cursor: true }],

    acct: [function (d) {
      var win = d.$('#wa-win'), pl = d.$('#wa-pl'), p1 = d.$('#wa-p1'), dlg = d.$('#wa-set');
      win.classList.remove('priv'); win.classList.remove('privacc');
      var rows = d.el.querySelectorAll('.wl-row');
      function flash(i) { var r = rows[i]; r.classList.remove('tick'); void r.offsetWidth; r.classList.add('tick'); }
      d.step(1);
      var p = Promise.resolve();
      [2, 0, 5, 3, 1, 4].forEach(function (i) { p = p.then(function () { flash(i); return d.wait(420); }); });
      return p.then(function () {
        return seq(d, [
          function () { d.step(2); flash(0); p1.textContent = '+10,000'; pl.textContent = '+9,970'; return d.wait(700); },
          function () { flash(0); p1.textContent = '+0'; pl.textContent = '−30'; return d.wait(700); },
          function () { flash(0); p1.textContent = '+5,000'; pl.textContent = '+4,970'; return d.wait(900); },
          function () { d.step(3); dlg.classList.add('show'); return d.wait(700); },
          function () { return d.move('#sw-acc'); },
          function () { return d.click(); },
          function () { win.classList.add('privacc'); return d.wait(600); },
          function () { return d.move('#sw-money'); },
          function () { return d.click(); },
          function () { win.classList.add('priv'); return d.wait(1000); },
          function () { dlg.classList.remove('show'); return d.moveXY(0.86, 0.94, 800); },
          function () { return d.wait(800); }
        ]);
      });
    }, { cursor: true }],

    ws: [function (d) {
      var ca = d.$('#pn-ca'), dk = d.$('#pn-dk'), fl = d.$('#pn-fl'), dlg = d.$('#ws-dlg'), lib = d.$('#ws-libdlg');
      var q = d.$('#ws-q'), name = d.$('#ws-name'), saved = d.$('#ws-saved'), pick = d.$('#ws-pick');
      ca.style.setProperty('--w', 78); dk.style.setProperty('--w', 78);
      q.textContent = ''; name.textContent = '';
      d.cap(1);
      return seq(d, [
        function () { return d.move('#ws-add'); },
        function () { return d.click(); },
        function () { dlg.classList.add('show'); return d.wait(400); },
        function () { return d.type(q, '閃電', 6); },
        function () { pick.classList.add('hl'); return d.move(pick); },
        function () { return d.click(); },
        function () {
          dlg.classList.remove('show'); d.step(2);
          ca.style.setProperty('--w', 50); dk.style.setProperty('--w', 50);
          return d.wait(1100);
        },
        function () { return d.move(ca, 0.985, 0.5); },
        function () { ca.classList.add('resizing'); d.cursor.classList.add('drag'); return d.wait(250); },
        function () {
          ca.style.setProperty('--w', 54); dk.style.setProperty('--w', 54); fl.style.setProperty('--x', 76); fl.style.setProperty('--w', 24);
          var a = d.$('#ws-area').getBoundingClientRect(), r = d.stage.getBoundingClientRect();
          return d.moveXY((a.left - r.left + a.width * 0.755) / r.width, 0.5, 650);
        },
        function () { ca.classList.remove('resizing'); d.cursor.classList.remove('drag'); return d.wait(600); },
        function () { d.step(3); return d.move('#ws-lib'); },
        function () { return d.click(); },
        function () { lib.classList.add('show'); return d.wait(500); },
        function () { return d.type(name, '盤中', 6); },
        function () { return d.move('#ws-save'); },
        function () { return d.click(); },
        function () { saved.classList.add('show'); return d.wait(1500); },
        function () { lib.classList.remove('show'); return d.moveXY(0.86, 0.94, 800); }
      ]);
    }, { cursor: true }],

    agent: [function (d) {
      var q = d.$('#ag-q1'), text = q.textContent;
      q.textContent = '';
      d.step(1);
      return seq(d, [
        function () { return d.wait(250); },
        function () { return d.type(q, text, 28); },
        function () { return d.wait(500); },
        function () { d.step(2); return d.wait(3000); },
        function () { d.step(3); return d.wait(3200); },
        function () { d.cap(4); return d.wait(1600); }
      ]);
    }, {}],

    build: [function (d) {
      var q = d.$('#bd-q'), text = q.textContent;
      q.textContent = '';
      d.step(1);
      return seq(d, [
        function () { return d.wait(200); },
        function () { return d.type(q, text, 26); },
        function () { return d.wait(400); },
        function () { d.step(2); return d.wait(2200); },
        function () { d.step(3); return d.wait(2800); }
      ]);
    }, {}],

    alloc: [function (d) {
      var q = d.$('#al-q'), text = q.textContent;
      q.textContent = '';
      d.step(1);
      return seq(d, [
        function () { return d.wait(200); },
        function () { return d.type(q, text, 26); },
        function () { return d.wait(400); },
        function () { d.step(2); return d.wait(1600); },
        function () { d.cap(2); d.gate(3); return d.wait(2600); },
        function () { d.step(4); d.cap(3); return d.wait(2600); },
        function () { d.gate(5); d.cap(4); return d.wait(1800); }
      ]);
    }, {}],

    brief: [function (d) {
      var form = d.$('#br-form'), log = d.$('#br-log'), t1 = d.$('#br-t1'), t2 = d.$('#br-t2');
      var name = d.$('#br-name'), ins = d.$('#br-ins'), n0 = name.textContent, i0 = ins.textContent;
      name.textContent = ''; ins.textContent = '';
      d.cap(1);
      return seq(d, [
        function () { return d.type(name, n0, 10); },
        function () { return d.type(ins, i0, 30); },
        function () { d.cap(2); return d.move('#br-time'); },
        function () { return d.click(); },
        function () { return d.wait(800); },
        function () { return d.move('#br-save'); },
        function () { return d.click(); },
        function () { return d.wait(600); },
        function () {
          d.cap(3); d.toast('盤前簡報：已完成，結論在「紀錄」');
          form.classList.add('hide'); log.classList.remove('hide'); t1.classList.remove('on'); t2.classList.add('on');
          return d.wait(3200);
        },
        function () { return d.moveXY(0.86, 0.94, 600); }
      ]);
    }, { cursor: true }],

    observe: [function (d) {
      var card = d.$('#ob-card'), row = d.$('#ob-row'), state = d.$('#ob-state'), tasks = d.$('#ob-tasks'), skills = d.$('#ob-skills');
      var t1 = d.$('#ob-t1'), t2 = d.$('#ob-t2');
      card.classList.remove('show');
      var orig = state.textContent;
      d.cap(1);
      return seq(d, [
        function () { return d.move('#ob-open'); },
        function () { return d.click(); },
        function () { card.classList.add('show'); d.cap(2); return d.wait(1600); },
        function () { return d.move('#ob-go'); },
        function () { return d.click(); },
        function () { card.classList.remove('show'); state.textContent = '已開啟。每天 13:50 執行，僅分析，不會下單。'; return d.wait(1500); },
        function () {
          d.cap(3); d.toast('學到新技能：早盤例行檢查');
          tasks.classList.add('hide'); skills.classList.remove('hide'); t1.classList.remove('on'); t2.classList.add('on');
          return d.wait(2600);
        },
        function () { state.textContent = orig; return d.moveXY(0.86, 0.94, 600); }
      ]);
    }, { cursor: true }],

    quant: [function (d) {
      var dlg = d.$('#bt-dlg'), run = d.$('#bt-run');
      d.cap(1);
      return seq(d, [
        function () { dlg.classList.add('show'); return d.wait(2000); },
        function () { return d.move('#bt-save'); },
        function () { return d.click(); },
        function () { dlg.classList.remove('show'); d.cap(2); return d.move(run); },
        function () { return d.click(); },
        function () { run.classList.add('busy'); run.textContent = '回測中…'; return d.wait(1300); },
        function () { run.classList.remove('busy'); run.textContent = '▷ 執行回測'; d.step(3); return d.wait(2600); },
        function () { d.step(4); return d.wait(2400); },
        function () { return d.moveXY(0.86, 0.94, 700); }
      ]);
    }, { cursor: true }],

    custom: [function (d) {
      var q = d.$('#cp-q'), text = q.textContent;
      q.textContent = '';
      d.step(1);
      return seq(d, [
        function () { return d.wait(200); },
        function () { return d.type(q, text, 24); },
        function () { return d.wait(500); },
        function () { d.step(2); return d.wait(1500); },
        function () { d.step(3); return d.wait(2600); }
      ]);
    }, {}]
  };

  // ---------- gallery tabs ----------
  Array.prototype.forEach.call(document.querySelectorAll('[data-gal]'), function (gal) {
    var tabs = gal.querySelectorAll('[role="tab"]'), panes = gal.querySelectorAll('.gal-pane');
    function select(i, focus) {
      Array.prototype.forEach.call(tabs, function (t, k) {
        t.setAttribute('aria-selected', String(k === i));
        t.tabIndex = k === i ? 0 : -1;
        panes[k].hidden = k !== i;
      });
      if (focus) tabs[i].focus();
    }
    Array.prototype.forEach.call(tabs, function (t, i) {
      t.addEventListener('click', function () { select(i); });
      t.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowRight') select((i + 1) % tabs.length, true);
        if (e.key === 'ArrowLeft') select((i - 1 + tabs.length) % tabs.length, true);
      });
    });
    select(0);
  });

  var demos = [];
  Array.prototype.forEach.call(document.querySelectorAll('.demo[data-demo]'), function (el) {
    var def = scenes[el.dataset.demo];
    if (!def) return;
    var d = new Demo(el, def[0], def[1]);
    demos.push(d);
    d.label();
  });

  function autoplayAllowed() { return !reduce.matches; }

  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        var d = demos.filter(function (x) { return x.el === e.target; })[0];
        if (!d) return;
        d.visible = e.isIntersecting;
        d.el.classList.toggle('offscreen', !d.visible);
        if (d.visible && !d.running && !d.userStopped && autoplayAllowed()) d.start();
      });
    }, { threshold: 0.35 });
    demos.forEach(function (d) { io.observe(d.el); });
  } else {
    demos.forEach(function (d) { d.visible = true; });
  }

  reduce.addEventListener('change', function () {
    if (reduce.matches) demos.forEach(function (d) { d.userStopped = true; d.stop(); });
  });
})();
