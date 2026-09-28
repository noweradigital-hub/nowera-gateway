import { esc } from './layout.js';
import { CONSENT_MODES } from '../lib/consent.js';

export const loginPage = () => `
<div class="card"><div class="card-b form" style="padding:22px">
  <div><h1 style="font-size:20px;margin:0 0 4px">Nowera Gateway</h1>
    <p class="dim" style="margin:0">Prihláste sa do administrácie.</p></div>
  <form method="post" action="/admin/login" class="form">
    <div><label for="email">E-mail</label>
      <input id="email" name="email" type="email" autocomplete="username" required autofocus></div>
    <div><label for="password">Heslo</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required></div>
    <div class="actions"><button class="btn primary" type="submit">Prihlásiť</button></div>
  </form>
</div></div>`;

export function accountPage(user, minLength) {
  return `
  <div class="head"><div><h1>Môj účet</h1><p class="meta"><span class="mono">${esc(user.email)}</span></p></div></div>
  <div class="card" style="max-width:480px">
    <form method="post" action="/admin/account" class="card-b form">
      <div><label for="current_password">Súčasné heslo</label>
        <input id="current_password" name="current_password" type="password" autocomplete="current-password" required autofocus></div>
      <div><label for="new_password">Nové heslo</label>
        <input id="new_password" name="new_password" type="password" autocomplete="new-password" minlength="${minLength}" required>
        <div class="hint">Aspoň ${minLength} znakov.</div></div>
      <div><label for="confirm_password">Nové heslo znova</label>
        <input id="confirm_password" name="confirm_password" type="password" autocomplete="new-password" minlength="${minLength}" required></div>
      <div class="actions"><button class="btn primary" type="submit">Zmeniť heslo</button></div>
      <p class="hint" style="margin:0">Zmena hesla odhlási všetky ostatné prihlásenia. Toto zostane aktívne.</p>
    </form>
  </div>`;
}

export function destinationForm(tenant, dest, schema) {
  const fields = schema.map((f) => {
    const stored = dest.settings?.[f.key] ?? '';
    return `
      <div><label for="${f.key}">${esc(f.label)}</label>
      <input id="${f.key}" name="${f.key}" class="mono" type="${f.secret ? 'password' : 'text'}"
             value="${f.secret ? '' : esc(stored)}" autocomplete="off"
             placeholder="${f.secret && stored ? 'uložené — nechajte prázdne' : ''}">
      ${f.secret && stored ? '<div class="hint">Prázdne pole ponechá uložený tajný kľúč.</div>' : ''}</div>`;
  }).join('');

  return `
  <p class="crumbs"><a href="/admin">Prehľad</a> / <a href="/admin/tenants/${tenant.id}/destinacie">${esc(tenant.name)}</a> / ${esc(dest.kind)}</p>
  <div class="head"><div><h1>Upraviť destináciu</h1><p class="meta"><span>${esc(tenant.name)}</span><span>${esc(dest.kind)}</span></p></div></div>
  <div class="card" style="max-width:560px">
    <form method="post" action="/admin/destinations/${dest.id}" class="card-b form">
      ${fields}
      ${dest.kind === 'meta' ? `<p class="hint" style="margin:0">Uložený test event code platí 60 minút. Kým platí, Meta posiela serverové
        eventy do Test Events a <strong>nezapočítava ich do kampaní</strong>; potom sa sám vypne.</p>` : ''}
      <div class="actions">
        <button class="btn primary" type="submit">Uložiť</button>
        <a class="btn" href="/admin/tenants/${tenant.id}/destinacie">Späť</a>
      </div>
    </form>
  </div>`;
}

/** The tenant's settings, for a new tenant (t = null) or an existing one. */
export function tenantForm(t) {
  return `
  <div class="card">
    <form method="post" action="${t ? `/admin/tenants/${t.id}` : '/admin/tenants'}" class="card-b form">
      <div class="group-t">Web</div>
      <div><label for="name">Názov</label>
        <input id="name" name="name" type="text" value="${esc(t?.name)}" required placeholder="Klient s.r.o."></div>
      ${t ? '' : `<div><label for="slug">Slug</label>
        <input id="slug" name="slug" type="text" required placeholder="klient" pattern="[a-z0-9-]{2,40}">
        <div class="hint">Malé písmená, čísla a pomlčky.</div></div>`}
      <div><label for="collector_host">Collector host</label>
        <input id="collector_host" name="collector_host" type="text" class="mono" value="${esc(t?.collector_host)}" required placeholder="t.klient.sk">
        <div class="hint">Subdoména klienta s A záznamom na tento server. Sem smeruje loader aj eventy.</div></div>
      <div><label for="allowed_origins">Povolené adresy webu</label>
        <input id="allowed_origins" name="allowed_origins" type="text" class="mono" value="${esc(t?.allowed_origins)}" placeholder="https://klient.sk,https://www.klient.sk">
        <div class="hint">Čiarkou oddelené. Iba z týchto adries prijmeme eventy z prehliadača.</div></div>
      <div><label for="cookie_domain">Cookie doména</label>
        <input id="cookie_domain" name="cookie_domain" type="text" class="mono" value="${esc(t?.cookie_domain)}" placeholder=".klient.sk">
        <div class="hint">S bodkou na začiatku, aby cookie platila pre web aj collector.</div></div>

      <div class="group-t">Súhlasy</div>
      <div><label for="consent_mode">Nástroj na súhlasy</label>
        <select id="consent_mode" name="consent_mode">
          ${Object.entries(CONSENT_MODES).map(([k, label]) =>
            `<option value="${k}" ${(t?.consent_mode || 'none') === k ? 'selected' : ''}>${esc(label)}</option>`).join('')}
        </select>
        <div class="hint">Platí aj pre stránky z cache webu — nastavenie ide priamo v px.js. Meta dostane eventy len so súhlasom
          marketing (CookieScript: targeting), GA4 so štatistikou (performance).</div></div>
      <div><label for="consent_prefix">Prefix cookies (iný nástroj)</label>
        <input id="consent_prefix" name="consent_prefix" type="text" class="mono" value="${esc(t?.consent_prefix || 'cmplz_')}"></div>

      <div class="group-t">Plugin a bezpečnosť</div>
      <div><label for="keep_path">Cookie keeper (cesta na webe klienta)</label>
        <input id="keep_path" name="keep_path" type="text" class="mono" value="${esc(t ? (t.keep_path || '') : '/wp-content/plugins/nowera-capi/keep.php')}" placeholder="/wp-content/plugins/nowera-capi/keep.php">
        <div class="hint">Súbor z pluginu nowera-capi, ktorý obnovuje cookies zo servera webu — Safari ich potom drží 90 dní namiesto 7.
          Nechajte prázdne pri webe bez pluginu.</div></div>
      <div><label for="server_only_events">Len zo servera webu</label>
        <input id="server_only_events" name="server_only_events" type="text" class="mono" value="${esc(t?.server_only_events)}" placeholder="Purchase">
        <div class="hint">Eventy, ktoré posiela podpísané len server webu (plugin). Rovnaký event z prehliadača sa ignoruje,
          takže nikto nepodvrhne napr. nákup s vymyslenou sumou. Nechajte prázdne pri webe bez pluginu.</div></div>
      ${t ? `<label class="check"><input type="checkbox" name="legacy_ingest" ${t.legacy_ingest !== false ? 'checked' : ''}>
        <span>Prijímať aj spoločný kľúč a staré verzie pluginu<br><span class="dim" style="font-size:12.5px">Len na prechod. Vypnite, keď má plugin na webe vlastný kľúč a verziu 0.9 alebo novšiu.</span></span></label>
      <label class="check"><input type="checkbox" name="active" ${t.active ? 'checked' : ''}> <span>Aktívny</span></label>` : ''}
      <div class="actions">
        <button class="btn primary" type="submit">${t ? 'Uložiť' : 'Vytvoriť klienta'}</button>
        ${t ? '' : '<a class="btn" href="/admin">Späť</a>'}
      </div>
    </form>
  </div>`;
}

/**
 * A new client in three steps on one form: the website (everything else follows
 * from its address), the DNS record, consent and plugin.
 */
export function newTenantPage({ serverIp, adminHost }) {
  const optional = (id, label, hint, placeholder) => `
      <div><label for="${id}">${label}</label>
        <input id="${id}" name="${id}" type="text" class="mono" placeholder="${esc(placeholder)}" data-derived>
        ${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
  return `
  <p class="crumbs"><a href="/admin">Prehľad</a> / Nový klient</p>
  <div class="head"><div><h1>Nový klient</h1><p class="meta"><span>tri kroky, zvyšok sa overí sám</span></p></div></div>
  <div class="grid two">
    <div class="card">
      <form class="card-b form" method="post" action="/admin/tenants" id="new-tenant">
        <div class="group-t">1 · Web</div>
        <div><label for="name">Názov</label><input id="name" name="name" type="text" required placeholder="Klient s.r.o."></div>
        <div><label for="site">Adresa webu</label>
          <input id="site" name="site" type="text" class="mono" required placeholder="https://www.klient.sk" autocomplete="off">
          <div class="hint">Z nej sa doplní collector host, povolené adresy aj cookie doména.</div></div>
        <details><summary class="dim" style="cursor:pointer;font-size:13px">Upresniť doplnené údaje</summary>
          <div class="form" style="margin-top:12px">
            ${optional('collector_host', 'Collector host', 'Subdoména klienta, na ktorej beží px.js a prijímajú sa eventy.', 't.klient.sk')}
            ${optional('allowed_origins', 'Povolené adresy webu', 'Čiarkou oddelené. Iba z nich sa prijmú eventy z prehliadača.', 'https://klient.sk,https://www.klient.sk')}
            ${optional('cookie_domain', 'Cookie doména', '', '.klient.sk')}
            ${optional('slug', 'Slug', 'Malé písmená, čísla a pomlčky.', 'klient')}
          </div>
        </details>

        <div class="group-t">2 · DNS</div>
        <p class="dim" style="margin:0;font-size:13px">U klienta pridajte záznam
          <span class="mono" id="dns-name">t.klient.sk</span> → <span class="mono">CNAME ${esc(adminHost)}</span>${serverIp ? ` (alebo <span class="mono">A ${esc(serverIp)}</span>)` : ''}.
          Ak je doména v Cloudflare, môže ísť cez proxy. Certifikát si gateway vybaví sám, keď záznam začne platiť.</p>

        <div class="group-t">3 · Súhlasy a plugin</div>
        <div><label for="consent_mode">Nástroj na súhlasy</label>
          <select id="consent_mode" name="consent_mode">
            <option value="auto" selected>Rozpoznať automaticky z webu</option>
            ${Object.entries(CONSENT_MODES).map(([k, label]) => `<option value="${k}">${esc(label)}</option>`).join('')}
          </select></div>
        <label class="check"><input type="checkbox" name="wordpress" checked>
          <span>WordPress s pluginom Nowera CAPI<br><span class="dim" style="font-size:12.5px">Podpísané eventy zo servera webu a cookie keeper, ktorý v Safari drží cookies 90 dní.</span></span></label>
        <div class="actions"><button class="btn primary" type="submit">Vytvoriť klienta</button><a class="btn" href="/admin">Späť</a></div>
      </form>
      <script>
      (function () {
        var multi = ['co.uk','org.uk','com.pl','net.pl','org.pl','com.au','co.at','or.at','com.hr','co.hu','com.ua','com.ro','com.cy'];
        var site = document.getElementById('site');
        var fields = { collector_host: '', allowed_origins: '', cookie_domain: '', slug: '' };
        function derive(value) {
          var raw = value.trim(); if (!raw) return null;
          try { var u = new URL(/^https?:\\/\\//i.test(raw) ? raw : 'https://' + raw); } catch (e) { return null; }
          var host = u.hostname.toLowerCase().replace(/\\.$/, '');
          if (!/^[a-z0-9.-]+\\.[a-z]{2,}$/.test(host)) return null;
          var labels = host.split('.');
          var keep = multi.indexOf(labels.slice(-2).join('.')) >= 0 ? 3 : 2;
          var domain = labels.slice(-keep).join('.');
          var origins = ['https://' + domain, 'https://www.' + domain];
          if (origins.indexOf('https://' + host) < 0) origins.push('https://' + host);
          return { collector_host: 't.' + domain, allowed_origins: origins.join(','), cookie_domain: '.' + domain,
            slug: labels.slice(-keep)[0].replace(/[^a-z0-9-]/g, '-').slice(0, 40) };
        }
        site.addEventListener('input', function () {
          var d = derive(site.value);
          Object.keys(fields).forEach(function (k) {
            var input = document.getElementById(k);
            input.placeholder = d ? d[k] : input.defaultValue || input.placeholder;
          });
          document.getElementById('dns-name').textContent = d ? d.collector_host : 't.klient.sk';
        });
      })();
      </script>
    </div>
    <div class="card"><div class="card-b dim" style="font-size:13px;display:grid;gap:8px">
      <b style="color:var(--text);font-weight:600">Po vytvorení</b>
      <span>Dostanete párovací kód pre plugin (ukáže sa raz) a otvorí sa záložka Inštalácia s kontrolným zoznamom.</span>
      <span>Nový klient začína s vlastným kľúčom, bez spoločného kľúča a so starými verziami pluginu vypnutými.</span>
      <span>Destinácie (Meta, GA4) pridáte v záložke Destinácie.</span>
    </div></div>
  </div>`;
}

/**
 * The tenant's new signing key, shown once, and the same key with the host as a
 * pairing code for plugin 1.0. It never goes into a URL or a log.
 */
export function ingestKeyPage(t, key, { created = false, pairing = null, notes = [] } = {}) {
  return `
  <p class="crumbs"><a href="/admin">Prehľad</a> / <a href="/admin/tenants/${t.id}">${esc(t.name)}</a> / Kľúč</p>
  <div class="head"><div><h1>Kľúč pre plugin</h1><p class="meta"><span>${esc(t.name)}</span><span class="mono">${esc(t.collector_host)}</span></p></div></div>
  ${notes.map((n) => `<p class="dim" style="margin:-6px 0 14px;font-size:13px">${esc(n)}</p>`).join('')}
  <div class="card" style="max-width:640px">
    <div class="card-b form">
      ${pairing ? `<div><label for="pairing_code">Párovací kód</label>
        <input id="pairing_code" type="text" class="mono" readonly value="${esc(pairing)}" onclick="this.select()">
        <div class="hint">Plugin Nowera CAPI 1.0 a novší: Nastavenia → Nowera CAPI → Párovací kód. Vyplní collector host aj kľúč naraz.</div></div>` : ''}
      <div><label for="ingest_key">Kľúč</label>
        <input id="ingest_key" type="text" class="mono" readonly value="${esc(key)}" onclick="this.select()">
        <div class="hint">Zobrazí sa len teraz. Staršie verzie pluginu: Nastavenia → Nowera CAPI → Kľúč.</div></div>
      ${created ? '' : `<p class="hint" style="margin:0">Predchádzajúci kľúč platí ďalej, kým ho na stránke klienta
        nezrušíte, takže web medzitým nestratí žiadne eventy.</p>`}
      <div class="actions"><a class="btn primary" href="/admin/tenants/${t.id}${created ? '/instalacia' : '/nastavenia'}">Pokračovať</a></div>
    </div>
  </div>`;
}
