/**
 * dsh-llm-trace — capture the raw HTTP request and response bodies of model
 * provider calls and expose them to a Conversation View tab and a loopback
 * viewer page.
 *
 * The host half wraps `globalThis.fetch` for the lifetime of its fiber, keeps a
 * count- and byte-bounded ring buffer of matching exchanges, and registers one
 * `prefix` route on `ctx.webServer`. An `llm/stream` listener runs every pull of
 * the adapter stream inside `AsyncLocalStorage.run(sessionId, …)`, which is what
 * lets the tab show one session's traffic. It imports only `node:` builtins, so
 * the Cordis Loader can load it from a path outside every profile's `node_modules`.
 *
 * Response bodies are read from a `Response.clone()`, so the caller receives the
 * original response as soon as the original fetch resolves and a streaming (SSE)
 * body keeps streaming. Bodies are decoded as UTF-8 text; binary payloads are
 * recorded byte-counted but not rendered.
 *
 * @module dsh-llm-trace
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'llm-trace'

/** The HTTP carrier that owns the viewer route. */
export const inject = ['webServer', 'llm']

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
 * @param sessionScope - carries the session id of the model call whose adapter
 *   is currently dispatching, so one capture can be attributed to a session.
 * @returns the owner that restores the prior fetch and awaits pending readers.
 */
function installFetchObserver(config, store, sessionScope) {
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
      sessionId: sessionScope.getStore(),
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
    sessionId: entry.sessionId,
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

/** Absolute path of the viewer document, resolved beside this module. */
const PAGE_PATH = fileURLToPath(new URL('./page.html', import.meta.url))

/** Directory of the browser modules both faces `import()`, resolved beside this module. */
const ASSET_DIR = fileURLToPath(new URL('./browser/', import.meta.url))

/**
 * Browser modules the asset route will serve.
 *
 * A closed allowlist, not a path join: the route is reachable by any caller the
 * Web host admits, and a name-derived path would let one walk out of the
 * directory.
 */
const ASSETS = new Set(['json-tree.js', 'sse.js'])

/**
 * Read the viewer document.
 *
 * The page is read per request rather than captured at load, so editing the
 * markup takes effect on the next browser refresh without reloading this module.
 * Node's ESM cache is keyed by resolved path and the Cordis profile reload does
 * not invalidate it, so a page baked into this module would need a host restart
 * to change.
 *
 * @returns the complete HTML document.
 */
function renderPage() {
  return readFileSync(PAGE_PATH, 'utf8')
}

/**
 * Serve one shared browser module.
 *
 * Read per request for the same reason the viewer document is: both faces load
 * these through the browser's module cache, so an edit is live on the next
 * refresh and never needs a host restart.
 *
 * @param res - the response this handler owns.
 * @param name - the requested module name.
 */
function sendAsset(res, name) {
  if (!ASSETS.has(name)) {
    sendJson(res, { error: `unknown asset ${name}` }, 404)
    return
  }
  const body = readFileSync(ASSET_DIR + name)
  res.writeHead(200, {
    'content-type': 'text/javascript; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  })
  res.end(body)
}
/**
 * Report whether the Web client registered this package's browser half.
 *
 * The client-modules registry is an optional capability of the Web stack, so the
 * lookup is a `ctx.get` read: a composition without it still serves the HTTP
 * viewer. This answers the one question the browser cannot answer for itself —
 * whether the Conversation View tab had a bundle to load.
 *
 * @param ctx - the plugin context.
 * @returns the client-row diagnostics carried on the list response.
 */
function clientDiagnostics(ctx) {
  const registry = ctx.get('clientModules')
  if (registry === undefined) return { available: false }
  let rows = []
  try {
    rows = registry.graph().entries.map((entry) => entry.id)
  } catch (error) {
    return { available: true, registered: false, error: renderError(error) }
  }
  const clientPath = registry.clientPath('dsh-llm-trace')
  return { available: true, registered: clientPath !== undefined, clientPath: clientPath ?? null, rows: rows.filter((id) => id.includes('llm-trace')) }
}

/**
 * Apply the Host/Origin fence and browser authentication the Web host puts in
 * front of its own routes.
 *
 * A named `webServer` route is registered beside that guard rather than behind
 * it, so without this call the viewer would hand captured prompts to any caller
 * that can reach the port. The `connection` service is an optional capability of
 * the Web stack, so this is a `ctx.get` read: a composition without it has no
 * browser session to check and serves the viewer unguarded.
 *
 * @param ctx - the plugin context.
 * @param req - the incoming HTTP request.
 * @param res - the response this handler owns.
 * @returns true when the request was rejected and the response is complete.
 */
function rejectUnauthenticated(ctx, req, res) {
  const connection = ctx.get('connection')
  if (connection === undefined) return false
  const rejection = connection.requestRejection(req)
  if (rejection === undefined) return false
  res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end(rejection === 401 ? 'unauthorized\n' : 'forbidden\n')
  return true
}

/**
 * Serve the viewer and its JSON endpoints under the mount path.
 *
 * @param req - the incoming HTTP request.
 * @param res - the response this handler owns.
 * @param config - the resolved config.
 * @param store - the exchange ring.
 * @param ctx - the plugin context, for the client-row diagnostic.
 */
function handleRoute(req, res, config, store, ctx) {
  if (rejectUnauthenticated(ctx, req, res)) return
  const url = new URL(req.url ?? '/', 'http://localhost')
  const rest = url.pathname.slice(config.path.length)
  if (rest === '' || rest === '/') {
    sendHtml(res, renderPage())
    return
  }
  if (rest.startsWith('/assets/')) {
    sendAsset(res, rest.slice('/assets/'.length))
    return
  }
  if (rest === '/api/list') {
    const session = url.searchParams.get('session')
    const entries = store.list().filter((entry) => session === null || entry.sessionId === session)
    sendJson(res, {
      stats: store.stats(),
      client: clientDiagnostics(ctx),
      sessions: [...new Set(store.list().map((entry) => entry.sessionId).filter((id) => id !== undefined))],
      entries: entries.map((entry) => projectEntry(entry, false)),
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
 * Install session attribution, fetch capture, and the viewer route.
 *
 * `llm/stream` carries the session id of every loop-built model call, and the
 * adapter's network request happens while the returned stream is pulled. Running
 * each pull inside `AsyncLocalStorage.run` therefore makes the id readable from
 * the `fetch` wrapper below the adapter, which is the only place the wire request
 * exists. Attribution stays correct for interleaved subagent calls because each
 * pull installs its own scope.
 *
 * @param ctx - the plugin context that owns every effect.
 * @param config - the Loader-supplied config.
 */
export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config)
  const store = createStore(resolved)
  const sessionScope = new AsyncLocalStorage()
  const observer = installFetchObserver(resolved, store, sessionScope)

  ctx.on('llm/stream', (options, next) => {
    const sessionId = options.sessionId
    if (sessionId === undefined) return next()
    const inner = next()
    return (async function* attributed() {
      const iterator = inner[Symbol.asyncIterator]()
      for (;;) {
        const step = await sessionScope.run(sessionId, () => iterator.next())
        if (step.done) break
        yield step.value
      }
    })()
  })

  ctx.effect(() => () => { void observer.stop() })
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: resolved.path,
    handler: (req, res) => { handleRoute(req, res, resolved, store, ctx) },
  }))
}
