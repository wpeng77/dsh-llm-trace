/**
 * End-to-end smoke test for dsh-llm-trace.
 *
 * Runs a real local HTTP server that streams SSE like an OpenAI-compatible
 * provider, installs the plugin against a fake Cordis context, and asserts the
 * capture, the streaming behavior, header redaction, selector filtering, and
 * fetch restoration.
 */

import { createServer } from 'node:http'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

const CHUNKS = ['data: {"a":1}\n\n', 'data: {"b":2}\n\n', 'data: {"c":3}\n\n', 'data: [DONE]\n\n']

/** Serve an OpenAI-compatible SSE stream that pauses between chunks. */
function startProvider() {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (piece) => { body += piece })
    req.on('end', async () => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-echo-len': String(body.length) })
      for (const chunk of CHUNKS) {
        res.write(chunk)
        await new Promise((resolve) => { setTimeout(resolve, 40) })
      }
      res.end()
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

/** A Cordis context double that records the registered route, listeners, and disposers. */
function fakeContext() {
  const disposers = []
  const routes = []
  const listeners = {}
  const services = {}
  return {
    disposers,
    routes,
    listeners,
    services,
    effect(factory) { disposers.push(factory()) },
    on(event, handler) { (listeners[event] ??= []).push(handler) },
    get(name) { return services[name] },
    webServer: {
      register(route) { routes.push(route); return () => { routes.splice(routes.indexOf(route), 1) } },
    },
  }
}

/** Invoke the registered route handler and collect its response. */
async function callRoute(route, pathname, headers = {}) {
  const req = { url: pathname, headers }
  const chunks = []
  const res = {
    status: 0,
    headers: {},
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(body) {
      if (body === undefined || body === null) return
      chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8'))
    },
  }
  await route.handler(req, res)
  return { status: res.status, headers: res.headers, body: Buffer.concat(chunks.filter(Boolean)).toString('utf8') }
}

const { server, port } = await startProvider()
const ctx = fakeContext()
const originalFetch = globalThis.fetch

apply(ctx, { match: ['/chat/completions'], path: '/llm-trace' })

assert.equal(ctx.routes.length, 1, 'the plugin registers exactly one route')
assert.equal(ctx.routes[0].kind, 'prefix')
assert.equal(ctx.routes[0].path, '/llm-trace')
assert.notEqual(globalThis.fetch, originalFetch, 'globalThis.fetch is wrapped')

// --- streaming must not be delayed by capture ------------------------------
const started = Date.now()
const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer super-secret' },
  body: JSON.stringify({ model: 'test-model', stream: true }),
})
assert.equal(response.status, 200)

const arrivals = []
const decoder = new TextDecoder()
let received = ''
for await (const piece of response.body) {
  arrivals.push(Date.now() - started)
  received += decoder.decode(piece, { stream: true })
}
received += decoder.decode()
assert.equal(received, CHUNKS.join(''), 'the consumer receives every byte unchanged')
assert.ok(arrivals.length >= 4, `the consumer sees each chunk separately, saw ${arrivals.length}`)
assert.ok(
  arrivals[arrivals.length - 1] - arrivals[0] >= 100,
  `chunks arrive incrementally rather than buffered, spread ${arrivals[arrivals.length - 1] - arrivals[0]} ms`,
)

// --- the capture settles ----------------------------------------------------
await new Promise((resolve) => { setTimeout(resolve, 250) })

const list = await callRoute(ctx.routes[0], '/llm-trace/api/list')
assert.equal(list.status, 200)
const listed = JSON.parse(list.body)
assert.equal(listed.entries.length, 1, 'the matching call was captured')
assert.equal(listed.entries[0].state, 'done', 'the exchange reached a terminal state')
assert.equal(listed.entries[0].status, 200)
assert.equal(listed.entries[0].responseBodyBytes, Buffer.byteLength(CHUNKS.join('')))

const detail = await callRoute(ctx.routes[0], `/llm-trace/api/exchange?id=${listed.entries[0].id}`)
const entry = JSON.parse(detail.body)
assert.equal(entry.requestBody, JSON.stringify({ model: 'test-model', stream: true }), 'the request body is captured verbatim')
assert.equal(entry.responseBody, CHUNKS.join(''), 'the response body is captured verbatim')
assert.equal(entry.mimeType, 'text/event-stream')
assert.equal(entry.requestTruncated, false)

const auth = entry.requestHeaders.find(([key]) => key.toLowerCase() === 'authorization')
assert.deepEqual(auth, ['authorization', '<redacted>'], 'the authorization header is redacted')

// --- the page renders -------------------------------------------------------
const page = await callRoute(ctx.routes[0], '/llm-trace')
assert.equal(page.status, 200)
assert.ok(page.body.startsWith('<!doctype html>'), 'the viewer page is served at the mount path')
assert.ok(page.body.includes('var BASE = location.pathname'), 'the page derives the mount path from its own URL')
assert.ok(page.body.includes("'/api/list'"), 'the page points at the JSON endpoints')

// --- the page owns exactly one scroll container in the detail pane ----------
assert.ok(/#pane\{flex:1;min-height:0;overflow:auto/.test(page.body), 'the detail pane owns the single scroller')
assert.ok(!/pre\{[^}]*overflow:auto/.test(page.body), 'a body panel does not nest its own scroller')

// --- the SSE assembler drops the per-chunk envelope -------------------------
// --- the shared browser modules are served and are the single implementation --
const script = /<script type="module">([\s\S]*?)<\/script>/.exec(page.body)[1]
assert.ok(script.includes("await import(BASE + '/assets/sse.js')"), 'the page imports the shared SSE module')
assert.ok(script.includes("await import(BASE + '/assets/json-tree.js')"), 'the page imports the shared tree module')
assert.ok(!script.includes('function assembleSse'), 'the page carries no assembler of its own')

const sseAsset = await callRoute(ctx.routes[0], '/llm-trace/assets/sse.js')
assert.equal(sseAsset.status, 200, 'the shared SSE module is served')
assert.equal(sseAsset.headers['content-type'], 'text/javascript; charset=utf-8')
assert.ok(sseAsset.body.includes('export function assembleSse'), 'the served module exports the assembler')

const treeAsset = await callRoute(ctx.routes[0], '/llm-trace/assets/json-tree.js')
assert.equal(treeAsset.status, 200, 'the shared tree module is served')
assert.ok(treeAsset.body.includes('export function flatten'), 'the served module exports the flattener')

// A name-derived path would let a caller walk out of the asset directory.
assert.equal((await callRoute(ctx.routes[0], '/llm-trace/assets/../index.js')).status, 404, 'the asset route is an allowlist')
assert.equal((await callRoute(ctx.routes[0], '/llm-trace/assets/nope.js')).status, 404, 'an unknown asset is refused')

const { assembleSse } = await import('../lib/browser/sse.js')

/** Build one provider chunk carrying a delta, mirroring the real wire format. */
function chunk(delta, extra = {}) {
  return `data: ${JSON.stringify({
    choices: [{ delta, index: 0, ...extra }],
    created: 1,
    id: 'chatcmpl-0123456789abcdef0123456789abcdef',
    model: 'test-model',
    object: 'chat.completion.chunk',
    usage: null,
  })}\n\n`
}

const sse = [
  chunk({ content: '', reasoning_content: '', role: 'assistant' }),
  chunk({ reasoning_content: 'Let me ' }),
  chunk({ reasoning_content: 'think.' }),
  chunk({ content: 'Hello ' }),
  chunk({ content: 'world' }),
  chunk({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"pa' } }] }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] }),
  chunk({ tool_calls: [{ index: 1, function: { name: 'grep', arguments: '{"q":"x"}' } }] }),
  chunk({}, { finish_reason: 'tool_calls' }),
  `data: ${JSON.stringify({ choices: [], usage: { completion_tokens: 9, prompt_tokens: 100, total_tokens: 109 } })}\n\n`,
  'data: [DONE]\n\n',
].join('')

const assembled = assembleSse(sse)
assert.equal(assembled.reasoning, 'Let me think.', 'reasoning deltas concatenate')
assert.equal(assembled.content, 'Hello world', 'content deltas concatenate')
assert.equal(assembled.tools.length, 2, 'tool calls group by their stream index')
assert.equal(assembled.tools[0].name, 'read_file')
assert.equal(assembled.tools[0].args, '{"path":"a.txt"}', 'tool-call argument fragments reassemble')
assert.equal(assembled.tools[1].name, 'grep')
assert.equal(assembled.finish, 'tool_calls')
assert.equal(assembled.usage.total_tokens, 109)
assert.equal(assembled.chunks, 10)
assert.equal(assembled.done, true)
assert.equal(assembled.broken, 0)

// The envelope dwarfs the payload on the real wire, which is why the pane
// defaults to the assembled view.
assert.ok(sse.length > 1500, `the fixture carries real envelope weight, got ${sse.length}`)
assert.ok(assembled.content.length + assembled.reasoning.length < 30)

const cut = assembleSse(`${sse}data: {"choices":[{"delta":{"content":"tru`)
assert.equal(cut.broken, 1, 'a body cut at the capture limit reports one incomplete trailing chunk')

// --- a non-matching call is never observed ----------------------------------
await fetch(`http://127.0.0.1:${port}/unrelated`, { method: 'POST', body: 'nope' })
await new Promise((resolve) => { setTimeout(resolve, 60) })
const after = JSON.parse((await callRoute(ctx.routes[0], '/llm-trace/api/list')).body)
assert.equal(after.entries.length, 1, 'a non-matching URL is not captured')

// --- unknown exchange and unknown route answer 404 --------------------------
assert.equal((await callRoute(ctx.routes[0], '/llm-trace/api/exchange?id=nope')).status, 404)
assert.equal((await callRoute(ctx.routes[0], '/llm-trace/nope')).status, 404)

// --- session attribution through llm/stream ---------------------------------
assert.equal(ctx.listeners['llm/stream']?.length, 1, 'the plugin listens on the llm/stream waterfall')

/** Pull one session-attributed adapter stream, whose fetch runs on the first pull. */
async function pullAttributed(sessionId, marker) {
  const listener = ctx.listeners['llm/stream'][0]
  const stream = listener({ sessionId }, () => (async function* () {
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({ marker }),
    })
    await response.text()
    yield { type: 'finish', reason: { kind: 'stop' } }
  })())
  const seen = []
  for await (const chunk of stream) seen.push(chunk)
  return seen
}

// Interleaved pulls must each keep their own scope.
const [a, b] = await Promise.all([pullAttributed('sess-a', 1), pullAttributed('sess-b', 2)])
assert.equal(a.length, 1, 'the waterfall wrapper forwards every chunk')
assert.equal(b.length, 1)
await new Promise((resolve) => { setTimeout(resolve, 200) })

const listAll = JSON.parse((await callRoute(ctx.routes[0], '/llm-trace/api/list')).body)
assert.deepEqual(listAll.sessions.sort(), ['sess-a', 'sess-b'], 'both sessions are reported')

const onlyA = JSON.parse((await callRoute(ctx.routes[0], '/llm-trace/api/list?session=sess-a')).body)
assert.equal(onlyA.entries.length, 1, 'the session filter selects one attributed call')
assert.equal(onlyA.entries[0].sessionId, 'sess-a', 'the capture carries its own session id')

const detailA = JSON.parse((await callRoute(ctx.routes[0], `/llm-trace/api/exchange?id=${onlyA.entries[0].id}`)).body)
assert.equal(JSON.parse(detailA.requestBody).marker, 1, 'interleaved calls are not cross-attributed')

const onlyB = JSON.parse((await callRoute(ctx.routes[0], '/llm-trace/api/list?session=sess-b')).body)
assert.equal(onlyB.entries.length, 1)
const detailB = JSON.parse((await callRoute(ctx.routes[0], `/llm-trace/api/exchange?id=${onlyB.entries[0].id}`)).body)
assert.equal(JSON.parse(detailB.requestBody).marker, 2)

assert.equal(
  JSON.parse((await callRoute(ctx.routes[0], '/llm-trace/api/list?session=nope')).body).entries.length,
  0,
  'an unknown session id selects nothing',
)
// A call made outside any session scope keeps no attribution.
assert.equal(listAll.entries.find((e) => e.id === 't1').sessionId, undefined)

// --- the viewer applies the Web host's browser-authentication guard ---------
// A named webServer route is registered beside that guard, not behind it, so the
// handler has to apply it or captured prompts leak to any caller reaching the port.
ctx.services.connection = {
  requestRejection(request) {
    return request.headers['x-test-unauthenticated'] === '1' ? 401 : undefined
  },
}
const rejected = await callRoute(ctx.routes[0], '/llm-trace', { 'x-test-unauthenticated': '1' })
assert.equal(rejected.status, 401, 'an unauthenticated request is rejected')
assert.ok(!rejected.body.includes('<!doctype html>'), 'the viewer document is not served to a rejected caller')
assert.equal((await callRoute(ctx.routes[0], '/llm-trace/api/list', { 'x-test-unauthenticated': '1' })).status, 401, 'the JSON endpoints are guarded too')
assert.equal((await callRoute(ctx.routes[0], '/llm-trace')).status, 200, 'an authenticated request is served')
delete ctx.services.connection

// --- disposal restores fetch and the route ---------------------------------
for (const dispose of ctx.disposers) dispose()
assert.equal(globalThis.fetch, originalFetch, 'disposal restores the prior fetch')
assert.equal(ctx.routes.length, 0, 'disposal removes the route')

server.close()
console.log('smoke: all assertions passed')
