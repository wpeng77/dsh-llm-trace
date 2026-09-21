/**
 * End-to-end check of the LLM Trace Conversation View tab.
 *
 * Requires a running `dsh web` whose profile loads this plugin, and the launch
 * token that host printed at startup:
 *
 *   TOKEN=$(journalctl -u dsh-web --no-pager \
 *     | grep -o 'http://127.0.0.1:3080/?token=[A-Za-z0-9_-]*' | tail -1 | sed 's/.*token=//')
 *   node test/e2e.mjs "$TOKEN"
 *
 * The token mints the host's browser-session cookie, which every route now
 * requires; without it the viewer answers 401. This drives the Playwright-cached
 * chromium over CDP, opens a session, asserts the tab is present, clicks it,
 * opens the largest captured response, and reads the assembled view back.
 * Console errors and uncaught exceptions are collected, so a React failure cannot
 * pass silently.
 */

import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PROFILE_MODULES = process.env.DSH_PROFILE_MODULES ?? '/home/hadoken/.dsh/profiles/node_modules'
const require = createRequire(join(PROFILE_MODULES, 'index.js'))
const WebSocket = require('ws')

const CHROME = process.env.DSH_CHROME
  ?? '/home/hadoken/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome'
const PORT = Number(process.env.DSH_E2E_CDP_PORT ?? 9333)
const ORIGIN = process.env.DSH_E2E_ORIGIN ?? 'http://127.0.0.1:3080'
const TOKEN = process.argv[2]
if (!TOKEN) throw new Error('usage: node test/e2e.mjs <launch-token>')

const profile = mkdtempSync(join(tmpdir(), 'llm-trace-e2e-'))
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--no-first-run',
  'about:blank',
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

async function waitForCdp() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) return
    } catch (error) {
      // The browser is still starting; keep polling until the deadline.
    }
    await sleep(250)
  }
  throw new Error('cdp endpoint never answered')
}

await waitForCdp()
const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = targets.find((target) => target.type === 'page')
if (!page) throw new Error('no page target')

const socket = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 })
await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })

let nextId = 0
const pending = new Map()
const consoleErrors = []
const exceptions = []

socket.on('message', (raw) => {
  const message = JSON.parse(raw.toString())
  if (message.id !== undefined) {
    const entry = pending.get(message.id)
    pending.delete(message.id)
    if (entry) message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result)
    return
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description ?? arg.type).join(' '))
  }
  if (message.method === 'Runtime.exceptionThrown') {
    exceptions.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text)
  }
})

function send(method, params = {}) {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed')
  return result.result.value
}

/** Poll until the Conversation shell renders its view tabs. */
async function waitForTabs() {
  for (let attempt = 0; attempt < 60; attempt++) {
    const labels = await evaluate(`Array.from(document.querySelectorAll('[role="tab"]')).map(function(n){return n.textContent.trim()})`)
    if (Array.isArray(labels) && labels.length > 0) return labels
    await sleep(500)
  }
  return []
}

function finish(code) {
  socket.close()
  chrome.kill('SIGKILL')
  process.exit(code)
}

await send('Runtime.enable')
await send('Page.enable')
// The sidebar collapses at the default headless viewport, hiding the session list.
await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1050, deviceScaleFactor: 1, mobile: false })

// Mint the browser-session cookie through the launch token, then load clean `/`.
await send('Page.navigate', { url: `${ORIGIN}/?token=${TOKEN}` })
await sleep(1500)
await send('Page.navigate', { url: `${ORIGIN}/` })
await sleep(3000)

const tabRowCount = () => evaluate(`document.querySelectorAll('[data-exchange]').length`)

let labels = await waitForTabs()
let openedSession = 'none'
if (labels.length === 0 || (await tabRowCount()) === 0) {
  // Captures are session-scoped, so only the session that made the calls has any
  // rows. Walk the sidebar until one does, rather than assuming the first is it.
  const sessionCount = await evaluate(`Array.from(document.querySelectorAll('[role="treeitem"]')).filter(function(n){ return /(min|\\dh|\\dd|mo)\\b/.test(n.textContent) }).length`)
  for (let index = 0; index < sessionCount; index++) {
    const clicked = await evaluate(`(function(){
      var items = Array.from(document.querySelectorAll('[role="treeitem"]')).filter(function(n){ return /(min|\\dh|\\dd|mo)\\b/.test(n.textContent) });
      if (!items[${index}]) return 'none';
      items[${index}].click();
      return items[${index}].textContent.trim().slice(0, 50);
    })()`)
    await sleep(2500)
    labels = await waitForTabs()
    if (labels.length === 0) continue
    await evaluate(`(function(){
      var tabs = Array.from(document.querySelectorAll('[role="tab"]'));
      var target = tabs.filter(function(n){ return n.textContent.indexOf('LLM Trace') >= 0 })[0];
      if (target) target.click();
      return !!target
    })()`)
    await sleep(2500)
    const rows = await tabRowCount()
    openedSession = `${clicked} → ${rows} rows`
    if (rows > 0) break
  }
}
console.log('opened session  :', openedSession)

console.log('tabs            :', JSON.stringify(labels))
const hasTab = labels.some((label) => label.includes('LLM Trace'))
console.log('LLM Trace tab   :', hasTab ? 'PRESENT' : 'MISSING')
if (!hasTab) {
  console.log('console errors  :', consoleErrors.length ? JSON.stringify(consoleErrors.slice(0, 5)) : 'none')
  console.log('exceptions      :', exceptions.length ? JSON.stringify(exceptions.slice(0, 5)) : 'none')
  finish(1)
}

await evaluate(`(function(){
  var tabs = Array.from(document.querySelectorAll('[role="tab"]'));
  tabs.filter(function(n){ return n.textContent.indexOf('LLM Trace') >= 0 })[0].click();
  return true
})()`)
await sleep(4000)

const pane = await evaluate(`(function(){
  return (document.querySelector('main') || document.body).innerText.slice(0, 1200)
})()`)
console.log('--- rendered pane ---')
console.log(pane)
console.log('--- end pane ---')

// Open the largest captured response and read the assembled view back.
const opened = await evaluate(`(function(){
  var rows = Array.from(document.querySelectorAll('[data-exchange]'));
  if (!rows.length) return 'no exchange rows';
  var size = function(n){
    var m = /out ([\\d.]+) (KiB|MiB|B)/.exec(n.innerText);
    if (!m) return 0;
    var v = parseFloat(m[1]);
    return m[2] === 'MiB' ? v * 1048576 : m[2] === 'KiB' ? v * 1024 : v;
  };
  rows.slice().sort(function(a, b){ return size(b) - size(a) })[0].click();
  return rows.length + ' rows';
})()`)
console.log('opened exchange :', opened)
await sleep(2500)

const detail = await evaluate(`(function(){
  var text = document.body.innerText;
  var marks = ['Reasoning', 'Tool calls', 'Content', 'Usage', 'Request body', 'Response body'];
  var idx = -1;
  for (var i = 0; i < marks.length; i++) { var at = text.indexOf(marks[i]); if (at >= 0) { idx = at; break } }
  if (idx < 0) idx = Math.max(0, text.length - 1200);
  return text.slice(Math.max(0, idx - 300), idx + 1500);
})()`)
console.log('--- detail pane ---')
console.log(detail)
console.log('--- end detail ---')

// --- the request body renders as a bounded, collapsible tree ---------------
const requestTabClicked = await evaluate(`(function(){
  var buttons = Array.from(document.querySelectorAll('button'));
  var target = buttons.filter(function(n){ return /Request body|请求体/.test(n.textContent) })[0];
  if (target) target.click();
  return !!target
})()`)
if (!requestTabClicked) {
  console.log('TREE FAIL: the request body tab is missing')
  finish(1)
}
await sleep(1500)

const treeShape = async () => JSON.parse(await evaluate(`(function(){
  var rows = Array.from(document.querySelectorAll('[data-path]'));
  var root = rows.filter(function(n){ return n.getAttribute('data-path') === '' })[0];
  return JSON.stringify({
    rows: rows.length,
    hasRoot: !!root,
    rootText: root ? root.innerText.replace(/\\s+/g, ' ').slice(0, 80) : null
  });
})()`))

const collapsed = await treeShape()
console.log('tree (collapsed)     :', JSON.stringify(collapsed))
if (!collapsed.hasRoot) {
  console.log('TREE FAIL: the request body did not render as a tree')
  finish(1)
}
if (collapsed.rows > 20) {
  console.log(`TREE FAIL: the collapsed tree materialized ${collapsed.rows} rows; it must stay small`)
  finish(1)
}

// Expanding one node must add only that node's children, and stay under the cap.
const expansion = await evaluate(`(function(){
  var rows = Array.from(document.querySelectorAll('[data-path]'));
  var target = rows.filter(function(n){ return n.getAttribute('data-path') === '/messages' })[0];
  if (!target) return 'no /messages row';
  target.click();
  return 'clicked'
})()`)
await sleep(1800)
const expandedShape = await treeShape()
console.log('tree (/messages open):', JSON.stringify(expandedShape), '|', expansion)

if (expandedShape.rows <= collapsed.rows) {
  console.log('TREE FAIL: expanding /messages added no rows')
  finish(1)
}
if (expandedShape.rows > 600) {
  console.log(`TREE FAIL: one expansion materialized ${expandedShape.rows} rows; the child limit is not holding`)
  finish(1)
}

// A long string expands into its full text: the clipped preview is a teaser, and
// a message body or a tool description is usually what the reader came for.
const clickPath = (path) => evaluate(`(function(){
  var rows = Array.from(document.querySelectorAll('[data-path]'));
  var target = rows.filter(function(n){ return n.getAttribute('data-path') === ${JSON.stringify(path)} })[0];
  if (!target) return 'missing';
  target.click();
  return 'clicked'
})()`)
for (const path of ['/messages/0', '/messages/0/content']) {
  const hit = await clickPath(path)
  if (hit !== 'clicked') {
    console.log(`TREE FAIL: ${path} was not expandable (${hit})`)
    finish(1)
  }
  await sleep(1200)
}

const textShape = JSON.parse(await evaluate(`(function(){
  var blocks = Array.from(document.querySelectorAll('div')).filter(function(n){ return n.style.whiteSpace === 'pre-wrap' });
  var longest = blocks.reduce(function(best, n){ return n.innerText.length > best ? n.innerText.length : best }, 0);
  return JSON.stringify({ blocks: blocks.length, longest: longest });
})()`))
console.log('long string expanded :', JSON.stringify(textShape))

if (textShape.longest < 200) {
  console.log(`TREE FAIL: a long string rendered only ${textShape.longest} characters; it must expand to its full text`)
  finish(1)
}

// The expanded text must be legible in whatever theme the operator runs. The
// theme's label colour is dark in light mode, so any panel colour hardcoded here
// would make the value invisible on a light theme — which is exactly what a fixed
// dark background did.
const contrast = JSON.parse(await evaluate(`(function(){
  function parse(value){
    var m = /rgba?\\((\\d+), ?(\\d+), ?(\\d+)(?:, ?([\\d.]+))?\\)/.exec(value);
    return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
  }
  function luminance(c){
    function channel(v){ v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
    return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
  }
  var blocks = Array.from(document.querySelectorAll('div')).filter(function(n){ return n.style.whiteSpace === 'pre-wrap' });
  if (!blocks.length) return JSON.stringify({ error: 'no text block' });
  var block = blocks.reduce(function(a, b){ return (b.innerText || '').length > (a.innerText || '').length ? b : a }, blocks[0]);
  var colour = parse(getComputedStyle(block).color);
  var node = block, background = null;
  while (node && !background) {
    var bg = parse(getComputedStyle(node).backgroundColor);
    if (bg && bg.a > 0.5) background = bg;
    node = node.parentElement;
  }
  if (!colour || !background) return JSON.stringify({ error: 'unresolved colours' });
  var light = Math.max(luminance(colour), luminance(background));
  var dark = Math.min(luminance(colour), luminance(background));
  return JSON.stringify({
    colour: getComputedStyle(block).color,
    background: 'rgb(' + background.r + ', ' + background.g + ', ' + background.b + ')',
    ratio: Math.round((light + 0.05) / (dark + 0.05) * 100) / 100
  });
})()`))
console.log('text contrast        :', JSON.stringify(contrast))

if (!(contrast.ratio >= 4.5)) {
  console.log(`CONTRAST FAIL: the expanded text reads at ${contrast.ratio}:1; WCAG AA needs 4.5`)
  finish(1)
}

// Each pane must scroll itself. The shell's view area carries `min-height: auto`,
// so an in-flow view grows to its content and pushes the shell's scroll body past
// the viewport, which scrolls both panes together. The view root is therefore
// absolutely positioned; this asserts the arrangement still holds.
const layout = JSON.parse(await evaluate(`(function(){
  var row = document.querySelector('[data-exchange]');
  if (!row) return JSON.stringify({ error: 'no rows' });
  var root = row;
  while (root && getComputedStyle(root).position !== 'absolute') root = root.parentElement;
  if (!root) return JSON.stringify({ error: 'the view root is not absolutely positioned' });
  var scrollers = [];
  Array.prototype.forEach.call(root.querySelectorAll('*'), function(n){
    var cs = getComputedStyle(n);
    if (cs.overflowY === 'auto' || cs.overflowY === 'scroll') {
      scrollers.push({ clientH: n.clientHeight, scrollH: n.scrollHeight });
    }
  });
  var shell = document.querySelector('[class*="scrollBody"]');
  return JSON.stringify({
    scrollers: scrollers,
    shellOverflow: shell ? shell.scrollHeight - shell.clientHeight : 0
  });
})()`))

const selfScrolling = layout.scrollers.filter((s) => s.scrollH > s.clientH + 4).length
console.log('scrollers            :', layout.scrollers.length, '| self-scrolling:', selfScrolling)
console.log('shell overflow       :', layout.shellOverflow, 'px')

// Both panes exist as scrollers; only the captured data decides whether each one
// actually overflows, so the number of overflowing panes is not asserted. What the
// fix guarantees is that the shell no longer scrolls them as one column and that
// the pane holding the body does scroll itself.
if (layout.scrollers.length < 2) {
  console.log('LAYOUT FAIL: the view does not expose two independently scrollable panes')
  finish(1)
}
if (selfScrolling < 1) {
  console.log('LAYOUT FAIL: no pane scrolls itself, so the shell is scrolling the content')
  finish(1)
}
if (layout.shellOverflow > 4) {
  console.log('LAYOUT FAIL: the shell scroll body overflows, so the panes scroll as one')
  finish(1)
}

// The composer seat is a sibling of the view area, so the seat rule has to hide
// it while this view is mounted and let it back when another view takes over.
async function clickTab(name) {
  const hit = await evaluate(`(function(){
    var tabs = Array.from(document.querySelectorAll('[role="tab"]'));
    var target = tabs.filter(function(n){ return n.textContent.indexOf(${JSON.stringify(name)}) >= 0 })[0];
    if (!target) return 'MISSING';
    target.click();
    return target.textContent.trim();
  })()`)
  await sleep(2600)
  return hit
}

async function composerDisplay() {
  return evaluate(`(function(){
    var seat = document.querySelector('[data-composer-seat]');
    return seat ? getComputedStyle(seat).display : 'absent';
  })()`)
}

const seatTrace = []
for (const name of ['Chat', 'LLM Trace', 'Chat', 'LLM Trace']) {
  await clickTab(name)
  seatTrace.push(await composerDisplay())
}
console.log('composer seat        :', JSON.stringify(seatTrace), '(Chat, LLM Trace, Chat, LLM Trace)')

const seatOk = seatTrace[0] !== 'none' && seatTrace[1] === 'none' && seatTrace[2] !== 'none' && seatTrace[3] === 'none'
if (!seatOk) {
  console.log('SEAT FAIL: the composer must hide on the trace tab and return on Chat')
  finish(1)
}

console.log('console errors  :', consoleErrors.length ? JSON.stringify(consoleErrors.slice(0, 5)) : 'none')
console.log('exceptions      :', exceptions.length ? JSON.stringify(exceptions.slice(0, 5)) : 'none')
finish(exceptions.length === 0 ? 0 : 1)
