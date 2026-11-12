import assert from 'node:assert/strict';
import test from 'node:test';
import { createUlid } from '#doc-model';
import { createDocService } from '../../src/kernel/doc-service.ts';
import { EmberError } from '../../src/kernel/errors.ts';
import { createEventBus } from '../../src/kernel/events.ts';
import { createPathTools } from '../../src/kernel/paths.ts';
import type { DocChange, Logger } from '../../src/kernel/types.ts';
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

const setup = (
  files: Record<string, string>,
): { vault: MemoryVault; service: ReturnType<typeof createDocService>; events: ReturnType<typeof createEventBus> } => {
  const vault = createMemoryVault({ files });
  const events = createEventBus();
  const service = createDocService({
    port: vault.port,
    paths: createPathTools(),
    events,
    log: silentLog,
    now: () => new Date('2026-11-12T00:00:00Z'),
  });
  return { vault, service, events };
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

void test('外部改名（同 id 换路径）后目录跟随迁移，旧路径不再广播 removed', async () => {
  silentLog.warnings.length = 0;
  const { vault, service, events } = setup({ [VALID]: VALID_TEXT });
  const changes: DocChange[] = [];
  const subscription = events.on('doc:changed', (change) => {
    changes.push(change);
  });

  const before = await service.list();
  assert.equal(before.length, 1);
  const meta = before[0];
  assert.ok(meta !== undefined);

  changes.length = 0;
  vault.writeRaw('notes/renamed.md', VALID_TEXT);
  vault.removeRaw(VALID);
  await service.refresh();

  const after = await service.list();
  assert.equal(after.length, 1);
  assert.ok(after[0] !== undefined);
  assert.equal(after[0].path, 'notes/renamed.md');
  assert.equal(after[0].rev.rev, meta.rev.rev);
  assert.equal(after[0].rev.hash, meta.rev.hash);
  assert.ok(
    changes.some((change) => change.kind === 'renamed' && change.path === 'notes/renamed.md'),
    `应广播 renamed，实际：${JSON.stringify(changes)}`,
  );
  assert.ok(!changes.some((change) => change.kind === 'removed'), `不应广播 removed：${JSON.stringify(changes)}`);

  const snapshot = await service.read(meta.id);
  assert.equal(snapshot.meta.path, 'notes/renamed.md');
  subscription.dispose();
});

void test('同名 id 的两个路径同时存在时仍按重复 id 处理，不互相抢占', async () => {
  silentLog.warnings.length = 0;
  const { service } = setup({ 'notes/a.md': VALID_TEXT, 'notes/b.md': VALID_TEXT });

  const docs = await service.list();

  assert.equal(docs.length, 1);
  assert.equal(docs[0]?.path, 'notes/a.md');
  assert.ok(silentLog.warnings.some((line) => line.includes('检测到重复 id')));
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

const createWriteGate = (): { readonly promise: Promise<void>; release: () => void } => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release() };
};

void test('并发 update 基于同一 base 时不得静默丢失任一方的改动', async () => {
  const vault = createMemoryVault({ files: { [VALID]: VALID_TEXT } });
  const gate = createWriteGate();
  let writeCalls = 0;
  const service = createDocService({
    port: {
      ...vault.port,
      write: async (path, bytes, intent) => {
        writeCalls += 1;
        // 门控写盘：制造「两个 update 都已完成读盘与 base 校验、都还没落盘」的并发窗口
        await gate.promise;
        await vault.port.write(path, bytes, intent);
      },
    },
    paths: createPathTools(),
    events: createEventBus(),
    log: silentLog,
    now: () => new Date('2026-11-12T00:00:00Z'),
  });

  const meta = (await service.list())[0];
  assert.ok(meta !== undefined);
  const base = meta.rev;

  const titleUpdate = service.update(meta.id, { frontmatter: { title: 'A 标题' } }, { base, intent: 'user' });
  const bodyUpdate = service.update(meta.id, { body: 'B 正文' }, { base, intent: 'user' });

  // 给两个调用足够时间完成读盘并卡在门控写盘上（修复前两边都会进入写盘）
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.ok(writeCalls >= 1, '至少有一个 update 进入写盘');
  gate.release();
  await Promise.allSettled([titleUpdate, bodyUpdate]);

  const stored = Object.values(vault.dump()).join('\n');
  assert.ok(stored.includes('A 标题'), `A 的标题改动被静默覆盖，实际：\n${stored}`);
  assert.ok(stored.includes('B 正文'), `B 的正文改动被静默覆盖，实际：\n${stored}`);
});

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const createServiceWith = (
  vault: MemoryVault,
  overrides: Partial<MemoryVault['port']> = {},
): { service: ReturnType<typeof createDocService>; events: ReturnType<typeof createEventBus> } => {
  const events = createEventBus();
  const service = createDocService({
    port: { ...vault.port, ...overrides },
    paths: createPathTools(),
    events,
    log: silentLog,
    now: () => new Date('2026-11-12T00:00:00Z'),
  });
  return { service, events };
};

void test('并发 update 不重叠时三方合并，双方改动都落盘且 rev 连续推进', async () => {
  const vault = createMemoryVault({ files: { [VALID]: VALID_TEXT } });
  const { service } = createServiceWith(vault);
  const meta = (await service.list())[0];
  assert.ok(meta !== undefined);
  const base = meta.rev;

  const [first, second] = await Promise.all([
    service.update(meta.id, { frontmatter: { title: '合并标题' } }, { base, intent: 'user' }),
    service.update(meta.id, { body: '合并正文' }, { base, intent: 'user' }),
  ]);

  assert.equal(first.merged, true);
  assert.equal(first.conflict, null);
  assert.equal(second.merged, true);
  assert.equal(second.conflict, null, '不重叠的并发改动应自动合并');
  const stored = vault.dump()[VALID] ?? '';
  assert.ok(stored.includes('合并标题'));
  assert.ok(stored.includes('合并正文'));
  const after = (await service.list())[0];
  assert.equal(after?.rev.rev, base.rev + 2, '两次成功写入应各推进一次 rev');
});

void test('并发 update 改动重叠时保留磁盘版本并落冲突副本，不丢内容', async () => {
  const vault = createMemoryVault({ files: { [VALID]: VALID_TEXT } });
  const { service } = createServiceWith(vault);
  const meta = (await service.list())[0];
  assert.ok(meta !== undefined);
  const base = meta.rev;

  const [first, second] = await Promise.all([
    service.update(meta.id, { body: '同一行改为 A' }, { base, intent: 'user' }),
    service.update(meta.id, { body: '同一行改为 B' }, { base, intent: 'user' }),
  ]);

  assert.equal(first.merged, true);
  assert.equal(second.merged, false);
  assert.ok(second.conflict !== null);
  const stored = vault.dump()[VALID] ?? '';
  assert.ok(stored.includes('同一行改为 A'), '磁盘保留先写入的版本');
  const all = Object.values(vault.dump()).join('\n');
  assert.ok(all.includes('同一行改为 B'), '后写入的内容必须保留在冲突副本里');
});

void test('rename 先入队、update 后入队：update 落在新路径且 rev 只 +1', async () => {
  const vault = createMemoryVault({ files: { [VALID]: VALID_TEXT } });
  const pathTools = createPathTools();
  const { service } = createServiceWith(vault);
  const meta = (await service.list())[0];
  assert.ok(meta !== undefined);
  const next = pathTools.normalize('notes/renamed.md');

  const [renamed, updated] = await Promise.all([
    service.rename(meta.id, next, { base: meta.rev, intent: 'user' }),
    service.update(meta.id, { body: '改名后的正文' }, { base: meta.rev, intent: 'user' }),
  ]);

  assert.equal(renamed.snapshot.meta.path, next);
  assert.equal(updated.merged, true);
  assert.equal(vault.dump()[VALID], undefined, '旧路径不应残留');
  assert.ok((vault.dump()['notes/renamed.md'] ?? '').includes('改名后的正文'));
  const list = await service.list();
  assert.equal(list.length, 1);
  assert.equal(list[0]?.path, next);
  assert.equal(list[0]?.rev.rev, meta.rev.rev + 1, 'rename 不消耗 rev');
});

void test('update 先、rename 后使用旧 base：rename 报 stale_revision，文件留在旧路径', async () => {
  const vault = createMemoryVault({ files: { [VALID]: VALID_TEXT } });
  const pathTools = createPathTools();
  const { service } = createServiceWith(vault);
  const meta = (await service.list())[0];
  assert.ok(meta !== undefined);
  const next = pathTools.normalize('notes/late.md');

  await service.update(meta.id, { body: '先更新' }, { base: meta.rev, intent: 'user' });
  await assert.rejects(
    () => service.rename(meta.id, next, { base: meta.rev, intent: 'user' }),
    (error: unknown) => error instanceof EmberError && error.code === 'stale_revision',
  );

  assert.ok((vault.dump()[VALID] ?? '').includes('先更新'));
  assert.equal(vault.dump()['notes/late.md'], undefined, '失败改名不应留下半移动文件');
});

void test('update 与 remove 交错：remove 报 stale_revision，不产生复活文件或目录孤儿', async () => {
  const vault = createMemoryVault({ files: { [VALID]: VALID_TEXT } });
  const gate = createWriteGate();
  const { service } = createServiceWith(vault, {
    write: async (path, bytes, intent) => {
      await gate.promise;
      await vault.port.write(path, bytes, intent);
    },
  });
  const meta = (await service.list())[0];
  assert.ok(meta !== undefined);

  const updating = service.update(meta.id, { body: '交错更新' }, { base: meta.rev, intent: 'user' });
  await delay(15);
  const removing = service.remove(meta.id, { base: meta.rev, intent: 'user' });
  gate.release();

  await updating;
  await assert.rejects(
    removing,
    (error: unknown) => error instanceof EmberError && error.code === 'stale_revision',
  );
  assert.ok((vault.dump()[VALID] ?? '').includes('交错更新'), '文件仍在且保留已写入内容');
  const list = await service.list();
  assert.equal(list.length, 1, '目录条目不能被误删');
  assert.deepEqual(Object.keys(vault.dump()), [VALID], '不应产生孤儿文件或遗留 trash');
});

void test('flush 等待队列排空，且队列单元失败不会让 flush reject', async () => {
  const vault = createMemoryVault({ files: { [VALID]: VALID_TEXT } });
  const gate = createWriteGate();
  const { service } = createServiceWith(vault, {
    write: async (path, bytes, intent) => {
      await gate.promise;
      await vault.port.write(path, bytes, intent);
    },
  });
  const meta = (await service.list())[0];
  assert.ok(meta !== undefined);

  const updating = service.update(meta.id, { body: '关窗前落盘' }, { base: meta.rev, intent: 'user' });
  await delay(15);
  let flushed = false;
  const flushing = service.flush().then(() => {
    flushed = true;
  });
  await delay(15);
  assert.equal(flushed, false, '队列未排空时 flush 不能返回');
  gate.release();
  await updating;
  await flushing;
  assert.equal(flushed, true);

  const failingVault = createMemoryVault({ files: { [VALID]: VALID_TEXT } });
  const { service: failingService } = createServiceWith(failingVault, {
    write: () => Promise.reject(new Error('disk full')),
  });
  const failingMeta = (await failingService.list())[0];
  assert.ok(failingMeta !== undefined);
  const failing = failingService.update(failingMeta.id, { body: '必失败' }, { base: failingMeta.rev, intent: 'user' });
  await assert.rejects(failing, /disk full/);
  await assert.doesNotReject(() => failingService.flush());
});

void test('refresh 读到写前内容时不回退 entry、不广播假 external', async () => {
  const vault = createMemoryVault({ files: { [VALID]: VALID_TEXT } });
  const gate = createWriteGate();
  let reads = 0;
  const { service, events } = createServiceWith(vault, {
    read: async (path) => {
      reads += 1;
      const bytes = await vault.port.read(path);
      // 第 3 次读属于 refresh：先取到写前字节，再延迟返回，制造「读完才 apply」的窗口
      if (reads === 3) await delay(40);
      return bytes;
    },
    write: async (path, bytes, intent) => {
      await gate.promise;
      await vault.port.write(path, bytes, intent);
    },
  });
  const kinds: string[] = [];
  events.on('doc:changed', (change) => {
    kinds.push(change.kind);
  });
  const meta = (await service.list())[0];
  assert.ok(meta !== undefined);

  const updating = service.update(meta.id, { body: 'refresh 期间的更新' }, { base: meta.rev, intent: 'user' });
  await delay(10);
  const refreshing = service.refresh();
  await delay(10);
  gate.release();

  const updated = await updating;
  await refreshing;
  const after = await service.read(meta.id);
  assert.ok(after.text.includes('refresh 期间的更新'), 'refresh 不能用写前内容覆盖已提交更新');
  assert.deepEqual(after.meta.rev, updated.snapshot.meta.rev);
  assert.ok(!kinds.includes('external'), `不应广播假 external：${kinds.join(',')}`);
});

void test('refresh 单飞：并发调用只扫描一次，结束后可再次刷新', async () => {
  const vault = createMemoryVault({ files: { [VALID]: VALID_TEXT } });
  let listCalls = 0;
  const { service } = createServiceWith(vault, {
    list: async () => {
      listCalls += 1;
      return vault.port.list();
    },
  });

  await Promise.all([service.refresh(), service.refresh()]);
  assert.equal(listCalls, 1, '并发 refresh 必须共享同一次扫描');
  await service.refresh();
  assert.equal(listCalls, 2, '扫描结束后释放单飞锁');
});

void test('删除成功：只调用一次 port.remove，库内零 trash 写入，目录与事件各一次', async () => {
  const vault = createMemoryVault({ files: { [VALID]: VALID_TEXT } });
  let removeCalls = 0;
  const trashWrites: string[] = [];
  const { service } = createServiceWith(vault, {
    remove: async (path) => {
      removeCalls += 1;
      return vault.port.remove(path);
    },
    write: async (path, bytes, intent) => {
      if (String(path).startsWith('.workbench/trash/')) trashWrites.push(String(path));
      return vault.port.write(path, bytes, intent);
    },
  });
  const meta = (await service.list())[0];
  assert.ok(meta !== undefined);
  const changes: DocChange[] = [];
  const watcher = service.watch((change) => changes.push(change));

  await service.remove(meta.id, { base: meta.rev, intent: 'user' });
  watcher.dispose();

  assert.equal(removeCalls, 1, '删除只能触发一次 port.remove');
  assert.deepEqual(trashWrites, [], '库内不得再写入任何回收副本');
  assert.deepEqual(Object.keys(vault.dump()), [], '文件是唯一真相源，删除后库内不残留副本');
  assert.equal((await service.list()).length, 0, '目录条目必须移除');
  assert.equal(changes.filter((change) => change.kind === 'removed').length, 1, 'removed 事件恰好一次');
});

void test('删除失败：只尝试一次 port.remove，目录与磁盘保持原样，无残留 key', async () => {
  const vault = createMemoryVault({ files: { [VALID]: VALID_TEXT } });
  let removeCalls = 0;
  const { service } = createServiceWith(vault, {
    remove: () => {
      removeCalls += 1;
      return Promise.reject(new Error('EACCES: 回收站不可写'));
    },
  });
  const meta = (await service.list())[0];
  assert.ok(meta !== undefined);
  const changes: DocChange[] = [];
  const watcher = service.watch((change) => changes.push(change));

  await assert.rejects(
    () => service.remove(meta.id, { base: meta.rev, intent: 'user' }),
    (error: unknown) =>
      error instanceof EmberError &&
      error.code === 'io_failed' &&
      error.message.includes('删除失败，文档保持原样（文件未被移入回收站）'),
  );
  watcher.dispose();

  assert.equal(removeCalls, 1, '失败后不得再拿副本路径重试删除');
  assert.ok((vault.dump()[VALID] ?? '').includes('正文内容'));
  assert.deepEqual(Object.keys(vault.dump()), [VALID], '目录里不得出现任何残留 key');
  assert.equal((await service.list()).length, 1, '目录条目保持不变');
  assert.deepEqual(changes, [], '失败不得广播 removed 事件');
});

void test('删除后库内不残留 .workbench/trash 副本', async () => {
  const { vault, service } = setup({ [VALID]: VALID_TEXT });
  const meta = (await service.list())[0];
  assert.ok(meta !== undefined);
  await service.remove(meta.id, { base: meta.rev, intent: 'user' });

  const trashKeys = Object.keys(vault.dump()).filter((path) => path.startsWith('.workbench/trash/'));
  assert.deepEqual(trashKeys, [], '文件是唯一真相源，库内不得再有删除副本');
  assert.equal(vault.dump()[VALID], undefined);
});
