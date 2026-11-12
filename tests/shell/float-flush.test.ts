import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import {
  FloatFlushError,
  flushFloatEditors,
  registerFloatFlusher,
  settleFloatWrite,
  trackFloatWrite,
} from '../../src/shell/editor/float-flush.ts';

void test('关窗前注册的编辑器落盘回调全部执行', async () => {
  const calls: string[] = [];
  const unsubscribeA = registerFloatFlusher(() => {
    calls.push('a');
    return Promise.resolve();
  });
  const unsubscribeB = registerFloatFlusher(() => {
    calls.push('b');
    return Promise.resolve();
  });

  await flushFloatEditors();

  assert.deepEqual(calls, ['a', 'b']);
  unsubscribeA();
  unsubscribeB();
});

void test('注销后的回调不再执行；单个回调失败不阻断其它，失败汇总上报', async () => {
  const calls: string[] = [];
  const unsubscribeBroken = registerFloatFlusher(() => Promise.reject(new Error('disk full')));
  const unsubscribeHealthy = registerFloatFlusher(() => {
    calls.push('healthy');
    return Promise.resolve();
  });

  await assert.rejects(
    () => flushFloatEditors(),
    (error: unknown) =>
      error instanceof FloatFlushError && error.failures.some((text) => text.includes('disk full')),
    '存在失败时必须向上抛，关窗流程据此阻止关闭',
  );
  assert.deepEqual(calls, ['healthy'], '失败的回调不阻断其它落盘');

  unsubscribeBroken();
  unsubscribeHealthy();
  await flushFloatEditors();
  assert.deepEqual(calls, ['healthy'], '注销后关窗不再触发');
});

void test('关闭写入未完成时，重开必须挂在等待上，落盘后才继续', async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let written = false;
  trackFloatWrite('doc-a', gate.then(() => {
    written = true;
  }));

  let settled = false;
  const waiting = settleFloatWrite('doc-a').then(() => {
    settled = true;
  });
  await delay(0);
  assert.equal(settled, false, '写入未完成前不能放行');
  assert.equal(written, false);

  release();
  await waiting;
  assert.equal(written, true, '放行时写入已完成');
});

void test('没有挂起写入时立即返回', async () => {
  await settleFloatWrite('doc-none');
});

void test('写入失败也不阻塞重开（错误由保存流程自己上报）', async () => {
  trackFloatWrite('doc-b', Promise.reject(new Error('disk full')));
  await assert.doesNotReject(() => settleFloatWrite('doc-b'));
});

void test('同一篇连续收尾两次：等待最后一次也完成，完成后清空记录', async () => {
  const done: string[] = [];
  let releaseFirst: () => void = () => undefined;
  const first = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  trackFloatWrite('doc-c', first.then(() => {
    done.push('first');
  }));
  trackFloatWrite('doc-c', Promise.resolve().then(() => {
    done.push('second');
  }));

  const waiting = settleFloatWrite('doc-c');
  releaseFirst();
  await waiting;
  assert.deepEqual([...done].sort(), ['first', 'second']);

  await settleFloatWrite('doc-c');
});
