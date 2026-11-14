import assert from 'node:assert/strict';
import test from 'node:test';
import { EditorState } from '@codemirror/state';
import { createUlid, splitFrontmatter, unsafeVaultPath } from '#doc-model';
import { createDocService } from '../../src/kernel/doc-service.ts';
import { EmberError } from '../../src/kernel/errors.ts';
import { createEventBus } from '../../src/kernel/events.ts';
import { createPathTools } from '../../src/kernel/paths.ts';
import type { Logger, WriteIntent } from '../../src/kernel/types.ts';
import type { VaultPort } from '../../src/kernel/ports.ts';
import { hasPendingWrite } from '../../src/shell/editor/float-persist.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');
const PATH = 'notes/enc.md';

const silentLog: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** 字节级内存端口：fakes 只收字符串，编码测试必须能塞非法 UTF-8 原始字节 */
const createByteVault = (
  initial: Readonly<Record<string, Uint8Array>>,
): {
  port: VaultPort;
  files: Map<string, Uint8Array>;
  writeRaw(path: string, bytes: Uint8Array): void;
} => {
  const files = new Map(Object.entries(initial));
  const port: VaultPort = {
    readonlyMode: false,
    readonlyReason: null,
    read: (path) => Promise.resolve(files.get(String(path)) ?? null),
    write: (path, bytes) => {
      files.set(String(path), bytes);
      return Promise.resolve();
    },
    remove: (path) => {
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
    list: () => Promise.resolve([...files.keys()].map((path) => unsafeVaultPath(path))),
    listCanvases: () => Promise.resolve([]),
    scan: () => Promise.resolve([]),
    stat: (path) => {
      const bytes = files.get(String(path));
      return Promise.resolve(bytes === undefined ? null : { mtime: new Date(0).toISOString(), size: bytes.byteLength });
    },
    watch: () => ({ dispose: (): void => undefined }),
  };
  return {
    port,
    files,
    writeRaw: (path, bytes) => {
      files.set(path, bytes);
    },
  };
};

const setup = (
  initial: Readonly<Record<string, Uint8Array>>,
): {
  vault: ReturnType<typeof createByteVault>;
  service: ReturnType<typeof createDocService>;
} => {
  const vault = createByteVault(initial);
  const service = createDocService({
    port: vault.port,
    paths: createPathTools(),
    events: createEventBus(),
    log: silentLog,
  });
  return { vault, service };
};

const docText = (id: string, body: string): string => `---\nid: ${id}\ntitle: 编码\n---\n${body}`;

const persisted = (vault: ReturnType<typeof createByteVault>, path: string): Uint8Array => {
  const bytes = vault.files.get(path);
  assert.ok(bytes !== undefined, `${path} 应存在`);
  return bytes;
};

const update = async (
  service: ReturnType<typeof createDocService>,
  id: Parameters<ReturnType<typeof createDocService>['update']>[0],
  body: string,
  base: Parameters<ReturnType<typeof createDocService>['update']>[2]['base'],
  intent: WriteIntent = 'user',
): Promise<void> => {
  await service.update(id, { body }, { base, intent });
};

void test('带 BOM 的文件保存后仍以 BOM 开头', async () => {
  const id = createUlid(1_700_000_001_000);
  const { vault, service } = setup({ [PATH]: encoder.encode(`\uFEFF${docText(id, 'hello\n')}`) });
  await service.refresh();
  const snap = await service.read((await service.list())[0]!.id);
  await update(service, snap.meta.id, 'hello\n', snap.meta.rev);
  const after = persisted(vault, PATH);
  assert.deepEqual([...after.slice(0, 3)], [0xef, 0xbb, 0xbf], 'BOM 必须保留在文件首字节');
});

void test('CRLF 文件保存后仍是纯 CRLF，不出现裸 LF', async () => {
  const id = createUlid(1_700_000_002_000);
  const original = `---\r\nid: ${id}\r\ntitle: 编码\r\n---\r\nline1\r\nline2\r\n`;
  const { vault, service } = setup({ [PATH]: encoder.encode(original) });
  await service.refresh();
  const snap = await service.read((await service.list())[0]!.id);
  await update(service, snap.meta.id, 'line1\nline2\n', snap.meta.rev);
  const text = decoder.decode(persisted(vault, PATH));
  const totalLf = text.split('\n').length - 1;
  const crlf = text.split('\r\n').length - 1;
  assert.equal(totalLf, crlf, '每一处换行都必须是 CRLF');
  assert.ok(text.includes('line1\r\nline2'), '正文保留 CRLF');
});

void test('零编辑开关不产生写入：canonical 正文与编辑器正文一致，rev 不变', async () => {
  const id = createUlid(1_700_000_003_000);
  const original = `---\r\nid: ${id}\r\ntitle: 编码\r\n---\r\nline1\r\nline2\r\n`;
  const { vault, service } = setup({ [PATH]: encoder.encode(original) });
  await service.refresh();
  const snap = await service.read((await service.list())[0]!.id);
  const savedBody = splitFrontmatter(snap.text).body;
  const editorBody = EditorState.create({ doc: savedBody }).doc.toString();
  assert.equal(savedBody, 'line1\nline2\n', '快照正文必须是 canonical LF');
  assert.equal(
    hasPendingWrite(editorBody, savedBody, { title: false, tags: false, summary: false }),
    false,
    '仅打开再关闭不应触发补写',
  );
  assert.equal(decoder.decode(persisted(vault, PATH)), original, '磁盘字节不应变化');
  assert.equal((await service.read((await service.list())[0]!.id)).meta.rev.rev, snap.meta.rev.rev, 'rev 不应推进');
});

void test('非法 UTF-8 文件拒绝写入，磁盘字节逐字节不变', async () => {
  const id = createUlid(1_700_000_004_000);
  const head = encoder.encode(docText(id, 'b'));
  const original = new Uint8Array([...head, 0xff, 0x0a]);
  const { vault, service } = setup({ [PATH]: original });
  await service.refresh();
  const snap = await service.read((await service.list())[0]!.id);
  await assert.rejects(
    update(service, snap.meta.id, 'b\n', snap.meta.rev),
    (error: unknown) => error instanceof EmberError && error.code === 'invalid_payload',
  );
  assert.deepEqual([...persisted(vault, PATH)], [...original], '拒绝写入时不得改动原文件');
});

void test('制表符、行尾空格、NUL、NFD 往返逐字节保真', async () => {
  const id = createUlid(1_700_000_005_000);
  const body = 'a\u0000b  \t\n e\u0301\n';
  const { vault, service } = setup({ [PATH]: encoder.encode(docText(id, body)) });
  await service.refresh();
  const snap = await service.read((await service.list())[0]!.id);
  await update(service, snap.meta.id, body, snap.meta.rev);
  const text = decoder.decode(persisted(vault, PATH));
  assert.ok(text.endsWith(`${body}`), '正文必须原样保留（含 NUL/Tab/行尾空格/NFD）');
});

void test('混合行尾文件写回统一 LF（已知限制的现行为）', async () => {
  const id = createUlid(1_700_000_006_000);
  const original = `---\nid: ${id}\ntitle: 编码\n---\nline1\r\nline2\n`;
  const { vault, service } = setup({ [PATH]: encoder.encode(original) });
  await service.refresh();
  const snap = await service.read((await service.list())[0]!.id);
  await update(service, snap.meta.id, 'line1\nline2\n', snap.meta.rev);
  const text = decoder.decode(persisted(vault, PATH));
  assert.equal(text.includes('\r'), false, '混合行尾按已知限制统一写回 LF');
});

void test('冲突副本继承原文件的 BOM 与 CRLF', async () => {
  const id = createUlid(1_700_000_007_000);
  const original = `\uFEFF---\r\nid: ${id}\r\ntitle: 编码\r\n---\r\none\r\ntwo\r\n`;
  const { vault, service } = setup({ [PATH]: encoder.encode(original) });
  const [meta] = await service.list();
  const snap = await service.read(meta!.id);
  // 外部改第一行、本地也改第一行：同区域两侧不同 → 三方合并冲突，落冲突副本
  vault.writeRaw(PATH, encoder.encode(`\uFEFF---\r\nid: ${id}\r\ntitle: 编码\r\n---\r\nDISK\r\ntwo\r\n`));
  const outcome = await service.update(snap.meta.id, { body: 'LOCAL\ntwo\n' }, { base: snap.meta.rev, intent: 'user' });
  assert.notEqual(outcome.conflict, null, '应生成冲突副本');
  const copyBytes = persisted(vault, String(outcome.conflict?.path));
  assert.deepEqual([...copyBytes.slice(0, 3)], [0xef, 0xbb, 0xbf], '冲突副本保留 BOM');
  assert.ok(decoder.decode(copyBytes).includes('\r\n'), '冲突副本保留 CRLF');
});
