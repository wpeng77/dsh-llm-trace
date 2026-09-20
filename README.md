# dsh-llm-trace

A DeepSeek Harness plugin that captures the **raw HTTP request and response bodies** of model provider calls and serves them on a loopback viewer page.

## Why it exists

`dsh-context` reads the durable session log, so it shows the *provider-neutral* request the loop assembled (system prompt, tool schemas, messages, tool results) and the provider-reported token actuals. It cannot show the **wire** payload: the exact JSON `POST`ed to the provider endpoint and the exact bytes that came back. That gap is what this plugin fills.

The `llm/stream` waterfall is the wrong seam for this. It hands listeners a provider-neutral `GenerateOptions` and a `StreamChunk` iterable; the wire JSON is built *below* it, inside the adapter (`@earendil-works/pi-ai` → the official `openai` SDK → `globalThis.fetch`). The wire layer is therefore only reachable by wrapping `globalThis.fetch`.

## Use it

The viewer is served by the Web host, so it lives on the same origin as the GUI — no second port:

```
http://127.0.0.1:3080/llm-trace
```

| Endpoint | What it returns |
| --- | --- |
| `GET /llm-trace` | The viewer document, read from `lib/page.html`. |
| `GET /llm-trace/api/list` | Newest-first exchange summaries plus retention stats. |
| `GET /llm-trace/api/exchange?id=<id>` | One exchange with headers and bodies. |

The page polls the list every 2 s and fetches one exchange's bodies only when the selection or its lifecycle state changes. The detail pane has four tabs and exactly one scroll container.

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

So the response tab defaults to an **assembled** view that concatenates the reasoning and content deltas, reassembles tool-call arguments by stream index, and prints the finish reason and usage. That same stream renders as 3,524 bytes — 1.3% of the raw body. The literal bytes stay behind one toggle.

## Configuration

Every field is optional.

| Field | Default | Meaning |
| --- | --- | --- |
| `path` | `/llm-trace` | Mount path; absolute, no trailing slash. |
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
- **Bodies are decoded as UTF-8 text.** LLM payloads are JSON and SSE. A binary response is recorded with its byte count but is not rendered.
- **Retention is a count- and byte-bounded ring.** Oldest-first eviction keeps memory flat across a long session.
- **The viewer document is read per request.** Editing `lib/page.html` takes effect on the next browser refresh; see *Develop* for why that matters.
- **The wrapper is restored synchronously on disposal**, so a live profile reload cannot leave a stale wrapper installed.

## Known Limitations and Deferred Work

- **Secrets in bodies are not redacted.** Header redaction covers the credential headers; the request body still carries the full system prompt, every tool schema, and any file content the agent read. The route is served by the Web host and inherits its loopback bind, which is the only access control.
- **The wrapper is process-global and order-dependent.** `@deepseek-ai/dsh-experimental-inspector` wraps the same global; running both nests the wrappers and captures every exchange twice.
- **A `fetch` reference cached before this plugin activates is not observed.** `dsh-llm-pi-ai` constructs its provider client per request, so it is covered; another adapter that caches the reference at load would not be.
- **Binary bodies are byte-counted only.**
- **No client half.** The viewer is a plain HTTP page, not a GUI tab, so it carries no slots, stores, or locale-owned copy.
- **The assembled view decodes OpenAI-style SSE only.** A provider using a different streaming envelope falls back to the raw view, which is always available.

## Install

The plugin is loaded as a profile patch row pointing at a revision directory, not as a declared bundle:

```yaml
- insert:
    - id: llm-trace
      name: '/data/workspace/dsh-plugins/live/r1/lib/index.js'
```

Removing that entry disposes the plugin and its route. A `dsh plugin --profile web add/update` run does not manage this row.

## Develop

```sh
./sync.sh          # publish a revision and repoint the profile patch
node test/smoke.mjs
```

Node's ESM module cache is keyed by **resolved realpath**, and the Cordis profile reload does not invalidate it. Once a plugin file has been imported, editing it in place keeps serving the old module until the host process restarts — re-creating the fiber is not enough, and a symlink alias does not help because Node resolves symlinks before caching.

`sync.sh` therefore copies the working tree to `../live/r<N>/` and repoints the patch row, giving the Loader a URL it has never imported. It symlinks `lib/page.html` instead of copying it, so:

| Change | What it takes |
| --- | --- |
| Viewer markup, CSS, or inline script (`lib/page.html`) | Edit and refresh the browser. No reload. |
| Host logic (`lib/index.js`, config, routes) | `./sync.sh`, then reload the page. |
| Anything after a `dsh web` restart | Nothing; the entry path stays valid. |

## Test

The smoke test runs a real local HTTP server that streams SSE, and asserts that the consumer still receives every chunk incrementally, that request and response bodies are captured verbatim, that credential headers are redacted, that non-matching URLs are ignored, that the detail pane owns a single scroller, that the SSE assembler drops the per-chunk envelope, and that disposal restores the prior `fetch`.
