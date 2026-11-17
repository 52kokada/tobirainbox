// ぼかしながら現れる（Blur Fade）。.tb-blur-fade を画面に入ったときに表示する。
// data-delay（秒）・data-duration（秒）・data-offset（px）・data-blur（px）・data-direction（up/down/left/right）・data-in-view（"false" で読み込み直後に表示）
(function () {
  function apply(el) {
    const d = el.dataset;
    if (d.delay) el.style.setProperty('--tb-bf-delay', d.delay + 's');
    if (d.duration) el.style.setProperty('--tb-bf-duration', d.duration + 's');
    if (d.offset) el.style.setProperty('--tb-bf-offset', d.offset + 'px');
    if (d.blur) el.style.setProperty('--tb-bf-blur', d.blur + 'px');
  }
  function show(el) { el.classList.add('is-visible'); }
  function init(root) {
    const items = (root || document).querySelectorAll('.tb-blur-fade:not([data-tb-ready])');
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const io = 'IntersectionObserver' in window
      ? new IntersectionObserver((entries) => {
          for (const e of entries) if (e.isIntersecting) { show(e.target); io.unobserve(e.target); }
        }, { rootMargin: '0px 0px -50px 0px' })
      : null;
    items.forEach((el) => {
      el.dataset.tbReady = '';
      apply(el);
      if (reduce || !io || el.dataset.inView === 'false') requestAnimationFrame(() => requestAnimationFrame(() => show(el)));
      else io.observe(el);
    });
  }
  window.TobiraBlurFade = { init };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => init());
  else init();
})();
