// Switch to true only after approval to replace the public homepage.
const LANDING_NEXT_ENABLED = false;

(() => {
  const url = new URL(window.location.href);
  const override = url.searchParams.get('landing');
  const showNext = override === 'new' || (override !== 'original' && LANDING_NEXT_ENABLED);
  if (!showNext) return;
  const next = new URL('landing-next.html', url);
  next.search = url.search;
  next.hash = url.hash;
  window.location.replace(next.href);
})();
