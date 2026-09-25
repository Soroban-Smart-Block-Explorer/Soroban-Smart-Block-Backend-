/**
 * Browser script for the try-it console, served at /api/try/app.js.
 *
 * Embedded as a string so it ships inside dist/ (the runtime image copies
 * only dist/). Plain ES2017, no dependencies, no template literals.
 *
 * The pure logic lives on `TryItCore` (share-link codec, request builder,
 * validation, curl rendering) and is exercised in Node by
 * tests/api/tryit-client.test.ts, which evaluates this exact string in a
 * `vm` context — the code under test is the code the browser runs.
 *
 * Security invariants (enforced here, asserted by tests):
 *  - requests only ever go to the page's own origin under the catalog basePath;
 *  - path params are percent-encoded and dot-segments are rejected, so a value
 *    can never escape its path segment;
 *  - the API key is never written into a share link, the URL, or the DOM;
 *  - response bodies are rendered with textContent (no HTML injection);
 *  - non-GET requests require an explicit confirmation.
 */
export const TRY_IT_CLIENT_SCRIPT = String.raw`(function (global) {
  'use strict';

  var SHARE_PREFIX = 'v1.';
  var MAX_SHARE_CHARS = 8192;
  var MAX_BODY_CHARS = 65536;
  var REQUEST_TIMEOUT_MS = 30000;
  var core = {};

  function b64urlEncode(text) {
    var bytes = new TextEncoder().encode(text);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function b64urlDecode(token) {
    if (!/^[A-Za-z0-9_-]*$/.test(token)) throw new Error('bad encoding');
    var b64 = token.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }

  function isPlainStringMap(v) {
    if (v === undefined) return true;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    return Object.keys(v).every(function (k) {
      return typeof v[k] === 'string';
    });
  }

  function findOperation(catalog, id) {
    for (var i = 0; i < catalog.operations.length; i++) {
      if (catalog.operations[i].id === id) return catalog.operations[i];
    }
    return null;
  }
  core.findOperation = findOperation;

  /** Encode {op, path, query, body} as a URL-fragment-safe token. No auth. */
  core.encodeShare = function (state) {
    var payload = { o: state.op };
    if (state.path && Object.keys(state.path).length) payload.p = state.path;
    if (state.query && Object.keys(state.query).length) payload.q = state.query;
    if (typeof state.body === 'string' && state.body.length) payload.b = state.body;
    var token = SHARE_PREFIX + b64urlEncode(JSON.stringify(payload));
    if (token.length > MAX_SHARE_CHARS) throw new Error('Request too large to share');
    return token;
  };

  /** Decode and validate a share token against the catalog. Never throws. */
  core.decodeShare = function (token, catalog) {
    if (typeof token !== 'string' || token.indexOf(SHARE_PREFIX) !== 0) {
      return { ok: false, error: 'Unsupported share link version' };
    }
    if (token.length > MAX_SHARE_CHARS) return { ok: false, error: 'Share link too large' };
    var raw;
    try {
      raw = JSON.parse(b64urlDecode(token.slice(SHARE_PREFIX.length)));
    } catch (e) {
      return { ok: false, error: 'Share link is corrupted' };
    }
    if (!raw || typeof raw !== 'object' || typeof raw.o !== 'string') {
      return { ok: false, error: 'Share link is corrupted' };
    }
    var op = findOperation(catalog, raw.o);
    if (!op) return { ok: false, error: 'Operation no longer exists: ' + raw.o };
    if (!isPlainStringMap(raw.p) || !isPlainStringMap(raw.q)) {
      return { ok: false, error: 'Share link is corrupted' };
    }
    if (raw.b !== undefined && (typeof raw.b !== 'string' || raw.b.length > MAX_BODY_CHARS)) {
      return { ok: false, error: 'Share link is corrupted' };
    }
    var known = {};
    op.params.forEach(function (p) {
      known[p.in + ':' + p.name] = true;
    });
    var state = { op: op.id, path: {}, query: {}, body: raw.b };
    var dropped = [];
    Object.keys(raw.p || {}).forEach(function (k) {
      if (known['path:' + k]) state.path[k] = raw.p[k];
      else dropped.push(k);
    });
    Object.keys(raw.q || {}).forEach(function (k) {
      if (known['query:' + k]) state.query[k] = raw.q[k];
      else dropped.push(k);
    });
    return { ok: true, state: state, dropped: dropped };
  };

  function coerce(param, rawValue) {
    var v = String(rawValue).trim();
    if (param.type === 'integer') {
      if (!/^-?\d+$/.test(v)) return { error: param.name + ' must be an integer' };
    } else if (param.type === 'number') {
      if (v === '' || isNaN(Number(v))) return { error: param.name + ' must be a number' };
    } else if (param.type === 'boolean') {
      if (v !== 'true' && v !== 'false') return { error: param.name + ' must be true or false' };
    }
    if ((param.type === 'integer' || param.type === 'number') && v !== '') {
      var n = Number(v);
      if (typeof param.minimum === 'number' && n < param.minimum) {
        return { error: param.name + ' must be >= ' + param.minimum };
      }
      if (typeof param.maximum === 'number' && n > param.maximum) {
        return { error: param.name + ' must be <= ' + param.maximum };
      }
    }
    if (param.enum && param.enum.length && param.enum.map(String).indexOf(v) < 0) {
      return { error: param.name + ' must be one of ' + param.enum.join(', ') };
    }
    return { value: v };
  }

  /**
   * Build a same-origin fetch request. Returns {ok:true, url, init, curl} or
   * {ok:false, errors:[...]}. The API key only ever goes into a header.
   */
  core.buildRequest = function (catalog, op, input, apiKey, origin) {
    var errors = [];
    var base = String(catalog.basePath || '');
    if (!/^\/(?!\/)[A-Za-z0-9\/_.-]*$/.test(base)) {
      return { ok: false, errors: ['Refusing non-relative API base path'] };
    }
    var path = op.path;
    var query = [];
    op.params.forEach(function (p) {
      var src = p.in === 'path' ? input.path || {} : input.query || {};
      var raw = src[p.name];
      var empty = raw === undefined || raw === null || String(raw).trim() === '';
      if (empty) {
        if (p.required) errors.push(p.name + ' is required');
        return;
      }
      var c = coerce(p, raw);
      if (c.error) {
        errors.push(c.error);
        return;
      }
      if (p.in === 'path') {
        if (c.value === '.' || c.value === '..') {
          errors.push(p.name + ' must not be a dot segment');
          return;
        }
        path = path.split('{' + p.name + '}').join(encodeURIComponent(c.value));
      } else if (p.in === 'query') {
        query.push(encodeURIComponent(p.name) + '=' + encodeURIComponent(c.value));
      }
    });
    var body;
    if (op.body && typeof input.body === 'string' && input.body.trim() !== '') {
      if (input.body.length > MAX_BODY_CHARS) errors.push('Body is too large');
      else if (op.body.contentType === 'application/json') {
        try {
          body = JSON.stringify(JSON.parse(input.body));
        } catch (e) {
          errors.push('Body is not valid JSON');
        }
      } else body = input.body;
    } else if (op.body && op.body.required) {
      errors.push('Request body is required');
    }
    if (errors.length) return { ok: false, errors: errors };

    var url = new URL(base + path + (query.length ? '?' + query.join('&') : ''), origin);
    if (url.origin !== origin || url.pathname.indexOf(base + '/') !== 0) {
      return { ok: false, errors: ['Refusing to call outside ' + base] };
    }
    var headers = { Accept: 'application/json', 'X-Client': 'try-it' };
    if (body !== undefined) headers['Content-Type'] = op.body.contentType;
    if (apiKey) headers['X-Api-Key'] = String(apiKey);
    return {
      ok: true,
      url: url.toString(),
      init: { method: op.method, headers: headers, body: body, credentials: 'same-origin' },
      curl: core.curlFor(op.method, url.toString(), headers, body),
    };
  };

  function shellQuote(s) {
    return "'" + String(s).replace(/'/g, "'\\''") + "'";
  }

  /** curl equivalent with the API key replaced by an env var reference. */
  core.curlFor = function (method, url, headers, body) {
    var parts = ['curl', '-sS', '-X', method, shellQuote(url)];
    Object.keys(headers).forEach(function (h) {
      if (h === 'X-Client') return;
      var v = h === 'X-Api-Key' ? '$SOROBAN_API_KEY' : headers[h];
      parts.push('-H', h === 'X-Api-Key' ? '"' + h + ': ' + v + '"' : shellQuote(h + ': ' + v));
    });
    if (body !== undefined) parts.push('--data', shellQuote(body));
    return parts.join(' ');
  };

  core.RATE_LIMIT_HEADERS = [
    'x-ratelimit-limit',
    'x-ratelimit-remaining',
    'x-ratelimit-reset',
    'x-ratelimit-tier',
    'retry-after',
    'x-request-id',
    'deprecation',
    'sunset',
  ];

  core.filterOperations = function (catalog, term) {
    var t = String(term || '').toLowerCase().trim();
    if (!t) return catalog.operations.slice();
    return catalog.operations.filter(function (o) {
      return (
        o.path.toLowerCase().indexOf(t) >= 0 ||
        o.summary.toLowerCase().indexOf(t) >= 0 ||
        o.id.toLowerCase().indexOf(t) >= 0 ||
        o.method.toLowerCase() === t
      );
    });
  };

  global.TryItCore = core;

  // ── DOM application ──────────────────────────────────────────────────────
  if (typeof document === 'undefined') return;

  var state = { catalog: null, op: null, apiKey: '' };
  var KEY_STORAGE = 'soroban-tryit-api-key';

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') node.textContent = attrs[k];
      else if (k === 'className') node.className = attrs[k];
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) {
      if (c) node.appendChild(c);
    });
    return node;
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function setStatus(text, isError) {
    var s = byId('status');
    s.textContent = text;
    s.className = isError ? 'status error' : 'status';
  }

  function renderList(term) {
    var list = byId('ops');
    list.textContent = '';
    var ops = core.filterOperations(state.catalog, term);
    var byTag = {};
    ops.forEach(function (o) {
      (byTag[o.tags[0]] = byTag[o.tags[0]] || []).push(o);
    });
    Object.keys(byTag)
      .sort()
      .forEach(function (tag) {
        var group = el('details', { open: '' }, [el('summary', { text: tag })]);
        byTag[tag].forEach(function (o) {
          var btn = el('button', { type: 'button', className: 'op' }, [
            el('span', { className: 'm m-' + o.method.toLowerCase(), text: o.method }),
            el('span', { className: 'p', text: o.path }),
          ]);
          btn.addEventListener('click', function () {
            selectOperation(o.id, null);
          });
          group.appendChild(btn);
        });
        list.appendChild(group);
      });
    byId('count').textContent = ops.length + ' / ' + state.catalog.operationCount + ' operations';
  }

  function fieldFor(p, value) {
    var id = 'f-' + p.in + '-' + p.name;
    var input;
    if (p.enum && p.enum.length) {
      input = el('select', { id: id }, [el('option', { value: '', text: '' })]);
      p.enum.forEach(function (v) {
        input.appendChild(el('option', { value: String(v), text: String(v) }));
      });
    } else {
      input = el('input', { id: id, type: 'text', autocomplete: 'off', spellcheck: 'false' });
    }
    if (value !== undefined) input.value = value;
    else if (p.default !== undefined && p.default !== null) input.placeholder = String(p.default);
    input.dataset.in = p.in;
    input.dataset.name = p.name;
    var label = el('label', { for: id }, [
      el('code', { text: p.name }),
      el('span', { className: 'meta', text: ' ' + p.in + ' · ' + p.type + (p.required ? ' · required' : '') }),
    ]);
    return el('div', { className: 'field' }, [label, input, p.description ? el('small', { text: p.description }) : null]);
  }

  function selectOperation(id, shared) {
    var op = core.findOperation(state.catalog, id);
    if (!op) return;
    state.op = op;
    var pane = byId('op');
    pane.textContent = '';
    pane.appendChild(
      el('h2', {}, [
        el('span', { className: 'm m-' + op.method.toLowerCase(), text: op.method }),
        el('code', { text: ' ' + state.catalog.basePath + op.path }),
      ]),
    );
    if (op.deprecated) pane.appendChild(el('p', { className: 'warn', text: 'Deprecated operation' }));
    if (op.summary) pane.appendChild(el('p', { text: op.summary }));
    if (op.description) pane.appendChild(el('p', { className: 'desc', text: op.description }));
    var form = el('form', { id: 'form' });
    op.params.forEach(function (p) {
      var src = shared ? (p.in === 'path' ? shared.path : shared.query) : null;
      form.appendChild(fieldFor(p, src ? src[p.name] : undefined));
    });
    if (op.body) {
      var ta = el('textarea', { id: 'body', rows: '10', spellcheck: 'false' });
      ta.value = shared && typeof shared.body === 'string' ? shared.body : op.body.example;
      form.appendChild(el('div', { className: 'field' }, [el('label', { for: 'body', text: 'Body (' + op.body.contentType + ')' }), ta]));
    }
    if (op.method !== 'GET') {
      form.appendChild(
        el('label', { className: 'confirm' }, [
          el('input', { type: 'checkbox', id: 'confirm' }),
          el('span', { text: ' I understand this ' + op.method + ' request may change data' }),
        ]),
      );
    }
    var send = el('button', { type: 'submit', className: 'primary', text: 'Send request' });
    var share = el('button', { type: 'button', text: 'Copy share link' });
    share.addEventListener('click', onShare);
    form.appendChild(el('div', { className: 'actions' }, [send, share]));
    form.addEventListener('submit', onSend);
    pane.appendChild(form);
    pane.appendChild(el('pre', { id: 'curl', className: 'curl' }));
    pane.appendChild(el('div', { id: 'response' }));
    setStatus('');
  }

  function collectInput() {
    var input = { path: {}, query: {}, body: undefined };
    Array.prototype.forEach.call(document.querySelectorAll('#form [data-name]'), function (f) {
      if (f.value !== '') input[f.dataset.in][f.dataset.name] = f.value;
    });
    var body = byId('body');
    if (body) input.body = body.value;
    return input;
  }

  function onShare() {
    var input = collectInput();
    try {
      var token = core.encodeShare({ op: state.op.id, path: input.path, query: input.query, body: input.body });
      var link = location.origin + location.pathname + '#try=' + token;
      history.replaceState(null, '', '#try=' + token);
      if (navigator.clipboard) navigator.clipboard.writeText(link).catch(function () {});
      setStatus('Share link copied (API key is never included)');
    } catch (e) {
      setStatus(e.message, true);
    }
  }

  function onSend(ev) {
    ev.preventDefault();
    var op = state.op;
    var confirmBox = byId('confirm');
    if (confirmBox && !confirmBox.checked) {
      setStatus('Tick the confirmation box to send a ' + op.method + ' request', true);
      return;
    }
    var keyInput = byId('api-key');
    var built = core.buildRequest(state.catalog, op, collectInput(), keyInput.value, location.origin);
    if (!built.ok) {
      setStatus(built.errors.join('; '), true);
      return;
    }
    byId('curl').textContent = built.curl;
    var ctrl = new AbortController();
    var timer = setTimeout(function () {
      ctrl.abort();
    }, REQUEST_TIMEOUT_MS);
    built.init.signal = ctrl.signal;
    var started = performance.now();
    setStatus('Sending…');
    fetch(built.url, built.init)
      .then(function (res) {
        return res.text().then(function (text) {
          renderResponse(res, text, Math.round(performance.now() - started));
        });
      })
      .catch(function (err) {
        setStatus(err.name === 'AbortError' ? 'Timed out after 30 s' : 'Network error: ' + err.message, true);
      })
      .then(function () {
        clearTimeout(timer);
      });
  }

  function renderResponse(res, text, ms) {
    var out = byId('response');
    out.textContent = '';
    var cls = res.status >= 500 ? 'error' : res.status >= 400 ? 'warn' : 'ok';
    out.appendChild(el('h3', { className: cls, text: res.status + ' ' + res.statusText + ' · ' + ms + ' ms' }));
    var dl = el('dl', { className: 'headers' });
    core.RATE_LIMIT_HEADERS.forEach(function (h) {
      var v = res.headers.get(h);
      if (v !== null) {
        dl.appendChild(el('dt', { text: h }));
        dl.appendChild(el('dd', { text: v }));
      }
    });
    out.appendChild(dl);
    var pretty = text;
    try {
      pretty = JSON.stringify(JSON.parse(text), null, 2);
    } catch (e) {
      /* not JSON — show raw text */
    }
    out.appendChild(el('pre', { className: 'body', text: pretty }));
    setStatus(res.status === 429 ? 'Rate limited — see Retry-After' : '');
  }

  function restoreKey() {
    var keyInput = byId('api-key');
    var remember = byId('remember-key');
    try {
      var saved = sessionStorage.getItem(KEY_STORAGE);
      if (saved) {
        keyInput.value = saved;
        remember.checked = true;
      }
    } catch (e) {
      /* storage unavailable (private mode) — key stays in memory only */
    }
    function persist() {
      try {
        if (remember.checked && keyInput.value) sessionStorage.setItem(KEY_STORAGE, keyInput.value);
        else sessionStorage.removeItem(KEY_STORAGE);
      } catch (e) {
        /* ignore */
      }
    }
    keyInput.addEventListener('change', persist);
    remember.addEventListener('change', persist);
  }

  function applyHash() {
    var m = /[#&]try=([^&]+)/.exec(location.hash);
    if (!m) return;
    var decoded = core.decodeShare(decodeURIComponent(m[1]), state.catalog);
    if (!decoded.ok) {
      setStatus(decoded.error, true);
      return;
    }
    selectOperation(decoded.state.op, decoded.state);
    if (decoded.dropped.length) setStatus('Ignored unknown parameters: ' + decoded.dropped.join(', '), true);
  }

  function boot() {
    restoreKey();
    byId('search').addEventListener('input', function (e) {
      renderList(e.target.value);
    });
    fetch('/api/try/catalog.json', { headers: { Accept: 'application/json' } })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (catalog) {
        state.catalog = catalog;
        byId('title').textContent = catalog.title + ' · v' + catalog.specVersion;
        renderList('');
        applyHash();
        window.addEventListener('hashchange', applyHash);
      })
      .catch(function (err) {
        setStatus('Could not load the API catalog (' + err.message + '). The raw spec is at ' + '/api/v1/openapi.json', true);
      });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof window !== 'undefined' ? window : globalThis);
`;
