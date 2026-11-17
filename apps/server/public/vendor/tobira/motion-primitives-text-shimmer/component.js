// 光が走る文字（Text Shimmer）。光の帯の幅を、元の部品と同じく「文字数 × data-spread（既定2）」px にする。
// data-duration（1回流れる秒数、既定2）
(function () {
  function init(root) {
    (root || document).querySelectorAll('.tb-text-shimmer:not([data-tb-ready])').forEach((el) => {
      el.dataset.tbReady = '';
      const spread = parseFloat(el.dataset.spread || '2');
      el.style.setProperty('--tb-shimmer-spread', Array.from(el.textContent.trim()).length * spread + 'px');
      if (el.dataset.duration) el.style.setProperty('--tb-shimmer-duration', el.dataset.duration + 's');
    });
  }
  window.TobiraTextShimmer = { init };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => init());
  else init();
})();
