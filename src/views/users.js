import QRCode from 'qrcode-svg';
import { esc } from './layout.js';
import { dateTime, pill, state } from './components.js';

const ACTIONS = {
  'tenant.create': 'nový klient',
  'tenant.update': 'uložené nastavenia',
  'tenant.key': 'nový kľúč pre plugin',
  'tenant.key_revoke': 'zrušený predchádzajúci kľúč',
  'tenant.test_event': 'testovací event',
  'destination.add': 'pridaná destinácia',
  'destination.update': 'upravená destinácia',
  'destination.verify': 'overený token',
  'destination.test_on': 'zapnutý testovací režim',
  'destination.test_off': 'ukončený testovací režim',
  'destination.toggle': 'zapnutá/vypnutá destinácia',
  'destination.delete': 'zmazaná destinácia',
  'event.retry': 'event poslaný znova',
  'alerts.update': 'uložené upozornenia',
  'user.invite': 'pozvaný používateľ',
  'user.remove': 'odobraný používateľ',
  'account.password': 'zmenené heslo',
  'account.2fa_on': 'zapnuté 2FA',
  'account.2fa_off': 'vypnuté 2FA',
};

/** Everyone with access, and who changed what. */
export function usersPage({ users, audit, me }) {
  const rows = users.map((u) => `<tr>
      <td>${esc(u.email)}${u.id === me.id ? ` ${pill('info', 'vy')}` : ''}</td>
      <td>${u.totp_enabled ? state('ok', 'zapnuté') : state('warn', 'nezapnuté')}</td>
      <td class="num dim">${dateTime(u.last_login_at)}</td>
      <td class="r">${u.id === me.id ? '<a href="/admin/account">Môj účet</a>' : `
        <form class="inline" method="post" action="/admin/pouzivatelia/${u.id}/delete"
              onsubmit="return confirm('Odobrať prístup pre ${esc(u.email)}?')"><button class="btn sm danger" type="submit">Odobrať</button></form>`}</td>
    </tr>`).join('');
  const log = audit.map((a) => `<tr>
      <td class="num dim" style="white-space:nowrap">${dateTime(a.at)}</td>
      <td class="dim">${esc(a.email || '—')}</td>
      <td>${esc(ACTIONS[a.action] || a.action)}${a.target ? `: ${esc(a.target)}` : ''}</td>
    </tr>`).join('');
  return `
  <div class="head"><div><h1>Používatelia</h1><p class="meta"><span>prístup do administrácie gatewaya</span></p></div></div>
  <div class="grid two">
    <div class="grid" style="align-content:start">
      <div class="card">
        <div class="scroll"><table>
          <thead><tr><th>E-mail</th><th>2FA</th><th>Posledné prihlásenie</th><th></th></tr></thead>
          <tbody>${rows}</tbody></table></div>
      </div>
      <div class="card">
        <div class="card-h"><h2>Pozvať kolegu</h2></div>
        <form class="card-b form" method="post" action="/admin/pouzivatelia">
          <div><label for="invite_email">E-mail</label><input id="invite_email" name="email" type="email" required autocomplete="off"></div>
          <div class="hint" style="margin-top:-6px">Vygeneruje sa dočasné heslo, ukáže sa raz. Kolega si ho zmení v Môj účet a zapne 2FA.</div>
          <div class="actions"><button class="btn primary" type="submit">Pozvať</button></div>
        </form>
      </div>
    </div>
    <div class="card">
      <div class="card-h"><h2>Záznam zmien</h2><span class="sub">kto čo zmenil · posledných 100</span></div>
      ${audit.length ? `<div class="scroll"><table><tbody>${log}</tbody></table></div>` : '<div class="empty">Zatiaľ žiadne zmeny.</div>'}
    </div>
  </div>`;
}

export function invitedPage(email, password) {
  return `
  <p class="crumbs"><a href="/admin/pouzivatelia">Používatelia</a> / Pozvánka</p>
  <div class="head"><div><h1>Prístup vytvorený</h1><p class="meta"><span>${esc(email)}</span></p></div></div>
  <div class="card" style="max-width:560px"><div class="card-b form">
    <div><label for="temp_password">Dočasné heslo</label>
      <input id="temp_password" type="text" class="mono" readonly value="${esc(password)}" onclick="this.select()">
      <div class="hint">Ukáže sa len teraz. Pošlite ho kolegovi iným kanálom ako e-mail s adresou, po prihlásení si ho zmení.</div></div>
    <div class="actions"><a class="btn primary" href="/admin/pouzivatelia">Hotovo</a></div>
  </div></div>`;
}

/** The second sign-in step. */
export const twoFactorLoginPage = () => `
<div class="card"><div class="card-b form" style="padding:22px">
  <div><h1 style="font-size:20px;margin:0 0 4px">Overenie</h1>
    <p class="dim" style="margin:0">Zadajte 6-miestny kód z aplikácie na overovanie.</p></div>
  <form method="post" action="/admin/login/2fa" class="form">
    <div><label for="code">Kód</label>
      <input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" required autofocus></div>
    <div class="actions"><button class="btn primary" type="submit">Overiť</button><a class="btn" href="/admin/login">Späť</a></div>
  </form>
</div></div>`;

/** Setting up an authenticator: the QR code, the secret for typing, and a code to confirm. */
export function twoFactorSetupPage(secret, url) {
  const qr = new QRCode({ content: url, padding: 2, width: 200, height: 200, ecl: 'M', join: true, container: 'svg-viewbox' })
    .svg().replace(/^<\?xml[^>]*>\s*/, '');
  return `
  <p class="crumbs"><a href="/admin/account">Môj účet</a> / Dvojfaktorové overenie</p>
  <div class="head"><div><h1>Zapnúť dvojfaktorové overenie</h1>
    <p class="meta"><span>Google Authenticator, 1Password, Authy alebo iná aplikácia</span></p></div></div>
  <div class="card" style="max-width:560px"><div class="card-b form">
    <div style="display:flex;gap:18px;flex-wrap:wrap;align-items:center">
      <div style="width:200px;background:#fff;border-radius:8px;padding:6px" aria-label="QR kód pre aplikáciu">${qr}</div>
      <div style="flex:1;min-width:200px"><p style="margin:0 0 6px">1. Naskenujte QR kód v aplikácii.</p>
        <p class="dim" style="margin:0;font-size:13px">Alebo zadajte kľúč ručne:</p>
        <p class="mono" style="margin:4px 0 0;word-break:break-all">${esc(secret.replace(/(.{4})/g, '$1 ').trim())}</p></div>
    </div>
    <form method="post" action="/admin/account/2fa/confirm" class="form">
      <div><label for="code">2. Kód z aplikácie</label>
        <input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" required></div>
      <div class="actions"><button class="btn primary" type="submit">Zapnúť</button><a class="btn" href="/admin/account">Zrušiť</a></div>
    </form>
  </div></div>`;
}

/** The two-factor part of "Môj účet". */
export function twoFactorCard(user) {
  return user.totp_enabled ? `
  <div class="card" style="max-width:480px">
    <div class="card-h"><h2>Dvojfaktorové overenie</h2>${state('ok', 'zapnuté')}</div>
    <form class="card-b form" method="post" action="/admin/account/2fa/disable">
      <p class="dim" style="margin:0;font-size:13px">Na vypnutie zadajte heslo a aktuálny kód.</p>
      <div><label for="d_password">Heslo</label><input id="d_password" name="password" type="password" autocomplete="current-password" required></div>
      <div><label for="d_code">Kód</label><input id="d_code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" required></div>
      <div class="actions"><button class="btn danger" type="submit">Vypnúť 2FA</button></div>
    </form>
  </div>` : `
  <div class="card" style="max-width:480px">
    <div class="card-h"><h2>Dvojfaktorové overenie</h2>${state('warn', 'nezapnuté')}</div>
    <form class="card-b form" method="post" action="/admin/account/2fa/start">
      <p class="dim" style="margin:0;font-size:13px">Pri prihlásení bude okrem hesla treba aj kód z aplikácie v telefóne.</p>
      <div class="actions"><button class="btn primary" type="submit">Zapnúť 2FA</button></div>
    </form>
  </div>`;
}
