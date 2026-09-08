// Reversible, scroll-driven product chapters. Native scrolling stays in control.
(() => {
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const clamp = value => Math.max(0, Math.min(1, value));
  const definitions = [
    ['workspace', '.tabs, .feature-panel', '.feature-panel:not([hidden])>figure, .feature-panel:not([hidden])>.feature-copy'],
    ['execution', '.execution-gallery', '.execution-card'],
    ['strategy', '.research-gallery', '.research-gallery figure'],
    ['agent', '.agent-visual', '.agent-skills-image, .agent-image'],
  ];
  const chapters = definitions.map(([id, selector, itemSelector]) => {
    const section = document.getElementById(id);
    const nodes = [...section.querySelectorAll(selector)];
    const track = document.createElement('div');
    track.className = 'chapter-track';
    const stage = document.createElement('div');
    stage.className = 'chapter-stage';
    nodes[0].before(track); track.append(stage); nodes.forEach(node => stage.append(node));
    section.classList.add('product-chapter');
    return { id, section, track, stage, itemSelector, travel:0 };
  });
  let frame = 0;
  function schedule() { if (!frame) frame = requestAnimationFrame(render); }
  function layout() {
    chapters.forEach(chapter => {
      const height = chapter.stage.offsetHeight;
      const pinned = !motion.matches && innerWidth > 1000 && height < innerHeight - 160;
      chapter.travel = pinned ? Math.round(innerHeight * .6) : 0;
      chapter.track.classList.toggle('chapter-pinned', pinned);
      chapter.track.style.height = `${height + chapter.travel}px`;
    });
    schedule();
  }
  function layoutTop(element) {
    let top = 0;
    for (let node = element; node; node = node.offsetParent) top += node.offsetTop;
    return top;
  }
  function render() {
    frame = 0;
    document.body.classList.toggle('chapters-ready', !motion.matches);
    if (motion.matches) return;
    const mobile = innerWidth <= 760;
    chapters.forEach(chapter => {
      const rect = chapter.track.getBoundingClientRect();
      const progress = clamp((innerHeight * .95 - rect.top) / (innerHeight * .7 + chapter.travel * .65));
      chapter.section.style.setProperty('--chapter-progress', progress);
      chapter.section.style.setProperty('--chapter-glow-y', `${(1 - progress) * 220}px`);
      const items = [...chapter.stage.querySelectorAll(chapter.itemSelector)];
      items.forEach((item, index) => {
        const top = chapter.travel ? rect.top : layoutTop(item) - scrollY;
        const stagger = mobile ? 0 : index * .12;
        const amount = clamp((innerHeight * .96 - top) / (innerHeight * .62 + chapter.travel * .55) - stagger);
        // Smoothstep gives the scene a deliberate arrival and a clean resting state.
        const eased = amount * amount * (3 - 2 * amount);
        const remaining = 1 - eased;
        item.style.setProperty('--chapter-opacity', String(.18 + eased * .82));
        item.style.setProperty('--chapter-y', `${remaining * (mobile ? 32 : 110)}px`);
        item.style.setProperty('--chapter-x', `${remaining * (mobile ? 12 : 90) * (index % 2 ? 1 : -1)}px`);
        item.style.setProperty('--chapter-angle', `${remaining * (mobile ? 4 : 22) * (index % 2 ? -1 : 1)}deg`);
        item.style.setProperty('--chapter-bank', `${remaining * (mobile ? 0 : (index - 1) * 5)}deg`);
        item.style.setProperty('--chapter-scale', String(.86 + eased * .14));
        item.style.setProperty('--chapter-inset', `${remaining * 14}%`);
      });
    });
  }
  const observer = new ResizeObserver(layout);
  chapters.forEach(({ stage }) => observer.observe(stage));
  document.addEventListener('click', event => { if (event.target.closest('[role="tab"]')) schedule(); });
  document.addEventListener('keydown', event => { if (event.target.closest('[role="tab"]')) schedule(); });
  addEventListener('scroll', schedule, { passive:true });
  addEventListener('resize', layout, { passive:true });
  motion.addEventListener('change', layout);
  document.fonts.ready.then(layout);
  layout();
})();
