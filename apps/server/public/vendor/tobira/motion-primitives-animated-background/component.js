// 選んだ項目へ滑る背景（Animated Background）。.tb-animated-background の中の [data-id] が項目。
// data-default-value（最初に選ぶ項目の id）・data-hover（付けるとマウスを乗せた項目を追う。外すと押した項目）。
// 選び直すたびに "tb-animated-background-change"（detail.id）を出す。
(function () {
  function init(root) {
    (root || document).querySelectorAll('.tb-animated-background:not([data-tb-ready])').forEach((box) => {
      box.dataset.tbReady = '';
      const hover = box.hasAttribute('data-hover');
      const bg = document.createElement('div');
      bg.className = 'tb-animated-background__bg';
      bg.setAttribute('aria-hidden', 'true');
      if (box.dataset.bgClass) bg.className += ' ' + box.dataset.bgClass;
      box.prepend(bg);
      const items = Array.from(box.querySelectorAll('[data-id]'));
      let active = null;

      function place(el) {
        const b = box.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        bg.style.transform = `translate(${r.left - b.left}px, ${r.top - b.top}px)`;
        bg.style.width = r.width + 'px';
        bg.style.height = r.height + 'px';
      }
      function set(id, initial) {
        const el = id == null ? null : items.find((n) => n.dataset.id === id);
        items.forEach((n) => n.setAttribute('data-checked', String(n === el)));
        if (el) {
          // 何も選ばれていない状態からは、その場に置いてから現れる。選び直しは位置と大きさを滑らせる。
          bg.classList.toggle('is-jump', !bg.classList.contains('is-active'));
          if (initial) bg.style.transition = 'none';
          place(el);
          bg.getBoundingClientRect();
          bg.classList.add('is-active');
          if (initial) { bg.getBoundingClientRect(); bg.style.transition = ''; }
        } else {
          bg.classList.remove('is-active');
        }
        if (active !== id && !initial) box.dispatchEvent(new CustomEvent('tb-animated-background-change', { detail: { id } }));
        active = id;
      }
      items.forEach((el) => {
        if (hover) {
          el.addEventListener('mouseenter', () => set(el.dataset.id));
          el.addEventListener('mouseleave', () => set(null));
          el.addEventListener('focusin', () => set(el.dataset.id));
          el.addEventListener('focusout', () => set(null));
        } else {
          el.addEventListener('click', () => set(el.dataset.id));
        }
      });
      if (box.dataset.defaultValue) set(box.dataset.defaultValue, true);
      // 幅が変わったら、選んでいる項目に合わせて置き直す
      if ('ResizeObserver' in window) new ResizeObserver(() => {
        const el = items.find((n) => n.dataset.id === active);
        if (el) { bg.classList.add('is-jump'); place(el); }
      }).observe(box);
    });
  }
  window.TobiraAnimatedBackground = { init };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => init());
  else init();
})();
