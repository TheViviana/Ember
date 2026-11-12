import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { asCapabilityId, asCommandId, asVaultId, unsafeVaultPath } from '#doc-model';
import { bootKernel, type Kernel } from '../../src/kernel/boot.ts';
import type { CapabilityModule } from '../../src/kernel/capability-host.ts';
import { EmberError } from '../../src/kernel/errors.ts';
import type { VaultPort } from '../../src/kernel/ports.ts';
import type { Logger } from '../../src/kernel/types.ts';
import { createMemoryIndex, createMemoryVault, type MemoryVault } from './fakes.ts';

const VAULT_ID = asVaultId('01JB8ZQ3K4M5N6P7Q8R9S0T1V2');
const CAPABILITY_ID = asCapabilityId('ember.core.slash');
const COMMAND_ID = asCommandId('core.slash.open');
assert.ok(VAULT_ID !== null && CAPABILITY_ID !== null && COMMAND_ID !== null);

const silentLogger: Logger = {
  debug: (): void => {},
  info: (): void => {},
  warn: (): void => {},
  error: (): void => {},
};

const slashCapability = (calls: string[]): CapabilityModule => ({
  manifest: {
    id: CAPABILITY_ID,
    version: '1.0.0',
    displayName: 'Slash',
    requiresKernel: '^1.0.0',
    defaultEnabled: true,
  },
  activate: (ctx) => {
    ctx.commands.register({
      id: COMMAND_ID,
      title: '打开斜杠菜单',
      scope: 'global',
      run: () => {
        calls.push('slash');
      },
    });
  },
});

const boot = async (vault: MemoryVault, calls: string[]): Promise<Kernel> =>
  bootKernel({
    vaultId: VAULT_ID,
    ports: { vault: vault.port, index: createMemoryIndex().port },
    capabilities: [slashCapability(calls)],
    log: silentLogger,
  });

void test('watcher 连续事件合并：扫描中只补扫一次，不会每个事件各排一次全库重读', async () => {
  const vault = createMemoryVault();
  let listCalls = 0;
  let releaseFirst = (): void => undefined;
  const port: VaultPort = {
    ...vault.port,
    list: () => {
      listCalls += 1;
      if (listCalls === 1) {
        return new Promise((resolve) => {
          releaseFirst = () => {
            resolve([]);
          };
        });
      }
      return Promise.resolve([]);
    },
  };
  const kernel = await bootKernel({
    vaultId: VAULT_ID,
    ports: { vault: port, index: createMemoryIndex().port },
    capabilities: [],
    log: silentLogger,
  });

  vault.emitExternal('notes/a.md', 'created');
  vault.emitExternal('notes/b.md', 'created');
  vault.emitExternal('notes/c.md', 'created');
  await delay(0);
  assert.equal(listCalls, 1, '事件到达时只应有一次扫描在跑');

  releaseFirst();
  await delay(10);

  assert.equal(listCalls, 2, '进行中收到的事件合并成结束后的一次补扫');
  await kernel.shutdown();
  assert.equal(listCalls, 2);
});

void test('运行期库锁失守：watchMode 转发为 vault:mode 事件并翻只读', async () => {
  const vault = createMemoryVault();
  let readonly = false;
  const listeners: ((state: { readonly: boolean; reason: string | null }) => void)[] = [];
  const port: VaultPort = {
    ...vault.port,
    get readonlyMode() {
      return readonly;
    },
    watchMode: (listener) => {
      listeners.push(listener);
      return {
        dispose: (): void => {
          const index = listeners.indexOf(listener);
          if (index >= 0) listeners.splice(index, 1);
        },
      };
    },
  };
  const kernel = await bootKernel({
    vaultId: VAULT_ID,
    ports: { vault: port, index: createMemoryIndex().port },
    capabilities: [],
    log: silentLogger,
  });
  const modes: boolean[] = [];
  const subscription = kernel.context.events.on('vault:mode', ({ readonly: next }) => {
    modes.push(next);
  });
  assert.equal(kernel.context.env.readonlyMode, false);

  readonly = true;
  const listener = listeners[0];
  assert.ok(listener !== undefined);
  listener({ readonly: true, reason: 'library lock unavailable' });

  assert.deepEqual(modes, [true]);
  assert.equal(kernel.context.env.readonlyMode, true, 'env 必须跟随端口，而不是固化启动值');

  subscription.dispose();
  await kernel.shutdown();
  assert.equal(listeners.length, 0, '关闭后注销运行期监听');
});

void test('启动后能力激活、命令可执行、关闭后命令消失', async () => {
  const vault = createMemoryVault();
  const calls: string[] = [];
  const kernel = await boot(vault, calls);

  assert.equal(kernel.context.capabilities.isActive(CAPABILITY_ID), true);
  const listed = kernel.context.commands.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.owner, CAPABILITY_ID);

  const result = await kernel.context.commands.execute(COMMAND_ID);
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['slash']);

  await kernel.shutdown();
  assert.equal(kernel.context.capabilities.isActive(CAPABILITY_ID), false);
  assert.deepEqual(kernel.context.commands.list(), []);
});

void test('创建文档写入 frontmatter 身份，读取可往返', async () => {
  const vault = createMemoryVault();
  const kernel = await boot(vault, []);

  const snapshot = await kernel.context.docs.create({
    path: unsafeVaultPath('notes/a.md'),
    text: 'one\ntwo',
    title: '示例',
    tags: ['demo'],
    intent: 'user',
  });

  assert.equal(snapshot.meta.title, '示例');
  assert.match(snapshot.text, /^---\n/);
  assert.match(snapshot.text, /id: 01[0-9A-HJKMNP-TV-Z]{24}/);
  const onDisk = vault.dump()['notes/a.md'];
  assert.ok(onDisk !== undefined && onDisk.includes('demo'));

  const reread = await kernel.context.docs.read(snapshot.meta.id);
  assert.equal(reread.text, snapshot.text);
  assert.equal(reread.meta.rev.hash, snapshot.meta.rev.hash);

  const listed = await kernel.context.docs.list();
  assert.equal(listed.length, 1);
  assert.equal(String(listed[0]?.path), 'notes/a.md');

  await kernel.shutdown();
});

void test('base 命中时走快路径，写入后 rev 递增', async () => {
  const vault = createMemoryVault();
  const kernel = await boot(vault, []);

  const created = await kernel.context.docs.create({
    path: unsafeVaultPath('notes/b.md'),
    text: 'one\ntwo',
    intent: 'user',
  });

  const outcome = await kernel.context.docs.update(
    created.meta.id,
    { body: 'one\nTWO' },
    { base: created.meta.rev, intent: 'user' },
  );

  assert.equal(outcome.merged, true);
  assert.equal(outcome.conflict, null);
  assert.equal(outcome.snapshot.meta.rev.rev, created.meta.rev.rev + 1);
  assert.match(vault.dump()['notes/b.md'] ?? '', /one\nTWO/);

  await kernel.shutdown();
});

void test('磁盘被外部改动时三方合并成功，不覆盖外部内容', async () => {
  const vault = createMemoryVault();
  const kernel = await boot(vault, []);

  const created = await kernel.context.docs.create({
    path: unsafeVaultPath('notes/c.md'),
    text: 'one\ntwo',
    intent: 'user',
  });
  const onDisk = vault.dump()['notes/c.md'] ?? '';
  vault.writeRaw('notes/c.md', onDisk.replace('two', 'TWO'));

  const outcome = await kernel.context.docs.update(
    created.meta.id,
    { body: 'one\ninserted\ntwo' },
    { base: created.meta.rev, intent: 'user' },
  );

  assert.equal(outcome.merged, true);
  assert.equal(outcome.conflict, null);
  const merged = vault.dump()['notes/c.md'] ?? '';
  assert.match(merged, /inserted/);
  assert.match(merged, /TWO/);

  await kernel.shutdown();
});

void test('无法自动合并时落盘冲突副本且保留磁盘版本（I13）', async () => {
  const vault = createMemoryVault();
  const kernel = await boot(vault, []);

  const created = await kernel.context.docs.create({
    path: unsafeVaultPath('notes/d.md'),
    text: 'alpha\nbeta',
    intent: 'user',
  });
  const onDisk = vault.dump()['notes/d.md'] ?? '';
  vault.writeRaw('notes/d.md', onDisk.replace('beta', 'BETA'));

  const outcome = await kernel.context.docs.update(
    created.meta.id,
    { body: 'alpha\nLOCAL' },
    { base: created.meta.rev, intent: 'user' },
  );

  assert.equal(outcome.merged, false);
  assert.ok(outcome.conflict !== null);
  const files = Object.keys(vault.dump());
  const copyPath = String(outcome.conflict.path);
  assert.ok(files.includes(copyPath), `冲突副本未落盘：${copyPath}`);
  assert.match(copyPath, /\(conflict \d{8}T\d{6}Z-[0-9A-Z]{4}\)/);
  assert.match(vault.dump()['notes/d.md'] ?? '', /BETA/);
  assert.doesNotMatch(vault.dump()['notes/d.md'] ?? '', /LOCAL/);

  await kernel.shutdown();
});

void test('只读模式下写操作抛 vault_locked，索引仍可用（G2）', async () => {
  const vault = createMemoryVault({ readonlyMode: true });
  const kernel = await boot(vault, []);

  assert.equal(kernel.context.env.readonlyMode, true);
  await assert.rejects(
    () => kernel.context.docs.create({ path: unsafeVaultPath('notes/e.md'), text: 'x', intent: 'user' }),
    (error: unknown) => error instanceof EmberError && error.code === 'vault_locked',
  );

  const result = await kernel.context.index.search({ text: '' });
  assert.deepEqual(result.hits, []);

  await kernel.shutdown();
});
