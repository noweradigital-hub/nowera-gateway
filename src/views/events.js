import { esc } from './layout.js';
import { dateTime, pill, seconds } from './components.js';

const STATUS = {
  sent: ['ok', 'doručené'], dead: ['bad', 'chyba'], pending: ['warn', 'čaká'], sending: ['info', 'odosiela sa'],
};
const statusPill = (s) => pill(...(STATUS[s] || ['off', s]));
const SOURCE = { browser: 'prehliadač', server: 'server' };
const KIND = { meta: 'Meta', ga4: 'GA4' };

/** Keep the current filters when linking to one row. */
function withParams(base, params, extra) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...params, ...extra })) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `${base}?${s}` : base;
}

/**
 * Filters, the delivery table and, when a row is picked, its detail beside it.
 * `base` is the page's own URL, `showTenant` adds the client column (global view).
 */
export function eventBrowser({ base, rows, names, filters, detail, showTenant = false, tenants = [] }) {
  const opt = (value, label, current) => `<option value="${esc(value)}"${String(current || '') === String(value) ? ' selected' : ''}>${esc(label)}</option>`;
  const form = `
  <form class="filters" method="get" action="${esc(base)}">
    <input type="search" name="q" value="${esc(filters.q)}" placeholder="Hľadať event_id alebo číslo objednávky" aria-label="Hľadať">
    ${showTenant ? `<select name="tenant" aria-label="Klient">${opt('', 'Všetci klienti', filters.tenant)}${tenants.map((t) => opt(t.id, t.name, filters.tenant)).join('')}</select>` : ''}
    <select name="name" aria-label="Event">${opt('', 'Všetky eventy', filters.name)}${names.map((n) => opt(n, n, filters.name)).join('')}</select>
    <select name="status" aria-label="Stav">${opt('', 'Všetky stavy', filters.status)}${Object.entries(STATUS).map(([k, v]) => opt(k, v[1], filters.status)).join('')}</select>
    <select name="source" aria-label="Zdroj">${opt('', 'Prehliadač aj server', filters.source)}${opt('browser', 'Len prehliadač', filters.source)}${opt('server', 'Len server', filters.source)}</select>
    <select name="period" aria-label="Obdobie">${opt('24h', 'Posledných 24 h', filters.period)}${opt('7d', '7 dní', filters.period)}${opt('30d', '30 dní', filters.period)}</select>
    <button class="btn" type="submit">Filtrovať</button>
  </form>`;

  const body = rows.length ? rows.map((r) => {
    const href = withParams(base, filters, { e: r.id });
    const latency = r.sent_at ? (new Date(r.sent_at) - new Date(r.created_at)) / 1000 : null;
    return `<tr class="link${detail && detail.id === r.id ? ' sel' : ''}" onclick="location.href='${esc(href)}'">
      <td class="num dim" style="white-space:nowrap">${dateTime(r.created_at)}</td>
      ${showTenant ? `<td>${esc(r.tenant_name)}</td>` : ''}
      <td class="mono"><a href="${esc(href)}" style="color:var(--text)">${esc(r.event_name)}</a></td>
      <td class="mono dim" title="${esc(r.event_id)}">${esc(String(r.event_id || '—').slice(0, 24))}</td>
      <td>${esc(SOURCE[r.source] || '—')}</td>
      <td>${esc(KIND[r.kind] || r.kind || '—')}</td>
      <td>${statusPill(r.status)}${r.attempts > 1 ? ` <span class="dim">×${r.attempts}</span>` : ''}</td>
      <td class="r">${seconds(latency)}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="${showTenant ? 8 : 7}" class="empty">Nič nezodpovedá filtru.</td></tr>`;

  const table = `<div class="scroll"><table>
    <thead><tr><th>Čas</th>${showTenant ? '<th>Klient</th>' : ''}<th>Event</th><th>Event ID</th><th>Zdroj</th><th>Cieľ</th><th>Stav</th><th class="r">Doručenie</th></tr></thead>
    <tbody>${body}</tbody></table></div>`;

  return `<div class="card">${form}<div class="ev-wrap${detail ? ' open' : ''}">${table}${detail ? eventDrawer(detail, withParams(base, filters, {})) : ''}</div></div>`;
}

/** Everything about one delivery: what went out, what came back. */
export function eventDrawer(e, closeHref) {
  const payload = typeof e.payload === 'string' ? e.payload : JSON.stringify(e.payload, null, 2);
  return `<aside class="drawer" aria-label="Detail eventu">
    <div style="display:flex;justify-content:space-between;gap:10px;align-items:center">
      <h3 class="mono">${esc(e.event_name)}</h3><a class="btn sm" href="${esc(closeHref)}">Zavrieť</a></div>
    <dl class="kv" style="grid-template-columns:110px 1fr">
      <dt>Event ID</dt><dd class="mono">${esc(e.event_id || '—')}</dd>
      <dt>Klient</dt><dd>${esc(e.tenant_name)}</dd>
      <dt>Zdroj</dt><dd>${esc(SOURCE[e.source] || '—')}</dd>
      <dt>Cieľ</dt><dd>${esc(KIND[e.kind] || e.kind || '—')}</dd>
      <dt>Stav</dt><dd>${statusPill(e.status)}</dd>
      <dt>Pokusy</dt><dd>${e.attempts}</dd>
      <dt>Prijatý</dt><dd>${dateTime(e.created_at)}</dd>
      <dt>Doručený</dt><dd>${dateTime(e.sent_at)}</dd>
    </dl>
    ${e.last_error ? `<div class="err">${esc(e.last_error)}</div>` : ''}
    <div><div class="dim" style="font-size:12px;margin-bottom:5px">Čo odišlo (osobné údaje sú zahashované)</div><pre>${esc(payload)}</pre></div>
    <div><div class="dim" style="font-size:12px;margin-bottom:5px">Odpoveď</div><pre>${esc(e.response || '—')}</pre></div>
    ${e.status === 'dead' ? `<form method="post" action="/admin/events/${e.id}/retry"><button class="btn sm primary" type="submit">Poslať znova</button></form>` : ''}
  </aside>`;
}
