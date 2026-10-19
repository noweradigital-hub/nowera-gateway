export const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The look of nowera tasks: glass surfaces on a soft gradient wallpaper, nowera
// purple. Light and dark follow the operating system unless the user picks one
// (kept in this browser only, see THEME_JS).
const LIGHT = `--bg:#ecebf2;--text:#0e1716;--dim:#43514e;--faint:#56635f;--field-line:#8a9693;
--accent:#7d16ff;--accent-2:#9a4dff;--accent-text:#6a0fe0;--accent-soft:rgba(125,22,255,.11);
--ok:#15803d;--ok-soft:rgba(21,128,61,.12);--warn:#a34408;--warn-soft:rgba(245,158,11,.18);
--bad:#b4232c;--bad-soft:rgba(229,72,77,.13);
--c1:#7d16ff;--c2:#2f7cf6;--c3:#0ea5a4;--c4:#f2711c;--c5:#22a559;--c6:#e9468f;--c7:#e3a008;--c8:#5b5bd6;--c9:#64748b;--c10:#b45309;
--fill:rgba(110,120,130,.12);--fill-2:rgba(110,120,130,.2);--sep:rgba(20,40,45,.1);
--glass:rgba(255,255,255,var(--glass-a));--glass-a:.55;--glass-chrome:rgba(255,255,255,.45);--glass-solid:#f7f6fb;--glass-input:rgba(255,255,255,.65);
--rim:inset 0 1px 1px rgba(255,255,255,.95),inset 0 -1px 1px rgba(255,255,255,.45),inset 0 0 0 .5px rgba(255,255,255,.7);
--sheen:linear-gradient(170deg,rgba(255,255,255,.5) 0%,rgba(255,255,255,0) 38%);
--shadow:0 1px 2px rgba(16,40,50,.05),0 6px 18px -12px rgba(16,40,50,.3);
--glow:0 4px 14px -6px rgba(125,22,255,.55);
--wp-1:rgba(125,22,255,.24);--wp-2:rgba(59,130,246,.2);--wp-3:rgba(236,72,153,.14);color-scheme:light;`;
const DARK = `--bg:#08070c;--text:#f2f6f6;--dim:#b7c3c1;--faint:#8d9d9a;--field-line:#6f807c;
--accent:#7d16ff;--accent-2:#a873ff;--accent-text:#b98aff;--accent-soft:rgba(150,80,255,.2);
--ok:#4ade80;--ok-soft:rgba(74,222,128,.14);--warn:#f5b82e;--warn-soft:rgba(245,184,46,.15);
--bad:#ff6369;--bad-soft:rgba(255,99,105,.08);
--c1:#9a5cff;--c2:#4b8eff;--c3:#22c3c0;--c4:#ff8a3d;--c5:#34c46b;--c6:#f2649f;--c7:#f5b82e;--c8:#7a7af0;--c9:#94a3b8;--c10:#d97706;
--fill:rgba(150,160,170,.13);--fill-2:rgba(150,160,170,.22);--sep:rgba(255,255,255,.09);
--glass:rgba(22,26,32,var(--glass-a));--glass-a:.55;--glass-chrome:rgba(24,28,34,.55);--glass-solid:#161a20;--glass-input:rgba(0,0,0,.22);
--rim:inset 0 1px 1px rgba(255,255,255,.2),inset 0 -1px 1px rgba(255,255,255,.05),inset 0 0 0 .5px rgba(255,255,255,.11);
--sheen:linear-gradient(170deg,rgba(255,255,255,.08) 0%,rgba(255,255,255,0) 36%);
--shadow:0 1px 2px rgba(0,0,0,.3),0 8px 22px -12px rgba(0,0,0,.6);
--glow:0 4px 16px -6px rgba(125,22,255,.65);
--wp-1:rgba(125,22,255,.28);--wp-2:rgba(37,99,235,.18);--wp-3:rgba(219,39,119,.09);color-scheme:dark;`;

const CSS = `
:root{${LIGHT}
--surface:var(--glass-solid);--surface-2:var(--fill);--line:var(--sep);--line-2:var(--sep);
--sans:-apple-system,BlinkMacSystemFont,"SF Pro Text","Inter","Segoe UI",system-ui,sans-serif;
--display:-apple-system,BlinkMacSystemFont,"SF Pro Display","Inter","Segoe UI",system-ui,sans-serif;
--mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;
--blur:22px;--ease:cubic-bezier(.22,.8,.24,1);--spring:cubic-bezier(.34,1.45,.55,1)}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){${DARK}}}
:root[data-theme=dark]{${DARK}}
@media (prefers-reduced-transparency:reduce){:root{--glass:var(--glass-solid);--glass-chrome:var(--glass-solid);--blur:0px}}
*{box-sizing:border-box}
[hidden]{display:none!important}
html{background:var(--bg)}
html,body{min-height:100%}
body{margin:0;background:transparent;color:var(--text);font:14px/1.5 var(--sans);-webkit-font-smoothing:antialiased}
body::before{content:"";position:fixed;inset:-10vmax;z-index:-1;pointer-events:none;
background:radial-gradient(42vmax 38vmax at 12% 8%,var(--wp-1),transparent 70%),radial-gradient(46vmax 40vmax at 92% 22%,var(--wp-2),transparent 70%),
radial-gradient(50vmax 40vmax at 55% 105%,var(--wp-3),transparent 70%),var(--bg)}
a{color:var(--accent-text);text-decoration:none}a:hover{text-decoration:underline}
button,input,select,textarea{font:inherit;color:inherit}
::selection{background:var(--accent-soft)}
:focus-visible{outline:2px solid var(--accent-2);outline-offset:2px;border-radius:6px}
.mono,code{font-family:var(--mono);font-size:.9em}
code{padding:1px 6px;border-radius:6px;background:var(--fill)}
.num{font-variant-numeric:tabular-nums}
.dim{color:var(--dim)}
.app{display:grid;grid-template-columns:248px minmax(0,1fr);min-height:100vh}
.side{position:sticky;top:14px;height:calc(100vh - 28px);margin:14px 0 14px 14px;padding:18px 12px;border-radius:28px;
display:flex;flex-direction:column;gap:20px;background:var(--sheen),var(--glass-chrome);
-webkit-backdrop-filter:blur(var(--blur)) saturate(180%);backdrop-filter:blur(var(--blur)) saturate(180%);box-shadow:var(--rim),var(--shadow);overflow-y:auto}
.brand{display:flex;align-items:center;gap:11px;padding:2px 8px;font:750 15.5px/1.2 var(--display);letter-spacing:-.02em;color:var(--text)}
.brand:hover{text-decoration:none}
.brand i{width:36px;height:36px;border-radius:11px;flex:none;display:grid;place-items:center;color:#fff;font:750 16px/1 var(--display);font-style:normal;
background:linear-gradient(180deg,rgba(255,255,255,.3),rgba(255,255,255,0) 60%),var(--accent);box-shadow:inset 0 1px 1px rgba(255,255,255,.5),0 6px 16px -8px rgba(125,22,255,.8)}
.brand small{display:block;font:500 11.5px/1.3 var(--sans);letter-spacing:0;color:var(--dim)}
.nav{display:flex;flex-direction:column;gap:3px}
.nav a{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 14px;border-radius:999px;color:var(--dim);font-weight:600;
transition:background .2s var(--ease),color .2s var(--ease)}
.nav a:hover{background:var(--fill);color:var(--text);text-decoration:none}
.nav a.on{background:var(--sheen),var(--glass-solid);color:var(--accent-text);box-shadow:var(--rim),0 2px 10px -4px rgba(0,0,0,.25)}
.nav .count{font:700 11px/1 var(--sans);min-width:20px;text-align:center;padding:4px 6px;border-radius:99px;background:var(--bad-soft);color:var(--bad)}
.nav .count.warn{background:var(--warn-soft);color:var(--warn)}
.nav-label{font:650 11px/1 var(--sans);text-transform:uppercase;letter-spacing:.08em;color:var(--faint);padding:0 14px 6px}
.side-foot{margin-top:auto;font-size:12.5px;color:var(--dim);padding:0 8px;display:grid;gap:10px}
.side-foot b{color:var(--text);font-weight:600;overflow-wrap:anywhere}
.side-foot form{margin:0}
.look{display:flex;gap:2px;padding:3px;border-radius:999px;background:var(--fill)}
.look button{flex:1;border:0;background:transparent;border-radius:999px;padding:6px 0;font-size:12px;font-weight:600;color:var(--dim);cursor:pointer;
transition:background .25s var(--ease),color .2s var(--ease)}
.look button.on{background:var(--sheen),var(--glass-solid);color:var(--text);box-shadow:var(--rim),0 2px 8px -2px rgba(0,0,0,.18)}
.linkbtn{background:none;border:0;padding:0;color:var(--accent-text);cursor:pointer;font-size:12.5px;font-weight:600}
.main{min-width:0;padding:26px 32px 72px 26px}
.crumbs{font-size:13px;color:var(--dim);margin:0 0 6px}.crumbs a{color:var(--dim)}
.head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:20px}
.head h1{font:750 30px/1.12 var(--display);letter-spacing:-.035em;margin:0;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.head .meta{color:var(--dim);margin:6px 0 0;font-size:13px;display:flex;gap:6px 14px;flex-wrap:wrap}
.actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:38px;padding:0 16px;border-radius:999px;border:0;
background:var(--sheen),var(--glass);box-shadow:var(--rim),0 1px 2px rgba(0,0,0,.06);color:var(--text);font-weight:600;font-size:13.5px;cursor:pointer;white-space:nowrap;
transition:transform .25s var(--spring),background .2s var(--ease),filter .2s var(--ease)}
.btn:hover{background:var(--sheen),var(--fill-2);text-decoration:none}
.btn:active{transform:scale(.97)}
.btn.primary{background:linear-gradient(180deg,rgba(255,255,255,.22),rgba(255,255,255,0) 55%),var(--accent);color:#fff;
box-shadow:inset 0 1px 1px rgba(255,255,255,.45),inset 0 -1px 1px rgba(0,0,0,.12),var(--glow)}
.btn.primary:hover{filter:brightness(1.07)}
.btn.danger{color:var(--bad)}
.btn[disabled]{cursor:not-allowed;transform:none;color:var(--faint);background:var(--fill);box-shadow:none;filter:none}
.btn.sm{min-height:32px;padding:0 13px;font-size:12.5px}
form.inline{display:inline}
.state{display:inline-flex;align-items:center;gap:7px;font-weight:650;font-size:12.5px;white-space:nowrap}
.state::before{content:"";width:8px;height:8px;border-radius:50%;background:currentColor;box-shadow:0 0 0 3px color-mix(in srgb,currentColor 18%,transparent)}
.state.ok{color:var(--ok)}.state.warn{color:var(--warn)}.state.bad{color:var(--bad)}.state.off,.state.todo{color:var(--faint)}
.pill{display:inline-flex;align-items:center;gap:6px;font:650 11.5px/1 var(--sans);padding:5px 10px;border-radius:999px;white-space:nowrap;background:var(--fill);color:var(--dim)}
.pill.ok{background:var(--ok-soft);color:var(--ok)}.pill.warn{background:var(--warn-soft);color:var(--warn)}
.pill.bad{background:var(--bad-soft);color:var(--bad)}.pill.off,.pill.todo{background:var(--fill);color:var(--dim)}
.pill.info{background:var(--accent-soft);color:var(--accent-text)}
.grid{display:grid;gap:14px}
.kpis{grid-template-columns:repeat(auto-fit,minmax(180px,1fr));margin-bottom:14px}
.kpi{border-radius:22px;padding:14px 18px 15px;background:var(--sheen),var(--glass);box-shadow:var(--rim),var(--shadow)}
.kpi span{display:block;font-size:12.5px;font-weight:600;color:var(--dim)}
.kpi b{display:block;font:750 28px/1.15 var(--display);letter-spacing:-.035em;margin-top:4px;font-variant-numeric:tabular-nums}
.kpi small{display:block;font-size:12px;color:var(--dim);margin-top:2px}
.up,.kpi .up{color:var(--ok)}.down,.kpi .down{color:var(--bad)}
.card{border-radius:20px;background:var(--sheen),var(--glass);box-shadow:var(--rim),var(--shadow);min-width:0;overflow:hidden}
.main>.card+.card,.main>.grid+.card{margin-top:14px}
.card-h{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:15px 20px;border-bottom:1px solid var(--sep)}
.card-h h2{font:700 15.5px/1.3 var(--display);letter-spacing:-.015em;margin:0}
.card-h .sub{font-size:12.5px;color:var(--dim)}
.card-b{padding:16px 20px}
.two{grid-template-columns:minmax(0,1.7fr) minmax(0,1fr)}
.cols-2{grid-template-columns:repeat(auto-fit,minmax(320px,1fr))}
.alertbar{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;padding:12px 16px;border-radius:18px;margin-bottom:14px;box-shadow:var(--rim)}
.alertbar.bad{background:var(--bad-soft);color:var(--bad)}.alertbar.warn{background:var(--warn-soft);color:var(--warn)}
.alertbar.ok{background:var(--ok-soft);color:var(--ok)}
.alertbar b{font-weight:650}.alertbar .btn{color:var(--text)}
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{font:600 12px/1.3 var(--sans);color:var(--dim);text-align:left;padding:11px 16px 9px;border-bottom:1px solid var(--sep);white-space:nowrap}
td{padding:11px 16px;border-bottom:1px solid var(--sep);vertical-align:middle;font-variant-numeric:tabular-nums}
th:first-child,td:first-child{padding-left:20px}th:last-child,td:last-child{padding-right:20px}
tr:last-child td{border-bottom:0}
tr.link{cursor:pointer}tr.link td{transition:background .15s var(--ease)}tr.link:hover td{background:var(--fill)}
tr.sel td{background:var(--accent-soft)}
td b{font-weight:650}
td .host{display:block;font:12px/1.35 var(--mono);color:var(--dim)}
td.r,th.r{text-align:right}td.r{font-weight:550}
table.compact th,table.compact td{padding-left:10px;padding-right:10px}table.compact td{padding-top:9px;padding-bottom:9px}
table.compact td:first-child,table.compact th:first-child{padding-left:20px}
.empty{color:var(--dim);padding:28px 16px;text-align:center}
.err{color:var(--bad);font-size:12.5px;overflow-wrap:anywhere}
.tabs{display:inline-flex;gap:2px;padding:4px;border-radius:999px;background:var(--fill);margin:0 0 18px;max-width:100%;overflow-x:auto}
.tabs a{padding:8px 16px;border-radius:999px;color:var(--dim);font-weight:600;white-space:nowrap;transition:background .25s var(--ease),color .2s var(--ease)}
.tabs a:hover{color:var(--text);text-decoration:none}
.tabs a.on{color:var(--text);background:var(--sheen),var(--glass-solid);box-shadow:var(--rim),0 2px 8px -2px rgba(0,0,0,.18)}
.legend{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12px;color:var(--dim);margin-top:12px}
.legend i{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;vertical-align:-1px}
svg text{fill:var(--faint);font:11px var(--sans)}
.split{display:flex;height:10px;border-radius:99px;overflow:hidden;background:var(--fill-2);margin:8px 0 6px}
.split span{display:block;height:100%}
.row-stat{display:flex;justify-content:space-between;gap:10px;padding:10px 0;border-bottom:1px solid var(--sep);font-size:13.5px}
.row-stat:last-child{border-bottom:0}
.row-stat b{font:700 13.5px var(--sans);font-variant-numeric:tabular-nums}
.q{font:600 12.5px var(--sans);font-variant-numeric:tabular-nums;text-align:center;border-radius:8px;padding:5px 0;min-width:52px;display:block}
.q.h3{background:var(--ok-soft);color:var(--ok)}.q.h2{background:var(--accent-soft);color:var(--accent-text)}
.q.h1{background:var(--fill);color:var(--dim)}.q.na{color:var(--faint)}
.findings{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
.finding{display:grid;grid-template-columns:auto 1fr;gap:10px;align-items:start;font-size:13.5px}
.finding p{margin:2px 0 0;color:var(--dim);font-size:13px}
.kv{display:grid;grid-template-columns:150px 1fr;gap:8px 12px;font-size:13.5px;margin:0}
.kv dt{color:var(--dim)}.kv dd{margin:0;min-width:0;overflow-wrap:anywhere}
.box{display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:12px 14px;border-radius:16px;background:var(--fill);font-size:13px}
.box input{flex:1;min-width:160px}
.steps{list-style:none;margin:0;padding:0}
.step{display:grid;grid-template-columns:28px 1fr auto;gap:12px;align-items:start;padding:13px 20px;border-bottom:1px solid var(--sep)}
.step:last-child{border-bottom:0}
.tick{width:24px;height:24px;border-radius:50%;display:grid;place-items:center;font:700 12px/1 var(--sans);margin-top:1px}
.tick.ok{background:var(--ok-soft);color:var(--ok)}.tick.warn{background:var(--warn-soft);color:var(--warn)}
.tick.bad{background:var(--bad-soft);color:var(--bad)}.tick.todo{background:var(--fill);color:var(--dim)}
.step b{font-weight:650}.step p{margin:2px 0 0;color:var(--dim);font-size:13px}
pre.snip,.drawer pre{margin:0;padding:12px 14px;border-radius:14px;background:var(--fill);font:12px/1.55 var(--mono);overflow-x:auto;white-space:pre-wrap;word-break:break-all}
.filters{display:flex;gap:8px;flex-wrap:wrap;padding:14px 20px;border-bottom:1px solid var(--sep);margin:0}
.filters input,.filters select{min-width:0;width:auto;min-height:36px;padding:6px 12px}
.filters input[type=search]{flex:1;min-width:200px}
.ev-wrap{display:grid;grid-template-columns:minmax(0,1fr)}
.ev-wrap.open{grid-template-columns:minmax(0,1fr) 380px}
.drawer{border-left:1px solid var(--sep);padding:18px;display:grid;gap:12px;align-content:start;min-width:0}
.drawer h3{margin:0;font:700 16px/1.3 var(--display)}
.form{display:grid;gap:16px}
label{display:block;font-size:12.5px;font-weight:650;color:var(--dim);margin-bottom:6px}
input[type=text],input[type=email],input[type=password],input[type=search],input[type=number],input[type=url],select,textarea{width:100%;min-height:40px;padding:9px 13px;border:0;border-radius:12px;
background:var(--glass-input);color:var(--text);outline:none;box-shadow:inset 0 0 0 1px var(--field-line),inset 0 1px 2px rgba(0,0,0,.06);transition:box-shadow .2s var(--ease)}
input:focus,select:focus,textarea:focus{box-shadow:inset 0 0 0 1.5px var(--accent-2),0 0 0 4px var(--accent-soft)}
::placeholder{color:var(--faint)}
.hint{font-size:12.5px;color:var(--dim);margin-top:6px}
.check{display:flex;gap:10px;align-items:flex-start;font-size:13.5px;font-weight:400;color:var(--text)}
.check input{margin-top:3px;width:auto;accent-color:var(--accent)}
.group-t{font:650 11px/1 var(--sans);text-transform:uppercase;letter-spacing:.08em;color:var(--faint);margin:6px 0 -4px}
.flash{padding:12px 16px;border-radius:18px;margin-bottom:16px;box-shadow:var(--rim)}
.flash.ok{background:var(--ok-soft);color:var(--ok)}.flash.err{background:var(--bad-soft);color:var(--bad)}
.login{max-width:420px;margin:12vh auto;padding:0 16px}
@media (max-width:1100px){.two{grid-template-columns:1fr}.ev-wrap.open{grid-template-columns:1fr}.drawer{border-left:0;border-top:1px solid var(--sep)}}
@media (max-width:860px){.app{grid-template-columns:minmax(0,1fr)}
.side{min-width:0;position:sticky;top:8px;z-index:20;height:auto;margin:8px 8px 0;padding:8px 10px;border-radius:24px;flex-direction:row;align-items:center;gap:8px;overflow:visible}
.brand{flex:none;padding:0}.brand span{display:none}.brand i{width:34px;height:34px;border-radius:10px}
.nav{flex-direction:row;flex:1;min-width:0;overflow-x:auto;scrollbar-width:none}.nav::-webkit-scrollbar{display:none}.nav a{flex:none;min-height:44px}
.tabs{display:flex;width:100%;border-radius:16px;scroll-padding-inline:4px}.tabs a{flex:none;min-height:44px;display:flex;align-items:center}
input,select,textarea{font-size:16px}.nav-label,.side-foot{display:none}.main{padding:18px 16px 60px}.kv{grid-template-columns:1fr}.head h1{font-size:26px}
.kpis{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.kpi{padding:12px 14px}.kpi b{font-size:23px}}
`;

// Before the first paint, so the chosen theme never flashes the other one.
const THEME_JS = `(function(){try{var t=localStorage.getItem('nwr-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}})();`;
const LOOK_JS = `(function(){var root=document.documentElement,box=document.querySelector('.look');if(!box)return;
function mark(){var t=root.dataset.theme||'auto';box.querySelectorAll('button').forEach(function(b){b.classList.toggle('on',b.value===t);b.setAttribute('aria-pressed',b.value===t)})}
box.addEventListener('click',function(e){var b=e.target.closest('button');if(!b)return;var t=b.value;
if(t==='auto')delete root.dataset.theme;else root.dataset.theme=t;try{if(t==='auto')localStorage.removeItem('nwr-theme');else localStorage.setItem('nwr-theme',t)}catch(err){}mark()});mark()})();`;

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
<meta name="theme-color" content="#ecebf2" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#08070c" media="(prefers-color-scheme: dark)">
<title>${esc(title)} · Nowera Gateway</title><script>${THEME_JS}</script><style>${CSS}</style></head><body>`;
  if (!user) return `${head}<main class="login">${flashHtml}${body}</main></body></html>`;
  return `${head}<div class="app">
<aside class="side" aria-label="Navigácia">
  <a class="brand" href="/admin"><i>S</i><span>Nowera Gateway<small>${esc(process.env.ADMIN_HOST || 'signals')}</small></span></a>
  <nav class="nav"><div class="nav-label">Prevádzka</div>
    ${NAV.map((n) => `<a href="${n.href}"${n.key === nav ? ' class="on"' : ''}>${n.label}${n.count && counts[n.count] ? ` <span class="count">${counts[n.count]}</span>` : ''}</a>`).join('')}
    <div class="nav-label" style="margin-top:14px">Správa</div>
    <a href="/admin/pouzivatelia"${nav === 'pouzivatelia' ? ' class="on"' : ''}>Používatelia</a>
    <a href="/admin/zalohy"${nav === 'zalohy' ? ' class="on"' : ''}>Zálohy${backupWarn ? ' <span class="count warn" title="Zálohy nie sú nastavené">!</span>' : ''}</a>
  </nav>
  <div class="side-foot">
    <div class="look" role="group" aria-label="Vzhľad"><button type="button" value="auto">Auto</button><button type="button" value="light">Svetlý</button><button type="button" value="dark">Tmavý</button></div>
    <b>${esc(user.email)}</b>
    <span><a href="/admin/account">Môj účet</a> · <form class="inline" method="post" action="/admin/logout"><button class="linkbtn">Odhlásiť</button></form></span>
  </div>
</aside>
<main class="main">${flashHtml}${body}</main></div><script>${LOOK_JS}</script></body></html>`;
}
