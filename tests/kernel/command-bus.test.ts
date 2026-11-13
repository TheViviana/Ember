import assert from 'node:assert/strict';
import test from 'node:test';
import { asCommandId, type CommandId } from '#doc-model';
import { createCommandBus, type Command } from '../../src/kernel/command-bus.ts';
import { EmberError } from '../../src/kernel/errors.ts';
import { createEventBus } from '../../src/kernel/events.ts';
import { stubContext } from './fakes.ts';

const cid = (value: string): CommandId => {
  const id = asCommandId(value);
  assert.ok(id !== null, `命令 id 非法：${value}`);
  return id;
};

const createBus = () => {
  const bus = createCommandBus({ events: createEventBus() });
  bus.bindKernel(() => stubContext(bus));
  return bus;
};

const noop = (): void => {};

void test('注册后可执行，执行结果带 ok', async () => {
  const bus = createBus();
  let calls = 0;
  bus.register<void>({
    id: cid('core.test.run'),
    title: 'Run',
    scope: 'global',
    run: () => {
      calls += 1;
    },
  });

  const result = await bus.execute(cid('core.test.run'));
  assert.deepEqual(result, { id: cid('core.test.run'), ok: true, error: null });
  assert.equal(calls, 1);
});

void test('非法命令 id 注册即抛 invalid_command_id', () => {
  const bus = createBus();
  const invalid = 'core' as unknown as CommandId;
  assert.throws(
    () => bus.register({ id: invalid, title: 'bad', scope: 'global', run: noop }),
    (error: unknown) => error instanceof EmberError && error.code === 'invalid_command_id',
  );
});

void test('重复 id 后来者失败，先注册者继续有效', async () => {
  const bus = createBus();
  let owner = '';
  bus.register({ id: cid('core.test.dup'), title: 'first', scope: 'global', run: () => void (owner = 'first') });
  assert.throws(
    () => bus.register({ id: cid('core.test.dup'), title: 'second', scope: 'global', run: () => void (owner = 'second') }),
    (error: unknown) => error instanceof EmberError && error.code === 'duplicate_command',
  );
  await bus.execute(cid('core.test.dup'));
  assert.equal(owner, 'first');
});

void test('执行不抛异常：未知命令返回 command_not_found', async () => {
  const bus = createBus();
  const result = await bus.execute(cid('core.test.missing'));
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /command_not_found/);
});

void test('命令重入被拒绝', async () => {
  const bus = createBus();
  let inner: string | null = null;
  bus.register({
    id: cid('core.test.reentrant'),
    title: 'reentrant',
    scope: 'global',
    run: async () => {
      const result = await bus.execute(cid('core.test.reentrant'));
      inner = result.error;
    },
  });
  const outer = await bus.execute(cid('core.test.reentrant'));
  assert.equal(outer.ok, true);
  assert.match(inner ?? '', /command_reentrant/);
});

void test('注销后从 list 消失且顺序稳定', () => {
  const bus = createBus();
  const registration = bus.register({ id: cid('core.test.owned'), title: 'owned', scope: 'editor', run: noop });

  const listed = bus.list();
  assert.equal(listed.length, 1);
  assert.equal(String(listed[0]?.id), 'core.test.owned');

  bus.register({ id: cid('core.test.free'), title: 'free', scope: 'global', run: noop });
  const sorted = bus.list().map((descriptor) => String(descriptor.id));
  assert.deepEqual(sorted, ['core.test.free', 'core.test.owned']);

  registration.dispose();
  assert.deepEqual(bus.list().map((descriptor) => String(descriptor.id)), ['core.test.free']);
});

void test('watch 在注册与注销时收到稳定快照', () => {
  const bus = createBus();
  const snapshots: number[] = [];
  const subscription = bus.watch((descriptors) => snapshots.push(descriptors.length));
  const registration = bus.register<unknown>({
    id: cid('core.test.watched'),
    title: 'watched',
    scope: 'global',
    run: (_args, ctx) => void ctx,
  });
  registration.dispose();
  subscription.dispose();
  assert.deepEqual(snapshots, [1, 0]);
});

void test('未绑定内核上下文时执行返回 not_implemented', async () => {
  const bus = createCommandBus();
  const command: Command = { id: cid('core.test.unbound'), title: 'unbound', scope: 'global', run: noop };
  bus.register(command);
  const result = await bus.execute(cid('core.test.unbound'));
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /not_implemented/);
});
