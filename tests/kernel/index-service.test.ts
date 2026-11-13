import assert from 'node:assert/strict';
import test from 'node:test';
import { asVaultId, unsafeVaultPath } from '#doc-model';
import { bootKernel } from '../../src/kernel/boot.ts';
import { tokenizeForIndex, tokenizeForQuery } from '../../src/kernel/search-token.ts';
import type { KernelContext } from '../../src/kernel/context.ts';
import type { Logger } from '../../src/kernel/types.ts';
import { createMemoryVault } from './fakes.ts';

const VAULT_ID = asVaultId('01JB8ZQ3K4M5N6P7Q8R9S0T1V2');
assert.ok(VAULT_ID !== null);

const silentLogger: Logger = {
  debug: (): void => {},
  info: (): void => {},
  warn: (): void => {},
  error: (): void => {},
};

/** 等到正文索引构建排空：stats.lastBuiltAt 非空即代表后台阶段跑完 */
const settleIndex = async (kernel: KernelContext): Promise<void> => {
  for (let i = 0; i < 200; i += 1) {
    const stats = await kernel.index.stats();
    if (stats.lastBuiltAt !== '') return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('索引后台构建超时');
};

void test('分词：中文按相邻二元组切分，拉丁按词，单字保留', () => {
  assert.deepEqual(tokenizeForIndex('知识库'), ['知', '识', '库', '知识', '识库']);
  assert.deepEqual(tokenizeForIndex('a'), ['a']);
  assert.deepEqual(tokenizeForQuery('知识'), ['知识']);
  assert.deepEqual(tokenizeForQuery('单'), ['单']);
  assert.deepEqual(tokenizeForQuery('Hello 世界'), ['hello', '世界']);
  assert.deepEqual(tokenizeForQuery('  。！  '), []);
});

void test('索引：元数据即时可搜，正文后台就绪后可搜正文', async () => {
  const vault = createMemoryVault();
  const kernel = await bootKernel({
    vaultId: VAULT_ID,
    ports: { vault: vault.port },
    log: silentLogger,
  });

  await kernel.context.docs.create({
    path: unsafeVaultPath('notes/画布.md'),
    title: '画布指南',
    text: '画布是空间，文件是唯一真相。Canvas zoom controls the viewport.',
    tags: ['手册'],
    aliases: ['canvas 指南'],
    intent: 'user',
  });

  // 元数据阶段：标题/标签/别名即时可用
  const byTitle = await kernel.context.index.search({ text: '画布指南' });
  assert.equal(byTitle.total, 1);
  assert.equal(String(byTitle.hits[0]?.path), 'notes/画布.md');

  await settleIndex(kernel.context);

  // 正文阶段：正文词与拉丁词都能命中
  const byBody = await kernel.context.index.search({ text: 'viewport' });
  assert.equal(byBody.total, 1);
  const byPhrase = await kernel.context.index.search({ text: '唯一真相' });
  assert.equal(byPhrase.total, 1);
  assert.ok(byPhrase.hits[0]?.snippet.includes('唯一真相'));

  // 反向过滤：无关词不命中
  const miss = await kernel.context.index.search({ text: '番茄钟' });
  assert.equal(miss.total, 0);

  await kernel.shutdown();
});

void test('索引：反链与双链解析（标题与路径），增量维护', async () => {
  const vault = createMemoryVault();
  const kernel = await bootKernel({
    vaultId: VAULT_ID,
    ports: { vault: vault.port },
    log: silentLogger,
  });

  const target = await kernel.context.docs.create({
    path: unsafeVaultPath('notes/目标.md'),
    title: '目标文档',
    text: '正文',
    intent: 'user',
  });
  const source = await kernel.context.docs.create({
    path: unsafeVaultPath('notes/来源.md'),
    title: '来源文档',
    text: '前文\n\n引用 [[目标文档]] 与 [[目标]] 两次。',
    intent: 'user',
  });

  await settleIndex(kernel.context);

  const back = await kernel.context.index.backlinks(target.meta.id);
  assert.equal(back.length, 2, '两条引用都计入');
  assert.ok(back.every((record) => String(record.srcId) === String(source.meta.id)));
  assert.ok(back.every((record) => record.resolver !== 'unresolved'));

  const out = await kernel.context.index.outbound(source.meta.id);
  assert.equal(out.length, 2);

  // 删除来源后反链消失
  await kernel.context.docs.remove(source.meta.id, { base: source.meta.rev, intent: 'user' });
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  const after = await kernel.context.index.backlinks(target.meta.id);
  assert.equal(after.length, 0);

  await kernel.shutdown();
});

void test('索引：referencesByRaw 反查原始键（嵌入与路径引用）', async () => {
  const vault = createMemoryVault();
  const kernel = await bootKernel({
    vaultId: VAULT_ID,
    ports: { vault: vault.port },
    log: silentLogger,
  });

  await kernel.context.docs.create({
    path: unsafeVaultPath('notes/图片引用.md'),
    title: '图片引用',
    text: '看图 ![[a.png]]，还有 [[b]]。',
    intent: 'user',
  });

  await settleIndex(kernel.context);

  const refs = await kernel.context.index.referencesByRaw('a.png');
  assert.equal(refs.length, 1);
  assert.equal(refs[0]?.kind, 'embed');

  await kernel.shutdown();
});

void test('索引：rebuild 重建全量数据（删索引可救）', async () => {
  const vault = createMemoryVault();
  const kernel = await bootKernel({
    vaultId: VAULT_ID,
    ports: { vault: vault.port },
    log: silentLogger,
  });

  await kernel.context.docs.create({
    path: unsafeVaultPath('notes/重建.md'),
    title: '重建验证',
    text: '正文内容',
    intent: 'user',
  });
  await settleIndex(kernel.context);

  const stats = await kernel.context.index.rebuild();
  assert.equal(stats.documents, 1);
  assert.ok(stats.lastBuiltAt !== '');

  await kernel.shutdown();
});
