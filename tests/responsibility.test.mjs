import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeRuntimeCommand, responsibilityLauncher, verifyDesktopHelper } from '../src/gateway/responsibility.mjs';

const helper = '/Relocated/Claude.app/Contents/Helpers/disclaimer';
const processTree = new Map([
  [10, { parent: 11, executable: '/somewhere/magpie-bun' }],
  [11, { parent: 12, executable: helper }],
  [12, { parent: 1, executable: '/Relocated/Claude.app/Contents/MacOS/Claude' }],
]);

test('a non-Desktop host keeps the original native command', () => {
  const read = pid => ({ parent: 1, executable: '/normal/agent' });
  assert.equal(responsibilityLauncher({ pid: 10, read, verify: () => assert.fail('no helper') }), undefined);
  assert.deepEqual(nativeRuntimeCommand('/official/node', '/official/cua-repl.mjs', undefined),
    { command: '/official/node', args: ['/official/cua-repl.mjs'] });
});

test('the actual inherited Desktop helper launches only the original signed runtime', () => {
  const verified = [];
  const found = responsibilityLauncher({ pid: 10, read: pid => processTree.get(pid), verify: p => { verified.push(p); return p; } });
  assert.deepEqual(verified, [helper]);
  assert.deepEqual(nativeRuntimeCommand('/official/node', '/official/cua-repl.mjs', found), {
    command: helper, args: ['--exec', '--', '/official/node', '/official/cua-repl.mjs'],
  });
});

test('an untrusted inherited helper fails closed rather than being executed', () => {
  assert.throws(() => responsibilityLauncher({ pid: 10, read: pid => processTree.get(pid),
    verify: () => { throw new Error('untrusted helper'); } }), /untrusted helper/);
});

test('ancestor cycles and vanished processes do not select an unrelated helper', () => {
  assert.equal(responsibilityLauncher({ pid: 10, read: () => ({ parent: 10, executable: '/ordinary/process' }), verify: () => assert.fail('cycle') }), undefined);
  assert.equal(responsibilityLauncher({ pid: 10, read: () => undefined, verify: () => assert.fail('vanished') }), undefined);
});

test('the helper must be inside an app and carry a valid Anthropic signature', () => {
  const calls = [];
  const verify = (team = 'Q6L2SF6YDW', valid = true) => ({
    realpath: p => p,
    stat: () => ({ isFile: () => true }),
    run: (cmd, args) => {
      calls.push([cmd, ...args]);
      return { status: valid ? 0 : 1, stdout: '', stderr: `Identifier=disclaimer\nTeamIdentifier=${team}\n` };
    },
  });
  assert.equal(verifyDesktopHelper(helper, verify()), helper);
  assert.equal(calls.length, 2);
  assert.throws(() => verifyDesktopHelper(helper, verify('OTHER')), /不是受信/);
  assert.throws(() => verifyDesktopHelper(helper, verify('Q6L2SF6YDW', false)), /签名校验失败/);
  assert.throws(() => verifyDesktopHelper('/tmp/disclaimer', verify()), /不属于完整/);
  assert.throws(() => verifyDesktopHelper('disclaimer', verify()), /路径无效/);
});
