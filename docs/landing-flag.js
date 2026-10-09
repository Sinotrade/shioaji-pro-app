// Homepage is the v2 landing (#156). Older versions stay reachable by query:
//   ?landing=v1 (or original) -> landing-v1.html
//   ?landing=new              -> landing-next.html
(() => {
  const url = new URL(window.location.href);
  const override = url.searchParams.get('landing');
  const target = { v1: 'landing-v1.html', original: 'landing-v1.html', new: 'landing-next.html' }[override];
  if (!target) return;
  const dest = new URL(target, url);
  dest.search = url.search;
  dest.hash = url.hash;
  window.location.replace(dest.href);
})();
