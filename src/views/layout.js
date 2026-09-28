export const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Light and dark palettes; the dashboard follows the operating system.
const CSS = `
:root{--bg:#f3f5f8;--surface:#fff;--surface-2:#f0f3f7;--line:#dde2ea;--line-2:#e8ecf1;
--text:#131a26;--dim:#5a6476;--faint:#8a93a3;--accent:#2a64d8;--accent-soft:rgba(42,100,216,.10);
--ok:#2b7d3e;--ok-soft:rgba(43,125,62,.11);--warn:#a0660f;--warn-soft:rgba(160,102,15,.12);
--bad:#c0362b;--bad-soft:rgba(192,54,43,.10);
--c1:#2a64d8;--c2:#5f8fe6;--c3:#9bb8ee;--c4:#d08a1e;--c5:#2b7d3e;--c6:#7c4fc4;--c7:#1f9aa3;--c8:#b5487c;
--shadow:0 1px 2px rgba(19,26,38,.05);
--sans:"IBM Plex Sans",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
--mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;color-scheme:light}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;
--bg:#0d1015;--surface:#151a21;--surface-2:#1b212a;--line:#262d38;--line-2:#20262f;
--text:#e6ebf2;--dim:#8f99a9;--faint:#667080;--accent:#5b97ff;--accent-soft:rgba(91,151,255,.13);
--ok:#46bf6c;--ok-soft:rgba(70,191,108,.13);--warn:#e3a843;--warn-soft:rgba(227,168,67,.14);
--bad:#f0695e;--bad-soft:rgba(240,105,94,.14);
--c1:#5b97ff;--c2:#3f6fbf;--c3:#2c4d80;--c4:#e3a843;--c5:#46bf6c;--c6:#a07ae6;--c7:#3fb8c1;--c8:#e07aa9;--shadow:none}}
*{box-sizing:border-box}
[hidden]{display:none!important}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 var(--sans);-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
button,input,select,textarea{font:inherit;color:inherit}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
.mono,code{font-family:var(--mono);font-size:.92em}
.num{font-variant-numeric:tabular-nums}
.dim{color:var(--dim)}
.app{display:grid;grid-template-columns:224px minmax(0,1fr);min-height:100%}
.side{border-right:1px solid var(--line);background:var(--surface);padding:18px 14px;display:flex;flex-direction:column;gap:22px;position:sticky;top:0;height:100vh}
.brand{display:flex;align-items:center;gap:10px;padding:2px 8px;font-weight:650;letter-spacing:-.01em;color:var(--text)}
.brand:hover{text-decoration:none}
.brand i{width:22px;height:22px;border-radius:6px;background:var(--accent);display:grid;place-items:center;color:#fff;font:600 11px/1 var(--mono);font-style:normal}
.brand small{display:block;font:500 11px/1.2 var(--mono);color:var(--dim)}
.nav{display:flex;flex-direction:column;gap:2px}
.nav a{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border-radius:7px;color:var(--dim);font-weight:500}
.nav a:hover{background:var(--surface-2);color:var(--text);text-decoration:none}
.nav a.on{background:var(--accent-soft);color:var(--accent)}
.nav .count{font:600 11px/1 var(--mono);padding:3px 6px;border-radius:99px;background:var(--bad-soft);color:var(--bad)}
.nav-label{font:600 10.5px/1 var(--mono);text-transform:uppercase;letter-spacing:.09em;color:var(--faint);padding:0 10px 6px}
.side-foot{margin-top:auto;font-size:12.5px;color:var(--dim);padding:0 10px;display:grid;gap:6px}
.side-foot b{color:var(--text);font-weight:500;overflow-wrap:anywhere}
.side-foot form{margin:0}
.linkbtn{background:none;border:0;padding:0;color:var(--accent);cursor:pointer;font-size:12.5px}
.main{min-width:0;padding:22px 28px 72px}
.crumbs{font-size:12.5px;color:var(--dim);margin:0 0 6px}.crumbs a{color:var(--dim)}
.head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:18px}
.head h1{font-size:24px;font-weight:650;letter-spacing:-.02em;margin:0;line-height:1.25;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.head .meta{color:var(--dim);margin:4px 0 0;font-size:13px;display:flex;gap:14px;flex-wrap:wrap}
.actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.btn{display:inline-flex;align-items:center;gap:7px;padding:7px 12px;border-radius:7px;border:1px solid var(--line);background:var(--surface);color:var(--text);font-weight:500;font-size:13px;cursor:pointer;box-shadow:var(--shadow);white-space:nowrap}
.btn:hover{border-color:var(--faint);text-decoration:none}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.btn.danger{color:var(--bad)}
.btn[disabled]{opacity:.5;cursor:not-allowed}
.btn.sm{padding:5px 9px;font-size:12.5px}
form.inline{display:inline}
.state{display:inline-flex;align-items:center;gap:7px;font-weight:600;font-size:12.5px;white-space:nowrap}
.state::before{content:"";width:8px;height:8px;border-radius:50%;background:currentColor}
.state.ok{color:var(--ok)}.state.warn{color:var(--warn)}.state.bad{color:var(--bad)}.state.off,.state.todo{color:var(--faint)}
.pill{display:inline-flex;align-items:center;gap:6px;font:600 11px/1 var(--mono);padding:4px 7px;border-radius:5px;white-space:nowrap}
.pill.ok{background:var(--ok-soft);color:var(--ok)}.pill.warn{background:var(--warn-soft);color:var(--warn)}
.pill.bad{background:var(--bad-soft);color:var(--bad)}.pill.off,.pill.todo{background:var(--surface-2);color:var(--dim)}
.pill.info{background:var(--accent-soft);color:var(--accent)}
.grid{display:grid;gap:14px}
.kpis{grid-template-columns:repeat(auto-fit,minmax(170px,1fr));margin-bottom:14px}
.kpi{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:14px 16px;box-shadow:var(--shadow)}
.kpi span{display:block;font-size:12px;color:var(--dim)}
.kpi b{display:block;font:600 24px/1.2 var(--mono);letter-spacing:-.03em;margin-top:4px;font-variant-numeric:tabular-nums}
.kpi small{display:block;font-size:12px;color:var(--dim);margin-top:2px}
.up{color:var(--ok)}.down{color:var(--bad)}
.card{background:var(--surface);border:1px solid var(--line);border-radius:10px;box-shadow:var(--shadow);min-width:0}
.card-h{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:13px 16px;border-bottom:1px solid var(--line-2)}
.card-h h2{font-size:14px;font-weight:600;margin:0}
.card-h .sub{font-size:12.5px;color:var(--dim)}
.card-b{padding:14px 16px}
.two{grid-template-columns:minmax(0,1.7fr) minmax(0,1fr)}
.cols-2{grid-template-columns:repeat(auto-fit,minmax(320px,1fr))}
.alertbar{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;padding:11px 14px;border-radius:9px;margin-bottom:14px}
.alertbar.bad{background:var(--bad-soft);color:var(--bad)}.alertbar.warn{background:var(--warn-soft);color:var(--warn)}
.alertbar.ok{background:var(--ok-soft);color:var(--ok)}
.alertbar b{font-weight:600}.alertbar .btn{color:var(--text)}
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13px}
th{font:600 10.5px/1.3 var(--mono);text-transform:uppercase;letter-spacing:.07em;color:var(--dim);text-align:left;padding:10px 16px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:10px 16px;border-bottom:1px solid var(--line-2);vertical-align:middle;font-variant-numeric:tabular-nums}
tr:last-child td{border-bottom:0}
tr.link{cursor:pointer}tr.link:hover td{background:var(--surface-2)}
tr.sel td{background:var(--accent-soft)}
td .host{display:block;font:12px/1.3 var(--mono);color:var(--dim)}
td.r,th.r{text-align:right}
table.compact th,table.compact td{padding-left:10px;padding-right:10px}
table.compact td:first-child,table.compact th:first-child{padding-left:16px}
.empty{color:var(--dim);padding:26px 16px;text-align:center}
.err{color:var(--bad);font-size:12.5px;overflow-wrap:anywhere}
.tabs{display:flex;gap:2px;border-bottom:1px solid var(--line);margin:0 0 16px;overflow-x:auto}
.tabs a{padding:9px 12px;color:var(--dim);font-weight:500;border-bottom:2px solid transparent;margin-bottom:-1px;white-space:nowrap}
.tabs a:hover{color:var(--text);text-decoration:none}
.tabs a.on{color:var(--text);border-bottom-color:var(--accent)}
.legend{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12px;color:var(--dim);margin-top:10px}
.legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:6px;vertical-align:-1px}
svg text{fill:var(--dim);font:11px var(--mono)}
.split{display:flex;height:10px;border-radius:99px;overflow:hidden;background:var(--surface-2);margin:8px 0 6px}
.split span{display:block;height:100%}
.row-stat{display:flex;justify-content:space-between;gap:10px;padding:9px 0;border-bottom:1px solid var(--line-2);font-size:13px}
.row-stat:last-child{border-bottom:0}
.row-stat b{font:600 13px var(--mono);font-variant-numeric:tabular-nums}
.q{font:500 12.5px var(--mono);text-align:center;border-radius:5px;padding:5px 0;min-width:52px;display:block}
.q.h3{background:var(--ok-soft);color:var(--ok)}.q.h2{background:var(--accent-soft);color:var(--accent)}
.q.h1{background:var(--surface-2);color:var(--dim)}.q.na{color:var(--faint)}
.findings{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
.finding{display:grid;grid-template-columns:auto 1fr;gap:10px;align-items:start;font-size:13.5px}
.finding p{margin:2px 0 0;color:var(--dim);font-size:13px}
.kv{display:grid;grid-template-columns:150px 1fr;gap:6px 12px;font-size:13px;margin:0}
.kv dt{color:var(--dim)}.kv dd{margin:0;min-width:0;overflow-wrap:anywhere}
.box{display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:10px 12px;border-radius:8px;background:var(--surface-2);font-size:13px}
.box input{flex:1;min-width:160px}
.steps{list-style:none;margin:0;padding:0}
.step{display:grid;grid-template-columns:28px 1fr auto;gap:12px;align-items:start;padding:12px 16px;border-bottom:1px solid var(--line-2)}
.step:last-child{border-bottom:0}
.tick{width:22px;height:22px;border-radius:50%;display:grid;place-items:center;font:600 12px/1 var(--mono);margin-top:1px}
.tick.ok{background:var(--ok-soft);color:var(--ok)}.tick.warn{background:var(--warn-soft);color:var(--warn)}
.tick.bad{background:var(--bad-soft);color:var(--bad)}.tick.todo{background:var(--surface-2);color:var(--dim)}
.step b{font-weight:600}.step p{margin:2px 0 0;color:var(--dim);font-size:13px}
pre.snip,.drawer pre{margin:0;padding:10px 12px;border-radius:8px;background:var(--surface-2);font:12px/1.5 var(--mono);overflow-x:auto;white-space:pre-wrap;word-break:break-all}
.filters{display:flex;gap:8px;flex-wrap:wrap;padding:12px 16px;border-bottom:1px solid var(--line-2);margin:0}
.filters input,.filters select{padding:6px 9px;border-radius:6px;border:1px solid var(--line);background:var(--surface);min-width:0;width:auto}
.filters input[type=search]{flex:1;min-width:200px}
.ev-wrap{display:grid;grid-template-columns:minmax(0,1fr)}
.ev-wrap.open{grid-template-columns:minmax(0,1fr) 380px}
.drawer{border-left:1px solid var(--line);padding:16px;display:grid;gap:12px;align-content:start;min-width:0}
.drawer h3{margin:0;font-size:15px}
.form{display:grid;gap:14px}
label{display:block;font-size:12.5px;font-weight:600;margin-bottom:5px}
input[type=text],input[type=email],input[type=password],input[type=search],select,textarea{width:100%;padding:8px 10px;border-radius:7px;border:1px solid var(--line);background:var(--surface)}
.hint{font-size:12.5px;color:var(--dim);margin-top:5px}
.check{display:flex;gap:9px;align-items:flex-start;font-size:13.5px;font-weight:400}
.check input{margin-top:3px;width:auto}
.group-t{font:600 11px/1 var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--dim);margin:6px 0 -4px}
.flash{padding:11px 14px;border-radius:9px;margin-bottom:16px}
.flash.ok{background:var(--ok-soft);color:var(--ok)}.flash.err{background:var(--bad-soft);color:var(--bad)}
.login{max-width:380px;margin:12vh auto;padding:0 16px}
@media (max-width:1000px){.two{grid-template-columns:1fr}.ev-wrap.open{grid-template-columns:1fr}.drawer{border-left:0;border-top:1px solid var(--line)}}
@media (max-width:860px){.app{grid-template-columns:1fr}
.side{position:static;height:auto;border-right:0;border-bottom:1px solid var(--line);padding:12px 16px;flex-direction:row;align-items:center;gap:12px;overflow-x:auto}
.nav{flex-direction:row}.nav-label,.side-foot{display:none}.main{padding:18px 16px 60px}.kv{grid-template-columns:1fr}}
`;

const FONTS = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
  + '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap">';

const NAV = [
  { key: 'prehlad', href: '/admin', label: 'Prehľad' },
  { key: 'eventy', href: '/admin/events', label: 'Eventy' },
  { key: 'upozornenia', href: '/admin/upozornenia', label: 'Upozornenia', count: 'alerts' },
];

/**
 * The dashboard frame. Without a user (the sign-in page) there is no sidebar.
 * `nav` marks the active sidebar item.
 */
export function page({ title, user, body, flash, nav = 'prehlad', alerts = 0 }) {
  const counts = { alerts };
  const flashHtml = flash ? `<div class="flash ${flash.type === 'err' ? 'err' : 'ok'}" role="status">${esc(flash.text)}</div>` : '';
  const head = `<!doctype html><html lang="sk"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)} · Nowera Gateway</title>${FONTS}<style>${CSS}</style></head><body>`;
  if (!user) return `${head}<main class="login">${flashHtml}${body}</main></body></html>`;
  return `${head}<div class="app">
<aside class="side" aria-label="Navigácia">
  <a class="brand" href="/admin"><i>S</i><span>Nowera Gateway<small>${esc(process.env.ADMIN_HOST || 'signals')}</small></span></a>
  <nav class="nav"><div class="nav-label">Prevádzka</div>
    ${NAV.map((n) => `<a href="${n.href}"${n.key === nav ? ' class="on"' : ''}>${n.label}${n.count && counts[n.count] ? ` <span class="count">${counts[n.count]}</span>` : ''}</a>`).join('')}
    <div class="nav-label" style="margin-top:14px">Správa</div>
    <a href="/admin/pouzivatelia"${nav === 'pouzivatelia' ? ' class="on"' : ''}>Používatelia</a>
  </nav>
  <div class="side-foot"><b>${esc(user.email)}</b>
    <span><a href="/admin/account">Môj účet</a> · <form class="inline" method="post" action="/admin/logout"><button class="linkbtn">Odhlásiť</button></form></span>
  </div>
</aside>
<main class="main">${flashHtml}${body}</main></div></body></html>`;
}
