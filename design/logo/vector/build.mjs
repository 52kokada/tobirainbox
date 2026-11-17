import opentype from 'opentype.js';
import fs from 'node:fs';
const F = (f) => opentype.loadSync(`fonts/${f}`);
const sans = F('IS-600.ttf'), sansB = F('IS-700.ttf'), serif = F('InstrumentSerif-Italic.ttf');
const SIZE = 200, BASE = 230;
// runs: [{text, font, fill, size?, dy?, track?, door?}]
function word(runs, { gap = 0 } = {}) {
  let x = 40, out = [], defs = [], extra = [];
  for (const r of runs) {
    const size = r.size ?? SIZE; const font = r.font;
    if (r.pre) x += r.pre;
    const glyphs = font.stringToGlyphs(r.text);
    glyphs.forEach((g, i) => {
      if (r.door && r.text[i] === 'o') {
        const p = g.getPath(x, BASE, size); const bb = p.getBoundingBox();
        const cx = (bb.x1 + bb.x2) / 2, cy = (bb.y1 + bb.y2) / 2, rr = (bb.x2 - bb.x1) / 2;
        const k = rr / 38; // door from the Tobira mark, scaled from its 100-unit box (circle r=38 at 50,50)
        const tx = (v) => (cx + (v - 50) * k).toFixed(2), ty = (v) => (cy + (v - 50) * k).toFixed(2);
        defs.push(`<mask id="door"><rect width="100%" height="100%" fill="#fff"/><path d="M${tx(49.2)} ${ty(100)}V${ty(27)}L${tx(70.8)} ${ty(17.6)}V${ty(0)}H${tx(74.1)}V${ty(100)}Z" fill="#000"/></mask>`);
        out.push(`<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${rr.toFixed(2)}" fill="${r.fill}" mask="url(#door)"/>`);
      } else {
        const gp = g.getPath(x, BASE + (r.dy ?? 0), size); (r.boxes ??= []).push(gp.getBoundingBox());
        out.push(`<path d="${gp.toPathData(2)}" fill="${r.fill}"/>`);
      }
      const next = glyphs[i + 1];
      x += g.advanceWidth * size / font.unitsPerEm + (next ? font.getKerningValue(g, next) * size / font.unitsPerEm : 0) + (r.track ?? 0);
    });
    if (r.after) x += r.after;
    if (r.mark) extra.push(r.mark(r.boxes));
    r.boxes = undefined;
  }
  return { body: out.join(''), defs: defs.join(''), extra: extra.join(''), width: x + 40 };
}
const GRAD = `<linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="#3b5bfd"/><stop offset="1" stop-color="#9b5cf6"/></linearGradient>`;
const INK = '#111113';
function svg({ body, defs, extra, width }, ink) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${Math.ceil(width)} 300" width="${Math.ceil(width)}" height="300"><defs>${globalThis.GRAD_V4 ?? GRAD}${defs}</defs>${(body + extra).replaceAll(INK, ink)}</svg>`;
}
const T = { text: 'Tobir', font: sans, fill: INK, door: true };
const N = { text: 'nbox', font: sans, fill: INK };
const variants = {
  '1-gradient': [T, { text: 'AI', font: sans, fill: 'url(#g)' }, N],
  '2-serif': [T, { text: 'AI', font: serif, fill: '#3b5bfd', size: 232, pre: 4, after: 6 }, N],
  '3-chip': [T, { text: 'AI', font: sansB, fill: '#fff', size: 150, dy: -14, pre: 40, after: 44, track: 4 }, N],
  '4-sparkle': [T, { text: 'AI', font: sansB, fill: 'url(#g)', mark: (boxes) => {
    const A = boxes[0], I = boxes[1];
    globalThis.GRAD_V4 = `<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="${A.x1}" y1="${A.y1 - 80}" x2="${I.x2}" y2="${A.y2}"><stop offset="0" stop-color="#3b5bfd"/><stop offset="1" stop-color="#9b5cf6"/></linearGradient>`;
    // the lowercase i in "Tobir": gap between its dot and its stem sets the gap above the I
    const ig = sans.charToGlyph('i').getPath(0, BASE, SIZE).commands; const ys = [];
    let cur = []; for (const c of ig) { if (c.type === 'M' && cur.length) { ys.push(cur); cur = []; } if (c.y !== undefined) cur.push(c.y); } ys.push(cur);
    const parts = ys.map((a) => [Math.min(...a), Math.max(...a)]).sort((a, b) => a[0] - b[0]);
    const gap = parts.length > 1 ? parts[1][0] - parts[0][1] : 24;
    const s = 30; const cx = (I.x1 + I.x2) / 2; const cy = I.y1 - gap - s;
    const w = s * 0.2;
    return `<path d="M${cx} ${cy - s}C${cx + w} ${cy - w} ${cx + w} ${cy - w} ${cx + s} ${cy}C${cx + w} ${cy + w} ${cx + w} ${cy + w} ${cx} ${cy + s}C${cx - w} ${cy + w} ${cx - w} ${cy + w} ${cx - s} ${cy}C${cx - w} ${cy - w} ${cx - w} ${cy - w} ${cx} ${cy - s}Z" fill="url(#g)"/><!-- I stem centre ${cx.toFixed(2)} -->`; } }, N],
};
fs.mkdirSync('out', { recursive: true });
for (const [k, runs] of Object.entries(variants)) {
  const w = word(runs);
  if (k === '3-chip') {
    // pill behind the AI letters: find the AI run's x-range by re-measuring
    const pre = word([T]).width - 40; const ai = word([T, runs[1]]).width - 40;
    w.body = `<rect x="${pre + 12}" y="${BASE - 168}" width="${ai - pre - 30}" height="${170}" rx="44" fill="url(#g)"/>` + w.body;
  }
  fs.writeFileSync(`out/${k}.svg`, svg(w, INK));
  fs.writeFileSync(`out/${k}-dark.svg`, svg(w, '#f2f2f4'));
  globalThis.GRAD_V4 = undefined;
}
console.log(fs.readdirSync('out').join(' '));
