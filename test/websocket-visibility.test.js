import assert from 'node:assert/strict';
import test from 'node:test';
import { MetricsBroadcaster } from '../src/durable/MetricsBroadcaster.js';

globalThis.WebSocketRequestResponsePair = class {};

function socket(attachment) {
  return {
    messages: [],
    deserializeAttachment: () => attachment,
    serializeAttachment: value => { attachment = value; },
    send(value) { this.messages.push(JSON.parse(value)); }
  };
}

function fixture(sockets, readIds = () => ['visible']) {
  const state = { setWebSocketAutoResponse() {}, getWebSockets: () => sockets };
  const env = { DB: { prepare: () => ({ all: async () => ({ results: readIds().map(id => ({ id })) }) }) } };
  return new MetricsBroadcaster(state, env);
}

const updates = ['visible', 'hidden'].map(serverId => ({ serverId, samples: [{ ts: 1000, data: { cpu: 10 } }] }));

test('public realtime filters hidden IDs for direct and all subscriptions', async () => {
  const direct = socket({ scope: 'hidden', serverIds: [] });
  const all = socket({ scope: 'all', serverIds: ['visible', 'hidden'] });
  const admin = socket({ scope: 'all', serverIds: ['visible', 'hidden'], includeHidden: true });
  await fixture([direct, all, admin])._broadcastBatch(updates);
  assert.equal(direct.messages.length, 0);
  assert.deepEqual(all.messages[0].updates.map(item => item.serverId), ['visible']);
  assert.deepEqual(admin.messages[0].updates.map(item => item.serverId), ['visible', 'hidden']);
});

test('subscription changes preserve server-authorized role and ignore client role claims', async () => {
  const publicWs = socket({ scope: 'visible', serverIds: [], includeHidden: false });
  const adminWs = socket({ scope: 'visible', serverIds: [], includeHidden: true });
  const broadcaster = fixture([publicWs, adminWs]);
  broadcaster._hintAgentRealtimeIntervals = async () => {};
  for (const ws of [publicWs, adminWs]) {
    await broadcaster.webSocketMessage(ws, JSON.stringify({ type: 'subscribe', scope: 'hidden', includeHidden: true }));
  }
  publicWs.messages.length = 0;
  adminWs.messages.length = 0;
  await broadcaster._broadcastBatch(updates);
  assert.equal(publicWs.messages.length, 0);
  assert.equal(adminWs.messages[0].updates[0].serverId, 'hidden');
});

test('visibility lookup failure fails closed for public viewers without breaking admin delivery', async () => {
  const publicWs = socket({ scope: 'hidden', serverIds: [] });
  const adminWs = socket({ scope: 'hidden', serverIds: [], includeHidden: true });
  const broadcaster = fixture([publicWs, adminWs], () => { throw new Error('D1 unavailable'); });
  await broadcaster._broadcastBatch(updates);
  assert.equal(publicWs.messages.length, 0);
  assert.equal(adminWs.messages[0].updates[0].serverId, 'hidden');
});

test('visibility is cached between batches and invalidated by node configuration changes', async () => {
  const publicWs = socket({ scope: 'visible', serverIds: [] });
  let visible = ['visible'];
  let queries = 0;
  const broadcaster = fixture([publicWs], () => { queries++; return visible; });
  await broadcaster._broadcastBatch(updates);
  await broadcaster._broadcastBatch(updates);
  assert.equal(queries, 1);
  visible = [];
  broadcaster._loadAgentConfigDescriptor = async () => null;
  await broadcaster._handleAgentConfigChanged(new Request('http://internal/agent-config-changed', {
    method: 'POST', body: JSON.stringify({ serverId: 'visible' })
  }));
  publicWs.messages.length = 0;
  await broadcaster._broadcastBatch(updates);
  assert.equal(queries, 2);
  assert.equal(publicWs.messages.length, 0);
});

test('visibility lookup is skipped with no public subscribers', async () => {
  let queries = 0;
  const adminWs = socket({ scope: 'hidden', serverIds: [], includeHidden: true });
  const broadcaster = fixture([adminWs], () => { queries++; return []; });
  await broadcaster._broadcastBatch(updates);
  assert.equal(queries, 0);
  assert.equal(adminWs.messages[0].updates[0].serverId, 'hidden');
});

test('visibility refreshes within 30 seconds even if a configuration notification is missed', async t => {
  let now = 100000;
  t.mock.method(Date, 'now', () => now);
  let ids = ['visible'];
  const publicWs = socket({ scope: 'visible', serverIds: [] });
  const broadcaster = fixture([publicWs], () => ids);
  await broadcaster._broadcastBatch(updates);
  assert.equal(publicWs.messages.length, 1);
  ids = [];
  now += 30000;
  publicWs.messages.length = 0;
  await broadcaster._broadcastBatch(updates);
  assert.equal(publicWs.messages.length, 0);
});
