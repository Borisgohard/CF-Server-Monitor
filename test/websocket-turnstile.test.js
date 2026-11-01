import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { generateToken } from '../src/middleware/auth.js';

const JWT_SECRET = 'local-test-jwt-secret-not-a-production-credential';
const bundled = await build({
  entryPoints: ['src/index.js'], bundle: true, write: false, format: 'esm',
  platform: 'neutral', conditions: ['workerd', 'worker', 'browser'],
  external: ['node:*', 'cloudflare:*']
});

async function proof(expires = Math.floor(Date.now() / 1000) + 300) {
  const hash = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(JWT_SECRET + '_turnstile'));
  const key = await webcrypto.subtle.importKey('raw', hash, 'AES-GCM', false, ['encrypt']);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify({ verified: true, expires, timestamp: Date.now() }));
  const encrypted = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  return Buffer.concat([Buffer.from(iv), Buffer.from(encrypted)]).toString('base64');
}

function protocols(value) {
  return 'cfsm-v1, cfsm-turnstile.' + value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function fixture(t, overrides = {}, realBroadcaster = false) {
  const mf = new Miniflare({
    workers: [{
      name: 'app', modules: true, script: bundled.outputFiles[0].text,
      compatibilityDate: '2024-12-01', compatibilityFlags: ['nodejs_compat'],
      bindings: { API_SECRET: 'local-test-agent-secret' }, d1Databases: ['DB'],
      durableObjects: { METRICS_BROADCASTER: realBroadcaster ? 'MetricsBroadcaster' : { className: 'UpgradeStub', scriptName: 'upgrade-stub' } }
    }, {
      name: 'upgrade-stub', modules: true, script: `
        export class UpgradeStub {
          async fetch(request) {
            const pair = new WebSocketPair();
            pair[1].accept();
            return new Response(null, { status: 101, webSocket: pair[0] });
          }
        }
        export default { fetch() { return new Response('stub'); } };
      `
    }]
  });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB', 'app');
  await db.prepare('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)').run();
  await db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').bind('site_options', JSON.stringify({
    jwt_secret: JWT_SECRET, is_public: 'true', turnstile_enabled: 'true',
    turnstile_secret_key: 'local-test-only', wss_report_enabled: 'true',
    wss_report_hours: Array.from({ length: 24 }, (_, i) => i), ...overrides
  })).run();
  return mf;
}

async function upgrade(mf, path = '/api/ws', headers = {}) {
  const response = await mf.dispatchFetch('https://example.com' + path, {
    headers: { Upgrade: 'websocket', ...headers }
  });
  if (response.webSocket) {
    response.webSocket.accept();
    response.webSocket.close(1000, 'test complete');
  }
  return response;
}

test('public realtime requires a valid, unexpired Turnstile proof', async t => {
  const mf = await fixture(t);
  const good = await proof();
  await t.test('no proof is rejected before upgrading', async () => {
    assert.equal((await upgrade(mf, '/api/ws?subscribe=known-node')).status, 403);
  });
  await t.test('tampered proof is rejected', async () => {
    assert.equal((await upgrade(mf, '/api/ws', { 'Sec-WebSocket-Protocol': protocols('AAAA' + good.slice(4)) })).status, 403);
  });
  await t.test('expired proof is rejected', async () => {
    assert.equal((await upgrade(mf, '/api/ws', { 'Sec-WebSocket-Protocol': protocols(await proof(1)) })).status, 403);
  });
  await t.test('URL query cannot substitute for verification', async () => {
    assert.equal((await upgrade(mf, '/api/ws?turnstile_verified=' + encodeURIComponent(good))).status, 403);
  });
  await t.test('valid browser proof upgrades and negotiates only the public protocol', async () => {
    const response = await upgrade(mf, '/api/ws', { 'Sec-WebSocket-Protocol': protocols(good) });
    assert.equal(response.status, 101);
    assert.equal(response.headers.get('Sec-WebSocket-Protocol'), 'cfsm-v1');
    assert.ok(!JSON.stringify([...response.headers]).includes(good));
  });
  await t.test('existing verified header remains supported', async () => {
    assert.equal((await upgrade(mf, '/api/ws', { 'X-Turnstile-Verified': good })).status, 101);
  });
  await t.test('ordinary data API still requires verification', async () => {
    assert.equal((await mf.dispatchFetch('https://example.com/api/servers')).status, 403);
  });
  await t.test('Agent upgrade reaches its existing authentication handler without Turnstile', async () => {
    assert.equal((await upgrade(mf, '/update')).status, 101);
  });
});

test('private realtime still requires login in addition to Turnstile', async t => {
  const mf = await fixture(t, { is_public: 'false' });
  const verified = await proof();
  assert.equal((await upgrade(mf, '/api/ws', { 'Sec-WebSocket-Protocol': protocols(verified) })).status, 401);
  const login = await generateToken({}, { jwt_secret: JWT_SECRET });
  assert.equal((await upgrade(mf, '/api/ws', {
    'Sec-WebSocket-Protocol': protocols(verified), Cookie: 'cfsm_auth=' + encodeURIComponent(login)
  })).status, 101);
});

test('Turnstile-disabled sites retain their existing realtime behavior', async t => {
  const mf = await fixture(t, { turnstile_enabled: 'false' });
  const response = await upgrade(mf, '/api/ws', { 'Sec-WebSocket-Protocol': 'cfsm-v1' });
  assert.equal(response.status, 101);
  assert.equal(response.headers.get('Sec-WebSocket-Protocol'), 'cfsm-v1');
});

test('real Durable Object grants hidden-node access only to authenticated administrators', async t => {
  const mf = await fixture(t, {}, true);
  const db = await mf.getD1Database('DB', 'app');
  await db.prepare('CREATE TABLE servers (id TEXT PRIMARY KEY, is_hidden INTEGER)').run();
  await db.prepare("INSERT INTO servers VALUES ('visible', 0), ('hidden', 1)").run();
  const namespace = await mf.getDurableObjectNamespace('METRICS_BROADCASTER', 'app');
  const stub = namespace.get(namespace.idFromName('global'));
  const login = await generateToken({}, { jwt_secret: JWT_SECRET });
  const verified = await proof();
  for (const admin of [false, true]) {
    const response = await mf.dispatchFetch('https://example.com/api/ws?subscribe=all&includeHidden=true', {
      headers: {
        Upgrade: 'websocket', 'Sec-WebSocket-Protocol': protocols(verified),
        'X-Include-Hidden': 'true',
        ...(admin ? { Cookie: 'cfsm_auth=' + encodeURIComponent(login) } : {})
      }
    });
    assert.equal(response.status, 101);
    const ws = response.webSocket;
    ws.accept();
    const nextMessage = type => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('No ' + type + ' message')), 2000);
      const listener = event => {
        const message = JSON.parse(event.data);
        if (message.type !== type) return;
        clearTimeout(timeout);
        ws.removeEventListener('message', listener);
        resolve(message);
      };
      ws.addEventListener('message', listener);
    });
    try {
      const subscribed = nextMessage('subscribed');
      ws.send(JSON.stringify({ type: 'subscribe', scope: 'all', ids: ['visible', 'hidden'], includeHidden: true }));
      await subscribed;
      const batch = nextMessage('batchUpdate');
      await stub.fetch('http://internal/batch-push', { method: 'POST', body: JSON.stringify({
        updates: ['visible', 'hidden'].map(serverId => ({ serverId, payload: { cpu: 10 } }))
      }) });
      assert.deepEqual((await batch).updates.map(item => item.serverId), admin ? ['visible', 'hidden'] : ['visible']);
    } finally {
      ws.close(1000, 'test complete');
    }
  }
});
