import assert from 'node:assert/strict';
import test from 'node:test';
import { asCapabilityId, asCommandId, type CapabilityId, type CommandId } from '#doc-model';
import {
  createCapabilityHost,
  type CapabilityHostInternal,
  type CapabilityModule,
} from '../../src/kernel/capability-host.ts';
import { createCommandBus, type CommandBus } from '../../src/kernel/command-bus.ts';
import { scopeContext } from '../../src/kernel/context.ts';
import { EmberError } from '../../src/kernel/errors.ts';
import { createEventBus } from '../../src/kernel/events.ts';
import type { CapabilityManifest, Logger } from '../../src/kernel/types.ts';
import { stubContext } from './fakes.ts';

const capId = (value: string): CapabilityId => {
  const id = asCapabilityId(value);
  assert.ok(id !== null, `能力 id 非法：${value}`);
  return id;
};

const cid = (value: string): CommandId => {
  const id = asCommandId(value);
  assert.ok(id !== null, `命令 id 非法：${value}`);
  return id;
};

const silentLogger: Logger = {
  debug: (): void => {},
  info: (): void => {},
  warn: (): void => {},
  error: (): void => {},
};

interface Harness {
  readonly host: CapabilityHostInternal;
  readonly commands: CommandBus;
  readonly order: string[];
}

const createHarness = (): Harness => {
  const order: string[] = [];
  const commands = createCommandBus({ events: createEventBus() });
  const base = stubContext(commands);
  commands.bindKernel(() => base);
  const host = createCapabilityHost({
    kernelVersion: '1.0.0',
    events: createEventBus(),
    log: silentLogger,
    commands,
    createContext: (_module, track) => scopeContext(base, track),
  });
  return { host, commands, order };
};

const moduleOf = (
  id: string,
  overrides: Partial<CapabilityManifest>,
  activate: CapabilityModule['activate'],
): CapabilityModule => ({
  manifest: {
    id: capId(id),
    version: '1.0.0',
    displayName: id,
    requiresKernel: '^1.0.0',
    defaultEnabled: true,
    ...overrides,
  },
  activate,
});

void test('激活时注册的命令 owner 等于能力 id，停用后命令消失（C6）', async () => {
  const { host, commands } = createHarness();
  host.register(
    moduleOf('ember.core.slash', {}, (ctx) => {
      ctx.commands.register({ id: cid('core.slash.open'), title: '斜杠', scope: 'global', run: () => {} });
    }),
  );
  host.validate();
  await host.activate(capId('ember.core.slash'));

  assert.equal(host.isActive(capId('ember.core.slash')), true);
  const listed = commands.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.owner, capId('ember.core.slash'));

  await host.deactivate(capId('ember.core.slash'));
  assert.equal(host.isActive(capId('ember.core.slash')), false);
  assert.deepEqual(commands.list(), []);
});

void test('依赖按拓扑序激活，停用按反拓扑序（C3）', async () => {
  const { host, order } = createHarness();
  host.register(moduleOf('ember.core.base', {}, () => void order.push('base')));
  host.register(moduleOf('ember.core.top', { dependsOn: [capId('ember.core.base')] }, () => void order.push('top')));

  await host.activate(capId('ember.core.top'));
  assert.deepEqual(order, ['base', 'top']);

  await host.deactivate(capId('ember.core.base'));
  assert.equal(host.isActive(capId('ember.core.top')), false);
  assert.equal(host.isActive(capId('ember.core.base')), false);
});

void test('依赖成环与依赖缺失都在 validate 阶段失败', () => {
  const cyclic = createHarness();
  cyclic.host.register(moduleOf('ember.a', { dependsOn: [capId('ember.b')] }, () => {}));
  cyclic.host.register(moduleOf('ember.b', { dependsOn: [capId('ember.a')] }, () => {}));
  assert.throws(
    () => cyclic.host.validate(),
    (error: unknown) => error instanceof EmberError && error.code === 'capability_failed',
  );

  const missing = createHarness();
  missing.host.register(moduleOf('ember.c', { dependsOn: [capId('ember.ghost')] }, () => {}));
  assert.throws(
    () => missing.host.validate(),
    (error: unknown) => error instanceof EmberError && error.code === 'capability_failed',
  );
});

void test('重复注册抛 duplicate_capability', () => {
  const { host } = createHarness();
  host.register(moduleOf('ember.dup', {}, () => {}));
  assert.throws(
    () => host.register(moduleOf('ember.dup', {}, () => {})),
    (error: unknown) => error instanceof EmberError && error.code === 'duplicate_capability',
  );
});

void test('内核版本不满足时只标记 error，不阻塞其它能力（C4）', async () => {
  const { host, order } = createHarness();
  host.register(moduleOf('ember.future', { requiresKernel: '^2.0.0' }, () => void order.push('future')));
  host.register(moduleOf('ember.now', {}, () => void order.push('now')));

  await host.activate(capId('ember.future'));
  await host.activate(capId('ember.now'));

  const states = host.list();
  const future = states.find((state) => String(state.id) === 'ember.future');
  assert.equal(future?.active, false);
  assert.match(future?.error ?? '', /capability_failed/);
  assert.equal(host.isActive(capId('ember.now')), true);
  assert.deepEqual(order, ['now']);
});

void test('激活失败回滚已注册资源', async () => {
  const { host, commands } = createHarness();
  host.register(
    moduleOf('ember.broken', {}, (ctx) => {
      ctx.commands.register({ id: cid('core.broken.run'), title: 'broken', scope: 'global', run: () => {} });
      throw new Error('activate boom');
    }),
  );

  await host.activate(capId('ember.broken'));

  const state = host.list()[0];
  assert.equal(state?.active, false);
  assert.match(state?.error ?? '', /activate boom/);
  assert.deepEqual(commands.list(), []);
});

void test('disabled 能力不会被 boot 激活，但 register 仍成功', () => {
  const { host } = createHarness();
  host.register(moduleOf('ember.off', { defaultEnabled: false }, () => {}));
  assert.equal(host.list()[0]?.enabled, false);
  assert.equal(host.isActive(capId('ember.off')), false);
});
