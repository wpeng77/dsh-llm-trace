/**
 * Unit test for the shared JSON-tree module.
 *
 * The two browser faces render differently but must agree on what a row is, how
 * big a node is, and what a node previews as. That agreement is this module, and
 * nothing else checks it: the page and the bundle only consume it.
 */

import assert from 'node:assert/strict'
import {
  DEFAULT_CHILD_LIMIT,
  EXPANDED_TEXT_LIMIT,
  ROOT_PATH,
  childCount,
  flatten,
  isContainer,
  joinPath,
  kindOf,
  measure,
  previewOf,
  utf8Length,
} from '../lib/browser/json-tree.js'

// --- UTF-8 accounting ------------------------------------------------------
assert.equal(utf8Length(''), 0)
assert.equal(utf8Length('abc'), 3)
assert.equal(utf8Length('中'), 3, 'a BMP non-ASCII character is three bytes')
assert.equal(utf8Length('😀'), 4, 'a surrogate pair is one four-byte character')
assert.equal(utf8Length('a中😀'), 1 + 3 + 4)
assert.equal(utf8Length(JSON.stringify('中')), 5, 'two quotes plus three encoded bytes')

// --- classification --------------------------------------------------------
assert.equal(kindOf(null), 'null')
assert.equal(kindOf([]), 'array')
assert.equal(kindOf({}), 'object')
assert.equal(kindOf(''), 'string')
assert.equal(kindOf(0), 'number')
assert.equal(kindOf(false), 'boolean')
assert.equal(isContainer([]), true)
assert.equal(isContainer(null), false, 'null is not expandable')
assert.equal(childCount([1, 2, 3]), 3)
assert.equal(childCount({ a: 1 }), 1)
assert.equal(childCount('abc'), 0)

// --- path escaping ---------------------------------------------------------
assert.equal(joinPath('', 'messages'), '/messages')
assert.equal(joinPath('/messages', 3), '/messages/3')
assert.equal(joinPath('', 'a/b'), '/a~1b', 'a slash in a key is escaped')
assert.equal(joinPath('', 'a~b'), '/a~0b', 'a tilde in a key is escaped')

// --- previews --------------------------------------------------------------
assert.equal(previewOf([1, 2, 3]), 'Array(3)')
assert.equal(previewOf({ n: 1 }), 'Object(1)', 'no string field means no hint')
assert.equal(previewOf({ role: 'system', content: 'x' }), 'Object(2) · role: "system"')
assert.equal(previewOf({ content: 'first', role: 'user' }), 'Object(2) · content: "first"', 'the hint is positional, not key-name based')
assert.equal(previewOf({ role: 'x'.repeat(60) }), 'Object(1)', 'a long field is not a hint')
assert.equal(previewOf('hi'), '"hi"')
assert.equal(previewOf(null), 'null')
assert.equal(previewOf(true), 'true')
assert.equal(previewOf(42), '42')

// --- a request-shaped body -------------------------------------------------
const body = {
  model: 'deepseek-v4.1-flash',
  messages: Array.from({ length: 973 }, (_, index) => ({
    role: index === 0 ? 'system' : 'user',
    content: `message ${index}`,
  })),
  stream: true,
  stream_options: { include_usage: true },
  max_tokens: 384000,
  tools: Array.from({ length: 65 }, (_, index) => ({ type: 'function', function: { name: `tool_${index}` } })),
  note: '中文字符',
}
const raw = JSON.stringify(body)
const sizes = measure(body)

assert.equal(
  sizes.get(ROOT_PATH),
  Buffer.byteLength(raw, 'utf8'),
  'the root measures exactly the compact body a provider would receive',
)
assert.equal(sizes.get('/messages'), Buffer.byteLength(JSON.stringify(body.messages), 'utf8'))
assert.equal(sizes.get('/stream_options'), Buffer.byteLength(JSON.stringify(body.stream_options), 'utf8'))

// --- flattening only walks what is expanded --------------------------------
const collapsed = flatten(body, new Set([ROOT_PATH]), sizes)
assert.equal(collapsed.length, 1 + Object.keys(body).length, 'the collapsed tree is one row per top-level key plus the root')
assert.equal(collapsed[0].path, ROOT_PATH)
assert.equal(collapsed[0].expanded, true)
assert.equal(collapsed[0].childCount, Object.keys(body).length)

const messagesRow = collapsed.find((row) => row.path === '/messages')
assert.equal(messagesRow.expandable, true)
assert.equal(messagesRow.expanded, false)
assert.equal(messagesRow.childCount, 973)
assert.equal(messagesRow.bytes, sizes.get('/messages'))

const streamRow = collapsed.find((row) => row.path === '/stream')
assert.equal(streamRow.expandable, false, 'a leaf cannot be expanded')
assert.equal(streamRow.bytes, 4, 'the leaf reports its own serialized size')

// A request body this size must never materialize in full by default.
assert.ok(collapsed.length < 20, `the default view stays small, got ${collapsed.length} rows`)

// --- expanding one node adds only that node's children ---------------------
// The default limit still applies, which is what stops one expansion from
// materializing a thousand-row array in full.
const oneOpen = flatten(body, new Set([ROOT_PATH, '/messages']), sizes)
assert.equal(oneOpen.filter((row) => row.depth === 2 && row.kind !== 'more').length, DEFAULT_CHILD_LIMIT)
assert.equal(oneOpen.find((row) => row.kind === 'more').hidden, 973 - DEFAULT_CHILD_LIMIT)
assert.equal(oneOpen.find((row) => row.path === '/messages/0').label, '[0]', 'array children are bracketed')
assert.equal(oneOpen.find((row) => row.path === '/messages/0').preview, 'Object(2) · role: "system"')

// --- the child limit bounds one expansion ----------------------------------
const capped = flatten(body, new Set([ROOT_PATH, '/messages']), sizes, new Map(), 100)
const more = capped.find((row) => row.kind === 'more')
assert.ok(more, 'a capped container emits a more row')
assert.equal(more.owner, '/messages')
assert.equal(more.hidden, 973 - 100)
assert.equal(capped.filter((row) => row.depth === 2 && row.kind !== 'more').length, 100)

// A raised limit for that one path is honoured, and other paths keep the default.
const raised = flatten(body, new Set([ROOT_PATH, '/messages']), sizes, new Map([['/messages', 200]]), 100)
assert.equal(raised.filter((row) => row.depth === 2 && row.kind !== 'more').length, 200)
assert.equal(raised.find((row) => row.kind === 'more').hidden, 973 - 200)

// A container under the limit emits no more row at all.
const toolsRow = flatten(body, new Set([ROOT_PATH, '/tools']), sizes).filter((row) => row.kind === 'more')
assert.equal(toolsRow.length, 0, '65 children fit under the default limit')
assert.equal(DEFAULT_CHILD_LIMIT, 500)

// --- a truncated capture is not parseable, and that is the caller's problem --
assert.throws(() => JSON.parse(raw.slice(0, raw.length - 20)), 'a cut body does not parse')

// --- long strings expand into their full text -------------------------------
const longText = 'line one\nline two\n' + 'x'.repeat(200)
const withText = { content: longText, short: 'ok' }
const textSizes = measure(withText)
const collapsedText = flatten(withText, new Set([ROOT_PATH]), textSizes)
assert.equal(collapsedText.find((row) => row.path === '/content').expandable, true, 'a long string is expandable')
assert.equal(collapsedText.find((row) => row.path === '/content').expanded, false)
assert.equal(collapsedText.find((row) => row.path === '/short').expandable, false, 'a short string is not')
assert.ok(collapsedText.find((row) => row.path === '/content').preview.endsWith('…'), 'the preview is clipped')
assert.equal(collapsedText.filter((row) => row.kind === 'text').length, 0, 'nothing renders while collapsed')

const openedText = flatten(withText, new Set([ROOT_PATH, '/content']), textSizes)
const textRow = openedText.find((row) => row.kind === 'text')
assert.ok(textRow, 'expanding a long string emits a text row')
assert.equal(textRow.text, longText, 'the full value is carried, newlines intact')
assert.equal(textRow.textTruncated, false)
assert.equal(textRow.depth, 2, 'the text row is indented under its key')
assert.equal(openedText.find((row) => row.path === '/content').expanded, true)

const huge = { blob: 'y'.repeat(EXPANDED_TEXT_LIMIT + 500) }
const hugeRow = flatten(huge, new Set([ROOT_PATH, '/blob']), measure(huge)).find((row) => row.kind === 'text')
assert.equal(hugeRow.text.length, EXPANDED_TEXT_LIMIT, 'the rendered text is capped')
assert.equal(hugeRow.textTruncated, true, 'and says so')

console.log('json-tree: all assertions passed')
