import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'vite'

async function fixture(t) {
  const vite = await createServer({ configFile: false, appType: 'custom', logLevel: 'silent', server: { middlewareMode: true, https: false, watch: null } })
  const { createLiveSocket } = await vite.ssrLoadModule('/src/frontend/utils/api.js')
  const { STORAGE } = await vite.ssrLoadModule('/src/frontend/utils/constants.js')
  const originals = { window: globalThis.window, document: globalThis.document, localStorage: globalThis.localStorage, WebSocket: globalThis.WebSocket, fetch: globalThis.fetch, setTimeout, clearTimeout }
  const state = {
    sockets: [], timers: [], requests: [], reloads: 0, messages: [], statuses: [],
    response: () => Response.json({ turnstile_enabled: true, verified: true })
  }
  const storage = new Map([[STORAGE.TURNSTILE_VERIFIED, 'local-test-proof']])
  class Socket {
    constructor(url, protocols) { this.url = url; this.protocols = protocols; this.listeners = {}; state.sockets.push(this) }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn) }
    emit(type, event = {}) { for (const fn of this.listeners[type] || []) fn(event) }
    send() {}
    close() { this.emit('close', {}) }
  }
  globalThis.window = { location: { origin: 'https://example.com', protocol: 'https:', host: 'example.com', reload() { state.reloads++ } } }
  globalThis.document = { hidden: false }
  globalThis.localStorage = { getItem: k => storage.get(k) || '', setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) }
  globalThis.WebSocket = Socket
  globalThis.fetch = async (url, init) => { state.requests.push({ url, init }); return state.response() }
  globalThis.setTimeout = (fn, delay) => { const timer = { fn, delay }; state.timers.push(timer); return timer }
  globalThis.clearTimeout = timer => { if (timer) timer.cleared = true }
  const flush = () => new Promise(resolve => originals.setTimeout(resolve, 0))
  const pending = () => state.timers.filter(timer => !timer.done && !timer.cleared)
  const next = async () => {
    const timer = pending()[0]
    assert.ok(timer, 'expected a pending retry')
    timer.done = true
    timer.fn()
    await flush()
    return timer.delay
  }
  const live = createLiveSocket('all', { onStatus: s => state.statuses.push(s), onMessage: m => state.messages.push(m) })
  t.after(async () => { live.close(); Object.assign(globalThis, originals); await vite.close() })
  return { state, live, next, pending, flush, storage, STORAGE }
}

test('returning from the background checks the existing proof and resumes updates', async t => {
  const { state, live, flush } = await fixture(t)
  state.sockets[0].emit('open')
  document.hidden = true
  live.close()
  document.hidden = false
  live.reconnect()
  await flush()
  assert.equal(state.requests.length, 1)
  assert.equal(state.requests[0].init.headers['X-Turnstile-Verified'], 'local-test-proof')
  assert.equal(state.requests[0].init.headers['X-Turnstile-Token'], undefined)
  assert.equal(state.sockets.length, 2)
  state.sockets[1].emit('open')
  state.sockets[1].emit('message', { data: JSON.stringify({ type: 'batchUpdate', updates: [] }) })
  assert.equal(live.isConnected, true)
  assert.equal(state.messages.length, 1)
  assert.equal(state.reloads, 0)
})

test('expired verification after a failed handshake enters the existing challenge flow', async t => {
  const { state, next, pending, storage, STORAGE } = await fixture(t)
  state.response = () => Response.json({ error: 'Turnstile verification failed', code: 403 }, { status: 403 })
  state.sockets[0].emit('error')
  await next()
  assert.equal(state.reloads, 1)
  assert.equal(storage.has(STORAGE.TURNSTILE_VERIFIED), false)
  assert.equal(state.sockets.length, 1)
  assert.equal(pending().length, 0)
  assert.equal(state.statuses.at(-1).reason, 'verification required')
})

test('missing proof also returns to verification without sending raw Turnstile tokens', async t => {
  const { state, live, flush } = await fixture(t)
  state.response = () => Response.json({ turnstile_enabled: true, verified: false })
  live.reconnect()
  await flush()
  assert.equal(state.reloads, 1)
  assert.equal(state.sockets.length, 1)
})

test('closing cancels the entire reconnect delay', async t => {
  const { state, live, pending } = await fixture(t)
  state.sockets[0].emit('error')
  assert.equal(pending().length, 1)
  live.close()
  assert.equal(pending().length, 0)
  assert.equal(state.requests.length, 0)
  assert.equal(state.sockets.length, 1)
})

test('closing during verification cannot revive a hidden connection or reload the page', async t => {
  const { state, live, flush } = await fixture(t)
  let resolve
  state.response = () => new Promise(done => { resolve = done })
  live.reconnect()
  document.hidden = true
  live.close()
  resolve(Response.json({ error: 'Turnstile verification failed' }, { status: 403 }))
  await flush()
  assert.equal(state.sockets.length, 1)
  assert.equal(state.reloads, 0)
})

test('temporary failures retry past ten attempts with a capped delay and recover', async t => {
  const { state, next, pending } = await fixture(t)
  state.response = () => Response.json({ error: 'temporarily unavailable' }, { status: 503 })
  state.sockets[0].emit('error')
  const delays = []
  for (let i = 0; i < 12; i++) {
    delays.push(await next())
    assert.equal(pending().length, 1)
  }
  assert.deepEqual(delays.slice(0, 6), [1000, 2000, 4000, 8000, 16000, 30000])
  assert.ok(delays.every(delay => delay <= 30000))
  state.response = () => Response.json({ turnstile_enabled: true, verified: true })
  await next()
  assert.equal(state.sockets.length, 2)
  assert.equal(state.reloads, 0)
})

test('an unrelated edge 403 does not cause a challenge reload loop', async t => {
  const { state, next, pending } = await fixture(t)
  state.response = () => new Response('error code: 1010', { status: 403 })
  state.sockets[0].emit('error')
  await next()
  assert.equal(state.reloads, 0)
  assert.equal(pending().length, 1)
})

test('Turnstile-disabled configurations can reconnect without a proof', async t => {
  const { state, live, flush, storage } = await fixture(t)
  storage.clear()
  state.response = () => Response.json({ turnstile_enabled: false, verified: false })
  live.reconnect()
  await flush()
  assert.equal(state.sockets.length, 2)
  assert.equal(state.reloads, 0)
})

test('a delayed retry does not query or connect while the page is hidden', async t => {
  const { state, next, pending } = await fixture(t)
  state.sockets[0].emit('error')
  document.hidden = true
  await next()
  assert.equal(state.requests.length, 0)
  assert.equal(state.sockets.length, 1)
  assert.equal(pending().length, 0)
})

test('an older verification response cannot replace a newer connection', async t => {
  const { state, live, flush } = await fixture(t)
  let resolve
  state.response = () => new Promise(done => { resolve = done })
  live.reconnect()
  state.response = () => Response.json({ turnstile_enabled: true, verified: true })
  live.reconnect()
  await flush()
  state.sockets[1].emit('open')
  resolve(Response.json({ turnstile_enabled: true, verified: false }))
  await flush()
  assert.equal(state.sockets.length, 2)
  assert.equal(state.reloads, 0)
  assert.equal(live.isConnected, true)
})
