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

/** A Cordis context double that records the registered route and disposers. */
function fakeContext() {
  const disposers = []
  const routes = []
  return {
    disposers,
    routes,
    effect(factory) { disposers.push(factory()) },
    webServer: {
      register(route) { routes.push(route); return () => { routes.splice(routes.indexOf(route), 1) } },
    },
  }
}

/** Invoke the registered route handler and collect its response. */
async function callRoute(route, pathname) {
  const req = { url: pathname }
  const chunks = []
  const res = {
    status: 0,
    headers: {},
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(body) { chunks.push(body) },
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
assert.ok(page.body.includes('var BASE = "/llm-trace"'), 'the page carries the mount path')
assert.ok(page.body.includes('"/api/list"'), 'the page points at the JSON endpoints')

// --- a non-matching call is never observed ----------------------------------
await fetch(`http://127.0.0.1:${port}/unrelated`, { method: 'POST', body: 'nope' })
await new Promise((resolve) => { setTimeout(resolve, 60) })
const after = JSON.parse((await callRoute(ctx.routes[0], '/llm-trace/api/list')).body)
assert.equal(after.entries.length, 1, 'a non-matching URL is not captured')

// --- unknown exchange and unknown route answer 404 --------------------------
assert.equal((await callRoute(ctx.routes[0], '/llm-trace/api/exchange?id=nope')).status, 404)
assert.equal((await callRoute(ctx.routes[0], '/llm-trace/nope')).status, 404)

// --- disposal restores fetch and the route ---------------------------------
for (const dispose of ctx.disposers) dispose()
assert.equal(globalThis.fetch, originalFetch, 'disposal restores the prior fetch')
assert.equal(ctx.routes.length, 0, 'disposal removes the route')

server.close()
console.log('smoke: all assertions passed')
