import assert from 'node:assert/strict';
import test from 'node:test';
import { routeChatRejection, type ChatHandlers } from '../../src/data/tauri/ai.ts';

interface Spy {
  done: number;
  errors: string[];
}

const spy = (): { handlers: ChatHandlers; spy: Spy } => {
  const state: Spy = { done: 0, errors: [] };
  return {
    handlers: {
      onDelta: () => undefined,
      onDone: () => {
        state.done += 1;
      },
      onError: (message) => {
        state.errors.push(message);
      },
    },
    spy: state,
  };
};

void test('用户主动取消按正常结束收尾，不进入 onError', () => {
  const { handlers, spy: state } = spy();

  routeChatRejection({ code: 'ai_cancelled', message: '请求已取消' }, handlers);

  assert.equal(state.done, 1);
  assert.deepEqual(state.errors, []);
});

void test('其余拒绝仍走 onError 并保留服务端文案', () => {
  const { handlers, spy: state } = spy();

  routeChatRejection({ code: 'ai_network', message: '无法连接' }, handlers);
  routeChatRejection(new Error('boom'), handlers);
  routeChatRejection('plain string', handlers);

  assert.equal(state.done, 0);
  assert.deepEqual(state.errors, ['无法连接', 'boom', 'plain string']);
});

void test('缺失 code 字段的拒绝不会误判为取消', () => {
  const { handlers, spy: state } = spy();

  routeChatRejection({ message: '请求已取消' }, handlers);

  assert.equal(state.done, 0);
  assert.deepEqual(state.errors, ['请求已取消']);
});
