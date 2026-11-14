import assert from 'node:assert/strict';
import test from 'node:test';
import { asDocId, createUlid, unsafeVaultPath, type DocId } from '#doc-model';
import { createDocService } from '../../src/kernel/doc-service.ts';
import { EmberError } from '../../src/kernel/errors.ts';
import { createEventBus } from '../../src/kernel/events.ts';
import { createPathTools } from '../../src/kernel/paths.ts';
import type { VaultPort } from '../../src/kernel/ports.ts';
import type { DocMeta, DocRevision, Logger } from '../../src/kernel/types.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

const ORIGINAL_PATH = 'notes/原文.md';
const COPY_PATH = 'notes/原文 (conflict 20260102-101010).md';
const HISTORY_PREFIX = '.workbench/history/documents';

const silentLog: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

interface ByteVault {
  readonly port: VaultPort;
  readonly files: Map<string, Uint8Array>;
  writeRaw(path: string, text: string): void;
  removeRaw(path: string): void;
}

interface SetupOptions {
  readonly readonlyMode?: boolean;
  readonly failRemove?: boolean;
}

/** 字节级内存端口：删除可注入失败，用于覆盖「写原文成功、删副本失败」的分步场景 */
const createByteVault = (
  initial: Readonly<Record<string, string>>,
  options: SetupOptions = {},
): ByteVault => {
  const files = new Map<string, Uint8Array>(
    Object.entries(initial).map(([path, text]) => [path, encoder.encode(text)]),
  );
  const port: VaultPort = {
    readonlyMode: options.readonlyMode === true,
    readonlyReason: options.readonlyMode === true ? 'lockedByOther' : null,
    read: (path) => Promise.resolve(files.get(String(path)) ?? null),
    write: (path, bytes) => {
      files.set(String(path), bytes);
      return Promise.resolve();
    },
    remove: (path) => {
      if (options.failRemove === true) return Promise.reject(new Error(`注入删除失败：${String(path)}`));
      files.delete(String(path));
      return Promise.resolve('system' as const);
    },
    purge: (path) => {
      files.delete(String(path));
      return Promise.resolve();
    },
    rename: (from, to) => {
      const bytes = files.get(String(from));
      if (bytes === undefined) return Promise.reject(new Error(`missing ${String(from)}`));
      files.delete(String(from));
      files.set(String(to), bytes);
      return Promise.resolve();
    },
    // 本桩只模拟文档字节，文件夹操作不在用例范围内。
    createDir: () => Promise.reject(new Error('文件夹操作未在此桩实现')),
    trashDir: () => Promise.reject(new Error('文件夹操作未在此桩实现')),
    listDirs: () => Promise.resolve([]),
    // 与 Rust list 一致：隐藏目录（含 .workbench 历史）不是文档
    list: () =>
      Promise.resolve(
        [...files.keys()]
          .filter((path) => !path.split('/').some((segment) => segment.startsWith('.')))
          .map((path) => unsafeVaultPath(path)),
      ),
    listCanvases: () => Promise.resolve([]),
    scan: () => Promise.resolve([]),
    stat: (path) => {
      const bytes = files.get(String(path));
      return Promise.resolve(
        bytes === undefined ? null : { mtime: new Date(0).toISOString(), size: bytes.byteLength },
      );
    },
    watch: () => ({ dispose: (): void => undefined }),
  };
  return {
    port,
    files,
    writeRaw: (path, text) => {
      files.set(path, encoder.encode(text));
    },
    removeRaw: (path) => {
      files.delete(path);
    },
  };
};

const setup = (
  initial: Readonly<Record<string, string>>,
  options: SetupOptions = {},
): {
  readonly vault: ByteVault;
  readonly service: ReturnType<typeof createDocService>;
} => {
  const vault = createByteVault(initial, options);
  let tick = 1_700_000_000_000;
  const service = createDocService({
    port: vault.port,
    paths: createPathTools(),
    events: createEventBus(),
    log: silentLog,
    now: () => {
      const at = new Date(tick);
      tick += 1;
      return at;
    },
  });
  return { vault, service };
};

const originalText = (id: string, body: string): string =>
  `---\nid: ${id}\ntitle: 原文\ncreated: 2026-01-01T00:00:00Z\n---\n${body}`;

const copyText = (id: string, of: string, body: string): string =>
  [
    '---',
    `id: ${id}`,
    'title: 副本标题',
    'summary: 副本简介',
    'tags:',
    '  - 冲突',
    'aliases:',
    '  - 副本别名',
    'created: 2026-01-02T00:00:00Z',
    'ember:',
    `  conflictOf: ${of}`,
    '---',
    body,
  ].join('\n');

const findCopy = (metas: readonly DocMeta[]): DocMeta => {
  const copy = metas.find((meta) => meta.conflictOf !== null);
  assert.ok(copy !== undefined, '应存在冲突副本');
  return copy;
};

const findOriginal = (metas: readonly DocMeta[]): DocMeta => {
  const original = metas.find((meta) => meta.conflictOf === null);
  assert.ok(original !== undefined, '应存在原文');
  return original;
};

const base = (rev: DocRevision): DocRevision => rev;

const codeOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof EmberError, `应抛 EmberError，实际：${String(error)}`);
    return error.code;
  }
  assert.fail('应当抛出错误');
};

const snapshot = (vault: ByteVault): Readonly<Record<string, string>> =>
  Object.fromEntries([...vault.files].map(([path, bytes]) => [path, decoder.decode(bytes)]));

const makeId = (seed: number): DocId => {
  const id = asDocId(createUlid(seed));
  if (id === null) throw new Error(`不是合法 ULID：${createUlid(seed)}`);
  return id;
};

const seed = (): { readonly originalId: DocId; readonly copyId: DocId; readonly files: Record<string, string> } => {
  const originalId = makeId(1_700_010_000_000);
  const copyId = makeId(1_700_010_001_000);
  return {
    originalId,
    copyId,
    files: {
      [ORIGINAL_PATH]: originalText(originalId, '原文正文'),
      [COPY_PATH]: copyText(copyId, originalId, '副本正文'),
    },
  };
};

void test('冲突副本在列表中可见并暴露 conflictOf，普通文档为 null', async () => {
  const { originalId, copyId, files } = seed();
  const { service } = setup(files);
  await service.refresh();

  const metas = await service.list();
  assert.equal(metas.length, 2);
  const copy = findCopy(metas);
  const original = findOriginal(metas);
  assert.equal(String(copy.id), String(copyId));
  assert.equal(String(copy.conflictOf), String(originalId));
  assert.equal(original.conflictOf, null);
});

void test('启动扫描即可发现冲突，不依赖运行时 doc:conflict 事件', async () => {
  const { originalId, copyId, files } = seed();
  const { service } = setup(files);

  // 不调用 refresh：首次 list 自己触发扫描
  const metas = await service.list();
  const copy = findCopy(metas);
  assert.equal(String(copy.id), String(copyId));
  assert.equal(String(copy.conflictOf), String(originalId));
});

void test('原文缺失时为孤儿冲突：采用被拒绝且零写入，另存可清除标记', async () => {
  const originalId = makeId(1_700_020_000_000);
  const copyId = makeId(1_700_020_001_000);
  const { vault, service } = setup({ [COPY_PATH]: copyText(copyId, originalId, '孤儿正文') });
  await service.refresh();
  const metas = await service.list();
  const copy = findCopy(metas);
  const before = snapshot(vault);

  const code = await codeOf(() =>
    service.adoptCopy(copyId, { base: base(copy.rev), copyBase: base(copy.rev), intent: 'user' }),
  );
  assert.equal(code, 'doc_not_found');
  assert.deepEqual(snapshot(vault), before, '孤儿冲突采用失败不得写盘');

  const detached = await service.detachCopy(copyId, { base: base(copy.rev), intent: 'user' });
  assert.equal(String(detached.meta.id), String(copyId));
  assert.equal(detached.meta.path, copy.path);
  assert.equal(detached.meta.conflictOf, null);
  assert.equal(detached.frontmatter.ember['conflictOf'], undefined);
  assert.match(detached.text, /孤儿正文/);
});

void test('原文基线过期：采用抛 stale_revision 且原文与副本都不变', async () => {
  const { originalId, copyId, files } = seed();
  const { vault, service } = setup(files);
  await service.refresh();
  const metas = await service.list();
  const copy = findCopy(metas);
  const original = findOriginal(metas);

  vault.writeRaw(ORIGINAL_PATH, originalText(String(originalId), '外部改写的原文'));
  const before = snapshot(vault);

  const code = await codeOf(() =>
    service.adoptCopy(copyId, { base: base(original.rev), copyBase: base(copy.rev), intent: 'user' }),
  );
  assert.equal(code, 'stale_revision');
  assert.deepEqual(snapshot(vault), before, '基线过期不得写盘，也不得再制造冲突副本');
});

void test('副本基线过期：采用抛 stale_revision 且不写原文', async () => {
  const { originalId, copyId, files } = seed();
  const { vault, service } = setup(files);
  await service.refresh();
  const metas = await service.list();
  const copy = findCopy(metas);
  const original = findOriginal(metas);

  vault.writeRaw(COPY_PATH, copyText(String(copyId), String(originalId), '外部改写的副本'));
  const before = snapshot(vault);

  const code = await codeOf(() =>
    service.adoptCopy(copyId, { base: base(original.rev), copyBase: base(copy.rev), intent: 'user' }),
  );
  assert.equal(code, 'stale_revision');
  assert.deepEqual(snapshot(vault), before, '副本过期不得写原文');
});

void test('采用副本：正文与允许元数据写回原文，保留原 id，副本移入回收站', async () => {
  const { originalId, copyId, files } = seed();
  const { vault, service } = setup(files);
  await service.refresh();
  const metas = await service.list();
  const copy = findCopy(metas);
  const original = findOriginal(metas);

  const result = await service.adoptCopy(copyId, {
    base: base(original.rev),
    copyBase: base(copy.rev),
    intent: 'user',
  });

  assert.equal(result.copyRemoved, true);
  assert.equal(String(result.snapshot.meta.id), String(originalId));
  assert.equal(result.snapshot.meta.title, '副本标题');
  assert.equal(result.snapshot.meta.summary, '副本简介');
  assert.deepEqual(result.snapshot.meta.tags, ['冲突']);
  assert.deepEqual(result.snapshot.meta.aliases, ['副本别名']);
  assert.equal(result.snapshot.frontmatter.created, '2026-01-01T00:00:00Z');
  assert.equal(result.snapshot.meta.conflictOf, null);
  assert.match(result.snapshot.text, /副本正文/);
  assert.doesNotMatch(result.snapshot.text, /原文正文/);

  assert.equal(vault.files.has(COPY_PATH), false, '副本应被移入回收站');
  const historyFiles = [...vault.files.keys()].filter((path) => path.startsWith(HISTORY_PREFIX));
  assert.ok(historyFiles.length > 0, '采用前应记录原文历史');

  const next = await service.list();
  assert.equal(next.length, 1);
  assert.equal(String(next[0]?.id), String(originalId));
});

void test('分步失败：删副本失败时原文已更新，copyRemoved 为 false 且副本保留', async () => {
  const { originalId, copyId, files } = seed();
  const { vault, service } = setup(files, { failRemove: true });
  await service.refresh();
  const metas = await service.list();
  const copy = findCopy(metas);
  const original = findOriginal(metas);

  const result = await service.adoptCopy(copyId, {
    base: base(original.rev),
    copyBase: base(copy.rev),
    intent: 'user',
  });

  assert.equal(result.copyRemoved, false);
  assert.match(result.snapshot.text, /副本正文/);
  assert.equal(vault.files.has(COPY_PATH), true, '删除失败时副本必须保留');
  const reread = await service.read(originalId);
  assert.match(reread.text, /副本正文/);
});

void test('只读模式：采用与另存都抛 vault_locked，零写入', async () => {
  const { copyId, files } = seed();
  const { vault, service } = setup(files, { readonlyMode: true });
  await service.refresh();
  const metas = await service.list();
  const copy = findCopy(metas);
  const original = findOriginal(metas);
  const before = snapshot(vault);

  const adoptCode = await codeOf(() =>
    service.adoptCopy(copyId, { base: base(original.rev), copyBase: base(copy.rev), intent: 'user' }),
  );
  assert.equal(adoptCode, 'vault_locked');
  const detachCode = await codeOf(() =>
    service.detachCopy(copyId, { base: base(copy.rev), intent: 'user' }),
  );
  assert.equal(detachCode, 'vault_locked');
  assert.deepEqual(snapshot(vault), before, '只读模式不得写盘');
});

void test('不自动清理：刷新与列表都不删除、不合并冲突副本', async () => {
  const { originalId, copyId, files } = seed();
  const { vault, service } = setup(files);
  await service.refresh();
  await service.list();
  await service.refresh();

  const metas = await service.list();
  assert.equal(metas.length, 2);
  const copy = findCopy(metas);
  assert.equal(String(copy.id), String(copyId));
  assert.equal(String(copy.conflictOf), String(originalId));
  assert.equal(vault.files.has(COPY_PATH), true);
  assert.equal(vault.files.has(ORIGINAL_PATH), true);
});
