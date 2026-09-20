# dsh-llm-trace

A DeepSeek Harness plugin that captures the **raw HTTP request and response bodies** of model provider calls and shows them in a **Conversation View tab** and on a loopback viewer page.

## Why it exists

`dsh-context` reads the durable session log, so it shows the *provider-neutral* request the loop assembled (system prompt, tool schemas, messages, tool results) and the provider-reported token actuals. It cannot show the **wire** payload: the exact JSON `POST`ed to the provider endpoint and the exact bytes that came back. That gap is what this plugin fills.

The `llm/stream` waterfall is the wrong seam for the payload. It hands listeners a provider-neutral `GenerateOptions` and a `StreamChunk` iterable; the wire JSON is built *below* it, inside the adapter (`@earendil-works/pi-ai` → the official `openai` SDK → `globalThis.fetch`). The wire layer is therefore only reachable by wrapping `globalThis.fetch`.

## Use it

### The Conversation View tab

The client half registers one `conversation.view` entry, so a **LLM Trace** tab appears beside Chat in every session. It is **session-scoped**: the host attributes each captured `fetch` to the model call that caused it, so another session's or another subagent's traffic never appears in this tab.

`sessionId` is a plain prop on a `conversation.view` entry, and the component reads the viewer's own JSON endpoints on the same origin — no Remote API and no generated client assembly are involved.

### The HTTP viewer

The same data is served by the Web host, so it needs no second port:

```
http://127.0.0.1:3080/llm-trace
```

| Endpoint | What it returns |
| --- | --- |
| `GET /llm-trace` | The viewer document, read from `lib/page.html`. |
| `GET /llm-trace/api/list` | Newest-first summaries, retention stats, the client-row diagnostic, and the seen session ids. Accepts `?session=<id>`. |
| `GET /llm-trace/api/exchange?id=<id>` | One exchange with headers and bodies. |

This page is **not** session-scoped: it shows every provider call the process made, which is what you want when a subagent or the title generator is the suspect.

Both surfaces pass through the Web host's Host/Origin fence and browser-session cookie check.

### Why a response body looks enormous

A provider streams **one SSE chunk per token**, and every chunk repeats the entire JSON envelope:

```
data: {"choices":[{"delta":{"content":"","reasoning_content":"The","role":"assistant"},"index":0},
       "created":...,"id":"chatcmpl-...","model":"...","object":"chat.completion.chunk","usage":null}
```

Per chunk that envelope costs roughly 230 bytes — `id` 42, `object` 23, `model` 21, `created` 10, `usage:null` 4, `index`/`role` framing 64 — while carrying a handful of bytes of actual token. On a measured 276,186-byte reasoning-and-tool-call stream the breakdown was:

| Component | Bytes | Share |
| --- | ---: | ---: |
| `delta.reasoning_content` | 1,184 | 0.4% |
| `delta.content` | 118 | 0.0% |
| tool-call arguments | 2,218 | 0.8% |
| `usage` block | ~370 | 0.1% |
| **per-chunk envelope, repeated 1,030×** | **~272,300** | **98.6%** |

So the response pane defaults to an **assembled** view that concatenates the reasoning and content deltas, reassembles tool-call arguments by stream index, and prints the finish reason and usage. That same stream renders as 3,524 bytes — 1.3% of the raw body. The literal bytes stay behind one toggle.

## Configuration

Every field is optional. The tab and the page share one config; the tab's mount path is the constant `BASE` at the top of `lib/client.js`.

| Field | Default | Meaning |
| --- | --- | --- |
| `path` | `/llm-trace` | Mount path; absolute, no trailing slash. Changing it also requires editing `BASE` in `lib/client.js`. |
| `match` | `['/chat/completions', '/v1/messages', '/v1/responses', '/v1/completions', '/responses']` | URL substrings selecting a provider call, matched case-insensitively. |
| `matchAll` | `false` | Capture every request regardless of `match`. |
| `redactHeaders` | `['authorization', 'api-key', 'x-api-key', 'proxy-authorization', 'cookie', 'set-cookie']` | Header names stored as `<redacted>`. Set `[]` to keep them verbatim. |
| `maxRequestBodyBytes` | 8 MiB | Retained request-body prefix. |
| `maxResponseBodyBytes` | 32 MiB | Retained response-body prefix. |
| `maxRetained` | 500 | Exchanges retained before the oldest is evicted. |
| `maxJournalBytes` | 256 MiB | Total retained body bytes across all exchanges. |

## Design

- **Only matching URLs take the capture path.** Every other `fetch` call is forwarded untouched, so unrelated traffic is never observed and pays no cost.
- **The caller is never delayed.** The response body is read from a `Response.clone()`, so the original `Response` is returned as soon as the original fetch resolves. `ReadableStream.tee` keeps both branches independent, which is what lets a streaming SSE body keep streaming.
- **Bodies are bounded, not selected.** Capture keeps a prefix and marks the exchange truncated at the configured limit, then cancels its own branch so the `tee` buffer cannot grow without bound.
- **Session attribution rides `AsyncLocalStorage`.** `llm/stream` carries `options.sessionId`, and the adapter's network request happens while the returned stream is pulled. The listener runs every pull inside `sessionScope.run(sessionId, …)`, which makes the id readable from the `fetch` wrapper below the adapter. Interleaved subagent calls stay correct because each pull installs its own scope.
- **Retention is a count- and byte-bounded ring.** Oldest-first eviction keeps memory flat across a long session.
- **The viewer document and the client bundle are read per request / per scan.** Editing either takes effect without reloading the host module; see *Develop*.
- **The wrapper is restored synchronously on disposal**, so a live profile reload cannot leave a stale wrapper installed.
- **The tab carries no build step.** `lib/client.js` is hand-written in the `window.__ModuleLoader__.load` envelope that `dsh-client-modules` serves: it requires only the platform `react` seed and uses `React.createElement` instead of JSX, so no bundler, no tsdown preset, and no module-graph declaration are involved.

## Known Limitations and Deferred Work

- **Secrets in bodies are not redacted.** Header redaction covers the credential headers; the request body still carries the full system prompt, every tool schema, and any file content the agent read. Both surfaces sit behind the Web host's loopback bind plus its browser-session cookie check, which is the only access control.
- **The SSE assembler exists twice.** `lib/page.html` and `lib/client.js` each carry a copy, because a static document and a hand-written bundle cannot import from each other without a build step. A change to one must be mirrored in the other.
- **`path` is not shared with the client.** The tab fetches a constant, so a non-default mount path needs a matching edit in `lib/client.js`.
- **The wrapper is process-global and order-dependent.** `@deepseek-ai/dsh-experimental-inspector` wraps the same global; running both nests the wrappers and captures every exchange twice.
- **A `fetch` reference cached before this plugin activates is not observed.** `dsh-llm-pi-ai` constructs its provider client per request, so it is covered; another adapter that caches the reference at load would not be.
- **Calls made outside a loop carry no session id.** A hand-built `llm.stream()` call without `sessionId` is captured but appears only in the HTTP viewer.
- **Binary bodies are byte-counted only.**
- **The assembled view decodes OpenAI-style SSE only.** A provider using a different streaming envelope falls back to the raw view, which is always available.

## Install

The plugin is loaded as a profile patch row pointing at a revision directory, not as a declared bundle:

```yaml
- insert:
    - id: llm-trace
      name: '/data/workspace/dsh-plugins/live/r6/lib/index.js'
```

The client row is discovered from that same absolute path: `dsh-client-modules` walks up from the resolved module to the nearest `package.json`, so the package's own `dsh.client` declaration and `./client` export are found without a `node_modules` install. `/llm-trace/api/list` reports the result under `client`.

Removing the entry disposes the plugin, its route, and its tab. A `dsh plugin --profile web add/update` run does not manage this row.

## Develop

```sh
./sync.sh          # publish a revision and repoint the profile patch
node test/smoke.mjs
node test/client.mjs
```

Node's ESM module cache is keyed by **resolved realpath**, and the Cordis profile reload does not invalidate it. Once a plugin file has been imported, editing it in place keeps serving the old module until the host process restarts — re-creating the fiber is not enough, and a symlink alias does not help because Node resolves symlinks before caching.

`sync.sh` therefore copies the working tree to `../live/r<N>/` and repoints the patch row, giving the Loader a URL it has never imported. It symlinks `lib/page.html` and `lib/client.js` instead of copying them, because the host reads both from disk:

| Change | What it takes |
| --- | --- |
| Viewer markup, CSS, or inline script (`lib/page.html`) | Edit and refresh the browser. No reload. |
| Browser half (`lib/client.js`) | Edit and refresh the browser. No reload. |
| Host logic (`lib/index.js`, config, routes) | `./sync.sh`, then reload the page. |
| Anything after a `dsh web` restart | Nothing; the entry path stays valid. |

### Never delete a published revision

`dsh-client-modules` snapshots the client bundle when it first scans the package, and re-reads it only through the HMR watch on the path it captured — which belongs to whichever revision registered the package first, not the current one. Deleting that directory makes the watch permanently dirty and freezes the served bundle at the old snapshot, so a `lib/client.js` edit stops appearing with no error anywhere.

`sync.sh` therefore keeps every revision. They are cheap (a few files plus two symlinks) and their client paths are the only handle the registry has. The row name still has to change per revision, because that is what defeats the module cache; the two requirements pull in opposite directions and this is the arrangement that satisfies both.

## Test

`test/smoke.mjs` runs a real local HTTP server that streams SSE, and asserts that the consumer still receives every chunk incrementally, that request and response bodies are captured verbatim, that credential headers are redacted, that non-matching URLs are ignored, that the detail pane owns a single scroller, that the SSE assembler drops the per-chunk envelope, that session attribution survives interleaved pulls, that the authentication guard rejects an unauthenticated caller, and that disposal restores the prior `fetch`.

`test/client.mjs` evaluates the hand-written browser bundle against a stub module loader and a stub React seed, and asserts its envelope, its exports, its locale namespace, and the `conversation.view` registration it performs.

`test/e2e.mjs` is the only check that covers the whole path. It needs a running `dsh web` and the launch token that host printed, drives the Playwright-cached chromium over CDP, opens a session, asserts the tab is present, clicks it, opens the largest captured response, and reads the assembled view back — failing on any console error or uncaught exception.

```sh
TOKEN=$(journalctl -u dsh-web --no-pager \
  | grep -o 'http://127.0.0.1:3080/?token=[A-Za-z0-9_-]*' | tail -1 | sed 's/.*token=//')
node test/e2e.mjs "$TOKEN"
```

The token is what mints the host's browser-session cookie, which every route requires; without it the viewer answers 401 and the check cannot run.
