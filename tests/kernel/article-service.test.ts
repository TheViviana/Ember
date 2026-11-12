import assert from 'node:assert/strict';
import test from 'node:test';
import { asVaultId, createUlid, unsafeVaultPath } from '#doc-model';
import { createArticleOnCanvas } from '../../src/kernel/article-service.ts';
import { bootKernel, type Kernel } from '../../src/kernel/boot.ts';
import { EmberError } from '../../src/kernel/errors.ts';
import type { Logger } from '../../src/kernel/types.ts';
import { createMemoryIndex, createMemoryVault, type MemoryVault } from './fakes.ts';

const VAULT_ID = asVaultId('01JB8ZQ3K4M5N6P7Q8R9S0T1V2');
if (VAULT_ID === null) throw new Error('测试库 id 非法');

const createLogger = (): { log: Logger; warns: string[] } => {
  const warns: string[] = [];
  return {
    warns,
    log: {
      debug: (): void => {},
      info: (): void => {},
      warn: (message: string): void => {
        warns.push(message);
      },
      error: (): void => {},
    },
  };
};

const boot = async (vault: MemoryVault, log: Logger): Promise<Kernel> =>
  bootKernel({
    vaultId: VAULT_ID,
    ports: { vault: vault.port, index: createMemoryIndex().port },
    capabilities: [],
    log,
  });

const createInput = async (kernel: Kernel, title: string) => {
  const canvasId = (await kernel.context.canvas.ensureDefault()).id;
  return {
    docs: kernel.context.docs,
    canvas: kernel.context.canvas,
    canvasId,
    title,
    point: { x: 64, y: 32 },
    nodeId: `n_${createUlid()}`,
    size: { w: 320, h: 200 },
    z: 1,
  };
};

void test('正常路径：落盘 notes/标题.md 并新增一个 doc 节点', async () => {
  const vault = createMemoryVault();
  const kernel = await boot(vault, createLogger().log);

  const input = await createInput(kernel, '验收文章');
  const result = await createArticleOnCanvas(input);

  assert.equal(String(result.snapshot.meta.path), 'notes/验收文章.md');
  const text = vault.dump()['notes/验收文章.md'];
  assert.ok(text !== undefined, '磁盘上应生成 .md');
  assert.match(text, /title: 验收文章/);
  assert.ok(text.includes(`id: ${String(result.snapshot.meta.id)}`), 'frontmatter 应写入文档 id');

  assert.equal(result.scene.nodes.length, 1);
  const node = result.scene.nodes[0];
  assert.equal(node?.kind, 'doc');
  assert.equal(String(node?.docId), String(result.snapshot.meta.id));
  assert.deepEqual(node?.rect, { x: 64, y: 32, w: 320, h: 200 });

  const onDisk = JSON.parse(vault.dump()[`.workbench/canvas/${String(input.canvasId)}.json`] ?? '{}') as {
    nodes?: unknown[];
  };
  assert.equal(onDisk.nodes?.length, 1);
  await kernel.shutdown();
});

void test('同名标题自动加后缀，不覆盖已有文件', async () => {
  const vault = createMemoryVault();
  const kernel = await boot(vault, createLogger().log);

  await createArticleOnCanvas(await createInput(kernel, '重名'));
  const second = await createArticleOnCanvas(await createInput(kernel, '重名'));

  assert.equal(String(second.snapshot.meta.path), 'notes/重名-2.md');
  assert.ok(vault.dump()['notes/重名.md'] !== undefined);
  assert.ok(vault.dump()['notes/重名-2.md'] !== undefined);
  await kernel.shutdown();
});

void test('以 . 开头的标题不会生成隐藏文档，重名仍按原有规则加后缀', async () => {
  const vault = createMemoryVault();
  const kernel = await boot(vault, createLogger().log);

  const first = await createArticleOnCanvas(await createInput(kernel, '.隐藏标题'));
  const second = await createArticleOnCanvas(await createInput(kernel, '.隐藏标题'));

  assert.equal(String(first.snapshot.meta.path), 'notes/隐藏标题.md');
  assert.equal(String(second.snapshot.meta.path), 'notes/隐藏标题-2.md');
  assert.ok(vault.dump()['notes/隐藏标题.md'] !== undefined);
  assert.equal(
    Object.keys(vault.dump()).filter((path) => path.startsWith('notes/.')).length,
    0,
    'notes/ 下不应出现以点开头的隐藏文档',
  );
  await kernel.shutdown();
});

void test('画布写失败：回滚走永久删除，库内不产生回收副本、节点数不变', async () => {
  const vault = createMemoryVault();
  // 先放行 ensureDefault 建画布，之后所有画布写入都失败
  let canvasWrites = 0;
  const calls = { purge: 0, remove: 0 };
  const instrumented = {
    ...vault,
    port: {
      ...vault.port,
      write: (path: Parameters<typeof vault.port.write>[0], bytes: Uint8Array, intent: Parameters<typeof vault.port.write>[2]) =>
        path.startsWith('.workbench/canvas/') && canvasWrites++ >= 1
          ? Promise.reject(new Error('EACCES: 磁盘只读'))
          : vault.port.write(path, bytes, intent),
      purge: (path: Parameters<typeof vault.port.purge>[0]) => {
        calls.purge += 1;
        return vault.port.purge(path);
      },
      remove: (path: Parameters<typeof vault.port.remove>[0]) => {
        calls.remove += 1;
        return vault.port.remove(path);
      },
    },
  };
  const kernel = await boot(instrumented, createLogger().log);

  const input = await createInput(kernel, '回滚文章');
  await assert.rejects(
    createArticleOnCanvas(input),
    (error: unknown) =>
      error instanceof EmberError &&
      error.code === 'io_failed' &&
      error.message.includes('已回滚') &&
      !error.message.includes('.workbench/trash/') &&
      error.message.includes('notes/回滚文章.md'),
  );

  assert.equal(calls.purge, 1, '回滚必须调用永久删除入口');
  assert.equal(calls.remove, 0, '回滚不能走用户删除（否则会进系统回收站）');
  const dump = vault.dump();
  assert.equal(dump['notes/回滚文章.md'], undefined, '刚建的文章必须已从磁盘删除');
  assert.deepEqual(
    Object.keys(dump).filter((path) => path.startsWith('.workbench/trash/')),
    [],
    '库内不得产生回收副本',
  );

  const scene = await kernel.context.canvas.open(input.canvasId);
  assert.equal(scene.scene.nodes.length, 0);
  scene.close();
  await kernel.shutdown();
});

void test('双重失败：错误文本给出文章磁盘路径，文件仍在磁盘且无回收副本', async () => {
  const vault = createMemoryVault();
  let canvasWrites = 0;
  const instrumented = {
    ...vault,
    port: {
      ...vault.port,
      write: (path: Parameters<typeof vault.port.write>[0], bytes: Uint8Array, intent: Parameters<typeof vault.port.write>[2]) =>
        path.startsWith('.workbench/canvas/') && canvasWrites++ >= 1
          ? Promise.reject(new Error('EACCES: 磁盘只读'))
          : vault.port.write(path, bytes, intent),
      purge: () => Promise.reject(new Error('EPERM: 永久删除失败')),
    },
  };
  const kernel = await boot(instrumented, createLogger().log);

  const input = await createInput(kernel, '双重失败文章');
  let message = '';
  await assert.rejects(createArticleOnCanvas(input), (error: unknown) => {
    assert.ok(error instanceof EmberError);
    message = error.message;
    return error.code === 'io_failed';
  });

  assert.match(message, /notes\/双重失败文章\.md/, `错误文本缺少文章路径：${message}`);
  assert.ok(!message.includes('.workbench/trash/'), `不应再提库内回收目录：${message}`);
  assert.match(message, /回滚失败/);

  const dump = vault.dump();
  assert.ok(dump['notes/双重失败文章.md'] !== undefined, '回滚失败时不能删掉用户的文章');
  assert.equal(
    Object.keys(dump).filter((path) => path.startsWith('.workbench/trash/')).length,
    0,
  );
  await kernel.shutdown();
});

void test('旧 .md 无 summary：读取不警告、不阻断，简介派生自正文首段且不回写磁盘', async () => {
  const legacy = [
    '---',
    'id: 01JB8ZQ3K4M5N6P7Q8R9S0T1V2',
    'title: 旧文章',
    'tags: [研发]',
    '---',
    '# 旧文章',
    '',
    '这是旧文档的第一段正文。',
    '',
    '第二段。',
    '',
  ].join('\n');
  const vault = createMemoryVault({ files: { 'notes/旧文章.md': legacy } });
  const logger = createLogger();
  const kernel = await boot(vault, logger.log);

  const listed = await kernel.context.docs.list();
  const item = listed.find((entry) => String(entry.path) === 'notes/旧文章.md');
  assert.ok(item !== undefined);
  assert.equal(item.summary, '这是旧文档的第一段正文。');

  const snapshot = await kernel.context.docs.read(item.id);
  assert.equal(snapshot.frontmatter.summary, null, '不得凭空写入 summary');
  assert.deepEqual(logger.warns, [], `读取旧文档不应产生警告：${logger.warns.join(' | ')}`);
  assert.equal(vault.dump()['notes/旧文章.md'], legacy, '读取不得改写磁盘');
  await kernel.shutdown();
});

void test('清空简介（summary: null）删键，磁盘上不再保留 summary', async () => {
  const vault = createMemoryVault();
  const kernel = await boot(vault, createLogger().log);

  const created = await kernel.context.docs.create({
    path: unsafeVaultPath('notes/有简介.md'),
    text: '正文第一段。\n\n第二段。\n',
    title: '有简介',
    intent: 'user',
  });
  const withSummary = await kernel.context.docs.update(
    created.meta.id,
    { frontmatter: { summary: '手写简介' } },
    { base: created.meta.rev, intent: 'user' },
  );
  assert.match(vault.dump()['notes/有简介.md'] ?? '', /summary: 手写简介/);

  await kernel.context.docs.update(
    created.meta.id,
    { frontmatter: { summary: null } },
    { base: withSummary.snapshot.meta.rev, intent: 'user' },
  );
  const final = vault.dump()['notes/有简介.md'] ?? '';
  assert.ok(!final.includes('summary:'), `summary 键应被删除：\n${final}`);
  await kernel.shutdown();
});
