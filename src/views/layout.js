export const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The look of nowera office: Apple's system colours, a grouped background,
// white cards on hairlines, a macOS sidebar and an iOS tab bar on the phone.
// Light and dark follow the operating system unless the user picks one (kept
// in this browser only, see THEME_JS).
const LIGHT = `--bg:#f2f2f7;--text:#1d1d1f;--dim:#6e6e73;--faint:#6e6e73;--field-line:#d1d1d6;
--accent:#7d16ff;--accent-2:#8a2cff;--accent-text:#6a0fe0;--accent-soft:rgba(125,22,255,.1);
--ok:#248a3d;--ok-soft:rgba(52,199,89,.14);--warn:#b25000;--warn-soft:rgba(255,149,0,.14);
--bad:#d70015;--bad-soft:rgba(255,59,48,.12);
--c1:#7d16ff;--c2:#007aff;--c3:#30b0c7;--c4:#ff9500;--c5:#34c759;--c6:#ff2d55;--c7:#ffcc00;--c8:#5856d6;--c9:#8e8e93;--c10:#a2845e;
--fill:rgba(120,120,128,.12);--fill-2:rgba(120,120,128,.2);--sep:rgba(60,60,67,.16);
--card:#ffffff;--chrome:rgba(246,246,248,.82);--input:#ffffff;--seg-on:#ffffff;
--rim:0 0 0 .5px rgba(0,0,0,.05);--shadow:0 1px 2px rgba(0,0,0,.04);color-scheme:light;`;
const DARK = `--bg:#000000;--text:#f5f5f7;--dim:#a1a1a6;--faint:#8d8d93;--field-line:#48484a;
--accent:#7d16ff;--accent-2:#9d4dff;--accent-text:#bf8cff;--accent-soft:rgba(157,77,255,.18);
--ok:#30d158;--ok-soft:rgba(48,209,88,.16);--warn:#ff9f0a;--warn-soft:rgba(255,159,10,.16);
--bad:#ff453a;--bad-soft:rgba(255,69,58,.16);
--c1:#9d4dff;--c2:#0a84ff;--c3:#40c8e0;--c4:#ff9f0a;--c5:#30d158;--c6:#ff375f;--c7:#ffd60a;--c8:#5e5ce6;--c9:#98989d;--c10:#ac8e68;
--fill:rgba(118,118,128,.24);--fill-2:rgba(118,118,128,.34);--sep:rgba(84,84,88,.65);
--card:#1c1c1e;--chrome:rgba(28,28,30,.78);--input:#1c1c1e;--seg-on:#636366;
--rim:0 0 0 .5px rgba(255,255,255,.06);--shadow:0 1px 2px rgba(0,0,0,.4);color-scheme:dark;`;

const CSS = `
:root{${LIGHT}
--surface:var(--card);--surface-2:var(--fill);--line:var(--sep);--line-2:var(--sep);
--sans:-apple-system,BlinkMacSystemFont,"SF Pro Text","Inter","Segoe UI",system-ui,sans-serif;
--display:-apple-system,BlinkMacSystemFont,"SF Pro Display","Inter","Segoe UI",system-ui,sans-serif;
--mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;
--blur:20px;--ease:cubic-bezier(.25,.1,.25,1)}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){${DARK}}}
:root[data-theme=dark]{${DARK}}
@media (prefers-reduced-transparency:reduce){:root{--chrome:var(--card);--blur:0px}}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
[hidden]{display:none!important}
html{background:var(--bg);-webkit-text-size-adjust:100%}
html,body{min-height:100%}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.47 var(--sans);letter-spacing:-.01em;-webkit-font-smoothing:antialiased}
a{color:var(--accent-text);text-decoration:none}a:hover{text-decoration:underline}
button,input,select,textarea{font:inherit;color:inherit;letter-spacing:inherit}
::selection{background:var(--accent-soft)}
:focus-visible{outline:3px solid var(--accent-soft);outline-offset:1px;box-shadow:0 0 0 1px var(--accent);border-radius:6px}
svg.i{width:18px;height:18px;flex:none;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.mono,code{font-family:var(--mono);font-size:.9em;letter-spacing:0}
code{padding:1px 5px;border-radius:5px;background:var(--fill)}
.num{font-variant-numeric:tabular-nums}
.dim{color:var(--dim)}
.app{display:grid;grid-template-columns:232px minmax(0,1fr);min-height:100vh}
.side{position:sticky;top:0;height:100vh;padding:14px 10px;display:flex;flex-direction:column;gap:18px;overflow-y:auto;
background:var(--chrome);-webkit-backdrop-filter:blur(var(--blur)) saturate(180%);backdrop-filter:blur(var(--blur)) saturate(180%);
box-shadow:inset -.5px 0 0 var(--sep)}
.brand{display:flex;align-items:center;gap:10px;padding:4px 8px;font:600 15px/1.2 var(--display);letter-spacing:-.01em;color:var(--text)}
.brand:hover{text-decoration:none}
.brand img{width:28px;height:28px;border-radius:7px;flex:none;display:block;box-shadow:0 0 0 .5px rgba(0,0,0,.08)}
.brand small{display:block;font:400 12px/1.3 var(--sans);color:var(--dim)}
.nav{display:flex;flex-direction:column;gap:1px}
.nav a{display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:8px;color:var(--text);font-size:14px;font-weight:400}
.nav a svg.i{color:var(--accent)}
.nav a .count{margin-left:auto}
.nav a:hover{background:var(--fill);text-decoration:none}
.nav a.on{background:var(--fill-2);font-weight:600}
.nav .count{font:600 11px/1 var(--sans);min-width:20px;text-align:center;padding:4px 6px;border-radius:99px;background:var(--bad);color:#fff}
.nav .count.warn{background:var(--warn);color:#fff}
.nav-label{font:600 11px/1 var(--sans);color:var(--faint);padding:8px 10px 5px}
.side-foot{margin-top:auto;font-size:12.5px;color:var(--dim);padding:0 8px;display:grid;gap:10px}
.side-foot b{color:var(--text);font-weight:500;overflow-wrap:anywhere}
.side-foot form{margin:0}
.look{display:flex;gap:2px;padding:2px;border-radius:9px;background:var(--fill)}
.look button{flex:1;border:0;background:transparent;border-radius:7px;padding:5px 0;font-size:12px;font-weight:590;color:var(--text);cursor:pointer;transition:background .2s var(--ease)}
.look button.on{background:var(--seg-on);box-shadow:0 0 0 .5px rgba(0,0,0,.04),0 3px 8px rgba(0,0,0,.12),0 3px 1px rgba(0,0,0,.04)}
.linkbtn{background:none;border:0;padding:0;color:var(--accent-text);cursor:pointer;font-size:12.5px}
.main{min-width:0;padding:26px 32px 72px}
.crumbs{font-size:13px;color:var(--dim);margin:0 0 4px}.crumbs a{color:var(--dim)}
.head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:20px}
.head h1{font:700 30px/1.15 var(--display);letter-spacing:-.025em;margin:0;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.head .meta{color:var(--dim);margin:6px 0 0;font-size:13px;display:flex;gap:6px 14px;flex-wrap:wrap}
.actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:36px;padding:0 15px;border-radius:10px;border:0;background:var(--fill);
color:var(--accent-text);font-weight:590;font-size:14px;cursor:pointer;white-space:nowrap;transition:opacity .15s var(--ease),background .2s var(--ease)}
.btn:hover{background:var(--fill-2);text-decoration:none}
.btn:active{opacity:.6}
.btn.primary{background:var(--accent);color:#fff}
.btn.primary:hover{background:var(--accent-2)}
.btn.danger{color:var(--bad)}
.btn[disabled]{opacity:.45;cursor:default}
.btn.sm{min-height:30px;padding:0 12px;font-size:13px;border-radius:8px}
form.inline{display:inline}
.state{display:inline-flex;align-items:center;gap:7px;font-weight:600;font-size:12.5px;white-space:nowrap}
.state::before{content:"";width:8px;height:8px;border-radius:50%;background:currentColor}
.state.ok{color:var(--ok)}.state.warn{color:var(--warn)}.state.bad{color:var(--bad)}.state.off,.state.todo{color:var(--faint)}
.pill{display:inline-flex;align-items:center;gap:6px;font:600 12px/1 var(--sans);padding:4px 9px;border-radius:999px;white-space:nowrap;background:var(--fill);color:var(--dim)}
.pill.ok{background:var(--ok-soft);color:var(--ok)}.pill.warn{background:var(--warn-soft);color:var(--warn)}
.pill.bad{background:var(--bad-soft);color:var(--bad)}.pill.off,.pill.todo{background:var(--fill);color:var(--dim)}
.pill.info{background:var(--accent-soft);color:var(--accent-text)}
.grid{display:grid;gap:14px}
.kpis{grid-template-columns:repeat(auto-fit,minmax(180px,1fr));margin-bottom:14px}
.kpi{border-radius:16px;padding:14px 16px;background:var(--card);box-shadow:var(--rim),var(--shadow)}
.kpi span{display:block;font-size:13px;color:var(--dim)}
.kpi b{display:block;font:700 28px/1.15 var(--display);letter-spacing:-.03em;margin-top:4px;font-variant-numeric:tabular-nums}
.kpi small{display:block;font-size:12px;color:var(--dim);margin-top:2px}
.up,.kpi .up{color:var(--ok)}.down,.kpi .down{color:var(--bad)}
.card{border-radius:16px;background:var(--card);box-shadow:var(--rim),var(--shadow);min-width:0;overflow:hidden}
.main>.card+.card,.main>.grid+.card{margin-top:14px}
.card-h{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:14px 18px;border-bottom:.5px solid var(--sep)}
.card-h h2{font:600 16px/1.3 var(--display);letter-spacing:-.015em;margin:0}
.card-h .sub{font-size:13px;color:var(--dim)}
.card-b{padding:16px 18px}
.two{grid-template-columns:minmax(0,1.7fr) minmax(0,1fr)}
.cols-2{grid-template-columns:repeat(auto-fit,minmax(320px,1fr))}
.alertbar{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;padding:12px 16px;border-radius:12px;margin-bottom:12px}
.alertbar.bad{background:var(--bad-soft);color:var(--bad)}.alertbar.warn{background:var(--warn-soft);color:var(--warn)}
.alertbar.ok{background:var(--ok-soft);color:var(--ok)}
.alertbar b{font-weight:600}.alertbar .btn{background:var(--card)}
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{font:500 12px/1.3 var(--sans);color:var(--dim);text-align:left;padding:10px 16px 8px;border-bottom:.5px solid var(--sep);white-space:nowrap}
td{padding:10px 16px;border-bottom:.5px solid var(--sep);vertical-align:middle;font-variant-numeric:tabular-nums}
th:first-child,td:first-child{padding-left:18px}th:last-child,td:last-child{padding-right:18px}
tr:last-child td{border-bottom:0}
tr.link{cursor:pointer}tr.link:hover td{background:var(--fill)}
tr.sel td{background:var(--accent-soft)}
td b{font-weight:600}
td .host{display:block;font:12px/1.35 var(--mono);color:var(--dim)}
td.r,th.r{text-align:right}td.r{font-weight:500}
table.compact th,table.compact td{padding-left:10px;padding-right:10px}table.compact td{padding-top:9px;padding-bottom:9px}
table.compact td:first-child,table.compact th:first-child{padding-left:18px}
.empty{color:var(--dim);padding:28px 16px;text-align:center}
.err{color:var(--bad);font-size:12.5px;overflow-wrap:anywhere}
.tabs{display:inline-flex;gap:2px;padding:2px;border-radius:9px;background:var(--fill);margin:0 0 18px;max-width:100%;overflow-x:auto;scrollbar-width:none}
.tabs::-webkit-scrollbar{display:none}
.tabs a{padding:5px 14px;border-radius:7px;color:var(--text);font-size:13.5px;font-weight:590;white-space:nowrap;transition:background .2s var(--ease)}
.tabs a:hover{text-decoration:none;background:var(--fill)}
.tabs a.on{background:var(--seg-on);box-shadow:0 0 0 .5px rgba(0,0,0,.04),0 3px 8px rgba(0,0,0,.12),0 3px 1px rgba(0,0,0,.04)}
.legend{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12px;color:var(--dim);margin-top:12px}
.legend i{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;vertical-align:-1px}
svg text{fill:var(--faint);font:11px var(--sans)}
.split{display:flex;height:8px;border-radius:99px;overflow:hidden;background:var(--fill-2);margin:8px 0 6px}
.split span{display:block;height:100%}
.row-stat{display:flex;justify-content:space-between;gap:10px;padding:10px 0;border-bottom:.5px solid var(--sep);font-size:13.5px}
.row-stat:last-child{border-bottom:0}
.row-stat b{font:600 13.5px var(--sans);font-variant-numeric:tabular-nums}
.q{font:600 12.5px var(--sans);font-variant-numeric:tabular-nums;text-align:center;border-radius:6px;padding:5px 0;min-width:52px;display:block}
.q.h3{background:var(--ok-soft);color:var(--ok)}.q.h2{background:var(--accent-soft);color:var(--accent-text)}
.q.h1{background:var(--fill);color:var(--dim)}.q.na{color:var(--faint)}
.findings{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
.finding{display:grid;grid-template-columns:auto 1fr;gap:10px;align-items:start;font-size:13.5px}
.finding p{margin:2px 0 0;color:var(--dim);font-size:13px}
.kv{display:grid;grid-template-columns:150px 1fr;gap:8px 12px;font-size:13.5px;margin:0}
.kv dt{color:var(--dim)}.kv dd{margin:0;min-width:0;overflow-wrap:anywhere}
.box{display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:12px 14px;border-radius:12px;background:var(--fill);font-size:13px}
.box input{flex:1;min-width:160px}
.steps{list-style:none;margin:0;padding:0}
.step{display:grid;grid-template-columns:28px 1fr auto;gap:12px;align-items:start;padding:12px 18px;border-bottom:.5px solid var(--sep)}
.step:last-child{border-bottom:0}
.tick{width:22px;height:22px;border-radius:50%;display:grid;place-items:center;font:700 12px/1 var(--sans);margin-top:1px}
.tick.ok{background:var(--ok);color:#fff}.tick.warn{background:var(--warn);color:#fff}
.tick.bad{background:var(--bad);color:#fff}.tick.todo{background:var(--fill-2);color:var(--dim)}
.step b{font-weight:600}.step p{margin:2px 0 0;color:var(--dim);font-size:13px}
pre.snip,.drawer pre{margin:0;padding:12px 14px;border-radius:10px;background:var(--fill);font:12px/1.55 var(--mono);overflow-x:auto;white-space:pre-wrap;word-break:break-all}
.filters{display:flex;gap:8px;flex-wrap:wrap;padding:12px 18px;border-bottom:.5px solid var(--sep);margin:0}
.filters input,.filters select{min-width:0;width:auto;min-height:34px;padding:6px 10px}
.filters input[type=search]{flex:1;min-width:200px}
.ev-wrap{display:grid;grid-template-columns:minmax(0,1fr)}
.ev-wrap.open{grid-template-columns:minmax(0,1fr) 380px}
.drawer{border-left:.5px solid var(--sep);padding:18px;display:grid;gap:12px;align-content:start;min-width:0}
.drawer h3{margin:0;font:600 16px/1.3 var(--display)}
.form{display:grid;gap:16px}
label{display:block;font-size:13px;font-weight:500;color:var(--dim);margin-bottom:6px}
input[type=text],input[type=email],input[type=password],input[type=search],input[type=number],input[type=url],select,textarea{width:100%;min-height:38px;padding:8px 12px;border:0;border-radius:10px;
background:var(--input);color:var(--text);outline:none;box-shadow:inset 0 0 0 1px var(--field-line);transition:box-shadow .2s var(--ease)}
input:focus,select:focus,textarea:focus{box-shadow:inset 0 0 0 1px var(--accent),0 0 0 3px var(--accent-soft)}
::placeholder{color:var(--faint)}
.hint{font-size:12.5px;color:var(--dim);margin-top:6px}
.check{display:flex;gap:10px;align-items:flex-start;font-size:14px;font-weight:400;color:var(--text)}
.check input{margin-top:3px;width:auto;accent-color:var(--accent)}
.group-t{font:600 12px/1 var(--sans);color:var(--faint);margin:6px 0 -4px}
.flash{padding:12px 16px;border-radius:12px;margin-bottom:16px}
.flash.ok{background:var(--ok-soft);color:var(--ok)}.flash.err{background:var(--bad-soft);color:var(--bad)}
.login{max-width:420px;margin:12vh auto;padding:0 16px}
@media (max-width:1100px){.two{grid-template-columns:1fr}.ev-wrap.open{grid-template-columns:1fr}.drawer{border-left:0;border-top:.5px solid var(--sep)}}
@media (max-width:860px){.app{grid-template-columns:minmax(0,1fr)}
body{padding-bottom:calc(64px + env(safe-area-inset-bottom))}
.side{position:fixed;z-index:30;left:0;right:0;bottom:0;top:auto;height:auto;min-width:0;padding:6px 4px calc(4px + env(safe-area-inset-bottom));flex-direction:row;gap:0;overflow:visible;
box-shadow:inset 0 .5px 0 var(--sep)}
.brand,.nav-label,.side-foot{display:none}
.nav{flex-direction:row;flex:1;justify-content:space-around;gap:0}
.nav a{flex:1;flex-direction:column;gap:2px;padding:4px 2px;border-radius:0;font-size:10.5px;font-weight:500;color:var(--dim);position:relative;min-width:0;text-align:center}
.nav a svg.i{width:24px;height:24px;color:inherit}
.nav a.on{background:transparent;color:var(--accent);font-weight:500}
.nav a:hover{background:transparent}
.nav a .count{position:absolute;top:0;left:calc(50% + 6px);margin:0;padding:3px 5px;min-width:17px;font-size:10px}
.main{padding:18px 16px 24px}.kv{grid-template-columns:1fr}.head h1{font-size:28px}
.tabs{display:flex;width:100%}.tabs a{flex:none;min-height:36px;display:flex;align-items:center}
input,select,textarea{font-size:16px}
.kpis{grid-template-columns:1fr;gap:0;border-radius:12px;overflow:hidden;background:var(--card);box-shadow:var(--rim),var(--shadow)}
.kpi{display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:12px;align-items:center;border-radius:0;box-shadow:none;background:transparent;padding:11px 16px;border-bottom:.5px solid var(--sep)}
.kpi:last-child{border-bottom:0}
.kpi span{grid-column:1;color:var(--text);font-size:15px}.kpi small{grid-column:1}
.kpi b{grid-column:2;grid-row:1/span 2;margin:0;font-size:20px;font-weight:600}}
`;

// Before the first paint, so the chosen theme never flashes the other one.
const THEME_JS = `(function(){try{var t=localStorage.getItem('nwr-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}})();`;
const LOOK_JS = `(function(){var root=document.documentElement,box=document.querySelector('.look');if(!box)return;
function mark(){var t=root.dataset.theme||'auto';box.querySelectorAll('button').forEach(function(b){b.classList.toggle('on',b.value===t);b.setAttribute('aria-pressed',b.value===t)})}
box.addEventListener('click',function(e){var b=e.target.closest('button');if(!b)return;var t=b.value;
if(t==='auto')delete root.dataset.theme;else root.dataset.theme=t;try{if(t==='auto')localStorage.removeItem('nwr-theme');else localStorage.setItem('nwr-theme',t)}catch(err){}mark()});mark()})();`;

// Stroke icons for the sidebar and the phone's tab bar (24×24, SF Symbols-like).
const ICONS = {
  prehlad: '<path d="M4 13h6V4H4zM14 20h6v-9h-6zM14 4v4h6V4zM4 20h6v-4H4z"/>',
  eventy: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  upozornenia: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20a2 2 0 0 0 4 0"/>',
  pouzivatelia: '<circle cx="12" cy="8" r="4"/><path d="M4 20c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
  zalohy: '<path d="M4 7h16v4H4zM5 11v8h14v-8M10 15h4"/>',
};
const icon = (key) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[key] || ''}</svg>`;

const NAV = [
  { key: 'prehlad', href: '/admin', label: 'Prehľad' },
  { key: 'eventy', href: '/admin/events', label: 'Eventy' },
  { key: 'upozornenia', href: '/admin/upozornenia', label: 'Upozornenia', count: 'alerts' },
];

/**
 * The dashboard frame. Without a user (the sign-in page) there is no sidebar.
 * `nav` marks the active sidebar item.
 */
export function page({ title, user, body, flash, nav = 'prehlad', alerts = 0, backupWarn = false }) {
  const counts = { alerts };
  const flashHtml = flash ? `<div class="flash ${flash.type === 'err' ? 'err' : 'ok'}" role="status">${esc(flash.text)}</div>` : '';
  const head = `<!doctype html><html lang="sk"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="theme-color" content="#f2f2f7" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">
<link rel="icon" type="image/png" sizes="32x32" href="/icon-32.png"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
<title>${esc(title)} · Nowera Gateway</title><script>${THEME_JS}</script><style>${CSS}</style></head><body>`;
  if (!user) return `${head}<main class="login">${flashHtml}${body}</main></body></html>`;
  return `${head}<div class="app">
<aside class="side" aria-label="Navigácia">
  <a class="brand" href="/admin"><img src="/icon-64.png" alt="" width="28" height="28"><span>Nowera Gateway<small>${esc(process.env.ADMIN_HOST || 'signals')}</small></span></a>
  <nav class="nav"><div class="nav-label">Prevádzka</div>
    ${NAV.map((n) => `<a href="${n.href}"${n.key === nav ? ' class="on" aria-current="page"' : ''}>${icon(n.key)}<span>${n.label}</span>${n.count && counts[n.count] ? `<span class="count">${counts[n.count]}</span>` : ''}</a>`).join('')}
    <div class="nav-label" style="margin-top:10px">Správa</div>
    <a href="/admin/pouzivatelia"${nav === 'pouzivatelia' ? ' class="on" aria-current="page"' : ''}>${icon('pouzivatelia')}<span>Používatelia</span></a>
    <a href="/admin/zalohy"${nav === 'zalohy' ? ' class="on" aria-current="page"' : ''}>${icon('zalohy')}<span>Zálohy</span>${backupWarn ? '<span class="count warn" title="Zálohy nie sú nastavené">!</span>' : ''}</a>
  </nav>
  <div class="side-foot">
    <div class="look" role="group" aria-label="Vzhľad"><button type="button" value="auto">Auto</button><button type="button" value="light">Svetlý</button><button type="button" value="dark">Tmavý</button></div>
    <b>${esc(user.email)}</b>
    <span><a href="/admin/account">Môj účet</a> · <form class="inline" method="post" action="/admin/logout"><button class="linkbtn">Odhlásiť</button></form></span>
  </div>
</aside>
<main class="main">${flashHtml}${body}</main></div><script>${LOOK_JS}</script></body></html>`;
}
