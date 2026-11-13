import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { asCommandId, asVaultId, unsafeVaultPath } from '#doc-model';
import { bootKernel, type Kernel } from '../../src/kernel/boot.ts';
import { EmberError } from '../../src/kernel/errors.ts';
import type { VaultPort } from '../../src/kernel/ports.ts';
import type { Logger } from '../../src/kernel/types.ts';
import { createMemoryVault, type MemoryVault } from './fakes.ts';

const VAULT_ID = asVaultId('01JB8ZQ3K4M5N6P7Q8R9S0T1V2');
assert.ok(VAULT_ID !== null);

const silentLogger: Logger = {
  debug: (): void => {},
  info: (): void => {},
  warn: (): void => {},
  error: (): void => {},
};

const boot = async (vault: MemoryVault): Promise<Kernel> =>
  bootKernel({
    vaultId: VAULT_ID,
    ports: { vault: vault.port },
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
    ports: { vault: port },
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

void test('启动后命令可注册与执行，注销后消失', async () => {
  const vault = createMemoryVault();
  const calls: string[] = [];
  const kernel = await boot(vault);

  const pingId = asCommandId('ember.test.ping');
  assert.ok(pingId !== null);
  const registration = kernel.context.commands.register({
    id: pingId,
    title: '测试命令',
    scope: 'global',
    run: () => {
      calls.push('ping');
    },
  });
  assert.deepEqual(kernel.context.commands.list().map((item) => String(item.id)), ['ember.test.ping']);

  const result = await kernel.context.commands.execute(pingId);
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['ping']);

  registration.dispose();
  assert.deepEqual(kernel.context.commands.list(), []);
  await kernel.shutdown();
});

void test('创建文档写入 frontmatter 身份，读取可往返', async () => {
  const vault = createMemoryVault();
  const kernel = await boot(vault);

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
  const kernel = await boot(vault);

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

void test('磁盘被外部改动时保留磁盘版本并落盘冲突副本，不静默覆盖', async () => {
  const vault = createMemoryVault();
  const kernel = await boot(vault);

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

  assert.equal(outcome.merged, false);
  assert.ok(outcome.conflict !== null);
  // 磁盘版本保持外部内容，本地改动完整进入冲突副本
  assert.match(vault.dump()['notes/c.md'] ?? '', /TWO/);
  assert.doesNotMatch(vault.dump()['notes/c.md'] ?? '', /inserted/);
  const copy = vault.dump()[String(outcome.conflict.path)] ?? '';
  assert.match(copy, /inserted/);
  assert.match(copy, /conflictOf/);

  await kernel.shutdown();
});

void test('无法自动合并时落盘冲突副本且保留磁盘版本（I13）', async () => {
  const vault = createMemoryVault();
  const kernel = await boot(vault);

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
  const kernel = await boot(vault);

  assert.equal(kernel.context.env.readonlyMode, true);
  await assert.rejects(
    () => kernel.context.docs.create({ path: unsafeVaultPath('notes/e.md'), text: 'x', intent: 'user' }),
    (error: unknown) => error instanceof EmberError && error.code === 'vault_locked',
  );

  const result = await kernel.context.index.search({ text: '' });
  assert.deepEqual(result.hits, []);

  await kernel.shutdown();
});

void test('shutdown 单飞：并发调用共享同一 promise，完成后重复调用保持幂等', async () => {
  const vault = createMemoryVault();
  const kernel = await boot(vault);

  const first = kernel.shutdown();
  const second = kernel.shutdown();
  assert.equal(first, second, '并发关停只能执行一次拆解');

  await Promise.all([first, second]);
  await kernel.shutdown();
});
