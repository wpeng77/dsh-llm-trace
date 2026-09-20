/**
 * dsh-llm-trace — capture the raw HTTP request and response bodies of model
 * provider calls and serve them on a loopback viewer page.
 *
 * The host half wraps `globalThis.fetch` for the lifetime of its fiber, keeps a
 * count- and byte-bounded ring buffer of matching exchanges, and registers one
 * `prefix` route on `ctx.webServer`. It imports only `node:` builtins, so the
 * Cordis Loader can load it from a path outside every profile's `node_modules`.
 *
 * Response bodies are read from a `Response.clone()`, so the caller receives the
 * original response as soon as the original fetch resolves and a streaming (SSE)
 * body keeps streaming. Bodies are decoded as UTF-8 text; binary payloads are
 * recorded byte-counted but not rendered.
 *
 * @module dsh-llm-trace
 */

import { Buffer } from 'node:buffer'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'llm-trace'

/** The HTTP carrier that owns the viewer route. */
export const inject = ['webServer']

/** URL substrings that select a provider call, matched case-insensitively. */
const DEFAULT_MATCH = ['/chat/completions', '/v1/messages', '/v1/responses', '/v1/completions', '/responses']

/** Viewer mount path; must be an absolute pathname with no trailing slash. */
const DEFAULT_PATH = '/llm-trace'

/** Header names replaced with `<redacted>` before retention. */
const DEFAULT_REDACT_HEADERS = ['authorization', 'api-key', 'x-api-key', 'proxy-authorization', 'cookie', 'set-cookie']

/** Retained prefix of one request body. */
const DEFAULT_MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024

/** Retained prefix of one response body. */
const DEFAULT_MAX_RESPONSE_BODY_BYTES = 32 * 1024 * 1024

/** Exchanges retained before the oldest is evicted. */
const DEFAULT_MAX_RETAINED = 500

/** Total retained body bytes across every exchange. */
const DEFAULT_MAX_JOURNAL_BYTES = 256 * 1024 * 1024

/**
 * Resolve and validate the plugin config. Every deployment-varying value is a
 * config field; a malformed one fails at load rather than at first capture.
 *
 * @param raw - the Loader-supplied config object.
 * @returns the resolved config with every default applied.
 */
function resolveConfig(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('llm-trace: config must be an object')
  }
  const path = raw.path ?? DEFAULT_PATH
  if (typeof path !== 'string' || !path.startsWith('/') || path.endsWith('/')) {
    throw new TypeError('llm-trace: path must be an absolute pathname with no trailing slash')
  }
  const match = raw.match ?? DEFAULT_MATCH
  if (!Array.isArray(match) || match.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    throw new TypeError('llm-trace: match must be an array of non-empty strings')
  }
  const redactHeaders = raw.redactHeaders ?? DEFAULT_REDACT_HEADERS
  if (!Array.isArray(redactHeaders) || redactHeaders.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    throw new TypeError('llm-trace: redactHeaders must be an array of non-empty strings')
  }
  const matchAll = raw.matchAll ?? false
  if (typeof matchAll !== 'boolean') throw new TypeError('llm-trace: matchAll must be a boolean')
  const bounds = {
    maxRequestBodyBytes: raw.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES,
    maxResponseBodyBytes: raw.maxResponseBodyBytes ?? DEFAULT_MAX_RESPONSE_BODY_BYTES,
    maxRetained: raw.maxRetained ?? DEFAULT_MAX_RETAINED,
    maxJournalBytes: raw.maxJournalBytes ?? DEFAULT_MAX_JOURNAL_BYTES,
  }
  for (const [field, value] of Object.entries(bounds)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`llm-trace: ${field} must be a positive safe integer`)
    }
  }
  return { path, match: match.map((entry) => entry.toLowerCase()), matchAll, redactHeaders: redactHeaders.map((h) => h.toLowerCase()), ...bounds }
}

/**
 * A count- and byte-bounded newest-first ring of captured exchanges.
 *
 * @param limits - the resolved retention bounds.
 * @returns the store handle.
 */
function createStore(limits) {
  const entries = []
  let retainedBytes = 0

  const entryBytes = (entry) => entry.requestBodyBytes + entry.responseBodyBytes

  function evictOldest() {
    const evicted = entries.pop()
    evicted.evicted = true
    retainedBytes -= entryBytes(evicted)
  }

  function trim() {
    while (entries.length > limits.maxRetained) evictOldest()
    while (retainedBytes > limits.maxJournalBytes && entries.length > 1) evictOldest()
  }

  return {
    /** Retain one new exchange at the head of the ring. */
    add(entry) {
      entries.unshift(entry)
      retainedBytes += entryBytes(entry)
      trim()
      return entry
    },
    /** Account for body bytes appended to a still-retained exchange. */
    grow(entry, delta) {
      if (entry.evicted) return
      retainedBytes += delta
      trim()
    },
    list() {
      return entries
    },
    find(id) {
      return entries.find((entry) => entry.id === id)
    },
    stats() {
      return { count: entries.length, retainedBytes, maxRetained: limits.maxRetained, maxJournalBytes: limits.maxJournalBytes }
    },
  }
}

/** Render an unknown thrown value as one diagnostic line. */
function renderError(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  try {
    return String(error)
  } catch {
    return 'unrenderable error'
  }
}

/** Whether a thrown value is the platform's abort signal. */
function isAbortError(error) {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** Read the request URL without constructing a `Request` for non-matching calls. */
function requestUrlOf(input) {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  if (typeof Request !== 'undefined' && input instanceof Request) return input.url
  return String(input)
}

/** Render header pairs, replacing every configured secret header's value. */
function headerPairs(headers, redactHeaders) {
  const pairs = []
  for (const [key, value] of headers.entries()) {
    pairs.push([key, redactHeaders.includes(key.toLowerCase()) ? '<redacted>' : value])
  }
  return pairs
}

/**
 * Read one body stream into text, stopping at the byte limit.
 *
 * The caller never awaits this before returning its own response: it runs beside
 * the consumer's read of the original branch of the `tee`, so a streaming body
 * keeps streaming. Cancelling this branch leaves the original branch readable.
 *
 * @param body - the cloned body stream, or `null` for a bodyless message.
 * @param limit - retained prefix in bytes.
 * @param signal - aborts capture when the plugin is disposed.
 * @param onGrow - receives each appended byte count so the store can re-trim.
 * @returns the retained text and its capture outcome.
 */
async function captureText(body, limit, signal, onGrow) {
  if (body === null) return { text: '', bytes: 0, truncated: false }
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let text = ''
  let bytes = 0
  let truncated = false
  const abort = () => { void reader.cancel(signal.reason).catch(() => undefined) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    while (!signal.aborted) {
      const item = await reader.read()
      if (item.done) break
      const remaining = limit - bytes
      if (remaining <= 0) {
        truncated = true
        void reader.cancel('llm-trace body limit reached').catch(() => undefined)
        break
      }
      const value = item.value
      const slice = value.byteLength > remaining ? value.subarray(0, remaining) : value
      bytes += slice.byteLength
      text += decoder.decode(slice, { stream: true })
      onGrow(slice.byteLength)
      if (slice.byteLength < value.byteLength) {
        truncated = true
        void reader.cancel('llm-trace body limit reached').catch(() => undefined)
        break
      }
    }
    text += decoder.decode()
    if (signal.aborted) return { text, bytes, truncated, error: 'llm-trace stopped during body capture' }
    return { text, bytes, truncated }
  } catch (error) {
    return { text, bytes, truncated: true, error: renderError(error) }
  } finally {
    signal.removeEventListener('abort', abort)
    try {
      reader.releaseLock()
    } catch {
      // The reader was already released by the cancel above.
    }
  }
}

/**
 * Install full `globalThis.fetch` capture.
 *
 * Only a URL matching the configured selectors takes the capture path; every
 * other call is forwarded untouched, so unrelated traffic pays no cost and
 * cannot be observed.
 *
 * @param config - the resolved config.
 * @param store - the exchange ring that receives captures.
 * @returns the owner that restores the prior fetch and awaits pending readers.
 */
function installFetchObserver(config, store) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
  const original = globalThis.fetch
  if (typeof original !== 'function') throw new Error('llm-trace: globalThis.fetch is unavailable')
  if (descriptor !== undefined && !('value' in descriptor)) {
    throw new Error('llm-trace: globalThis.fetch is an accessor and cannot be observed safely')
  }

  const controller = new AbortController()
  const pending = new Set()
  let nextId = 0

  const track = (promise) => {
    pending.add(promise)
    void promise.then(
      () => { pending.delete(promise) },
      () => { pending.delete(promise) },
    )
  }

  const selected = (url) => config.matchAll || config.match.some((needle) => url.toLowerCase().includes(needle))

  const observedFetch = async (input, init) => {
    if (!selected(requestUrlOf(input))) return Reflect.apply(original, globalThis, [input, init])

    const request = new Request(input, init)
    const entry = store.add({
      id: `t${++nextId}`,
      url: request.url,
      method: request.method,
      state: 'pending',
      startedAt: Date.now(),
      headersAt: undefined,
      endedAt: undefined,
      requestHeaders: headerPairs(request.headers, config.redactHeaders),
      requestBody: '',
      requestBodyBytes: 0,
      requestTruncated: false,
      requestCaptureError: undefined,
      status: undefined,
      statusText: undefined,
      responseHeaders: [],
      mimeType: '',
      responseBody: '',
      responseBodyBytes: 0,
      responseTruncated: false,
      responseCaptureError: undefined,
      error: undefined,
      canceled: false,
      evicted: false,
    })

    let requestClone
    try {
      requestClone = request.clone()
    } catch (error) {
      entry.requestCaptureError = renderError(error)
    }
    if (requestClone !== undefined) {
      track(captureText(
        requestClone.body,
        config.maxRequestBodyBytes,
        controller.signal,
        (delta) => { entry.requestBodyBytes += delta; store.grow(entry, delta) },
      ).then((outcome) => {
        entry.requestBody = outcome.text
        entry.requestTruncated = outcome.truncated
        if (outcome.error !== undefined) entry.requestCaptureError = outcome.error
      }))
    }

    let response
    try {
      response = await Reflect.apply(original, globalThis, [request])
    } catch (error) {
      entry.state = 'error'
      entry.error = renderError(error)
      entry.canceled = request.signal.aborted || isAbortError(error)
      entry.endedAt = Date.now()
      throw error
    }

    entry.headersAt = Date.now()
    entry.status = response.status
    entry.statusText = response.statusText
    entry.url = response.url === '' ? request.url : response.url
    entry.responseHeaders = headerPairs(response.headers, config.redactHeaders)
    entry.mimeType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? ''

    try {
      const responseClone = response.clone()
      track(captureText(
        responseClone.body,
        config.maxResponseBodyBytes,
        controller.signal,
        (delta) => { entry.responseBodyBytes += delta; store.grow(entry, delta) },
      ).then((outcome) => {
        entry.responseBody = outcome.text
        entry.responseTruncated = outcome.truncated
        if (outcome.error !== undefined) entry.responseCaptureError = outcome.error
        entry.state = 'done'
        entry.endedAt = Date.now()
      }))
    } catch (error) {
      entry.responseCaptureError = renderError(error)
      entry.state = 'done'
      entry.endedAt = Date.now()
    }
    return response
  }

  Object.defineProperty(observedFetch, 'name', { value: original.name, configurable: true })
  Object.defineProperty(observedFetch, 'length', { value: original.length, configurable: true })
  Object.defineProperty(globalThis, 'fetch', descriptor === undefined
    ? { value: observedFetch, writable: true, configurable: true }
    : { ...descriptor, value: observedFetch })

  let stopped
  return {
    /**
     * Restore the prior fetch synchronously, then await pending body readers.
     * A live profile reload must not leave a stale wrapper installed.
     *
     * @returns settlement of every in-flight body reader.
     */
    stop() {
      if (stopped !== undefined) return stopped
      const current = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
      if (current !== undefined && 'value' in current && current.value === observedFetch) {
        if (descriptor === undefined) Reflect.deleteProperty(globalThis, 'fetch')
        else Object.defineProperty(globalThis, 'fetch', descriptor)
      }
      controller.abort()
      stopped = Promise.allSettled([...pending])
      return stopped
    },
  }
}

/** One exchange as the viewer reads it. */
function projectEntry(entry, includeBodies) {
  const projected = {
    id: entry.id,
    url: entry.url,
    method: entry.method,
    state: entry.state,
    startedAt: entry.startedAt,
    headersAt: entry.headersAt,
    endedAt: entry.endedAt,
    status: entry.status,
    statusText: entry.statusText,
    mimeType: entry.mimeType,
    requestBodyBytes: entry.requestBodyBytes,
    responseBodyBytes: entry.responseBodyBytes,
    requestTruncated: entry.requestTruncated,
    responseTruncated: entry.responseTruncated,
    requestCaptureError: entry.requestCaptureError,
    responseCaptureError: entry.responseCaptureError,
    error: entry.error,
    canceled: entry.canceled,
  }
  if (!includeBodies) return projected
  return {
    ...projected,
    requestHeaders: entry.requestHeaders,
    responseHeaders: entry.responseHeaders,
    requestBody: entry.requestBody,
    responseBody: entry.responseBody,
  }
}

/** Write one JSON response and end it. */
function sendJson(res, payload, status = 200) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.byteLength), 'cache-control': 'no-store' })
  res.end(body)
}

/** Write the viewer page and end it. */
function sendHtml(res, html) {
  const body = Buffer.from(html, 'utf8')
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': String(body.byteLength), 'cache-control': 'no-store' })
  res.end(body)
}

/**
 * Render the self-contained viewer page.
 *
 * The page carries no build step and no external asset: it polls the JSON
 * endpoints and renders text bodies. Its inline script uses concatenation rather
 * than template literals so this module's own interpolation stays unambiguous.
 *
 * @param config - the resolved config, for the mount path.
 * @returns the complete HTML document.
 */
function renderPage(config) {
  const base = config.path
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>LLM Trace</title>',
    '<style>',
    ':root{--bg:#0d1117;--panel:#161b22;--line:#30363d;--fg:#e6edf3;--dim:#8b949e;--accent:#58a6ff;--ok:#3fb950;--warn:#d29922;--err:#f85149}',
    '*{box-sizing:border-box}',
    'body{margin:0;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--bg);color:var(--fg);height:100vh;display:flex;flex-direction:column}',
    'header{padding:10px 14px;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:center;flex-wrap:wrap}',
    'h1{font-size:14px;margin:0;font-weight:600}',
    'input[type=search]{background:var(--panel);border:1px solid var(--line);color:var(--fg);border-radius:6px;padding:5px 9px;min-width:220px}',
    'label{color:var(--dim);display:flex;gap:5px;align-items:center;cursor:pointer}',
    'button{background:var(--panel);border:1px solid var(--line);color:var(--fg);border-radius:6px;padding:5px 10px;cursor:pointer}',
    'button:hover{border-color:var(--accent)}',
    'main{flex:1;display:flex;min-height:0}',
    '#list{width:44%;min-width:340px;overflow:auto;border-right:1px solid var(--line)}',
    '#detail{flex:1;overflow:auto;padding:14px}',
    '.row{padding:8px 14px;border-bottom:1px solid var(--line);cursor:pointer}',
    '.row:hover{background:#1c2128}',
    '.row.sel{background:#1f2937;border-left:3px solid var(--accent);padding-left:11px}',
    '.row .u{color:var(--fg);word-break:break-all}',
    '.row .m{color:var(--dim);font-size:12px;display:flex;gap:10px;flex-wrap:wrap;margin-top:2px}',
    '.s2{color:var(--ok)}.s4{color:var(--warn)}.s5{color:var(--err)}',
    '.sec{margin-bottom:16px}',
    '.sec h2{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);margin:0 0 6px}',
    'pre{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:10px;overflow:auto;max-height:46vh;margin:0;white-space:pre-wrap;word-break:break-word}',
    'table{border-collapse:collapse;width:100%}',
    'td{padding:2px 8px 2px 0;vertical-align:top;border-bottom:1px solid #21262d}',
    'td:first-child{color:var(--dim);white-space:nowrap;width:1%}',
    '.tag{font-size:11px;padding:1px 6px;border-radius:999px;border:1px solid var(--line);color:var(--dim)}',
    '.empty{color:var(--dim);padding:24px;text-align:center}',
    '.note{color:var(--dim);font-size:12px}',
    '</style></head><body>',
    '<header>',
    '<h1>LLM Trace</h1>',
    '<input id="q" type="search" placeholder="filter by url / status / method">',
    '<label><input id="auto" type="checkbox" checked> auto-refresh</label>',
    '<button id="refresh">Refresh</button>',
    '<span id="stats" class="note"></span>',
    '</header>',
    '<main><div id="list"><div class="empty">waiting for the first matching model call…</div></div><div id="detail"><div class="empty">select an exchange</div></div></main>',
    '<script>',
    'var BASE = ' + JSON.stringify(base) + ';',
    'var entries = [];',
    'var selected = null;',
    'function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c]})}',
    'function bytes(n){if(n<1024)return n+" B";if(n<1048576)return (n/1024).toFixed(1)+" KiB";return (n/1048576).toFixed(1)+" MiB"}',
    'function statusClass(s){if(s>=500)return "s5";if(s>=400)return "s4";if(s>=200)return "s2";return ""}',
    'function shortPath(u){try{var x=new URL(u);return x.host+x.pathname}catch(e){return u}}',
    'function ms(e){if(e.endedAt&&e.startedAt)return (e.endedAt-e.startedAt)+" ms";if(e.headersAt&&e.startedAt)return (e.headersAt-e.startedAt)+" ms+" ;return "…"}',
    'function matches(e){var q=document.getElementById("q").value.trim().toLowerCase();if(!q)return true;return (e.url+" "+(e.status||"")+" "+e.method).toLowerCase().indexOf(q)>=0}',
    'function renderList(){',
    '  var el=document.getElementById("list");var rows=entries.filter(matches);',
    '  if(!rows.length){el.innerHTML=\'<div class="empty">no matching exchange</div>\';return}',
    '  el.innerHTML=rows.map(function(e){',
    '    return \'<div class="row\'+(e.id===selected?" sel":"")+\'" data-id="\'+e.id+\'">\'',
    '      +\'<div class="u">\'+esc(shortPath(e.url))+\'</div>\'',
    '      +\'<div class="m"><span>\'+esc(e.method)+\'</span>\'',
    '      +\'<span class="\'+statusClass(e.status)+\'">\'+(e.status===undefined?esc(e.state):e.status)+\'</span>\'',
    '      +\'<span>\'+esc(ms(e))+\'</span>\'',
    '      +\'<span>in \'+bytes(e.requestBodyBytes)+\'</span>\'',
    '      +\'<span>out \'+bytes(e.responseBodyBytes)+\'</span>\'',
    '      +\'<span>\'+new Date(e.startedAt).toLocaleTimeString()+\'</span></div></div>\'})',
    '  .join("");',
    '  Array.prototype.forEach.call(el.querySelectorAll(".row"),function(node){node.onclick=function(){selected=node.getAttribute("data-id");renderList();renderDetail()}});',
    '}',
    'function body(kind,text,truncated,err){',
    '  var out="";',
    '  if(err)out+=\'<div class="note">capture error: \'+esc(err)+\'</div>\';',
    '  if(!text)return out+\'<pre>(empty)</pre>\';',
    '  var pretty=text;',
    '  try{pretty=JSON.stringify(JSON.parse(text),null,2)}catch(e){}',
    '  out+=\'<pre>\'+esc(pretty)+\'</pre>\';',
    '  if(truncated)out+=\'<div class="note">truncated at the configured byte limit</div>\';',
    '  return out',
    '}',
    'function headers(pairs){if(!pairs||!pairs.length)return "<pre>(none)</pre>";return "<table>"+pairs.map(function(p){return "<tr><td>"+esc(p[0])+"</td><td>"+esc(p[1])+"</td></tr>"}).join("")+"</table>"}',
    'function renderDetail(){',
    '  var el=document.getElementById("detail");',
    '  if(!selected){el.innerHTML=\'<div class="empty">select an exchange</div>\';return}',
    '  fetch(BASE+"/api/exchange?id="+encodeURIComponent(selected)).then(function(r){return r.json()}).then(function(e){',
    '    if(e.error){el.innerHTML=\'<div class="empty">\'+esc(e.error)+\'</div>\';return}',
    '    el.innerHTML=',
    '      \'<div class="sec"><h2>Exchange</h2><table>\'',
    '      +\'<tr><td>url</td><td>\'+esc(e.url)+\'</td></tr>\'',
    '      +\'<tr><td>method</td><td>\'+esc(e.method)+\'</td></tr>\'',
    '      +\'<tr><td>status</td><td>\'+esc(e.status===undefined?e.state:e.status)+\' \'+esc(e.statusText||"")+\'</td></tr>\'',
    '      +\'<tr><td>duration</td><td>\'+esc(ms(e))+\'</td></tr>\'',
    '      +\'<tr><td>mime</td><td>\'+esc(e.mimeType||"-")+\'</td></tr>\'',
    '      +(e.error?\'<tr><td>error</td><td class="s5">\'+esc(e.error)+\'</td></tr>\':"")',
    '      +\'<tr><td>canceled</td><td>\'+esc(String(!!e.canceled))+\'</td></tr></table></div>\'',
    '      +\'<div class="sec"><h2>Request headers</h2>\'+headers(e.requestHeaders)+\'</div>\'',
    '      +\'<div class="sec"><h2>Request body</h2>\'+body("request",e.requestBody,e.requestTruncated,e.requestCaptureError)+\'</div>\'',
    '      +\'<div class="sec"><h2>Response headers</h2>\'+headers(e.responseHeaders)+\'</div>\'',
    '      +\'<div class="sec"><h2>Response body</h2>\'+body("response",e.responseBody,e.responseTruncated,e.responseCaptureError)+\'</div>\'',
    '      +\'<div class="note">secret headers are stored as &lt;redacted&gt;. bodies are retained verbatim.</div>\';',
    '  })',
    '}',
    'function poll(){',
    '  fetch(BASE+"/api/list").then(function(r){return r.json()}).then(function(d){',
    '    entries=d.entries;',
    '    document.getElementById("stats").textContent=d.stats.count+" / "+d.stats.maxRetained+" retained · "+bytes(d.stats.retainedBytes)+" of "+bytes(d.stats.maxJournalBytes);',
    '    renderList();',
    '  }).catch(function(){document.getElementById("stats").textContent="host unreachable"})',
    '}',
    'document.getElementById("refresh").onclick=poll;',
    'document.getElementById("q").oninput=renderList;',
    'setInterval(function(){if(document.getElementById("auto").checked){poll();if(selected)renderDetail()}},2000);',
    'poll();',
    '</script></body></html>',
  ].join('\n')
}

/**
 * Serve the viewer and its JSON endpoints under the mount path.
 *
 * @param req - the incoming HTTP request.
 * @param res - the response this handler owns.
 * @param config - the resolved config.
 * @param store - the exchange ring.
 */
function handleRoute(req, res, config, store) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const rest = url.pathname.slice(config.path.length)
  if (rest === '' || rest === '/') {
    sendHtml(res, renderPage(config))
    return
  }
  if (rest === '/api/list') {
    sendJson(res, {
      stats: store.stats(),
      entries: store.list().map((entry) => projectEntry(entry, false)),
    })
    return
  }
  if (rest === '/api/exchange') {
    const id = url.searchParams.get('id')
    const entry = id === null ? undefined : store.find(id)
    if (entry === undefined) {
      sendJson(res, { error: `unknown exchange ${id ?? ''}` }, 404)
      return
    }
    sendJson(res, projectEntry(entry, true))
    return
  }
  sendJson(res, { error: `unknown route ${rest}` }, 404)
}

/**
 * Install fetch capture and the viewer route.
 *
 * @param ctx - the plugin context that owns both effects.
 * @param config - the Loader-supplied config.
 */
export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config)
  const store = createStore(resolved)
  const observer = installFetchObserver(resolved, store)

  ctx.effect(() => () => { void observer.stop() })
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: resolved.path,
    handler: (req, res) => { handleRoute(req, res, resolved, store) },
  }))
}
