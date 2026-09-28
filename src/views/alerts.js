import { esc } from './layout.js';
import { dateTime, pill } from './components.js';
import { RULES } from '../lib/alerts.js';

/** Alert rules, the webhook they go to, and what happened in the last 30 days. */
export function alertsPage({ settings, history }) {
  const open = history.filter((a) => !a.resolved_at);
  const bars = open.map((a) => `
    <div class="alertbar bad"><span><b>${esc(a.tenant_name || 'Gateway')}:</b> ${esc(RULES[a.rule]?.title || a.rule)} — ${esc(a.message)}</span>
      ${a.tenant_id ? `<a class="btn sm" href="/admin/tenants/${a.tenant_id}">Otvoriť</a>` : ''}</div>`).join('');

  const rules = Object.entries(RULES).map(([key, r]) => `
    <label class="check" style="padding:10px 0;border-bottom:1px solid var(--line-2);margin:0">
      <input type="checkbox" name="rule_${key}" ${settings.rules[key] !== false ? 'checked' : ''}>
      <span><b style="font-weight:600">${esc(r.title)}</b><br><span class="dim" style="font-size:12.5px">${esc(r.hint)}</span></span></label>`).join('');

  const rows = history.map((a) => `<tr>
      <td class="num dim" style="white-space:nowrap">${dateTime(a.opened_at)}</td>
      <td>${esc(a.tenant_name || '—')}</td>
      <td>${esc(RULES[a.rule]?.title || a.rule)}<div class="dim" style="font-size:12.5px">${esc(a.message)}</div></td>
      <td>${a.resolved_at ? pill('ok', `vyriešené ${dateTime(a.resolved_at)}`) : pill('bad', 'trvá')}</td>
      <td class="dim" style="font-size:12.5px">${a.notified_at ? 'odoslané' : settings.webhook_url ? 'čaká' : '—'}</td>
    </tr>`).join('');

  return `
  <div class="head">
    <div><h1>Upozornenia</h1><p class="meta"><span>Posielajú sa na webhook (n8n) pri vzniku aj vyriešení problému.</span></p></div>
    <div class="actions"><form class="inline" method="post" action="/admin/upozornenia/test">
      <button class="btn" type="submit"${settings.webhook_url ? '' : ' disabled title="Najprv uložte webhook"'}>Poslať skúšobné upozornenie</button></form></div>
  </div>
  ${bars}
  <div class="grid two">
    <div class="card">
      <div class="card-h"><h2>História</h2><span class="sub">30 dní</span></div>
      ${history.length ? `<div class="scroll"><table>
        <thead><tr><th>Kedy</th><th>Klient</th><th>Čo</th><th>Stav</th><th>Webhook</th></tr></thead>
        <tbody>${rows}</tbody></table></div>` : '<div class="empty">Zatiaľ žiadne upozornenia.</div>'}
    </div>
    <div class="card">
      <div class="card-h"><h2>Pravidlá a webhook</h2><span class="sub">pre všetkých klientov</span></div>
      <form class="card-b form" method="post" action="/admin/upozornenia">
        <div>${rules}</div>
        <div><label for="webhook_url">Webhook</label>
          <input id="webhook_url" name="webhook_url" type="text" class="mono" autocomplete="off"
                 placeholder="${settings.webhook_url ? 'uložený — nechajte prázdne' : 'https://n8n.example.sk/webhook/…'}">
          <div class="hint">Gateway pošle JSON s poľami <code>title</code>, <code>message</code>, <code>url</code> a hotovým textom
            <code>text</code>. V n8n: Webhook (POST) → e-mail alebo Slack s <code>{{ $json.body.text }}</code>.</div></div>
        ${settings.webhook_url ? '<label class="check"><input type="checkbox" name="clear_webhook"> <span>Zmazať uložený webhook</span></label>' : ''}
        <div class="actions"><button class="btn primary" type="submit">Uložiť</button></div>
      </form>
    </div>
  </div>`;
}
