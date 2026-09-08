(() => {
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  function selectTab(selected) {
    tabs.forEach(tab => {
      const active = tab === selected;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      document.getElementById(tab.getAttribute('aria-controls')).hidden = !active;
      const panel = document.getElementById(tab.getAttribute('aria-controls'));
      panel.classList.toggle('entering', active);
    });
    requestScrollUpdate();
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', event => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      if (next === undefined) return;
      event.preventDefault();
      selectTab(tabs[next]);
      tabs[next].focus();
    });
  });
  document.querySelectorAll('[data-theme]').forEach(button => {
    button.addEventListener('click', () => {
      const source = button.dataset.theme === 'light' ? 'shot-terminal-light.png' : 'shot-terminal-dark.png';
      document.getElementById('terminal-image').src = source;
      document.getElementById('terminal-link').href = source;
      document.querySelectorAll('[data-theme]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    });
  });

  // Atmospheric market traces are decorative, not live market data.
  const canvas = document.getElementById('hero-bg');
  const ctx = canvas?.getContext('2d');
  if (ctx) {
    let width = 0, height = 0, frame = 0, visible = true, lastTime = 0;
    const series = Array.from({ length: 3 }, (_, layer) => Array.from({ length: 180 }, (_, i) =>
      .46 + layer * .11 + Math.sin(i * .048 + layer) * .10 + Math.sin(i * .173 + layer * 3) * .027 + Math.sin(i * .61) * .009));
    function size() {
      const dpr = Math.min(devicePixelRatio || 1, 2);
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      paint(0);
    }
    function paint(time) {
      ctx.clearRect(0, 0, width, height);
      ctx.lineWidth = .5;
      ctx.strokeStyle = 'rgba(137,163,198,.08)';
      for (let x = 0; x < width; x += 80) {
        ctx.beginPath(); ctx.moveTo(x, 140); ctx.lineTo(x, height); ctx.stroke();
      }
      for (let y = 140; y < height; y += 70) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
      }
      series.forEach((points, layer) => {
        const offset = motion.matches ? 0 : time * .000045;
        ctx.beginPath();
        points.forEach((point, i) => {
          const x = i / (points.length - 1) * width;
          const y = (point + Math.sin(i * .052 + offset + layer) * .055) * height;
          if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        });
        ctx.lineWidth = layer === 0 ? 1.4 : .8;
        ctx.strokeStyle = ['rgba(159,184,222,.30)', 'rgba(102,142,194,.22)', 'rgba(182,195,217,.12)'][layer];
        ctx.shadowColor = 'rgba(115,163,228,.35)';
        ctx.shadowBlur = layer === 0 ? 12 : 0;
        ctx.stroke();
        ctx.shadowBlur = 0;
      });
      // A slow, broad light pass provides depth without flashing.
      const sweep = motion.matches ? width * .6 : (time * .018) % (width * 1.8) - width * .4;
      const light = ctx.createRadialGradient(sweep, height * .5, 0, sweep, height * .5, width * .4);
      light.addColorStop(0, 'rgba(148,177,220,.055)');
      light.addColorStop(1, 'rgba(148,177,220,0)');
      ctx.fillStyle = light; ctx.fillRect(0, 0, width, height);
    }
    function animate(time) {
      frame = 0;
      if (motion.matches || document.hidden || !visible || document.documentElement.classList.contains('webgl-ready')) return;
      if (time - lastTime >= 32) { paint(time); lastTime = time; }
      frame = requestAnimationFrame(animate);
    }
    function sync() {
      cancelAnimationFrame(frame); frame = 0;
      if (!motion.matches && !document.hidden && visible && !document.documentElement.classList.contains('webgl-ready')) frame = requestAnimationFrame(animate);
      else if (motion.matches) paint(0);
    }
    size();
    window.addEventListener('resize', size, { passive: true });
    document.addEventListener('visibilitychange', sync);
    document.getElementById('hero-webgl')?.addEventListener('webglcontextlost', sync);
    motion.addEventListener('change', sync);
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(entries => { visible = entries[0].isIntersecting; sync(); }).observe(canvas);
    }
    sync();
  }
  // Scroll position drives reversible transitions, rather than one-shot entrances.
  // Only nearby elements are measured and no scroll event prevents native scrolling.
  const progress = document.createElement('div');
  progress.className = 'scroll-progress';
  progress.setAttribute('aria-hidden', 'true');
  document.body.append(progress);
  const hero = document.querySelector('.hero');
  const showroom = document.querySelector('.showroom-track');
  const stage = document.querySelector('.showroom-stage');
  const agentSection = document.querySelector('.agent-section');
  const targets = [...document.querySelectorAll('.section-intro>div, .section-intro>p, .feature-panel>figure, .feature-copy, .agent-copy, .agent-image, .research, .release-row, .download-grid article, .onboarding p, .execution-card, .research-gallery figure')];
  const nearby = new Set(targets);
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(entries => entries.forEach(entry => {
      if (entry.isIntersecting) nearby.add(entry.target);
      else nearby.delete(entry.target);
      requestScrollUpdate();
    }), { rootMargin: '200px' });
    targets.forEach(target => observer.observe(target));
  }
  let scrollFrame = 0;
  const clamp = value => Math.min(1, Math.max(0, value));
  function updateScroll() {
    scrollFrame = 0;
    const viewport = innerHeight;
    const small = innerWidth < 761;
    const root = document.documentElement;
    root.style.setProperty('--page-progress', String(clamp(scrollY / Math.max(1, root.scrollHeight - viewport))));
    document.body.classList.toggle('scroll-ready', !motion.matches);
    if (motion.matches) return;
    const heroProgress = clamp(scrollY / (small ? 500 : 700));
    hero.style.setProperty('--hero-opacity', String(1 - heroProgress * .85));
    hero.style.setProperty('--hero-shift', `${heroProgress * (small ? 12 : 42)}px`);
    hero.style.setProperty('--terminal-scale', String(.965 + clamp(scrollY / 300) * .035));
    hero.style.setProperty('--terminal-tilt', `${3 * (1 - clamp(scrollY / 300))}deg`);
    const scene = small ? 0 : clamp((85 - showroom.getBoundingClientRect().top) / Math.max(1, showroom.offsetHeight - stage.offsetHeight));
    const focus = 1 - Math.pow(1 - scene, 2);
    stage.style.setProperty('--scene-rx', `${10 * (1 - focus)}deg`);
    stage.style.setProperty('--scene-ry', `${-5 * (1 - focus)}deg`);
    stage.style.setProperty('--scene-rz', `${-1.5 * (1 - focus)}deg`);
    stage.style.setProperty('--scene-scale', String(.92 + focus * .08));
    stage.style.setProperty('--float-left', `${-focus * 140}px`);
    stage.style.setProperty('--float-right', `${focus * 140}px`);
    stage.style.setProperty('--float-up', `${-focus * 75}px`);
    stage.style.setProperty('--float-down', `${focus * 70}px`);
    stage.style.setProperty('--float-opacity', String(1 - clamp((scene - .15) / .65)));
    const focused = scene >= .9;
    if (stage.classList.contains('scene-focused') !== focused) {
      stage.classList.toggle('scene-focused', focused);
      stage.dispatchEvent(new Event('scenevisibilitychange'));
    }
    const agentTop = agentSection.getBoundingClientRect().top;
    const agentProgress = clamp((viewport - agentTop) / (viewport + agentSection.offsetHeight));
    agentSection.style.setProperty('--agent-parallax', `${(agentProgress - .5) * (small ? 0 : -38)}px`);
    agentSection.style.setProperty('--agent-light', `${(agentProgress - .5) * -180}px`);
    const measurements = [...nearby].filter(target => target.getClientRects().length).map(target => {
      let top = 0;
      for (let element = target; element; element = element.offsetParent) top += element.offsetTop;
      const siblings = target.parentElement.matches('.download-grid, .onboarding, .execution-gallery, .research-gallery') ? [...target.parentElement.children] : [];
      const stagger = small ? 0 : Math.max(0, siblings.indexOf(target)) * 28;
      return [target, top - scrollY + stagger];
    });
    measurements.forEach(([target, top]) => {
      const amount = clamp((viewport * .98 - top) / (viewport * .32));
      const eased = 1 - Math.pow(1 - amount, 3);
      target.style.setProperty('--reveal-opacity', String(.12 + eased * .88));
      target.style.setProperty('--reveal-shift', `${(1 - eased) * (small ? 20 : 48)}px`);
      if (target.classList.contains('execution-card')) target.style.setProperty('--execution-tilt', `${(1-eased)*12}deg`);
    });
  }
  function requestScrollUpdate() { if (!scrollFrame) scrollFrame = requestAnimationFrame(updateScroll); }
  addEventListener('scroll', requestScrollUpdate, { passive: true });
  addEventListener('resize', requestScrollUpdate, { passive: true });
  motion.addEventListener('change', requestScrollUpdate);
  updateScroll();
  const patterns = {
    'mac-arm': /aarch64\.dmg$/,
    'mac-intel': /x64\.dmg$/,
    'win-exe': /x64-setup\.exe$/i,
    'win-msi': /x64.*\.msi$/i,
    'linux-image': /amd64\.AppImage$/,
    'linux-deb': /amd64\.deb$/,
    'linux-rpm': /x86_64\.rpm$/,
  };
  fetch('https://api.github.com/repos/Sinotrade/shioaji-pro-app/releases/latest', { signal: AbortSignal.timeout(8000) })
    .then(response => { if (!response.ok) throw new Error('Release unavailable'); return response.json(); })
    .then(release => {
      if (!Array.isArray(release.assets) || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) throw new Error('Invalid release');
      document.querySelectorAll('[data-version]').forEach(el => { el.textContent = release.tag_name; });
      let resolved = 0;
      document.querySelectorAll('[data-asset]').forEach(link => {
        const asset = release.assets.find(item => patterns[link.dataset.asset]?.test(item.name));
        if (!asset || typeof asset.browser_download_url !== 'string') return;
        const url = new URL(asset.browser_download_url);
        if (url.origin !== 'https://github.com' || !url.pathname.startsWith('/Sinotrade/shioaji-pro-app/releases/download/')) return;
        link.href = url.href;
        resolved++;
      });
      document.getElementById('download-status').textContent = resolved === 7
        ? `下載 ${release.tag_name} 安裝檔 · 安裝後可透過 App 自動更新。`
        : `最新版本 ${release.tag_name}；尚未提供的安裝檔請至 GitHub 版本頁查看。`;
    })
    .catch(() => { document.getElementById('download-status').textContent = '暫時無法取得安裝檔清單；下載連結仍可開啟 GitHub 最新版本頁。'; });
})();
