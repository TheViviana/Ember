import assert from 'node:assert/strict';
import test from 'node:test';
import type { VaultStartupView } from '../../src/data/tauri/vault-session.ts';
import {
  isSameDirectory,
  runVaultSwitch,
  type VaultSwitchDeps,
} from '../../src/shell/settings/vault-switch.ts';

const readyView: VaultStartupView = {
  status: 'ready',
  root: '/vaults/next',
  identity: { vaultId: '01JNEXT', readonly: false },
};

const createDeps = (
  calls: string[],
  overrides: Partial<VaultSwitchDeps> = {},
): VaultSwitchDeps => ({
  flushFloatEditors: () =>
    Promise.resolve().then(() => {
      calls.push('float');
    }),
  flushDocs: () =>
    Promise.resolve().then(() => {
      calls.push('docs');
    }),
  flushCanvas: () =>
    Promise.resolve().then(() => {
      calls.push('canvas');
    }),
  flushSettings: () =>
    Promise.resolve().then(() => {
      calls.push('settings');
    }),
  open: (root) => {
    calls.push(`open:${root}`);
    return Promise.resolve(readyView);
  },
  reload: () => {
    calls.push('reload');
  },
  ...overrides,
});

void test('切库前先冲刷浮窗编辑器的防抖写入，全部落盘后才打开并重载', async () => {
  const calls: string[] = [];
  const outcome = await runVaultSwitch(createDeps(calls), '/vaults/next', 'existing');

  assert.deepEqual(outcome, { kind: 'switched' });
  // S2 的原始问题：漏掉 float 时最后一次编辑会随 reload 丢失
  assert.deepEqual(calls, [
    'float',
    'docs',
    'canvas',
    'settings',
    'open:/vaults/next',
    'reload',
  ]);
});

void test('浮窗落盘失败时中止切换：不打开目标库、不重载、当前库保留', async () => {
  const calls: string[] = [];
  const outcome = await runVaultSwitch(
    createDeps(calls, {
      flushFloatEditors: () => {
        calls.push('float');
        return Promise.reject(new Error('disk full'));
      },
    }),
    '/vaults/next',
    'existing',
  );

  assert.equal(outcome.kind, 'aborted');
  assert.match(outcome.kind === 'aborted' ? outcome.reason : '', /disk full/);
  assert.deepEqual(calls, ['float'], '失败后不得继续落盘、打开或重载');
});

void test('目标库未就绪时不重载窗口', async () => {
  const calls: string[] = [];
  const outcome = await runVaultSwitch(
    createDeps(calls, {
      open: () => Promise.resolve({ status: 'failed', root: null, code: 'startup_failed', message: '坏了' }),
    }),
    '/vaults/next',
    'existing',
  );

  assert.equal(outcome.kind, 'aborted');
  assert.ok(!calls.includes('reload'), '未就绪的库不能把当前界面重载掉');
});

void test('同一目录按尾斜杠归一化，避免把当前库再打开一次', () => {
  assert.equal(isSameDirectory('/vaults/a', '/vaults/a/'), true);
  assert.equal(isSameDirectory('/vaults/a/', '/vaults/a'), true);
  assert.equal(isSameDirectory('/vaults/a', '/vaults/b'), false);
});
