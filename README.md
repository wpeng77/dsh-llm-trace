# dsh-llm-trace

A DeepSeek Harness plugin that captures the **raw HTTP request and response bodies** of model provider calls and shows them in a **Conversation View tab** and on a loopback viewer page.

## Why it exists

[dsh-context](https://github.com/bowenliang123/dsh-context) reads the durable session log, so it shows the *provider-neutral* request the loop assembled (system prompt, tool schemas, messages, tool results) and the provider-reported token actuals. It cannot show the **wire** payload: the exact JSON `POST`ed to the provider endpoint and the exact bytes that came back. That gap is what this plugin fills.

The `llm/stream` waterfall is the wrong seam for the payload. It hands listeners a provider-neutral `GenerateOptions` and a `StreamChunk` iterable; the wire JSON is built *below* it, inside the adapter (`@earendil-works/pi-ai` → the official `openai` SDK → `globalThis.fetch`). The wire layer is therefore only reachable by wrapping `globalThis.fetch`.

## Install

```sh
dsh plugin --profile web add dsh-llm-trace
```

Or straight from GitHub:

```sh
dsh plugin --profile web add github:wpeng77/dsh-llm-trace
```

Then start the Web UI with `dsh web`. No build step: the plugin is plain ESM, ships no bundler output, and declares no install-time script.

## Use it

### The Conversation View tab

A **LLM Trace** tab appears beside Chat in every session. It is **session-scoped**: the host attributes each captured `fetch` to the model call that caused it, so another session's or another subagent's traffic never appears in this tab.

`sessionId` is a plain prop on a `conversation.view` entry, and the component reads the viewer's own JSON endpoints on the same origin — no Remote API and no generated client assembly are involved.

**The composer is hidden while the tab is open**, the way the Context tab does it. The composer seat is a sibling of the view area inside the conversation scroll container, so the shell exposes no per-view control over it; the bundle installs a `:has()` rule keyed on the view root instead. A pending approval, question, or plan review stays visible, because those are answers the agent is blocked on rather than a chat composer.

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

### The request body opens as a tree

A real request is mostly one array. A measured capture was 3,653,601 bytes across 8,787 JSON nodes, of which `messages` alone was 3,602,024 bytes — **98.6%** — in 973 entries. Reading that as pretty-printed text means scrolling a long way to learn one fact.

So the request body renders as a collapsible tree, collapsed to its top level by default:

```
▼ root   Object(6) · model: "deepseek-v4.1-flash"                     3.7 MiB
  ├ model             "deepseek-v4.1-flash"                             21 B
  ├ messages  ▸       Array(973)                                     3.4 MiB
  ├ stream            true                                               4 B
  ├ stream_options ▸  Object(1)                                         23 B
  ├ max_tokens        384000                                             6 B
  └ tools  ▸          Array(65)                                     62.7 KiB
```

- **Sizes are measured, not estimated.** One bottom-up pass gives every node its compact serialized size, so the root's figure equals the captured body exactly.
- **Only expanded nodes render.** The default view is seven rows; a collapsed multi-megabyte subtree costs one. A container past 500 children emits a "more" row that raises that one container's limit instead of materializing the rest.
- **Previews are generic.** A container shows its child count and its first short string field, chosen by position rather than by key name, so a shape this plugin has never seen still reads as something.
- **Everything follows the theme.** The tab carries no fixed colours: the text block that shows an expanded value inherits the same panel background and label colour the rest of the tree uses, so it stays legible on a light theme as well as a dark one. `test/e2e.mjs` measures the rendered contrast and fails below WCAG AA.
- **A long string expands to its full text.** The preview is a 72-character teaser; clicking it renders the whole value, newlines and all, so a message body or a tool description reads in place instead of being unreadable. The rendered text is capped at 32 KiB and says so — `Copy` always has the complete value. The expanded block deliberately has no inner scrollbar: the pane owns the scroll, and clicking the header collapses it again.
- **`Tree` / `Raw`** switches back to the literal bytes, and a body that does not parse (a truncated capture) falls back to raw with a note.

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

Set them from a profile patch:

```yaml
- insert:
    - id: llm-trace
      name: 'dsh-llm-trace'
      config:
        match: ['model.example.com']
        maxRetained: 2000
```

## Design

- **Only matching URLs take the capture path.** Every other `fetch` call is forwarded untouched, so unrelated traffic is never observed and pays no cost.
- **The caller is never delayed.** The response body is read from a `Response.clone()`, so the original `Response` is returned as soon as the original fetch resolves. `ReadableStream.tee` keeps both branches independent, which is what lets a streaming SSE body keep streaming.
- **Bodies are bounded, not selected.** Capture keeps a prefix and marks the exchange truncated at the configured limit, then cancels its own branch so the `tee` buffer cannot grow without bound.
- **Session attribution rides `AsyncLocalStorage`.** `llm/stream` carries `options.sessionId`, and the adapter's network request happens while the returned stream is pulled. The listener runs every pull inside `sessionScope.run(sessionId, …)`, which makes the id readable from the `fetch` wrapper below the adapter. Interleaved subagent calls stay correct because each pull installs its own scope.
- **Retention is a count- and byte-bounded ring.** Oldest-first eviction keeps memory flat across a long session.
- **The tab's view root is absolutely positioned.** The Conversation shell's view area carries `min-height: auto`, so an in-flow view sizes to its content, pushes the shell's scroll body past the viewport, and makes the shell scroll both panes together. Taking the root out of flow breaks that intrinsic-size chain, which is what lets the list and the detail pane each own a scroller. `test/e2e.mjs` asserts it: two self-scrolling panes and no shell overflow.
- **The two browser faces share one implementation.** The tree logic and the SSE assembler live in `lib/browser/`, which the host serves under `/llm-trace/assets/` and both the viewer document and the Conversation View bundle `import()`. The asset route is a closed allowlist rather than a path join, because a name-derived path would let a caller walk out of the directory.
- **The viewer document and the client bundle are read per request.** Editing either takes effect without reloading the host module.
- **The wrapper is restored synchronously on disposal**, so a live profile reload cannot leave a stale wrapper installed.
- **The tab carries no build step.** `lib/client.js` is hand-written in the `window.__ModuleLoader__.load` envelope that `dsh-client-modules` serves: it requires only the platform `react` seed and uses `React.createElement` instead of JSX, so no bundler, no tsdown preset, and no module-graph declaration are involved.

## Known Limitations and Deferred Work

- **Secrets in bodies are not redacted.** Header redaction covers the credential headers; the request body still carries the full system prompt, every tool schema, and any file content the agent read. Both surfaces sit behind the Web host's loopback bind plus its browser-session cookie check, which is the only access control.
- **`path` is not shared with the client.** The tab fetches a constant, so a non-default mount path needs a matching edit in `lib/client.js`.
- **The wrapper is process-global and order-dependent.** `@deepseek-ai/dsh-experimental-inspector` wraps the same global; running both nests the wrappers and captures every exchange twice.
- **A `fetch` reference cached before this plugin activates is not observed.** `dsh-llm-pi-ai` constructs its provider client per request, so it is covered; another adapter that caches the reference at load would not be.
- **Calls made outside a loop carry no session id.** A hand-built `llm.stream()` call without `sessionId` is captured but appears only in the HTTP viewer.
- **Binary bodies are byte-counted only.**
- **The assembled view decodes OpenAI-style SSE only.** A provider using a different streaming envelope falls back to the raw view, which is always available.

## Develop

```sh
npm test           # shared tree logic + host smoke test + browser-bundle unit test
```

`test/e2e.mjs` is the only check that covers the whole path. It needs a running `dsh web` and the launch token that host printed, drives a headless chromium over CDP, opens a session, asserts the tab is present, clicks it, opens the largest captured response, reads the assembled view back, and checks the pane and composer layout:

```sh
TOKEN=$(journalctl -u dsh-web --no-pager \
  | grep -o 'http://127.0.0.1:3080/?token=[A-Za-z0-9_-]*' | tail -1 | sed 's/.*token=//')
node test/e2e.mjs "$TOKEN"
```

The token is what mints the host's browser-session cookie, which every route requires; without it the viewer answers 401 and the check cannot run.

### Loading a working tree into a running host

`sync.sh` publishes this tree to a revision directory and repoints a profile patch row at it, so a host-code edit takes effect without restarting `dsh web`. It exists because Node's ESM module cache is keyed by resolved realpath and the Cordis profile reload does not invalidate it.

Two constraints shape it, and they pull in opposite directions:

1. The Loader row name has to change per revision, because that is what defeats the module cache.
2. Superseded revisions are never deleted, because `dsh-client-modules` snapshots the client bundle at first scan and re-reads it only through the HMR watch on the captured path — a deleted directory makes that watch permanently dirty and freezes the served bundle with no error anywhere.

`lib/page.html` and `lib/client.js` are symlinked rather than copied, so editing either is live on the next browser refresh and never needs `sync.sh`.

## License

Apache-2.0.
