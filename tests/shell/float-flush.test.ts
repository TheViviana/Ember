import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { settleFloatWrite, trackFloatWrite } from '../../src/shell/editor/float-flush.ts';

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
  await settleFloatWrite('doc-b');
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
