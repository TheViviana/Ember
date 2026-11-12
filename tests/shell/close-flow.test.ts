import assert from 'node:assert/strict';
import test from 'node:test';
import { runCloseFlow } from '../../src/shell/close-flow.ts';

const createLog = (): { readonly errors: string[]; readonly error: (message: string) => void } => {
  const errors: string[] = [];
  return {
    errors,
    error: (message: string): void => {
      errors.push(message);
    },
  };
};

void test('阶段一全部成功：执行全部落盘后再拆解内核', async () => {
  const calls: string[] = [];
  const log = createLog();
  const outcome = await runCloseFlow({
    flushers: [
      () =>
        Promise.resolve().then(() => {
          calls.push('ui');
        }),
      () =>
        Promise.resolve().then(() => {
          calls.push('kernel');
        }),
    ],
    shutdown: () => {
      calls.push('shutdown');
      return Promise.resolve();
    },
    log,
  });

  assert.deepEqual(outcome, { kind: 'close' });
  assert.deepEqual(calls, ['ui', 'kernel', 'shutdown']);
  assert.deepEqual(log.errors, []);
});

void test('阶段一有失败：返回 block、汇总失败且不进入 shutdown', async () => {
  const calls: string[] = [];
  const log = createLog();
  const outcome = await runCloseFlow({
    flushers: [
      () => Promise.reject(new Error('disk full')),
      () =>
        Promise.resolve().then(() => {
          calls.push('healthy');
        }),
    ],
    shutdown: () => {
      calls.push('shutdown');
      return Promise.resolve();
    },
    log,
  });

  assert.equal(outcome.kind, 'block');
  assert.ok(outcome.kind === 'block');
  assert.equal(outcome.failures.length, 1);
  assert.match(outcome.failures[0] ?? '', /disk full/);
  assert.deepEqual(calls, ['healthy'], '其它落盘仍执行完，但绝不能拆解内核');
  assert.deepEqual(log.errors, []);
});

void test('阶段一多处失败：一次汇总全部原因', async () => {
  const outcome = await runCloseFlow({
    flushers: [() => Promise.reject(new Error('disk full')), () => Promise.reject(new Error('permission denied'))],
    shutdown: () => Promise.resolve(),
    log: createLog(),
  });

  assert.equal(outcome.kind, 'block');
  assert.ok(outcome.kind === 'block');
  assert.equal(outcome.failures.length, 2);
  assert.match(outcome.failures.join('|'), /disk full/);
  assert.match(outcome.failures.join('|'), /permission denied/);
});

void test('阶段二 shutdown 失败：仍允许关闭但记录错误', async () => {
  const log = createLog();
  const outcome = await runCloseFlow({
    flushers: [() => Promise.resolve()],
    shutdown: () => Promise.reject(new Error('teardown failed')),
    log,
  });

  assert.deepEqual(outcome, { kind: 'close' });
  assert.equal(log.errors.length, 1);
  assert.match(log.errors[0] ?? '', /关窗收尾失败/);
});
