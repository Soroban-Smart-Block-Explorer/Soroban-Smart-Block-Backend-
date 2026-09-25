/**
 * HTML shell for the try-it console (/api/try). No inline script: the app is
 * loaded from /api/try/app.js so the global CSP (`script-src 'self'`) holds.
 */
export const TRY_IT_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>API Console · Soroban Explorer</title>
<style>
  :root { --bg:#fbfbfa; --fg:#1d1d1b; --muted:#6b6b66; --line:#e3e2de; --accent:#2b59c3; --ok:#1f7a3f; --warn:#9a6700; --err:#b42318; --code:#f3f2ef; }
  @media (prefers-color-scheme: dark) { :root { --bg:#161615; --fg:#ecebe7; --muted:#a3a29c; --line:#2e2d2a; --accent:#7ea2ff; --ok:#5cc583; --warn:#e3b341; --err:#ff7b72; --code:#21201e; } }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; background:var(--bg); color:var(--fg); }
  header { display:flex; flex-wrap:wrap; gap:12px; align-items:center; padding:12px 16px; border-bottom:1px solid var(--line); }
  header h1 { font-size:16px; margin:0; flex:1 1 auto; }
  header input[type=password] { width:min(320px, 100%); }
  main { display:grid; grid-template-columns:minmax(260px, 360px) 1fr; min-height:calc(100vh - 58px); }
  @media (max-width: 800px) { main { grid-template-columns:1fr; } #list { max-height:40vh; } }
  #list { border-right:1px solid var(--line); overflow:auto; padding:12px 16px; }
  #pane { padding:16px; overflow:auto; min-width:0; }
  input, select, textarea { font:inherit; color:inherit; background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:6px 8px; width:100%; }
  textarea, pre, code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:13px; }
  details summary { cursor:pointer; font-weight:600; margin:8px 0 4px; }
  button { font:inherit; border:1px solid var(--line); border-radius:6px; padding:6px 12px; background:var(--code); color:inherit; cursor:pointer; }
  button.primary { background:var(--accent); color:#fff; border-color:var(--accent); }
  button.op { display:flex; gap:8px; width:100%; text-align:left; background:none; border:none; padding:3px 4px; }
  button.op:hover { background:var(--code); }
  .p { overflow-wrap:anywhere; }
  .m { font:600 11px/1.8 ui-monospace, monospace; min-width:52px; text-align:center; border-radius:4px; background:var(--code); }
  .m-get { color:var(--ok); } .m-post { color:var(--accent); } .m-delete { color:var(--err); } .m-put, .m-patch { color:var(--warn); }
  .field { margin:10px 0; } .field small { color:var(--muted); display:block; }
  .meta { color:var(--muted); }
  .actions { display:flex; flex-wrap:wrap; gap:8px; margin:12px 0; }
  .confirm { display:flex; gap:6px; align-items:center; } .confirm input { width:auto; }
  pre { background:var(--code); padding:10px; border-radius:6px; overflow-x:auto; white-space:pre-wrap; overflow-wrap:anywhere; }
  .status { min-height:1.5em; color:var(--muted); } .error { color:var(--err); } .warn { color:var(--warn); } .ok { color:var(--ok); }
  dl.headers { display:grid; grid-template-columns:max-content 1fr; gap:2px 12px; } dl.headers dt { color:var(--muted); }
  #count { color:var(--muted); font-size:12px; }
</style>
</head>
<body>
<header>
  <h1 id="title">API Console</h1>
  <label for="api-key" class="meta">API key</label>
  <input id="api-key" type="password" autocomplete="off" placeholder="optional — public tier without a key">
  <label class="confirm meta"><input id="remember-key" type="checkbox"> remember for this tab</label>
</header>
<main>
  <nav id="list">
    <input id="search" type="search" placeholder="Filter by path, summary or method" aria-label="Filter operations">
    <div id="count"></div>
    <div id="ops"></div>
  </nav>
  <section id="pane">
    <p class="status" id="status" role="status">Loading API catalog…</p>
    <div id="op">
      <p>Pick an operation to build a request. Requests run from your browser against this server with your API key and count against your rate limit. Share links never include the key.</p>
    </div>
  </section>
</main>
<noscript><p style="padding:16px">The console needs JavaScript. The OpenAPI spec is at <a href="/api/v1/openapi.json">/api/v1/openapi.json</a>.</p></noscript>
<script src="/api/try/app.js" defer></script>
</body>
</html>
`;
