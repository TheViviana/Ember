import assert from 'node:assert/strict';
import test from 'node:test';
import { createUlid } from '#doc-model';
import { createDocService } from '../../src/kernel/doc-service.ts';
import { createEventBus } from '../../src/kernel/events.ts';
import { createPathTools } from '../../src/kernel/paths.ts';
import type { Logger } from '../../src/kernel/types.ts';
import { createMemoryVault, type MemoryVault } from './fakes.ts';

const VALID = 'notes/ok.md';
const BROKEN = 'notes/broken.md';

const VALID_TEXT = [
  '---',
  `id: ${createUlid(1_700_000_000_000)}`,
  'title: 正常文档',
  'tags:',
  '  - 笔记',
  '---',
  '',
  '正文内容',
  '',
].join('\n');

const BROKEN_TEXT = [
  '---',
  'tags: [unclosed',
  'title: 坏文件',
  '---',
  '',
  '这段正文不应被改写',
  '',
].join('\n');

const silentLog: Logger & { warnings: string[] } = {
  warnings: [],
  debug: () => undefined,
  info: () => undefined,
  warn(message, fields) {
    silentLog.warnings.push(`${message}${fields === undefined ? '' : ` ${JSON.stringify(fields)}`}`);
  },
  error: () => undefined,
};

const setup = (files: Record<string, string>): { vault: MemoryVault; service: ReturnType<typeof createDocService> } => {
  const vault = createMemoryVault({ files });
  const service = createDocService({
    port: vault.port,
    paths: createPathTools(),
    events: createEventBus(),
    log: silentLog,
    now: () => new Date('2026-11-12T00:00:00Z'),
  });
  return { vault, service };
};

void test('YAML 语法非法的 frontmatter 不炸穿整库：其余文档照常可读', async () => {
  silentLog.warnings.length = 0;
  const { service } = setup({ [VALID]: VALID_TEXT, [BROKEN]: BROKEN_TEXT });

  const docs = await service.list();

  assert.equal(docs.length, 1);
  const first = docs[0];
  assert.ok(first !== undefined);
  assert.equal(first.title, '正常文档');
  await assert.doesNotReject(service.read(first.id));
});

void test('坏 YAML 文档被跳过并输出可诊断告警', async () => {
  silentLog.warnings.length = 0;
  const { service } = setup({ [BROKEN]: BROKEN_TEXT });

  const docs = await service.list();

  assert.deepEqual(docs, []);
  assert.ok(
    silentLog.warnings.some((line) => line.includes('frontmatter YAML 无法解析') && line.includes(BROKEN)),
    `应包含坏 YAML 专属告警，实际：${JSON.stringify(silentLog.warnings)}`,
  );
});

void test('坏 YAML 文档在磁盘上保持逐字节原样（内核不改写）', async () => {
  silentLog.warnings.length = 0;
  const { vault, service } = setup({ [BROKEN]: BROKEN_TEXT });

  await service.list();
  await service.flush();

  assert.equal(vault.dump()[BROKEN], BROKEN_TEXT);
});

void test('frontmatter 解析为非对象（列表/标量）按无 id 跳过，不抛错', async () => {
  silentLog.warnings.length = 0;
  const listDoc = ['---', '- a', '- b', '---', '正文'].join('\n');
  const scalarDoc = ['---', '只是一个字符串', '---', '正文'].join('\n');
  const { service } = setup({ 'notes/list.md': listDoc, 'notes/scalar.md': scalarDoc });

  const docs = await service.list();

  assert.deepEqual(docs, []);
  assert.ok(!silentLog.warnings.some((line) => line.includes('YAML 无法解析')));
});

void test('外部把合法文档改坏 YAML 后，后续刷新跳过该文档且整库仍可用', async () => {
  silentLog.warnings.length = 0;
  const { vault, service } = setup({ [VALID]: VALID_TEXT });

  const before = await service.list();
  assert.equal(before.length, 1);

  vault.writeRaw(BROKEN, BROKEN_TEXT);
  await assert.doesNotReject(service.refresh());

  const after = await service.list();
  assert.equal(after.length, 1);
  assert.equal(after[0]?.path, VALID);
});

void test('update 重写整份 frontmatter 时不丢失取值非法的键', async () => {
  silentLog.warnings.length = 0;
  // 用户手写的非法取值：tags 是字符串、created 非 ISO——修复前任何一次保存都会把它们从磁盘删掉
  const messy = [
    '---',
    `id: ${createUlid(1_700_000_000_001)}`,
    'title: 手写文档',
    'tags: 项目笔记',
    'created: 2024/01/02',
    '---',
    '',
    '正文',
    '',
  ].join('\n');
  const path = 'notes/messy.md';
  const { vault, service } = setup({ [path]: messy });

  const docs = await service.list();
  assert.equal(docs.length, 1);
  const meta = docs[0];
  assert.ok(meta !== undefined);
  // 非法值不参与语义
  assert.deepEqual(meta.tags, []);
  assert.ok(silentLog.warnings.some((line) => line.includes('原值已保留')));

  const snapshot = await service.read(meta.id);
  const outcome = await service.update(
    meta.id,
    { body: `${snapshot.text.split('---\n').slice(-1)[0]}\n补充一段` },
    { base: meta.rev, intent: 'user' },
  );
  assert.equal(outcome.merged, true);

  const stored = vault.dump()[path] ?? '';
  assert.ok(stored.includes('tags: 项目笔记'), `磁盘应保留原始 tags，实际：\n${stored}`);
  assert.ok(stored.includes('created: 2024/01/02'), `磁盘应保留原始 created，实际：\n${stored}`);
  assert.ok(stored.includes('补充一段'));
});
