// すべる数字（Sliding Number）。data-value を書き換えると、変わった桁だけがばねで回る。
// data-value（数値）・data-pad（"true" で10未満を 05 のように2桁に）・data-separator（小数点の記号、既定 "."）
// JS からは TobiraSlidingNumber.set(要素, 数値) でも変えられる。
(function () {
  // 元の部品と同じばね（stiffness 280 / damping 18 / mass 0.3）。
  const K = 280, C = 18, M = 0.3;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');

  function makeDigit(value) {
    const el = document.createElement('span');
    el.className = 'tb-sliding-number__digit';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = '<span class="tb-sliding-number__ghost">0</span>';
    const nums = [];
    for (let i = 0; i < 10; i++) {
      const n = document.createElement('span');
      n.className = 'tb-sliding-number__n';
      n.textContent = i;
      el.appendChild(n);
      nums.push(n);
    }
    const d = { el, nums, x: value, v: 0, target: value, last: 0, running: false };
    draw(d);
    return d;
  }
  // 数字 i を、今の値との差の分だけ縦にずらす。5より遠いものは反対側へ回す。
  function draw(d) {
    const place = ((d.x % 10) + 10) % 10;
    d.nums.forEach((n, i) => {
      let off = (10 + i - place) % 10;
      if (off > 5) off -= 10;
      n.style.transform = `translateY(${off * 100}%)`;
    });
  }
  function step(d, t) {
    const dt = d.last ? Math.min((t - d.last) / 1000, 1 / 30) : 1 / 60;
    d.last = t;
    d.v += ((-K * (d.x - d.target) - C * d.v) / M) * dt;
    d.x += d.v * dt;
    if (Math.abs(d.x - d.target) < 0.001 && Math.abs(d.v) < 0.01) {
      d.x = d.target; d.v = 0; d.running = false; d.last = 0; draw(d); return;
    }
    draw(d);
    requestAnimationFrame((tt) => step(d, tt));
  }
  function setDigit(d, value) {
    d.target = value;
    if (reduce.matches) { d.x = value; d.v = 0; draw(d); return; }
    if (!d.running) { d.running = true; requestAnimationFrame((t) => step(d, t)); }
  }

  function render(root) {
    const value = parseFloat(root.dataset.value || '0');
    const sep = root.dataset.separator || '.';
    const abs = Math.abs(value);
    const [intStr, decStr] = abs.toString().split('.');
    const intVal = parseInt(intStr, 10);
    const padded = root.dataset.pad === 'true' && intVal < 10 ? '0' + intStr : intStr;
    const state = root._tbSn || (root._tbSn = { digits: new Map() });
    const keys = [];
    const plan = [];
    padded.split('').forEach((_, i) => {
      const place = Math.pow(10, padded.length - i - 1);
      plan.push({ key: 'i' + place, value: Math.floor(intVal / place) % 10 });
    });
    if (decStr) {
      const decVal = parseInt(decStr, 10);
      plan.push({ key: 'sep' });
      decStr.split('').forEach((_, i) => {
        const place = Math.pow(10, decStr.length - i - 1);
        plan.push({ key: 'd' + i, value: Math.floor(decVal / place) % 10 });
      });
    }
    const frag = document.createDocumentFragment();
    if (value < 0) { const m = document.createElement('span'); m.textContent = '-'; m.setAttribute('aria-hidden', 'true'); frag.appendChild(m); }
    for (const p of plan) {
      if (p.key === 'sep') { const s = document.createElement('span'); s.textContent = sep; s.setAttribute('aria-hidden', 'true'); frag.appendChild(s); continue; }
      keys.push(p.key);
      let d = state.digits.get(p.key);
      if (!d) { d = makeDigit(p.value); state.digits.set(p.key, d); }
      else setDigit(d, p.value);
      frag.appendChild(d.el);
    }
    for (const k of [...state.digits.keys()]) if (!keys.includes(k)) state.digits.delete(k);
    const sr = document.createElement('span');
    sr.className = 'tb-sliding-number__sr';
    sr.textContent = (value < 0 ? '-' : '') + padded + (decStr ? sep + decStr : '');
    frag.appendChild(sr);
    root.replaceChildren(frag);
  }
  function set(el, value) { el.dataset.value = String(value); }
  function init(root) {
    (root || document).querySelectorAll('.tb-sliding-number:not([data-tb-ready])').forEach((el) => {
      el.dataset.tbReady = '';
      render(el);
      new MutationObserver(() => render(el)).observe(el, { attributes: true, attributeFilter: ['data-value'] });
    });
  }
  window.TobiraSlidingNumber = { init, set };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => init());
  else init();
})();
