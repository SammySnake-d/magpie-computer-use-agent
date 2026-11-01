import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createNativeApproval, parseAppApproval, showMacApproval } from '../src/native-approval.mjs';

const request = (overrides = {}) => ({ mode: 'form', message: 'Allow Computer Use to use "Finder"?',
  requestedSchema: { type: 'object', properties: {} },
  _meta: { connector_id: 'computer-use', codex_approval_kind: 'mcp_tool_call',
    tool_params: { app: 'com.apple.finder' }, tool_params_display: [{ name: 'app', value: 'Finder' }],
    persist: ['session', 'always'], riskLevel: 'low', ...overrides } });

test('only native app approvals with an empty schema and offered scopes can open a dialog', () => {
  assert.deepEqual(parseAppApproval(request()), { app: 'com.apple.finder', name: 'Finder', scopes: ['session', 'always'], risk: 'low', subtitle: '' });
  assert.equal(parseAppApproval({ ...request(), mode: 'url' }), undefined);
  assert.equal(parseAppApproval({ ...request(), requestedSchema: { type: 'object', properties: { secret: { type: 'string' } } } }), undefined);
  assert.equal(parseAppApproval(request({ connector_id: 'browser' })), undefined);
  assert.equal(parseAppApproval(request({ tool_params: { app: 'com.apple.finder\nnot-valid' } })), undefined);
  assert.equal(parseAppApproval(request({ persist: [] })), undefined);
});

test('dialog choice is scoped to the original offer and hostile display text is sanitized', async () => {
  let seen;
  const approve = createNativeApproval({ platform: 'darwin', dialog: async q => { seen = q; return 'session'; } });
  const p = request({ tool_params_display: [{ name: 'app', value: 'Finder\n\u202e伪装' }] });
  assert.deepEqual(await approve(p), { action: 'accept', content: {}, _meta: { persist: 'session' } });
  assert.doesNotMatch(seen.name, /[\n\u202e]/);
  const noAlways = createNativeApproval({ platform: 'darwin', dialog: async () => 'always' });
  assert.deepEqual(await noAlways(request({ persist: ['session'] })), { action: 'cancel' });
  const deny = createNativeApproval({ platform: 'darwin', dialog: async () => 'decline' });
  assert.deepEqual(await deny(request()), { action: 'decline' });
  const fail = createNativeApproval({ platform: 'darwin', dialog: async () => { throw Error('closed'); } });
  assert.deepEqual(await fail(request()), { action: 'cancel' });
});

test('prompts are serialized and an aborted queued request never opens a dialog', async () => {
  const seen = []; let finish;
  const approve = createNativeApproval({ platform: 'darwin', dialog: async q => { seen.push(q.app); return new Promise(r => { finish = r; }); } });
  const first = approve(request());
  await new Promise(r => setImmediate(r));
  const controller = new AbortController();
  const second = approve(request({ tool_params: { app: 'com.example.other' } }), { signal: controller.signal });
  controller.abort();
  assert.deepEqual(await second, { action: 'cancel' });
  finish('session');
  assert.equal((await first).action, 'accept');
  await new Promise(r => setImmediate(r));
  assert.deepEqual(seen, ['com.apple.finder']);
});

test('the native subprocess cannot approve after cancellation or malformed output', async () => {
  function fake() {
    const child = new EventEmitter(); child.stdout = new PassThrough();
    child.kill = () => { child.emit('close', null); return true; };
    return child;
  }
  const controller = new AbortController(), child = fake();
  const pending = showMacApproval(parseAppApproval(request()), { signal: controller.signal, spawnProcess: () => child });
  controller.abort();
  assert.equal(await pending, 'cancel');
  const malformed = fake();
  const other = showMacApproval(parseAppApproval(request()), { spawnProcess: () => malformed });
  malformed.stdout.write('unexpected'); malformed.emit('close', 0);
  assert.equal(await other, 'cancel');
});
