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

export function newTenantPage() {
  return `
  <p class="crumbs"><a href="/admin">Prehľad</a> / Nový klient</p>
  <div class="head"><div><h1>Nový klient</h1><p class="meta"><span>Po vytvorení dostanete kľúč pre plugin a kontrolný zoznam inštalácie.</span></p></div></div>
  <div style="max-width:720px">${tenantForm(null)}</div>`;
}

/** The tenant's new signing key, shown once. It never goes into a URL or a log. */
export function ingestKeyPage(t, key, { created = false } = {}) {
  return `
  <p class="crumbs"><a href="/admin">Prehľad</a> / <a href="/admin/tenants/${t.id}">${esc(t.name)}</a> / Kľúč</p>
  <div class="head"><div><h1>Kľúč pre plugin</h1><p class="meta"><span>${esc(t.name)}</span><span class="mono">${esc(t.collector_host)}</span></p></div></div>
  <div class="card" style="max-width:640px">
    <div class="card-b form">
      <div><label for="ingest_key">Kľúč</label>
        <input id="ingest_key" type="text" class="mono" readonly value="${esc(key)}" onclick="this.select()">
        <div class="hint">Zobrazí sa len teraz. Vložte ho do WordPressu: Nastavenia → Nowera CAPI → Kľúč.</div></div>
      ${created ? '' : `<p class="hint" style="margin:0">Predchádzajúci kľúč platí ďalej, kým ho na stránke klienta
        nezrušíte, takže web medzitým nestratí žiadne eventy.</p>`}
      <div class="actions"><a class="btn primary" href="/admin/tenants/${t.id}${created ? '/instalacia' : '/nastavenia'}">Pokračovať</a></div>
    </div>
  </div>`;
}
