export const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CSS = `
:root{--bg:#0e1116;--panel:#161b22;--line:#262c36;--fg:#e6edf3;--dim:#8b949e;
--accent:#3b82f6;--ok:#2ea043;--warn:#d29922;--err:#f85149;--radius:8px}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
font:14px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
header{border-bottom:1px solid var(--line);padding:14px 24px;display:flex;
align-items:center;gap:16px;background:var(--panel)}
header .brand{font-weight:650;letter-spacing:-.01em}
header nav{display:flex;gap:16px;margin-left:auto;align-items:center}
main{max-width:1080px;margin:0 auto;padding:28px 24px 64px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:32px 0 12px;color:var(--dim);
text-transform:uppercase;letter-spacing:.06em;font-weight:600}
.sub{color:var(--dim);margin:0 0 24px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);
padding:20px;margin-bottom:20px}
table{width:100%;border-collapse:collapse}
th{text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:.05em;
color:var(--dim);padding:8px 10px;border-bottom:1px solid var(--line);font-weight:600}
td{padding:10px;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:0}
label{display:block;font-size:12px;color:var(--dim);margin:14px 0 5px;font-weight:600}
input,select,textarea{width:100%;padding:9px 11px;background:#0d1117;color:var(--fg);
border:1px solid var(--line);border-radius:6px;font:inherit}
input:focus,select:focus,textarea:focus{outline:2px solid var(--accent);outline-offset:-1px;border-color:transparent}
.hint{font-size:12px;color:var(--dim);margin-top:5px}
button,.btn{display:inline-block;padding:9px 15px;border-radius:6px;border:1px solid var(--line);
background:#21262d;color:var(--fg);font:inherit;font-weight:550;cursor:pointer}
button:hover,.btn:hover{border-color:#3d444d;text-decoration:none}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button.danger{color:var(--err)}
.row{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end}
.row>*{flex:1;min-width:170px}
.actions{margin-top:20px;display:flex;gap:10px;align-items:center}
.pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11.5px;font-weight:600}
.pill.ok{background:rgba(46,160,67,.15);color:var(--ok)}
.pill.pending{background:rgba(210,153,34,.15);color:var(--warn)}
.pill.dead{background:rgba(248,81,73,.15);color:var(--err)}
.pill.off{background:#21262d;color:var(--dim)}
.flash{padding:11px 14px;border-radius:6px;margin-bottom:20px;border:1px solid}
.flash.ok{background:rgba(46,160,67,.1);border-color:rgba(46,160,67,.4);color:#7ee787}
.flash.err{background:rgba(248,81,73,.1);border-color:rgba(248,81,73,.4);color:#ffa198}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
.err-text{color:var(--err);font-size:12px;word-break:break-word;max-width:420px;display:block}
.stats{display:flex;gap:28px;flex-wrap:wrap}
.stat b{display:block;font-size:24px;font-weight:650;letter-spacing:-.02em}
.stat span{font-size:12px;color:var(--dim)}
.empty{color:var(--dim);padding:22px 0;text-align:center}
form.inline{display:inline}
`;

export function page({ title, user, body, flash }) {
  return `<!doctype html><html lang="sk"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)} · Nowera Gateway</title><style>${CSS}</style></head><body>
${user ? `<header><span class="brand">Nowera Gateway</span><nav>
<a href="/admin">Klienti</a><a href="/admin/events">Eventy</a>
<span style="color:var(--dim)">${esc(user.email)}</span>
<form method="post" action="/admin/logout" class="inline"><button>Odhlásiť</button></form>
</nav></header>` : ''}
<main>${flash ? `<div class="flash ${flash.type}">${esc(flash.text)}</div>` : ''}${body}</main>
</body></html>`;
}
