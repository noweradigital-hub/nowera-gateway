import { esc } from './layout.js';
import { bytes, dateTime, num, pill, state } from './components.js';
import { formatAgo } from '../lib/checks.js';

const TABLE_NAMES = { tenants: 'klienti', destinations: 'destinácie', events: 'eventy', received: 'štatistiky', admin_users: 'používatelia' };

function summary(counts = {}) {
  return Object.entries(TABLE_NAMES).filter(([t]) => counts[t] !== undefined)
    .map(([t, label]) => `${num(counts[t])} ${label}`).join(' · ');
}

/** Backups: where they go, how the last ones went, the recovery key, and restore on a fresh install. */
export function backupsPage({ settings, state: st, list, listError, emptyInstall, keySource, totpEnabled, isConfigured }) {
  const failedLast = st.last_error && (!st.last_ok_at || new Date(st.last_error_at) > new Date(st.last_ok_at));
  const level = !isConfigured ? 'warn' : failedLast ? 'bad' : st.last_ok_at ? 'ok' : 'warn';
  const label = !isConfigured ? 'nenastavené' : failedLast ? 'posledná zlyhala' : st.last_ok_at ? 'v poriadku' : 'čaká na prvú';

  const rows = list.map((o) => `<tr>
      <td class="num">${dateTime(o.modified)}</td>
      <td class="num r">${bytes(o.size)}</td>
      <td class="mono dim" style="font-size:12px">${esc(o.key)}</td>
      <td class="r"><a class="btn sm" href="/admin/zalohy/stiahnut?key=${encodeURIComponent(o.key)}">Stiahnuť</a></td>
    </tr>`).join('');

  const status = `
    <div class="card">
      <div class="card-h"><h2>Stav</h2>${state(level, label)}</div>
      <div class="card-b" style="display:grid;gap:12px">
        <dl class="kv">
          <dt>Posledná záloha</dt><dd>${st.last_ok_at ? `${dateTime(st.last_ok_at)} <span class="dim">(${esc(formatAgo(st.last_ok_at))}, ${bytes(st.last_ok_size)})</span>` : '—'}</dd>
          <dt>Obsah</dt><dd>${st.last_counts ? esc(summary(st.last_counts)) : '—'}</dd>
          ${failedLast ? `<dt>Chyba</dt><dd><span class="err">${esc(st.last_error)}</span> <span class="dim">${esc(formatAgo(st.last_error_at))}</span></dd>` : ''}
          <dt>Kedy</dt><dd>každú noc medzi 3:00 a 6:00, po výpadku hneď ako sa dá · uchováva sa ${num(settings.keep_days)} dní</dd>
        </dl>
        <div class="actions">
          <form class="inline" method="post" action="/admin/zalohy/teraz"><button class="btn primary" type="submit"${isConfigured ? '' : ' disabled'}>Zálohovať teraz</button></form>
          <form class="inline" method="post" action="/admin/zalohy/overit"><button class="btn" type="submit"${isConfigured && list.length ? '' : ' disabled'}>Overiť poslednú zálohu</button></form>
        </div>
        <p class="hint" style="margin:0">Overenie stiahne poslednú zálohu, rozšifruje ju a skontroluje, či je úplná. Do databázy nič nezapíše.</p>
      </div>
    </div>`;

  const stored = `
    <div class="card">
      <div class="card-h"><h2>Zálohy v úložisku</h2><span class="sub">${esc(settings.bucket || '')}${settings.prefix ? ` / ${esc(settings.prefix)}` : ''}</span></div>
      ${listError ? `<div class="card-b"><span class="err">Úložisko neodpovedá: ${esc(listError)}</span></div>`
        : list.length ? `<div class="scroll"><table><thead><tr><th>Vytvorená</th><th class="r">Veľkosť</th><th>Súbor</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
          : `<div class="empty">${isConfigured ? 'Zatiaľ žiadna záloha.' : 'Najprv nastavte úložisko.'}</div>`}
    </div>`;

  const restore = emptyInstall ? `
    <div class="card">
      <div class="card-h"><h2>Obnoviť zo zálohy</h2>${pill('warn', 'prázdna inštalácia')}</div>
      <form class="card-b form" id="restore-form">
        <p class="dim" style="margin:0;font-size:13px">Táto inštalácia nemá žiadneho klienta, takže sa do nej dá nahrať záloha.
          Súbor <span class="mono">.nwrb</span> stiahnite z úložiska. Ak pochádza z iného servera, musí mať tento server v prostredí
          <span class="mono">SECRETS_KEY</span> nastavený na kľúč na obnovu z pôvodného servera.</p>
        <div><label for="restore-file">Súbor zálohy</label><input id="restore-file" type="file" accept=".nwrb" required></div>
        <label class="check"><input type="checkbox" id="restore-ok" required> <span>Obnova nahradí všetko v tejto inštalácii vrátane používateľov. Potom sa prihlásite účtom zo zálohy.</span></label>
        <div class="actions"><button class="btn danger" type="submit">Obnoviť</button><span class="hint" id="restore-status" role="status"></span></div>
      </form>
      <script>
      (function () {
        var form = document.getElementById('restore-form');
        var status = document.getElementById('restore-status');
        form.addEventListener('submit', function (e) {
          e.preventDefault();
          var file = document.getElementById('restore-file').files[0];
          if (!file) return;
          form.querySelector('button').disabled = true;
          status.textContent = 'Nahrávam a obnovujem…';
          fetch('/admin/zalohy/obnova', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file })
            .then(function (res) { return res.text().then(function (text) { return { ok: res.ok, text: text }; }); })
            .then(function (r) {
              if (r.ok) { location.href = '/admin/login?m=' + encodeURIComponent(r.text) + '&t=ok'; return; }
              status.textContent = r.text;
              form.querySelector('button').disabled = false;
            })
            .catch(function (err) { status.textContent = 'Chyba: ' + err.message; form.querySelector('button').disabled = false; });
        });
      })();
      </script>
    </div>` : '';

  const storageForm = `
    <div class="card">
      <div class="card-h"><h2>Úložisko</h2><span class="sub">S3 kompatibilné, mimo VPS</span></div>
      <form class="card-b form" method="post" action="/admin/zalohy" autocomplete="off">
        <div><label for="endpoint">Endpoint</label>
          <input id="endpoint" name="endpoint" type="text" class="mono" value="${esc(settings.endpoint)}" placeholder="https://<ACCOUNT_ID>.r2.cloudflarestorage.com" required></div>
        <div style="display:grid;grid-template-columns:1fr 110px;gap:10px">
          <div><label for="bucket">Bucket</label><input id="bucket" name="bucket" type="text" class="mono" value="${esc(settings.bucket)}" placeholder="nowera-gateway-zalohy" required></div>
          <div><label for="region">Región</label><input id="region" name="region" type="text" class="mono" value="${esc(settings.region || 'auto')}"></div>
        </div>
        <div><label for="prefix">Priečinok</label><input id="prefix" name="prefix" type="text" class="mono" value="${esc(settings.prefix)}"></div>
        <div><label for="access_key_id">Access Key ID</label><input id="access_key_id" name="access_key_id" type="text" class="mono" value="${esc(settings.access_key_id)}" required></div>
        <div><label for="secret_access_key">Secret Access Key</label>
          <input id="secret_access_key" name="secret_access_key" type="password" class="mono" placeholder="${settings.secret_access_key ? 'uložený — nechajte prázdne' : ''}" ${settings.secret_access_key ? '' : 'required'}></div>
        <div><label for="keep_days">Uchovávať (dní)</label><input id="keep_days" name="keep_days" type="text" inputmode="numeric" class="mono" value="${esc(settings.keep_days)}" style="max-width:110px"></div>
        <div class="actions"><button class="btn primary" type="submit">Uložiť a otestovať</button></div>
        <p class="hint" style="margin:0"><b>Cloudflare R2:</b> vytvorte bucket, potom <i>R2 → Manage API Tokens → Create API token</i>
          s právom <i>Object Read &amp; Write</i> len pre tento bucket. Región nechajte <span class="mono">auto</span>.
          Kľúč sa uloží zašifrovaný a už sa nezobrazí.</p>
      </form>
    </div>`;

  const recovery = `
    <div class="card">
      <div class="card-h"><h2>Kľúč na obnovu</h2></div>
      <form class="card-b form" method="post" action="/admin/zalohy/kluc" autocomplete="off">
        <p class="dim" style="margin:0;font-size:13px">Zálohy aj tokeny v databáze sú zašifrované kľúčom tohto servera
          (dnes odvodeným z <span class="mono">${esc(keySource)}</span>). Ak server zanikne, bez tohto kľúča sa záloha nedá obnoviť.
          Uložte si ho raz do správcu hesiel.</p>
        <div><label for="k_password">Vaše heslo</label><input id="k_password" name="password" type="password" autocomplete="current-password" required></div>
        ${totpEnabled ? '<div><label for="k_code">Kód z aplikácie</label><input id="k_code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" required></div>' : ''}
        <div class="actions"><button class="btn" type="submit">Zobraziť kľúč</button></div>
      </form>
    </div>`;

  return `
  <div class="head"><div><h1>Zálohy</h1><p class="meta"><span>celá databáza, zašifrovaná, každú noc mimo VPS</span></p></div></div>
  ${!isConfigured ? '<div class="alertbar warn"><span><b>Zálohy nie sú nastavené.</b> Pri strate VPS by sa stratili nastavenia a tokeny všetkých klientov.</span></div>' : ''}
  <div class="grid two">
    <div class="grid" style="align-content:start">${status}${stored}${restore}</div>
    <div class="grid" style="align-content:start">${storageForm}${recovery}</div>
  </div>`;
}

export function recoveryKeyPage(key) {
  return `
  <p class="crumbs"><a href="/admin/zalohy">Zálohy</a> / Kľúč na obnovu</p>
  <div class="head"><div><h1>Kľúč na obnovu</h1></div></div>
  <div class="card" style="max-width:640px"><div class="card-b form">
    <div><label for="recovery_key">Kľúč</label>
      <input id="recovery_key" type="text" class="mono" readonly value="${esc(key)}" onclick="this.select()">
      <div class="hint">Uložte ho do správcu hesiel (napr. 1Password) pod názvom „Nowera Gateway — kľúč na obnovu“.
        Na novom serveri ho nastavte do prostredia ako <span class="mono">SECRETS_KEY</span>, potom nahrajte zálohu.
        Nikomu ho neposielajte e-mailom ani chatom.</div></div>
    <div class="actions"><a class="btn primary" href="/admin/zalohy">Hotovo</a></div>
  </div></div>`;
}
