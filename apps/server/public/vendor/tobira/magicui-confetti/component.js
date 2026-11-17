// 紙吹雪（Confetti）。元の部品が使う canvas-confetti と同じ計算（初速・減衰・重力・揺れ・傾き・200コマで消える）を、依存なしで書き直したもの。
// <canvas class="tb-confetti"> … 読み込み時に1回飛ばす。data-manual で自動では飛ばさない。data-fire-on-hover で親にマウスが入るたびに飛ばす。
// <button data-tb-confetti> … 押すと、ボタンの中心から画面全体に飛ばす。どちらも data-options='{"spread":90}' のように設定を JSON で渡せる。
// JS から：TobiraConfetti.fire(canvas または null, 設定)
(function () {
  const DEFAULTS = {
    particleCount: 50, angle: 90, spread: 45, startVelocity: 45, decay: 0.9, gravity: 1, drift: 0,
    ticks: 200, origin: { x: 0.5, y: 0.5 }, shapes: ['square', 'circle'], scalar: 1, flat: false,
    colors: ['#26ccff', '#a25afd', '#ff5e7e', '#88ff5a', '#fcff42', '#ffa62d', '#ff36ff'],
  };
  const FRAME = Math.floor(1000 / 60);
  const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  function rgb(hex) {
    let h = String(hex).replace(/[^0-9a-f]/gi, '');
    if (h.length < 6) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function particle(o, x, y, color, shape) {
    const rad = o.angle * (Math.PI / 180), spread = o.spread * (Math.PI / 180);
    return {
      x, y, color, shape, flat: o.flat, scalar: o.scalar, decay: o.decay, drift: o.drift,
      wobble: Math.random() * 10,
      wobbleSpeed: Math.min(0.11, Math.random() * 0.1 + 0.05),
      velocity: o.startVelocity * 0.5 + Math.random() * o.startVelocity,
      angle2D: -rad + (0.5 * spread - Math.random() * spread),
      tiltAngle: (Math.random() * 0.5 + 0.25) * Math.PI,
      tick: 0, totalTicks: o.ticks, random: Math.random() + 2,
      tiltSin: 0, tiltCos: 0, wobbleX: 0, wobbleY: 0, gravity: o.gravity * 3, ovalScalar: 0.6,
    };
  }
  // 1コマ分動かして描く。寿命が残っていれば true。
  function step(ctx, f) {
    f.x += Math.cos(f.angle2D) * f.velocity + f.drift;
    f.y += Math.sin(f.angle2D) * f.velocity + f.gravity;
    f.velocity *= f.decay;
    if (f.flat) {
      f.wobble = 0; f.wobbleX = f.x + 10 * f.scalar; f.wobbleY = f.y + 10 * f.scalar;
      f.tiltSin = 0; f.tiltCos = 0; f.random = 1;
    } else {
      f.wobble += f.wobbleSpeed;
      f.wobbleX = f.x + 10 * f.scalar * Math.cos(f.wobble);
      f.wobbleY = f.y + 10 * f.scalar * Math.sin(f.wobble);
      f.tiltAngle += 0.1;
      f.tiltSin = Math.sin(f.tiltAngle); f.tiltCos = Math.cos(f.tiltAngle);
      f.random = Math.random() + 2;
    }
    const progress = f.tick++ / f.totalTicks;
    const x1 = f.x + f.random * f.tiltCos, y1 = f.y + f.random * f.tiltSin;
    const x2 = f.wobbleX + f.random * f.tiltCos, y2 = f.wobbleY + f.random * f.tiltSin;
    ctx.fillStyle = `rgba(${f.color[0]}, ${f.color[1]}, ${f.color[2]}, ${1 - progress})`;
    ctx.beginPath();
    if (f.shape === 'circle') {
      ctx.ellipse(f.x, f.y, Math.abs(x2 - x1) * f.ovalScalar, Math.abs(y2 - y1) * f.ovalScalar, (Math.PI / 10) * f.wobble, 0, 2 * Math.PI);
    } else {
      ctx.moveTo(Math.floor(f.x), Math.floor(f.y));
      ctx.lineTo(Math.floor(f.wobbleX), Math.floor(y1));
      ctx.lineTo(Math.floor(x2), Math.floor(y2));
      ctx.lineTo(Math.floor(x1), Math.floor(f.wobbleY));
    }
    ctx.closePath();
    ctx.fill();
    return f.tick < f.totalTicks;
  }

  const states = new WeakMap();
  let pageCanvas = null;
  function pageTarget() {
    if (!pageCanvas || !pageCanvas.isConnected) {
      pageCanvas = document.createElement('canvas');
      pageCanvas.className = 'tb-confetti tb-confetti--page';
      pageCanvas.setAttribute('aria-hidden', 'true');
      document.body.appendChild(pageCanvas);
    }
    return pageCanvas;
  }
  function fire(canvas, opts) {
    if (reduce()) return;
    canvas = canvas || pageTarget();
    const o = Object.assign({}, DEFAULTS, opts || {});
    o.origin = Object.assign({}, DEFAULTS.origin, (opts || {}).origin);
    let s = states.get(canvas);
    if (!s) { s = { list: [], raf: 0, last: 0 }; states.set(canvas, s); }
    // canvas-confetti と同じく、画素数は表示サイズそのまま。
    if (!s.list.length) { canvas.width = canvas.clientWidth; canvas.height = canvas.clientHeight; }
    const ctx = canvas.getContext('2d');
    const sx = canvas.width * o.origin.x, sy = canvas.height * o.origin.y;
    for (let n = o.particleCount; n > 0; n--) {
      s.list.push(particle(o, sx, sy, rgb(o.colors[n % o.colors.length]), o.shapes[Math.floor(Math.random() * o.shapes.length)]));
    }
    if (s.raf) return;
    // 1秒60コマに合わせて進める（速い画面でも同じ速さに見える）。
    const loop = (t) => {
      if (s.last && t - s.last < FRAME - 1) { s.raf = requestAnimationFrame(loop); return; }
      s.last = t;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      s.list = s.list.filter((f) => step(ctx, f));
      if (s.list.length) s.raf = requestAnimationFrame(loop);
      else { s.raf = 0; s.last = 0; ctx.clearRect(0, 0, canvas.width, canvas.height); }
    };
    s.raf = requestAnimationFrame(loop);
  }
  function parse(v) { try { return v ? JSON.parse(v) : {}; } catch (e) { return {}; } }

  function init(root) {
    (root || document).querySelectorAll('canvas.tb-confetti:not(.tb-confetti--page):not([data-tb-ready])').forEach((canvas) => {
      canvas.dataset.tbReady = '';
      canvas.setAttribute('aria-hidden', 'true');
      const opts = parse(canvas.dataset.options);
      if (!('manual' in canvas.dataset)) fire(canvas, opts);
      if ('fireOnHover' in canvas.dataset && canvas.parentElement) {
        canvas.parentElement.addEventListener('mouseenter', () => fire(canvas, opts));
      }
    });
    (root || document).querySelectorAll('[data-tb-confetti]:not([data-tb-ready])').forEach((btn) => {
      btn.dataset.tbReady = '';
      btn.addEventListener('click', () => {
        const r = btn.getBoundingClientRect();
        const opts = parse(btn.dataset.tbConfetti);
        opts.origin = { x: (r.left + r.width / 2) / innerWidth, y: (r.top + r.height / 2) / innerHeight };
        fire(null, opts);
      });
    });
  }
  window.TobiraConfetti = { init, fire };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => init());
  else init();
})();
