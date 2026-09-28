import { esc } from './layout.js';
import { LEVEL_COLOR, num, pctFloor, pill, seconds, spark, state, trend } from './components.js';
import { formatAgo } from '../lib/checks.js';

const destLabel = (d) => {
  const name = d.kind === 'meta' ? 'Meta' : d.kind === 'ga4' ? 'GA4' : d.kind;
  if (!d.active) return `${name} vypnutá`;
  if (d.tokenError) return `${name} ✗ token`;
  if (d.dead) return `${name} ✗`;
  return `${name} ✓`;
};

/** The first page: every client's health at a glance. */
export function overviewPage({ tenants, totals }) {
  const problems = tenants.filter((t) => t.health.level === 'bad');
  const alerts = problems.map((t) => `
    <div class="alertbar bad"><span><b>${esc(t.name)}:</b> ${esc(t.health.reasons[0] || 'chyba')}</span>
      <a class="btn sm" href="/admin/tenants/${t.id}/destinacie">Otvoriť</a></div>`).join('');

  const rows = tenants.map((t) => {
    const testing = t.destinations.some((d) => d.testing);
    return `<tr class="link" onclick="location.href='/admin/tenants/${t.id}'">
      <td><a href="/admin/tenants/${t.id}"><b style="font-weight:600;color:var(--text)">${esc(t.name)}</b></a><span class="host">${esc(t.collector_host)}</span></td>
      <td>${state(t.health.level)}${testing ? ` ${pill('warn', 'test')}` : ''}${t.has_key && t.legacy_ingest === false ? '' : ` ${pill('off', 'spoločný kľúč')}`}</td>
      <td class="dim">${formatAgo(t.last_event_at)}</td>
      <td class="r">${num(t.events24h)}</td>
      <td>${spark(t.series, LEVEL_COLOR[t.health.level] || 'var(--accent)')}</td>
      <td class="r">${t.errors24h ? pill('bad', num(t.errors24h)) : '0'}</td>
      <td class="dim">${t.destinations.length ? t.destinations.map(destLabel).map(esc).join(' · ') : '—'}</td>
    </tr>`;
  }).join('');

  return `
  <div class="head">
    <div><h1>Prehľad</h1><p class="meta"><span>${tenants.length} ${tenants.length === 1 ? 'klient' : tenants.length < 5 ? 'klienti' : 'klientov'}</span><span>posledných 24 hodín</span></p></div>
    <div class="actions"><a class="btn" href="/admin/tenants/new">+ Nový klient</a></div>
  </div>
  ${alerts}
  <div class="grid kpis">
    <div class="kpi"><span>Eventy za 24 h</span><b>${num(totals.events24h)}</b><small>${trend(totals.events24h, totals.avgDay) || '&nbsp;'} ${totals.avgDay ? 'oproti priemeru 7 dní' : ''}</small></div>
    <div class="kpi"><span>Doručené</span><b>${pctFloor(totals.delivered)}</b><small>${totals.waiting ? `${num(totals.waiting)} čaká alebo zlyhalo` : 'všetko doručené'}</small></div>
    <div class="kpi"><span>Oneskorenie doručenia</span><b>${seconds(totals.latency)}</b><small>medián za 24 h</small></div>
    <div class="kpi"><span>Odfiltrované boty</span><b>${num(totals.bots)}</b><small>včera a dnes, neodoslané nikam</small></div>
  </div>
  <div class="card">
    <div class="card-h"><h2>Klienti</h2><span class="sub">Stav sa počíta z posledného eventu, chybovosti a odpovedí Mety a GA4.</span></div>
    ${tenants.length ? `<div class="scroll"><table>
      <thead><tr><th>Klient</th><th>Stav</th><th>Posledný event</th><th class="r">Eventy 24 h</th><th>14 dní</th><th class="r">Chyby 24 h</th><th>Destinácie</th></tr></thead>
      <tbody>${rows}</tbody></table></div>` : '<div class="empty">Zatiaľ žiadni klienti. <a href="/admin/tenants/new">Pridať prvého</a></div>'}
  </div>`;
}
