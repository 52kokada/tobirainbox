// public/ui.js — custom controls shared by the console (no native <select> popups anywhere).
import { html, useState, useEffect, useRef, useLayoutEffect } from '/vendor/htm-preact.js';
import { STAR_PATH } from '/logo.js';

/** The AI star: wherever the AI wrote, sorted, read or suggested something. live = working right now. */
export const Star = ({ live, title } = {}) => html`<svg class=${`star ${live ? 'live' : ''}`} viewBox="0 0 24 24" aria-hidden=${title ? undefined : 'true'} role=${title ? 'img' : undefined}>
  ${title ? html`<title>${title}</title>` : ''}
  <path d=${STAR_PATH} fill="url(#tbistar)"/></svg>`;

const Chev = html`<svg class="sel-chev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>`;
const Tick = html`<svg class="sel-tick" viewBox="0 0 24 24"><path d="M5 12l4 4 10-10"/></svg>`;

/**
 * Select: options [{value, label, hint?}]. Controlled with value+onChange, or uncontrolled with
 * defaultValue (+ name, so a surrounding <form> still sees it through a hidden input).
 */
export function Select({ value, defaultValue = '', onChange, options, name, disabled, className = '', label, placeholder }) {
  const [inner, setInner] = useState(defaultValue);
  const cur = value !== undefined ? value : inner;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [up, setUp] = useState(false);
  const root = useRef(null); const list = useRef(null); const btn = useRef(null);
  const sel = options.find((o) => String(o.value) === String(cur));

  const choose = (o) => {
    setOpen(false); btn.current?.focus();
    if (String(o.value) === String(cur)) return;
    if (value === undefined) setInner(o.value);
    onChange?.(o.value);
  };
  const show = () => {
    if (disabled) return;
    const r = btn.current.getBoundingClientRect();
    setUp(window.innerHeight - r.bottom < Math.min(320, options.length * 34 + 16) && r.top > window.innerHeight - r.bottom);
    setActive(Math.max(0, options.findIndex((o) => String(o.value) === String(cur))));
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return undefined;
    const off = (e) => { if (!root.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', off, true);
    return () => document.removeEventListener('pointerdown', off, true);
  }, [open]);
  useLayoutEffect(() => {
    if (open) list.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const onKey = (e) => {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); e.stopPropagation(); show(); }
      return;
    }
    e.stopPropagation();
    if (e.key === 'Escape' || e.key === 'Tab') { if (e.key === 'Escape') e.preventDefault(); setOpen(false); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(options.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(options.length - 1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (options[active]) choose(options[active]); }
    else if (e.key.length === 1) {
      const i = options.findIndex((o) => String(o.label).toLowerCase().startsWith(e.key.toLowerCase()));
      if (i >= 0) setActive(i);
    }
  };

  return html`<div class=${`sel ${open ? 'open' : ''} ${disabled ? 'dis' : ''} ${className}`} ref=${root} onKeyDown=${onKey}>
    ${name ? html`<input type="hidden" name=${name} value=${cur ?? ''} />` : ''}
    <button type="button" class="sel-btn" ref=${btn} disabled=${disabled} aria-haspopup="listbox" aria-expanded=${open} aria-label=${label}
      onClick=${() => (open ? setOpen(false) : show())}>
      <span class=${`sel-val ${sel ? '' : 'ph'}`}>${sel ? sel.label : (placeholder ?? '—')}</span>${Chev}</button>
    ${open ? html`<ul class=${`sel-menu ${up ? 'up' : ''}`} role="listbox" ref=${list} tabindex="-1">
      ${options.map((o, i) => html`<li key=${o.value} role="option" aria-selected=${String(o.value) === String(cur)}
        class=${`${i === active ? 'act' : ''} ${String(o.value) === String(cur) ? 'on' : ''}`}
        onPointerMove=${() => setActive(i)} onClick=${() => choose(o)}>
        <span class="sel-l">${o.label}${o.hint ? html`<small>${o.hint}</small>` : ''}</span>${String(o.value) === String(cur) ? Tick : ''}</li>`)}
    </ul>` : ''}
  </div>`;
}
