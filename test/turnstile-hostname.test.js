import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyTurnstileToken } from '../src/utils/common.js';

const hostname = 'monitor.example.com';

for (const [name, result, accepted] of [
  ['exact hostname', { success: true, hostname }, true],
  ['different hostname', { success: true, hostname: 'other.example.com' }, false],
  ['parent hostname', { success: true, hostname: 'example.com' }, false],
  ['child hostname', { success: true, hostname: 'other.monitor.example.com' }, false],
  ['hostname suffix', { success: true, hostname: 'monitor.example.com.invalid' }, false],
  ['missing hostname', { success: true }, false],
  ['failed verification', { success: false, hostname }, false],
  ['non-boolean success', { success: 'true', hostname }, false]
]) {
  test(`Turnstile checks Siteverify hostname: ${name}`, async t => {
    t.mock.method(globalThis, 'fetch', async () => Response.json(result));
    assert.equal(await verifyTurnstileToken('test-token', 'test-secret', hostname), accepted);
  });
}

test('Turnstile requires an expected hostname before sending a token', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ success: true, hostname }));
  assert.equal(await verifyTurnstileToken('test-token', 'test-secret'), false);
  assert.equal(await verifyTurnstileToken('test-token', 'test-secret', ''), false);
  assert.equal(fetch.mock.callCount(), 0);
});

test('an unsuccessful Siteverify HTTP response cannot grant access', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ success: true, hostname }, { status: 503 }));
  assert.equal(await verifyTurnstileToken('test-token', 'test-secret', hostname), false);
});
