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
    var img = document.getElementById('hero-shot');
    if (!img) return;
    var source = img.parentElement.querySelector('source');
    if (!source) return;
    if (!root.dataset.theme) source.media = '(prefers-color-scheme: dark)';
    else source.media = root.dataset.theme === 'dark' ? 'all' : 'not all';
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
        document.getElementById('cta-label').textContent = label;
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
    this.cap(0);
    this.cursor = null;
    if (this.opts.cursor) {
      var stage = this.wins[0].querySelector('.stage');
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
    this.cap(0);
    this.label();
  };

  function rowOf(d, price) { return d.$('.fl-row[data-p="' + price + '"]'); }

  var scenes = {
    setup: [function (d) {
      d.cap(1); d.gate(1);
      return d.wait(2100)
        .then(function () { d.cap(2); d.gate(2); return d.wait(2300); })
        .then(function () { d.gate(3); return d.wait(1100); })
        .then(function () { d.cap(3); d.gate(4); return d.wait(2000); });
    }, {}],

    flash: [function (d) {
      var arm = d.$('#fl-arm'), hl = d.$('.fl-hl'), buy = d.$('#fl-buy'), sell = d.$('#fl-sell');
      arm.classList.remove('armed');
      hl.style.setProperty('--row', 5);
      buy.classList.add('gone'); buy.classList.remove('filled');
      function row(n) { hl.style.setProperty('--row', n); }
      d.cap(1);
      return d.move(arm, 0.5, 0.5)
        .then(function () { return d.click(); })
        .then(function () { arm.classList.add('armed'); d.gate(1); return d.wait(900); })
        .then(function () { d.step(2); row(4); return d.wait(650); })
        .then(function () { row(5); return d.wait(650); })
        .then(function () { row(4); return d.wait(650); })
        .then(function () { row(5); return d.wait(500); })
        .then(function () { d.step(3); return d.move(rowOf(d, 2545).querySelector('.bc'), 0.55, 0.5); })
        .then(function () { return d.click(); })
        .then(function () { buy.classList.remove('gone'); d.toast('委託・買 2,545・1 張'); return d.wait(1300); })
        .then(function () { d.step(4); row(6); return d.wait(350); })
        .then(function () { buy.classList.add('filled'); d.toast('成交・買 2,545・1 張', 'fill'); return d.wait(700); })
        .then(function () { buy.classList.add('gone'); return d.wait(1100); })
        .then(function () { d.step(5); row(5); return d.move(rowOf(d, 2560).querySelector('.sc'), 0.45, 0.5); })
        .then(function () { return d.click(); })
        .then(function () { sell.classList.remove('gone'); d.toast('委託・賣 2,560・1 張'); return d.wait(1200); })
        .then(function () { return d.click(); })
        .then(function () { sell.classList.add('gone'); d.toast('已刪單・賣 2,560'); return d.wait(700); })
        .then(function () { row(6); return d.moveXY(0.86, 0.92, 900); });
    }, { cursor: true }],

    odd: [function (d) {
      var win = d.$('#tk-win'), segs = d.$('#tk-unit').children, q = d.$('#tk-q'), u = d.$('#tk-u'), s = d.$('#tk-s');
      win.classList.remove('odd');
      segs[1].classList.remove('on'); segs[0].classList.add('on');
      q.textContent = '1'; u.textContent = '張'; s.textContent = '1 張';
      d.cap(1);
      return d.move(segs[1])
        .then(function () { return d.click(); })
        .then(function () {
          segs[0].classList.remove('on'); segs[1].classList.add('on');
          win.classList.add('odd'); u.textContent = '股'; s.textContent = '1 股';
          d.gate(1);
          var box = d.$('#tk-qty'); box.classList.remove('flash'); void box.offsetWidth; box.classList.add('flash');
          return d.wait(1300);
        })
        .then(function () { d.step(2); return d.move(q, 0.7, 0.5); })
        .then(function () { return d.click(); })
        .then(function () { q.textContent = ''; return d.wait(250); })
        .then(function () { q.textContent = '3'; return d.wait(240); })
        .then(function () { q.textContent = '35'; s.textContent = '35 股'; return d.wait(1100); })
        .then(function () { d.step(3); return d.move('.book', 0.5, 0.45); })
        .then(function () { return d.wait(1100); })
        .then(function () { return d.move('#tk-send', 0.5, 0.5); })
        .then(function () { return d.wait(1300); });
    }, { cursor: true }],

    chart: [function (d) {
      var xh = d.$('#ch-xh'), order = d.$('#ch-order'), pop = d.$('#ch-pop'), ot = d.$('#ch-otext'), oax = d.$('#ch-oax');
      order.style.transform = 'translateY(195px)';
      var mode = d.$('#ch-mode');
      ot.textContent = '買 1 張 2,525'; oax.textContent = '2,525';
      mode.classList.remove('on');
      d.gate(1);
      return d.wait(1500)
        .then(function () { d.cap(1); return d.move(mode); })
        .then(function () { return d.click(); })
        .then(function () { mode.classList.add('on'); return d.wait(600); })
        .then(function () { d.cap(2); return d.moveXY(0.42, 195 / 330); })
        .then(function () { xh.classList.add('show'); return d.wait(500); })
        .then(function () { return d.click(); })
        .then(function () { pop.classList.add('show'); return d.wait(700); })
        .then(function () { return d.move(pop.querySelector('.go')); })
        .then(function () { return d.click(); })
        .then(function () { pop.classList.remove('show'); xh.classList.remove('show'); d.gate(2); d.toast('委託・買 2,525・1 張'); return d.wait(1300); })
        .then(function () { d.cap(3); return d.moveXY(0.62, 195 / 330); })
        .then(function () { d.cursor.classList.add('drag'); return d.wait(300); })
        .then(function () {
          order.style.transform = 'translateY(180px)';
          ot.textContent = '買 1 張 2,530'; oax.textContent = '2,530';
          return d.moveXY(0.62, 180 / 330, 650);
        })
        .then(function () { d.cursor.classList.remove('drag'); d.toast('改價・2,530'); return d.wait(1300); })
        .then(function () { d.cap(4); mode.classList.remove('on'); return d.move('#ch-stopbtn'); })
        .then(function () { return d.click(); })
        .then(function () { d.$('#ch-stopbtn').classList.add('on'); return d.moveXY(0.42, 240 / 330); })
        .then(function () { return d.click(); })
        .then(function () { d.gate(4); d.$('#ch-stopbtn').classList.remove('on'); d.toast('停損・2,510・1 張'); return d.moveXY(0.86, 0.92, 900); })
        .then(function () { return d.wait(900); });
    }, { cursor: true }],

    acct: [function (d) {
      var win = d.$('#wa-win'), pl = d.$('#wa-pl'), p1 = d.$('#wa-p1');
      win.classList.remove('priv'); win.classList.remove('privacc');
      var rows = d.el.querySelectorAll('.wl-row');
      function flash(i) { var r = rows[i]; r.classList.remove('tick'); void r.offsetWidth; r.classList.add('tick'); }
      var seq = [2, 0, 5, 3, 1, 4];
      d.step(1);
      var p = Promise.resolve();
      seq.forEach(function (i) { p = p.then(function () { flash(i); return d.wait(430); }); });
      return p
        .then(function () { d.step(2); return d.wait(300); })
        .then(function () { flash(0); pl.textContent = '+1,970'; p1.textContent = '+2,000'; return d.wait(700); })
        .then(function () { flash(0); pl.textContent = '+970'; p1.textContent = '+1,000'; return d.wait(700); })
        .then(function () { flash(0); pl.textContent = '+1,470'; p1.textContent = '+1,500'; return d.wait(800); })
        .then(function () { d.step(3); return d.move('#wa-eye'); })
        .then(function () { return d.click(); })
        .then(function () { win.classList.add('privacc'); return d.wait(700); })
        .then(function () { return d.move('#wa-money'); })
        .then(function () { return d.click(); })
        .then(function () { win.classList.add('priv'); return d.wait(1600); })
        .then(function () { return d.moveXY(0.86, 0.92, 800); });
    }, { cursor: true }],

    ws: [function (d) {
      var ca = d.$('#pn-ca'), fl = d.$('#pn-fl'), menu = d.$('#ws-menu'), save = d.$('#ws-save'), name = d.$('#ws-name');
      ca.style.setProperty('--h', 100); ca.style.setProperty('--w', 56);
      fl.style.setProperty('--x', 78); fl.style.setProperty('--w', 22);
      name.textContent = '未命名';
      var items = menu.children;
      d.cap(1);
      return d.move('#ws-add')
        .then(function () { return d.click(); })
        .then(function () { menu.classList.add('show'); return d.wait(350); })
        .then(function () { items[0].classList.add('hl'); return d.wait(320); })
        .then(function () { items[1].classList.add('hl'); return d.wait(320); })
        .then(function () { items[2].classList.add('hl'); return d.wait(500); })
        .then(function () { menu.classList.remove('show'); d.step(2); return d.moveXY(0.5, 0.6, 1300); })
        .then(function () { d.step(3); return d.move(ca, 0.985, 0.6); })
        .then(function () { ca.classList.add('resizing'); d.cursor.classList.add('drag'); return d.wait(300); })
        .then(function () {
          ca.style.setProperty('--w', 50); fl.style.setProperty('--x', 72); fl.style.setProperty('--w', 28);
          var a = d.$('#ws-area').getBoundingClientRect(), r = d.stage.getBoundingClientRect();
          return d.moveXY((a.left - r.left + a.width * 0.715) / r.width, 0.6, 650);
        })
        .then(function () { ca.classList.remove('resizing'); d.cursor.classList.remove('drag'); return d.wait(700); })
        .then(function () { d.step(4); ca.style.setProperty('--h', 50); return d.wait(1500); })
        .then(function () { d.step(5); return d.move('#ws-name', 0.5, 0.5); })
        .then(function () { return d.click(); })
        .then(function () { save.classList.add('show'); return d.wait(900); })
        .then(function () { return d.move(save.querySelector('.ok')); })
        .then(function () { return d.click(); })
        .then(function () { save.classList.remove('show'); name.textContent = '盤中'; return d.wait(1200); })
        .then(function () { return d.moveXY(0.86, 0.92, 800); });
    }, { cursor: true }],

    agent: [function (d) {
      var q = d.$('#ag-q1'), text = q.textContent;
      q.textContent = '';
      d.step(1);
      return d.wait(250)
        .then(function () { return d.type(q, text, 26); })
        .then(function () { return d.wait(500); })
        .then(function () { d.step(2); return d.wait(2000); })
        .then(function () { d.step(3); return d.wait(2600); })
        .then(function () { d.step(4); return d.wait(900); })
        .then(function () { return d.move('.preview .go', 0.5, 0.6); })
        .then(function () { return d.wait(2000); });
    }, { cursor: true }],

    quant: [function (d) {
      d.step(1);
      return d.wait(2100)
        .then(function () { d.step(2); return d.wait(2200); })
        .then(function () { d.step(3); return d.wait(2500); })
        .then(function () { d.step(4); return d.wait(2000); });
    }, {}],

    custom: [function (d) {
      var q = d.$('#cp-q'), text = q.textContent;
      q.textContent = '';
      d.step(1);
      return d.wait(200)
        .then(function () { return d.type(q, text, 26); })
        .then(function () { return d.wait(500); })
        .then(function () { d.step(2); return d.wait(2000); })
        .then(function () { d.step(3); return d.wait(1800); })
        .then(function () { d.step(4); return d.wait(1800); });
    }, {}]
  };

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
