/**
 * Unit test for the hand-written browser bundle.
 *
 * No bundler produces `lib/client.js`, so nothing else validates its
 * `window.__ModuleLoader__.load` envelope, its exports, or the Cordis wiring its
 * `apply` performs. This evaluates the bundle against a stub loader and a stub
 * React seed; the component itself is only defined, never rendered.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')

let registration
globalThis.window = { __ModuleLoader__: { load(value) { registration = value } } }
new Function(source)()

assert.ok(registration, 'the bundle registers itself through window.__ModuleLoader__.load')
assert.equal(registration.id, 'dsh-llm-trace', 'the envelope id is the package name the boot graph keys on')
assert.equal(typeof registration.factory, 'function', 'the envelope carries a factory')

const react = {
  createElement: () => ({}),
  cloneElement: (element) => element,
  useState: () => [undefined, () => {}],
  useEffect: () => {},
}

const specifiers = []
const clientExports = registration.factory((specifier) => {
  specifiers.push(specifier)
  assert.equal(specifier, 'react', 'the bundle requires only the platform react seed')
  return react
})

assert.equal(clientExports.name, 'dsh-llm-trace')
assert.deepEqual(clientExports.inject, ['slots', 'locale'], 'the plugin waits on the slot and locale services')
assert.equal(typeof clientExports.apply, 'function')

// The bundle installs a seat stylesheet; nothing else checks that rule, and a
// silently missing one leaves the composer visible under the trace view.
const styleTags = []
globalThis.document = {
  head: { appendChild(node) { styleTags.push(node) } },
  createElement(tag) {
    return {
      tagName: tag,
      attributes: {},
      textContent: '',
      setAttribute(name, value) { this.attributes[name] = value },
      remove() { this.removed = true },
    }
  },
}

const seen = []
const ctx = {
  effect(factory) { seen.push(['effect', factory()]) },
  locale: {
    register(namespace, dictionary) { seen.push(['locale', namespace, dictionary]); return () => {} },
    bind(namespace) { return (key) => `${namespace}:${key}` },
  },
  slots: {
    inject(key, callback) { seen.push(['inject', key]); callback() },
    register(options, component) { seen.push(['slot', options, component]); return () => {} },
  },
}

clientExports.apply(ctx)

const locale = seen.find((entry) => entry[0] === 'locale')
assert.ok(locale, 'the bundle registers its locale namespace')
assert.equal(locale[1], 'dsh-llm-trace')
assert.deepEqual(Object.keys(locale[2]).sort(), ['en', 'zh'], 'both dictionaries are supplied')
assert.equal(locale[2].en.tab, 'LLM Trace')
assert.ok(locale[2].zh.tab, 'the Chinese dictionary covers the tab label')

const inject = seen.find((entry) => entry[0] === 'inject')
assert.equal(inject[1], 'conversation.view', 'the tab targets the Conversation View slot')

const slot = seen.find((entry) => entry[0] === 'slot')
assert.equal(slot[1].name, 'conversation.view')
assert.equal(slot[1].id, 'llm-trace', 'the tab id is stable and namespaced')
assert.equal(slot[1].locale, 'dsh-llm-trace', 'the tab label resolves through the registered namespace')
assert.equal(slot[1].label(), 'dsh-llm-trace:tab')
assert.equal(typeof slot[2], 'function', 'the tab renders a component')

assert.equal(styleTags.length, 1, 'the bundle installs exactly one seat stylesheet')
const seatCss = styleTags[0].textContent
assert.ok(seatCss.includes('[data-conversation-scroll]:has([data-llm-trace-root]) > [data-composer-seat]'), 'the rule hides the composer while this view is mounted')
assert.ok(seatCss.includes(':not(:has([data-approval-key],[data-question-key],[data-plan-review-key]))'), 'a pending approval, question, or plan review stays visible')
assert.ok(seatCss.includes('~ [data-width-handle]{display:none}'), 'the width handle is hidden with the composer')
assert.ok(source.includes('[ROOT_ATTR]: ""'), 'the view root carries the attribute the rule keys on')

// Both browser faces import the same two modules, so neither may carry its own
// copy of the tree logic or the SSE assembler.
assert.ok(source.includes("import(BASE + \"/assets/json-tree.js\")"), 'the bundle loads the shared tree module')
assert.ok(source.includes("import(BASE + \"/assets/sse.js\")"), 'the bundle loads the shared SSE module')
assert.ok(!source.includes('function assembleSse'), 'the bundle carries no assembler of its own')
assert.ok(!source.includes('function measure('), 'the bundle carries no tree logic of its own')
assert.ok(source.includes('shared.sse.assembleSse(raw)'), 'the assembled view calls the shared assembler')
assert.ok(source.includes('renderTree()'), 'the request pane renders a tree')
assert.ok(source.includes('row.kind === "text"'), 'a long string expands into its full text')
assert.ok(source.includes('note.textTruncated'), 'a capped value says so')

console.log('client: all assertions passed')
