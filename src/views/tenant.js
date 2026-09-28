import { esc } from './layout.js';
import {
  heat, money, num, pct, pctFloor, pill, plural, seconds, split, stackedBars, state, time, trend,
} from './components.js';
import { formatAgo, siteOrigin } from '../lib/checks.js';
import { testModeActive } from '../destinations/test-mode.js';
import { tenantForm } from './pages.js';

export const TABS = [
  ['prehlad', 'Prehľad'], ['kvalita', 'Kvalita dát'], ['destinacie', 'Destinácie'],
  ['instalacia', 'Inštalácia'], ['eventy', 'Eventy'], ['nastavenia', 'Nastavenia'],
];

const tabHref = (t, tab) => (tab === 'prehlad' ? `/admin/tenants/${t.id}` : `/admin/tenants/${t.id}/${tab}`);
const KIND_NAME = { meta: 'Meta Conversions API', ga4: 'GA4 Measurement Protocol' };
const SHORT = { meta: 'Meta', ga4: 'GA4' };

/** Name, health, key facts and the tab row; the same on every tab. */
export function tenantHeader(t, destinations, health, active) {
  const testing = destinations.filter((d) => d.active && testModeActive(d.settings));
  const banner = testing.map((d) => `
    <div class="alertbar warn"><span>Testovací režim ${esc(SHORT[d.kind] || d.kind)} do ${time(d.settings.test_until)} —
      serverové eventy idú len do Test Events a nezapočítavajú sa do kampaní.</span>
      <form class="inline" method="post" action="/admin/destinations/${d.id}/test-off"><button class="btn sm">Ukončiť test</button></form></div>`).join('');
  const origin = siteOrigin(t);
  const metaTesting = destinations.some((d) => d.kind === 'meta' && d.active && testModeActive(d.settings));
  const hasMeta = destinations.some((d) => d.kind === 'meta' && d.active);
  return `
  ${banner}
  <p class="crumbs"><a href="/admin">Prehľad</a> / ${esc(t.name)}</p>
  <div class="head">
    <div>
      <h1>${esc(t.name)} ${state(health.level)}</h1>
      <p class="meta"><span class="mono">${esc(t.collector_host)}</span>${origin ? `<span>${esc(origin.replace(/^https?:\/\//, ''))}</span>` : ''}
        ${t.plugin_version ? `<span>plugin ${esc(t.plugin_version)}</span>` : ''}<span>posledný event ${esc(formatAgo(t.last_event_at))}</span></p>
    </div>
    <div class="actions">
      <form class="inline" method="post" action="/admin/tenants/${t.id}/test">
        <button class="btn" type="submit"${hasMeta && !metaTesting ? ' disabled title="Najprv zapnite testovací režim Mety v záložke Destinácie"' : ''}>Poslať testovací event</button></form>
    </div>
  </div>
  ${health.level !== 'ok' && health.reasons.length ? `<p class="dim" style="margin:-8px 0 14px;font-size:13px">${health.reasons.map(esc).join(' · ')}</p>` : ''}
  <nav class="tabs" aria-label="Záložky klienta">
    ${TABS.map(([key, label]) => `<a href="${tabHref(t, key)}"${key === active ? ' class="on" aria-current="page"' : ''}>${label}</a>`).join('')}
  </nav>`;
}

// ------------------------------------------------------------------ Prehľad

export function overviewTab(t, s) {
  const meta = s.destinations.find((d) => d.kind === 'meta' && d.active);
  const metaTotal = meta ? meta.sent + meta.dead + meta.retrying : 0;
  const n24 = s.last24.n;
  return `
  <div class="grid kpis">
    <div class="kpi"><span>Eventy za 24 h</span><b>${num(n24)}</b><small>${trend(n24, s.avgDay) || '&nbsp;'} ${s.avgDay ? 'oproti priemeru 7 dní' : ''}</small></div>
    <div class="kpi"><span>Doručené do Mety</span><b>${meta ? pctFloor(metaTotal ? meta.sent / metaTotal : null) : '—'}</b>
      <small>${meta ? `${num(meta.sent)} doručených, ${plural(meta.dead + meta.retrying, 'chyba', 'chyby', 'chýb')}` : 'Meta nie je pridaná'}</small></div>
    <div class="kpi"><span>Nákupy za 7 dní</span><b>${num(s.purchases.n)}</b><small>${s.purchases.n ? `v hodnote ${money(s.purchases.value, s.purchases.currency)}` : 'zatiaľ žiadne'}</small></div>
    <div class="kpi"><span>Oneskorenie doručenia</span><b>${seconds(meta?.p50 ?? null)}</b><small>${meta?.p95 != null ? `95 % do ${seconds(meta.p95)}` : 'medián za 24 h'}</small></div>
  </div>
  <div class="grid two">
    <div class="card">
      <div class="card-h"><h2>Eventy za deň</h2><span class="sub">posledných 14 dní</span></div>
      <div class="card-b">${s.series.length ? stackedBars(s.days, s.series) : '<div class="empty">Zatiaľ bez dát. Štatistiky sa zbierajú od nasadenia verzie 1.0.</div>'}</div>
    </div>
    <div class="card">
      <div class="card-h"><h2>Odkiaľ eventy prichádzajú</h2><span class="sub">24 h</span></div>
      <div class="card-b">
        <div class="dim" style="font-size:12.5px">Prehliadač · server webu</div>
        ${split([{ label: 'prehliadač', value: s.last24.browser, color: 'var(--c1)' }, { label: 'server', value: s.last24.server, color: 'var(--c4)' }])}
        <div class="dim" style="font-size:12.5px;margin-top:16px">Súhlas pri eventoch</div>
        ${split([
          { label: 'marketing', value: s.last24.marketing, color: 'var(--c5)' },
          { label: 'len štatistika', value: s.last24.statistics, color: 'var(--c3)' },
          ...(s.last24.unmanaged ? [{ label: 'bez kontroly súhlasu', value: s.last24.unmanaged, color: 'var(--faint)' }] : []),
        ])}
        <div style="margin-top:14px">
          <div class="row-stat"><span>Nákupy aj z prehliadača, aj zo servera</span><b>${pct(s.purchasePaired)}</b></div>
          <div class="row-stat"><span>Odfiltrované boty (včera a dnes)</span><b>${num(s.dropped.bot)}</b></div>
          <div class="row-stat"><span>Zablokované za limit požiadaviek</span><b>${num(s.dropped.rateLimited)}</b></div>
          <div class="row-stat"><span>Ignorované kópie z prehliadača</span><b>${num(s.dropped.serverOnly)}</b></div>
        </div>
      </div>
    </div>
  </div>`;
}

// ------------------------------------------------------------------ Kvalita dát

const QUALITY_COLS = [['em', 'E-mail'], ['ph', 'Telefón'], ['ext', 'External ID'], ['fbp', 'fbp'], ['fbc', 'fbc'], ['ip', 'IP'], ['country', 'Krajina']];

export function qualityTab(rows, findings) {
  const table = rows.length ? `<div class="scroll"><table class="compact">
      <thead><tr><th>Event</th><th class="r">Počet</th>${QUALITY_COLS.map(([, l]) => `<th style="text-align:center">${l}</th>`).join('')}<th style="text-align:center">Prehliadač + server</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td class="mono">${esc(r.event_name)}</td><td class="r">${num(r.n)}</td>
        ${QUALITY_COLS.map(([k]) => `<td>${heat(r[k])}</td>`).join('')}
        <td>${heat(r.paired, r.browser && !r.server ? 'Posiela len prehliadač' : 'Posiela len server')}</td></tr>`).join('')}</tbody>
    </table></div>` : '<div class="empty">Zatiaľ bez dát. Štatistiky sa zbierajú od nasadenia verzie 1.0.</div>';
  const tone = { warn: 'warn', info: 'info', ok: 'ok' };
  return `
  <div class="grid">
    <div class="card">
      <div class="card-h"><h2>Údaje pri eventoch</h2><span class="sub">podiel eventov s daným údajom, ako ich dostáva Meta · 7 dní</span></div>
      ${table}
      <div class="card-b" style="border-top:1px solid var(--line-2)"><div class="legend" style="margin-top:0">
        <span>${heat(0.95)}&nbsp;od 90 %</span><span>${heat(0.5)}&nbsp;od 40 %</span><span>${heat(0.1)}&nbsp;menej</span><span>„—“ tento údaj sa nedá porovnať</span></div></div>
    </div>
    <div class="card">
      <div class="card-h"><h2>Na čo sa pozrieť</h2></div>
      <div class="card-b">${findings.length ? `<div class="findings">${findings.map((f) => `
        <div class="finding">${pill(tone[f.tone] || 'info', f.event)}<div>${esc(f.title)}<p>${esc(f.text)}</p></div></div>`).join('')}</div>`
        : '<div class="dim">Nič, čo by potrebovalo pozornosť.</div>'}</div>
    </div>
  </div>`;
}

// ------------------------------------------------------------------ Destinácie

function destinationFields(kind, schema) {
  return schema.map((f) => `
    <div><label for="${kind}_${f.key}">${esc(f.label)}</label>
    <input id="${kind}_${f.key}" name="${f.key}" class="mono" type="${f.secret ? 'password' : 'text'}" ${f.required ? 'required' : ''} autocomplete="off"></div>`).join('');
}

function destinationCard(t, d, metaVersion) {
  const s = d.settings || {};
  const total = d.sent + d.dead + d.retrying;
  const level = !d.active ? 'off' : d.tokenError || d.dead ? 'bad' : d.retrying ? 'warn' : 'ok';
  const label = { off: 'vypnutá', bad: 'chyba', warn: 'opakuje', ok: 'doručuje' }[level];
  const testing = testModeActive(s);
  const rows = d.kind === 'meta' ? `
      <dt>Dataset</dt><dd class="mono">${esc(s.dataset_id)}</dd>
      <dt>Verzia API</dt><dd class="mono">${esc(metaVersion)}</dd>
      <dt>Token</dt><dd>${s.verify_error ? `<span class="err">overenie zlyhalo: ${esc(s.verify_error)}</span>`
        : s.verified_at ? `overený ${esc(formatAgo(s.verified_at))}${s.verified_name ? ` · ${esc(s.verified_name)}` : ''}` : 'uložený, zatiaľ neoverený'}</dd>`
    : `
      <dt>Measurement ID</dt><dd class="mono">${esc(s.measurement_id)}</dd>
      <dt>API secret</dt><dd>uložený</dd>`;
  const testBox = d.kind !== 'meta' ? '' : testing ? `
    <div class="box"><span>Testovací režim:</span>${pill('warn', `do ${time(s.test_until)}`)}<span class="mono">${esc(s.test_event_code)}</span>
      <form class="inline" method="post" action="/admin/destinations/${d.id}/test-off"><button class="btn sm" type="submit">Ukončiť</button></form></div>` : `
    <form class="box" method="post" action="/admin/destinations/${d.id}/test-on">
      <span>Testovací režim:</span>${pill('off', 'vypnutý')}
      <input type="text" name="test_event_code" placeholder="Test event code z Events Managera" aria-label="Test event code" required>
      <button class="btn sm" type="submit">Zapnúť na 60 min</button></form>`;
  return `
  <div class="card">
    <div class="card-h"><h2>${esc(KIND_NAME[d.kind] || d.kind)}</h2>${state(level === 'ok' ? 'ok' : level === 'off' ? 'off' : level, label)}</div>
    <div class="card-b" style="display:grid;gap:12px">
      <dl class="kv">${rows}
        <dt>Posledný úspech</dt><dd>${esc(formatAgo(d.last_success))}</dd>
        <dt>Za 24 h</dt><dd>${num(d.sent)} doručených${total ? `, ${num(d.dead + d.retrying)} chýb (${pct((d.dead + d.retrying) / total)})` : ''}</dd>
        <dt>Posledná chyba</dt><dd>${d.last_error ? `<span class="err">${esc(String(d.last_error).slice(0, 220))}</span> <span class="dim">${esc(formatAgo(d.error_at))}</span>` : '<span class="dim">žiadna za 7 dní</span>'}</dd>
      </dl>
      ${testBox}
      <div class="actions">
        ${d.kind === 'meta' ? `<form class="inline" method="post" action="/admin/destinations/${d.id}/verify"><button class="btn sm" type="submit">Overiť token</button></form>` : ''}
        <a class="btn sm" href="/admin/destinations/${d.id}/edit">Upraviť</a>
        <form class="inline" method="post" action="/admin/destinations/${d.id}/toggle"><button class="btn sm" type="submit">${d.active ? 'Vypnúť' : 'Zapnúť'}</button></form>
        <form class="inline" method="post" action="/admin/destinations/${d.id}/delete"
              onsubmit="return confirm('Naozaj zmazať destináciu ${esc(SHORT[d.kind] || d.kind)}? Zmaže sa aj jej história eventov.')"><button class="btn sm danger" type="submit">Zmazať</button></form>
      </div>
    </div>
  </div>`;
}

export function destinationsTab(t, destinations, schemas, metaVersion) {
  const cards = destinations.map((d) => destinationCard(t, d, metaVersion)).join('');
  const kindOptions = Object.keys(schemas).map((k) => `<option value="${k}">${esc(KIND_NAME[k] || k)}</option>`).join('');
  return `
  <div class="grid cols-2">${cards}
    <div class="card">
      <div class="card-h"><h2>Pridať destináciu</h2></div>
      <form class="card-b form" method="post" action="/admin/tenants/${t.id}/destinations" id="dest-form">
        <div><label for="kind">Typ</label><select id="kind" name="kind">${kindOptions}</select></div>
        ${Object.entries(schemas).map(([kind, schema], i) => `<div data-kind="${kind}" class="form" ${i === 0 ? '' : 'hidden'}>${destinationFields(kind, schema)}</div>`).join('')}
        <div class="actions"><button class="btn primary" type="submit">Pridať</button></div>
      </form>
      <script>
      (function () {
        var select = document.getElementById('kind');
        var groups = document.querySelectorAll('#dest-form [data-kind]');
        function sync() {
          Array.prototype.forEach.call(groups, function (group) {
            var active = group.dataset.kind === select.value;
            group.hidden = !active;
            // A hidden required input blocks the submit and cannot be focused, so
            // the button looks dead. Disabling skips it in validation and the POST.
            Array.prototype.forEach.call(group.querySelectorAll('input'), function (input) {
              input.disabled = !active;
            });
          });
        }
        select.addEventListener('change', sync);
        sync();
      })();
      </script>
    </div>
  </div>`;
}

// ------------------------------------------------------------------ Inštalácia

export function installTab(t, checks) {
  const tick = { ok: '✓', warn: '!', bad: '✗', todo: '–' };
  const label = { ok: 'ok', warn: 'pozor', bad: 'chyba', todo: 'voliteľné' };
  const tone = { ok: 'ok', warn: 'warn', bad: 'bad', todo: 'off' };
  return `
  <div class="grid two">
    <div class="card">
      <div class="card-h"><h2>Kontrolný zoznam</h2>
        <form class="inline" method="post" action="/admin/tenants/${t.id}/checks"><span class="sub">overené ${esc(formatAgo(checks.at))}</span> <button class="btn sm" type="submit">Overiť znova</button></form></div>
      <ul class="steps">${checks.items.map((c) => `
        <li class="step"><span class="tick ${c.state}">${tick[c.state] || '–'}</span><div><b>${esc(c.title)}</b><p>${esc(c.text)}</p></div>${pill(tone[c.state] || 'off', label[c.state] || c.state)}</li>`).join('')}</ul>
    </div>
    <div class="card">
      <div class="card-h"><h2>Napojenie webu</h2></div>
      <div class="card-b" style="display:grid;gap:14px">
        <div><b style="font-weight:600">WordPress + WooCommerce</b>
          <p class="dim" style="margin:2px 0 0;font-size:13px">Plugin Nowera CAPI: v nastaveniach vyplňte collector host <span class="mono">${esc(t.collector_host)}</span> a kľúč zo záložky Nastavenia.</p></div>
        <div><b style="font-weight:600">Iný web</b>
          <p class="dim" style="margin:2px 0 8px;font-size:13px">Vložte do &lt;head&gt; každej stránky:</p>
          <pre class="snip">&lt;script async src="https://${esc(t.collector_host)}/px.js"&gt;&lt;/script&gt;</pre></div>
      </div>
    </div>
  </div>`;
}

// ------------------------------------------------------------------ Nastavenia

export function settingsTab(t) {
  const keyState = t.ingest_secret
    ? `Vlastný kľúč je nastavený.${t.ingest_secret_prev ? ' Predchádzajúci kľúč ešte platí.' : ''}`
    : 'Web zatiaľ podpisuje spoločným kľúčom všetkých klientov.';
  const legacyState = t.legacy_ingest !== false
    ? 'Prijíma sa aj spoločný kľúč a staré verzie pluginu.'
    : 'Prijíma sa len vlastný kľúč s časovou pečiatkou.';
  return `
  <div class="grid two">
    <div>${tenantForm(t)}</div>
    <div class="card">
      <div class="card-h"><h2>Kľúč pre plugin</h2>${state(t.ingest_secret && t.legacy_ingest === false ? 'ok' : 'warn', t.ingest_secret ? 'vlastný' : 'spoločný')}</div>
      <div class="card-b" style="display:grid;gap:10px">
        <p style="margin:0">${keyState}</p>
        <p class="dim" style="margin:0;font-size:13px">${legacyState}</p>
        <div class="actions">
          <form class="inline" method="post" action="/admin/tenants/${t.id}/key"
                onsubmit="return confirm('Vygenerovať nový kľúč? Doterajší bude platiť, kým ho nezrušíte.')">
            <button class="btn sm" type="submit">${t.ingest_secret ? 'Vygenerovať nový kľúč' : 'Vygenerovať kľúč'}</button></form>
          ${t.ingest_secret_prev ? `<form class="inline" method="post" action="/admin/tenants/${t.id}/key/revoke-previous"
                onsubmit="return confirm('Zrušiť predchádzajúci kľúč? Web, ktorý ho ešte používa, prestane posielať serverové eventy.')">
            <button class="btn sm danger" type="submit">Zrušiť predchádzajúci kľúč</button></form>` : ''}
        </div>
        <p class="dim" style="margin:0;font-size:12.5px">Nový kľúč sa ukáže raz. Starý platí, kým ho nezrušíte, takže sa medzitým nestratí žiadny event.</p>
      </div>
    </div>
  </div>`;
}
