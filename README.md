# dsh-llm-trace

A DeepSeek Harness plugin that captures the **raw HTTP request and response bodies** of model provider calls and serves them on a loopback viewer page.

## Why it exists

`dsh-context` reads the durable session log, so it shows the *provider-neutral* request the loop assembled (system prompt, tool schemas, messages, tool results) and the provider-reported token actuals. It cannot show the **wire** payload: the exact JSON `POST`ed to the provider endpoint and the exact bytes that came back. That gap is what this plugin fills.

The `llm/stream` waterfall is the wrong seam for this. It hands listeners a provider-neutral `GenerateOptions` and a `StreamChunk` iterable; the wire JSON is built *below* it, inside the adapter (`@earendil-works/pi-ai` → the official `openai` SDK → `globalThis.fetch`). The wire layer is therefore only reachable by wrapping `globalThis.fetch`.

## Use it

The viewer is served by the Web host, so it lives on the same origin as the GUI:

```
http://127.0.0.1:3080/llm-trace
```

| Endpoint | What it returns |
| --- | --- |
| `GET /llm-trace` | The self-contained viewer page. |
| `GET /llm-trace/api/list` | Newest-first exchange summaries plus retention stats. |
| `GET /llm-trace/api/exchange?id=<id>` | One exchange with headers and bodies. |

The page polls every 2 s and can be filtered by URL, status, or method.

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
- **The wrapper is restored synchronously on disposal**, so a live profile reload cannot leave a stale wrapper installed.

## Known Limitations and Deferred Work

- **Secrets in bodies are not redacted.** Header redaction covers the credential headers; the request body still carries the full system prompt, every tool schema, and any file content the agent read. The route is served by the Web host and inherits its loopback bind, which is the only access control.
- **The wrapper is process-global and order-dependent.** `@deepseek-ai/dsh-experimental-inspector` wraps the same global; running both nests the wrappers and captures every exchange twice.
- **A `fetch` reference cached before this plugin activates is not observed.** `dsh-llm-pi-ai` constructs its provider client per request, so it is covered; another adapter that caches the reference at load would not be.
- **Binary bodies are byte-counted only.**
- **No client half.** The viewer is a plain HTTP page, not a GUI tab, so it carries no slots, stores, or locale-owned copy.

## Install

Installed as a patch entry rather than a bundle, so the live profile reload picks it up without a restart:

```sh
ln -sfn /data/workspace/dsh-plugins/dsh-llm-trace ~/.dsh/profiles/web/node_modules/dsh-llm-trace
```

Then add to `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: llm-trace
      name: 'dsh-llm-trace'
```

Removing that entry disposes the plugin and its route; the profile reload is idempotent, so editing a comment around an unchanged entry does not rebuild the plugin fiber. A `dsh plugin --profile web add/update` run may prune the `node_modules` symlink, because the entry is a patch row and not a declared bundle dependency.

## Test

```sh
node test/smoke.mjs
```

The smoke test runs a real local HTTP server that streams SSE, and asserts that the consumer still receives every chunk incrementally, that request and response bodies are captured verbatim, that credential headers are redacted, that non-matching URLs are ignored, and that disposal restores the prior `fetch`.
