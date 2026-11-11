import assert from 'node:assert/strict';
import test from 'node:test';
import { Decoration } from '@codemirror/view';
import { asVaultId, unsafeVaultPath } from '#doc-model';
import { bootKernel, type Kernel } from '../../src/kernel/boot.ts';
import { EmberError } from '../../src/kernel/errors.ts';
import type { DocChange, Logger } from '../../src/kernel/types.ts';
import { createMemoryIndex, createMemoryVault, type MemoryVault } from './fakes.ts';

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
    ports: { vault: vault.port, index: createMemoryIndex().port },
    capabilities: [],
    log: silentLogger,
  });

void test('editor.open 返回快照/扩展/装饰槽，open 幂等且按引用释放（E4）', async () => {
  const vault = createMemoryVault();
  const kernel = await boot(vault);
  const created = await kernel.context.docs.create({
    path: unsafeVaultPath('notes/open.md'),
    text: 'hello',
    intent: 'user',
  });

  const first = await kernel.context.editor.open(created.meta.id);
  const second = await kernel.context.editor.open(created.meta.id);

  assert.equal(first, second);
  assert.equal(first.snapshot.meta.rev.hash, created.meta.rev.hash);
  assert.deepEqual(first.extensions, []);
  assert.deepEqual(first.slots, []);
  assert.equal(kernel.context.editor.active(), first);

  first.close();
  assert.equal(kernel.context.editor.active(), first);
  second.close();
  assert.equal(kernel.context.editor.active(), null);

  await kernel.shutdown();
});

void test('装饰槽 id 冲突抛 duplicate_slot，dispose 后可重新登记（E3）', async () => {
  const vault = createMemoryVault();
  const kernel = await boot(vault);

  const slot = {
    id: 'ember.core.slash',
    placement: 'inline' as const,
    provider: () => ({
      provide: () => Decoration.none,
    }),
  };
  const handle = kernel.context.editor.registerDecorationSlot(slot);

  assert.throws(
    () => kernel.context.editor.registerDecorationSlot(slot),
    (error: unknown) => error instanceof EmberError && error.code === 'duplicate_slot',
  );

  handle.dispose();
  const again = kernel.context.editor.registerDecorationSlot(slot);
  again.dispose();

  await kernel.shutdown();
});

void test('目录对账发现外部改动时广播 external 变更（S12 订阅源）', async () => {
  const vault = createMemoryVault();
  const kernel = await boot(vault);
  const created = await kernel.context.docs.create({
    path: unsafeVaultPath('notes/watch.md'),
    text: 'before',
    intent: 'user',
  });

  const received = new Promise<DocChange>((resolve) => {
    kernel.context.events.on('doc:changed', (change) => {
      if (change.kind === 'external') resolve(change);
    });
  });

  const onDisk = vault.dump()['notes/watch.md'] ?? '';
  vault.writeRaw('notes/watch.md', onDisk.replace('before', 'after'));
  vault.emitExternal('notes/watch.md', 'changed');

  const change = await received;
  assert.equal(String(change.id), String(created.meta.id));
  assert.equal(change.kind, 'external');
  assert.equal(change.revision.rev, created.meta.rev.rev + 1);

  await kernel.shutdown();
});

void test('目录对账发现外部新增文档时广播 created（冲突副本进入侧栏的来源）', async () => {
  const vault = createMemoryVault();
  const kernel = await boot(vault);
  await kernel.context.docs.list();

  const received = new Promise<DocChange>((resolve) => {
    kernel.context.events.on('doc:changed', (change) => {
      if (change.kind === 'created') resolve(change);
    });
  });

  vault.writeRaw('notes/copy.md', '---\nid: 01JAVBBBBBBBBBBBBBBBBBBBBB\n---\n副本\n');
  vault.emitExternal('notes/copy.md', 'created');

  const change = await received;
  assert.equal(change.kind, 'created');
  assert.equal(String(change.path), 'notes/copy.md');
  assert.equal(change.revision.rev, 1);

  await kernel.shutdown();
});
