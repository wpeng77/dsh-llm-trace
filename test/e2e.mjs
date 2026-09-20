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

let labels = await waitForTabs()
if (labels.length === 0) {
  // The blank Hero renders no views; open a session from the sidebar first.
  const opened = await evaluate(`(function(){
    var items = Array.from(document.querySelectorAll('[role="treeitem"]'));
    var target = items.filter(function(n){ return /(min|\\dh|\\dd|mo)\\b/.test(n.textContent) })[0];
    if (!target) return 'no session item found';
    target.click();
    return target.textContent.trim().slice(0, 60);
  })()`)
  console.log('opened session  :', opened)
  labels = await waitForTabs()
}

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
console.log('self-scrolling panes :', selfScrolling, 'of', layout.scrollers.length)
console.log('shell overflow       :', layout.shellOverflow, 'px')

if (selfScrolling < 2) {
  console.log('LAYOUT FAIL: fewer than two panes scroll themselves — both panes will scroll together')
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
