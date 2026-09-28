import { esc } from './layout.js';

const nf = new Intl.NumberFormat('sk-SK');
export const num = (v) => nf.format(Math.round(Number(v) || 0));
export const pct = (v, digits = 0) => (v === null || v === undefined || Number.isNaN(v)
  ? '—'
  : `${(v * 100).toLocaleString('sk-SK', { minimumFractionDigits: digits, maximumFractionDigits: digits })} %`);
/** A share for "delivered": never rounds 99.96 % up to a perfect 100 %. */
export const pctFloor = (v) => (v === null || v === undefined ? '—'
  : `${(Math.floor(v * 1000) / 10).toLocaleString('sk-SK', { minimumFractionDigits: v < 1 ? 1 : 0, maximumFractionDigits: 1 })} %`);
export { plural } from '../lib/stats.js';
export const money = (v, currency = 'EUR') => {
  try {
    return Number(v).toLocaleString('sk-SK', { style: 'currency', currency: currency || 'EUR', maximumFractionDigits: 0 });
  } catch {
    return `${num(v)} ${esc(currency || '')}`;
  }
};
export const seconds = (s) => (s === null || s === undefined ? '—' : `${Number(s).toLocaleString('sk-SK', { maximumFractionDigits: 1 })} s`);
export const dateTime = (d) => (d ? new Date(d).toLocaleString('sk-SK', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'Europe/Bratislava' }) : '—');
/** A file size: "840 kB", "12,4 MB". */
export const bytes = (n) => {
  const v = Number(n) || 0;
  if (v < 1000) return `${v} B`;
  if (v < 1e6) return `${Math.round(v / 1000)} kB`;
  return `${(v / 1e6).toLocaleString('sk-SK', { maximumFractionDigits: v < 1e8 ? 1 : 0 })} MB`;
};
export const time = (d) => new Date(d).toLocaleTimeString('sk-SK', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Bratislava' });

export const LEVEL_TEXT = { ok: 'v poriadku', warn: 'varovanie', bad: 'chyba', off: 'vypnutý' };
export const LEVEL_COLOR = { ok: 'var(--ok)', warn: 'var(--warn)', bad: 'var(--bad)', off: 'var(--faint)' };
export const state = (level, text) => `<span class="state ${level}">${esc(text ?? LEVEL_TEXT[level] ?? level)}</span>`;
export const pill = (tone, text) => `<span class="pill ${tone}">${esc(text)}</span>`;

/** Change against a baseline, as "+8 %" in the colour of good or bad news. */
export function trend(current, baseline) {
  if (!baseline) return '';
  const change = (current - baseline) / baseline;
  if (Math.abs(change) < 0.005) return '<span>bez zmeny</span>';
  const sign = change > 0 ? '+' : '−';
  return `<span class="${change > 0 ? 'up' : 'down'}">${sign}${Math.round(Math.abs(change) * 100)} %</span>`;
}

/** A small line with an area under it and the last value marked. */
export function spark(values, color = 'var(--accent)') {
  const w = 104;
  const h = 28;
  if (!values.length) return '';
  const max = Math.max(...values);
  const min = Math.min(...values);
  const step = (w - 8) / Math.max(values.length - 1, 1);
  const pts = values.map((v, i) => [4 + i * step, h - 4 - ((v - min) / ((max - min) || 1)) * (h - 8)]);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">`
    + `<path d="${d} L${last[0].toFixed(1)} ${h - 2} L4 ${h - 2} Z" fill="${color}" opacity=".12"/>`
    + `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round"/>`
    + `<circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.6" fill="${color}"/></svg>`;
}

const SERIES_COLORS = ['var(--c3)', 'var(--c2)', 'var(--c1)', 'var(--c4)', 'var(--c6)', 'var(--c5)', 'var(--c7)', 'var(--c8)'];

/** A "nice" top for an axis: 1, 2 or 5 times a power of ten, at least `max`. */
export function niceMax(max) {
  if (max <= 0) return 10;
  const p = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= max) return m * p;
  return 10 * p;
}

/** Events per day, one stacked bar per day, one colour per event name. */
export function stackedBars(days, series) {
  const W = 640;
  const H = 240;
  const L = 48;
  const R = 8;
  const T = 10;
  const B = 26;
  const totals = days.map((_, i) => series.reduce((s, x) => s + x.values[i], 0));
  const top = niceMax(Math.max(...totals, 0));
  const y = (v) => T + (H - T - B) * (1 - v / top);
  const bw = (W - L - R) / days.length;
  let g = '';
  for (let i = 0; i <= 4; i++) {
    const t = (top / 4) * i;
    g += `<line x1="${L}" x2="${W - R}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}" stroke="var(--line)"/>`
      + `<text x="${L - 8}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end">${num(t)}</text>`;
  }
  days.forEach((day, i) => {
    let acc = 0;
    const x = L + i * bw + bw * 0.18;
    const w = bw * 0.64;
    series.forEach((s, j) => {
      const v = s.values[i];
      if (!v) return;
      const y0 = y(acc);
      const y1 = y(acc + v);
      g += `<rect x="${x.toFixed(1)}" y="${y1.toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(y0 - y1, 0).toFixed(1)}" fill="${SERIES_COLORS[j % SERIES_COLORS.length]}"><title>${esc(day)} ${esc(s.name)}: ${num(v)}</title></rect>`;
      acc += v;
    });
    if (i % 2 === 1 || i === days.length - 1) {
      g += `<text x="${(x + w / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle">${Number(day.slice(8))}.</text>`;
    }
  });
  const legend = series.map((s, j) => `<span><i style="background:${SERIES_COLORS[j % SERIES_COLORS.length]}"></i>${esc(s.name)}</span>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Eventy za deň">${g}</svg><div class="legend">${legend}</div>`;
}

/** A two-part bar with its legend: shares of a whole. */
export function split(parts) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  if (!total) return '<div class="dim" style="font-size:12.5px">Zatiaľ bez dát.</div>';
  const bar = parts.map((p) => `<span style="width:${(p.value / total * 100).toFixed(1)}%;background:${p.color}"></span>`).join('');
  const legend = parts.map((p) => `<span><i style="background:${p.color}"></i>${esc(p.label)} ${pct(p.value / total)}</span>`).join('');
  return `<div class="split">${bar}</div><div class="legend" style="margin-top:0">${legend}</div>`;
}

/** A coverage cell: strong from 90 %, medium from 40 %, otherwise quiet. */
export function heat(v, naTitle = '') {
  if (v === null || v === undefined) return `<span class="q na" title="${esc(naTitle)}">—</span>`;
  const cls = v >= 0.9 ? 'h3' : v >= 0.4 ? 'h2' : 'h1';
  return `<span class="q ${cls}">${Math.round(v * 100)} %</span>`;
}
