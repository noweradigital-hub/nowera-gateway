import { esc } from './layout.js';

const fmt = (d) => (d ? new Date(d).toLocaleString('sk-SK', { dateStyle: 'short', timeStyle: 'medium' }) : '—');

const statusPill = (s) => {
  const cls = s === 'sent' ? 'ok' : s === 'dead' ? 'dead' : 'pending';
  return `<span class="pill ${cls}">${esc(s)}</span>`;
};

export const loginPage = () => `
<div class="panel" style="max-width:380px;margin:60px auto">
  <h1>Nowera Gateway</h1>
  <p class="sub">Prihláste sa do administrácie.</p>
  <form method="post" action="/admin/login">
    <label for="email">E-mail</label>
    <input id="email" name="email" type="email" autocomplete="username" required autofocus>
    <label for="password">Heslo</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    <div class="actions"><button class="primary" type="submit">Prihlásiť</button></div>
  </form>
</div>`;

export function accountPage(user, minLength) {
  return `
  <h1>Môj účet</h1>
  <p class="sub mono">${esc(user.email)}</p>
  <div class="panel" style="max-width:460px">
    <form method="post" action="/admin/account">
      <label for="current_password">Súčasné heslo</label>
      <input id="current_password" name="current_password" type="password" autocomplete="current-password" required autofocus>

      <label for="new_password">Nové heslo</label>
      <input id="new_password" name="new_password" type="password" autocomplete="new-password"
             minlength="${minLength}" required>
      <div class="hint">Aspoň ${minLength} znakov.</div>

      <label for="confirm_password">Nové heslo znova</label>
      <input id="confirm_password" name="confirm_password" type="password" autocomplete="new-password"
             minlength="${minLength}" required>

      <div class="actions"><button class="primary" type="submit">Zmeniť heslo</button></div>
    </form>
    <p class="hint" style="margin-top:18px">
      Zmena hesla odhlási všetky ostatné prihlásenia. Toto zostane aktívne.
    </p>
  </div>`;
}

export function tenantList(tenants) {
  const rows = tenants.map((t) => `
    <tr>
      <td><a href="/admin/tenants/${t.id}"><strong>${esc(t.name)}</strong></a>
          <div class="mono" style="color:var(--dim)">${esc(t.collector_host)}</div></td>
      <td>${t.active ? '<span class="pill ok">aktívny</span>' : '<span class="pill off">vypnutý</span>'}</td>
      <td>${t.destination_count}</td>
      <td>${t.sent_24h}</td>
      <td>${Number(t.dead_24h) > 0 ? `<span class="pill dead">${t.dead_24h}</span>` : '0'}</td>
    </tr>`).join('');

  return `
  <div style="display:flex;align-items:flex-start;gap:16px">
    <div style="flex:1"><h1>Klienti</h1><p class="sub">Jeden riadok = jeden web s vlastným collector hostom.</p></div>
    <a class="btn" href="/admin/tenants/new">+ Nový klient</a>
  </div>
  <div class="panel">
    ${tenants.length ? `<table>
      <thead><tr><th>Klient</th><th>Stav</th><th>Destinácie</th><th>Odoslané 24h</th><th>Chyby 24h</th></tr></thead>
      <tbody>${rows}</tbody></table>` : '<div class="empty">Zatiaľ žiadni klienti.</div>'}
  </div>`;
}

export function tenantForm(t) {
  return `
  <h1>${t ? 'Upraviť klienta' : 'Nový klient'}</h1>
  <p class="sub">Collector host musí byť subdoména klientovej domény s A záznamom na tento server.</p>
  <div class="panel">
    <form method="post" action="${t ? `/admin/tenants/${t.id}` : '/admin/tenants'}">
      <div class="row">
        <div><label for="name">Názov</label>
          <input id="name" name="name" value="${esc(t?.name)}" required placeholder="Klient s.r.o."></div>
        ${t ? '' : `<div><label for="slug">Slug</label>
          <input id="slug" name="slug" required placeholder="klient" pattern="[a-z0-9-]{2,40}"></div>`}
      </div>
      <label for="collector_host">Collector host</label>
      <input id="collector_host" name="collector_host" class="mono" value="${esc(t?.collector_host)}" required placeholder="t.klient.sk">
      <div class="hint">Sem smeruje loader aj eventy. Musí byť na doméne klienta, inak sa stratí 1st-party kontext.</div>

      <label for="allowed_origins">Povolené originy</label>
      <input id="allowed_origins" name="allowed_origins" class="mono" value="${esc(t?.allowed_origins)}" placeholder="https://klient.sk,https://www.klient.sk">
      <div class="hint">Čiarkou oddelené. Iba z týchto adries prijmeme eventy z prehliadača.</div>

      <label for="cookie_domain">Cookie doména</label>
      <input id="cookie_domain" name="cookie_domain" class="mono" value="${esc(t?.cookie_domain)}" placeholder=".klient.sk">
      <div class="hint">S bodkou na začiatku, aby cookie platila pre web aj collector.</div>

      ${t ? `<label style="display:flex;gap:8px;align-items:center;margin-top:18px">
        <input type="checkbox" name="active" ${t.active ? 'checked' : ''} style="width:auto"> Aktívny
      </label>` : ''}
      <div class="actions">
        <button class="primary" type="submit">${t ? 'Uložiť' : 'Vytvoriť klienta'}</button>
        <a class="btn" href="/admin">Späť</a>
      </div>
    </form>
  </div>`;
}

function destinationFields(kind, schema) {
  return schema.map((f) => `
    <label for="${kind}_${f.key}">${esc(f.label)}</label>
    <input id="${kind}_${f.key}" name="${f.key}" class="mono"
           type="${f.secret ? 'password' : 'text'}" ${f.required ? 'required' : ''}
           autocomplete="off">`).join('');
}

export function tenantDetail(t, destinations, events, schemas) {
  const destRows = destinations.map((d) => {
    const keys = Object.keys(d.settings || {})
      .map((k) => `${esc(k)}=${/token|secret/i.test(k) ? '••••••' : esc(d.settings[k])}`)
      .join('  ');
    return `<tr>
      <td><strong>${esc(d.kind)}</strong></td>
      <td class="mono" style="color:var(--dim)">${keys}</td>
      <td>${d.active ? '<span class="pill ok">aktívna</span>' : '<span class="pill off">vypnutá</span>'}</td>
      <td style="text-align:right;white-space:nowrap">
        <form class="inline" method="post" action="/admin/destinations/${d.id}/toggle"><button>${d.active ? 'Vypnúť' : 'Zapnúť'}</button></form>
        <form class="inline" method="post" action="/admin/destinations/${d.id}/delete"
              onsubmit="return confirm('Naozaj zmazať destináciu ${esc(d.kind)}?')"><button class="danger">Zmazať</button></form>
      </td></tr>`;
  }).join('');

  const eventRows = events.map((e) => `<tr>
      <td class="mono">${esc(e.event_name)}</td>
      <td>${statusPill(e.status)}${e.attempts > 1 ? ` <span style="color:var(--dim)">×${e.attempts}</span>` : ''}</td>
      <td style="color:var(--dim)">${fmt(e.created_at)}</td>
      <td>${e.last_error ? `<span class="err-text">${esc(e.last_error)}</span>` : ''}</td>
    </tr>`).join('');

  const kindOptions = Object.keys(schemas)
    .map((k) => `<option value="${k}">${k === 'meta' ? 'Meta Conversions API' : 'GA4 Measurement Protocol'}</option>`).join('');

  return `
  <h1>${esc(t.name)}</h1>
  <p class="sub mono">${esc(t.collector_host)}</p>

  <h2>Napojenie webu</h2>
  <div class="panel">
    <p style="margin:0 0 10px">Vložte na web klienta do <code>&lt;head&gt;</code>:</p>
    <textarea readonly rows="2" class="mono" onclick="this.select()">&lt;script async src="https://${esc(t.collector_host)}/px.js"&gt;&lt;/script&gt;</textarea>
    <div class="hint">Loader sám naštartuje Meta pixel, odošle PageView a zdieľa <code>event_id</code> so serverovou vetvou.</div>
  </div>

  <h2>Destinácie</h2>
  <div class="panel">
    ${destinations.length ? `<table><tbody>${destRows}</tbody></table>` : '<div class="empty">Žiadne destinácie — eventy sa nikam neposielajú.</div>'}
  </div>

  <div class="panel">
    <form method="post" action="/admin/tenants/${t.id}/destinations" id="dest-form">
      <label for="kind">Pridať destináciu</label>
      <select id="kind" name="kind">${kindOptions}</select>
      ${Object.entries(schemas).map(([kind, schema], i) => `
        <div data-kind="${kind}" ${i === 0 ? '' : 'hidden'}>${destinationFields(kind, schema)}</div>`).join('')}
      <div class="actions"><button class="primary" type="submit">Pridať</button></div>
    </form>
    <script>
    (function () {
      var select = document.getElementById('kind');
      var groups = document.querySelectorAll('#dest-form [data-kind]');
      function sync() {
        Array.prototype.forEach.call(groups, function (group) {
          var active = group.dataset.kind === select.value;
          group.hidden = !active;
          // A hidden input that is still required blocks submission and cannot be
          // focused, so the submit button looks dead. Disabling skips it in both
          // validation and the POST body.
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

  <h2>Posledné eventy</h2>
  <div class="panel">
    ${events.length ? `<table>
      <thead><tr><th>Event</th><th>Stav</th><th>Čas</th><th>Chyba</th></tr></thead>
      <tbody>${eventRows}</tbody></table>` : '<div class="empty">Zatiaľ nič neprišlo.</div>'}
    <div class="actions">
      <form class="inline" method="post" action="/admin/tenants/${t.id}/test"><button>Poslať testovací event</button></form>
      <a class="btn" href="/admin/events?tenant=${t.id}">Celý log</a>
    </div>
  </div>

  <h2>Nastavenia</h2>
  ${tenantForm(t)}`;
}

export function eventLog(rows, tenants, filters) {
  const options = (sel) => tenants
    .map((t) => `<option value="${t.id}" ${String(sel) === String(t.id) ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
  const statusOpt = (s) => `<option value="${s}" ${filters.status === s ? 'selected' : ''}>${s}</option>`;

  const body = rows.map((r) => `<tr>
      <td><a href="/admin/tenants/${r.tenant_id}">${esc(r.tenant_name)}</a></td>
      <td class="mono">${esc(r.event_name)}</td>
      <td class="mono" style="color:var(--dim)" title="${esc(r.event_id)}">${esc(r.event_id || '—')}</td>
      <td>${esc(r.kind || '—')}</td>
      <td>${statusPill(r.status)}${r.attempts > 1 ? ` <span style="color:var(--dim)">×${r.attempts}</span>` : ''}</td>
      <td style="color:var(--dim);white-space:nowrap">${fmt(r.created_at)}</td>
      <td>${r.last_error ? `<span class="err-text">${esc(r.last_error)}</span>` : ''}</td>
    </tr>`).join('');

  return `
  <h1>Eventy</h1>
  <p class="sub">Posledných 150 záznamov.</p>
  <div class="panel">
    <form method="get" class="row" style="margin-bottom:18px">
      <div><label for="tenant">Klient</label>
        <select id="tenant" name="tenant"><option value="">Všetci</option>${options(filters.tenantId)}</select></div>
      <div><label for="status">Stav</label>
        <select id="status" name="status"><option value="">Všetky</option>
          ${['pending', 'sending', 'sent', 'dead'].map(statusOpt).join('')}</select></div>
      <div style="flex:0"><button type="submit">Filtrovať</button></div>
    </form>
    ${rows.length ? `<table>
      <thead><tr><th>Klient</th><th>Event</th><th>Event ID</th><th>Cieľ</th><th>Stav</th><th>Čas</th><th>Chyba</th></tr></thead>
      <tbody>${body}</tbody></table>` : '<div class="empty">Nič nezodpovedá filtru.</div>'}
  </div>`;
}
