import assert from 'node:assert/strict';
import test from 'node:test';
import { createUlid, unsafeVaultPath, type DocId } from '#doc-model';
import { createDocService } from '../../src/kernel/doc-service.ts';
import { EmberError } from '../../src/kernel/errors.ts';
import { createEventBus } from '../../src/kernel/events.ts';
import { createPathTools } from '../../src/kernel/paths.ts';
import type { VaultPort } from '../../src/kernel/ports.ts';
import type { DocRevision, Logger } from '../../src/kernel/types.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');
const PATH = 'notes/history.md';
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
  writeRaw(path: string, bytes: Uint8Array): void;
  removeRaw(path: string): void;
}

/** 字节级内存端口：历史存储必须按原始字节断言；failWrite 用于注入历史写失败 */
const createByteVault = (
  initial: Readonly<Record<string, Uint8Array>>,
  failWrite?: (path: string) => boolean,
): ByteVault => {
  const files = new Map(Object.entries(initial));
  const port: VaultPort = {
    readonlyMode: false,
    readonlyReason: null,
    read: (path) => Promise.resolve(files.get(String(path)) ?? null),
    write: (path, bytes) => {
      if (failWrite?.(String(path)) === true) return Promise.reject(new Error(`注入失败：${String(path)}`));
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
    writeRaw: (path, bytes) => {
      files.set(path, bytes);
    },
    removeRaw: (path) => {
      files.delete(path);
    },
  };
};

const setup = (
  initial: Readonly<Record<string, Uint8Array>>,
  failWrite?: (path: string) => boolean,
): {
  readonly vault: ByteVault;
  readonly service: ReturnType<typeof createDocService>;
} => {
  const vault = createByteVault(initial, failWrite);
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

const docText = (id: string, body: string): string =>
  `---\nid: ${id}\ntitle: 历史\n---\n${body}`;

const boot = async (
  service: ReturnType<typeof createDocService>,
  initial: Readonly<Record<string, Uint8Array>>,
): Promise<{ readonly id: DocId; readonly rev: DocRevision }> => {
  await service.refresh();
  const metas = await service.list();
  assert.equal(metas.length, Object.keys(initial).length, '刷新后应收录全部文档');
  const meta = metas.find((item) => String(item.path) === PATH) ?? metas[0];
  assert.ok(meta !== undefined);
  return { id: meta.id, rev: meta.rev };
};

const updateBody = async (
  service: ReturnType<typeof createDocService>,
  id: DocId,
  body: string,
): Promise<void> => {
  const snap = await service.read(id);
  await service.update(id, { body }, { base: snap.meta.rev, intent: 'user' });
};

const historyFiles = (vault: ByteVault, id: DocId): readonly string[] =>
  [...vault.files.keys()].filter(
    (path) => path.startsWith(`${HISTORY_PREFIX}/${String(id)}/`) && path.endsWith('.md'),
  );

const indexRaw = (id: DocId): string => `${HISTORY_PREFIX}/${String(id)}/index.json`;
const versionRaw = (id: DocId, versionId: string): string =>
  `${HISTORY_PREFIX}/${String(id)}/${versionId}.md`;

void test('保留策略：连续更新 21 次只留 20 版，最旧文件被清理', async () => {
  const id = createUlid(1_700_000_100_000);
  const initial = { [PATH]: encoder.encode(docText(id, 'v0\n')) };
  const { vault, service } = setup(initial);
  const booted = await boot(service, initial);

  for (let index = 1; index <= 21; index += 1) {
    await updateBody(service, booted.id, `v${index}\n`);
  }

  const history = await service.listHistory(booted.id);
  assert.equal(history.length, 20, '最多保留 20 版');
  assert.equal(historyFiles(vault, booted.id).length, 20, '磁盘上也只保留 20 个版本文件');
  const oldest = history[history.length - 1];
  assert.ok(oldest !== undefined);
  const kept = history.find((entry) => entry.versionId === oldest.versionId);
  assert.equal(kept?.hash, oldest.hash, '列表与磁盘一致');
});

void test('字节预算：旧索引条目超过 64 MiB 时从最旧开始淘汰，最新版保留', async () => {
  const id = createUlid(1_700_000_200_000);
  const initial = { [PATH]: encoder.encode(docText(id, 'v0\n')) };
  const { vault, service } = setup(initial);
  const booted = await boot(service, initial);
  await updateBody(service, booted.id, 'v1\n');

  const newest = createUlid(1_700_000_201_000);
  const older = createUlid(1_700_000_202_000);
  const fakeHash = `sha256:${'ab'.repeat(32)}`;
  vault.writeRaw(
    indexRaw(booted.id),
    encoder.encode(
      JSON.stringify({
        schemaVersion: 1,
        docId: String(booted.id),
        versions: [
          { versionId: newest, path: PATH, hash: fakeHash, at: '2026-01-01T00:00:01Z', size: 40 * 1024 * 1024 },
          { versionId: older, path: PATH, hash: fakeHash, at: '2026-01-01T00:00:00Z', size: 40 * 1024 * 1024 },
        ],
      }),
    ),
  );

  await updateBody(service, booted.id, 'v2\n');
  const history = await service.listHistory(booted.id);

  assert.equal(history.length, 2, '删掉最旧一条后 40 MiB 回到预算内');
  assert.equal(history.some((entry) => entry.versionId === older), false, '最旧条目被淘汰');
  assert.equal(history.some((entry) => entry.versionId === newest), true, '较新的旧条目保留');
});

void test('历史版本按原始字节保存：BOM 与 CRLF 逐字节不变', async () => {
  const id = createUlid(1_700_000_300_000);
  const original = encoder.encode(`\uFEFF---\r\nid: ${id}\r\ntitle: 历史\r\n---\r\none\r\ntwo\r\n`);
  const initial = { [PATH]: original };
  const { vault, service } = setup(initial);
  const booted = await boot(service, initial);
  await updateBody(service, booted.id, 'one\ntwo\nthree\n');

  const [entry] = await service.listHistory(booted.id);
  assert.ok(entry !== undefined);
  const stored = vault.files.get(versionRaw(booted.id, entry.versionId));
  assert.ok(stored !== undefined, '版本文件应存在');
  assert.deepEqual([...stored], [...original], '历史文件必须逐字节等于旧版磁盘字节');

  const preview = await service.readHistory(booted.id, entry.versionId);
  assert.equal(preview.text.startsWith('\uFEFF'), false, '预览去 BOM');
  assert.equal(preview.text.includes('\r'), false, '预览归一为 LF');
});

void test('历史写失败时不提交主文', async () => {
  const id = createUlid(1_700_000_400_000);
  const original = encoder.encode(docText(id, 'v0\n'));
  const { vault, service } = setup({ [PATH]: original }, (path) => path.startsWith(HISTORY_PREFIX));
  const booted = await boot(service, { [PATH]: original });

  await assert.rejects(updateBody(service, booted.id, 'v1\n'), /注入失败/);
  assert.deepEqual([...(vault.files.get(PATH) ?? new Uint8Array())], [...original], '主文字节不变');
  const after = await service.read(booted.id);
  assert.equal(after.meta.rev.rev, booted.rev.rev, 'rev 不推进');
  assert.equal((await service.listHistory(booted.id)).length, 0, '索引不应写成功');
  assert.equal(historyFiles(vault, booted.id).length, 0, '失败的新版本文件应被清理');
});

void test('重启后仍能列出并预览历史', async () => {
  const id = createUlid(1_700_000_500_000);
  const initial = { [PATH]: encoder.encode(docText(id, 'v0\n')) };
  const first = setup(initial);
  const booted = await boot(first.service, initial);
  await updateBody(first.service, booted.id, 'v1\n');
  const [entry] = await first.service.listHistory(booted.id);

  const second = createDocService({
    port: first.vault.port,
    paths: createPathTools(),
    events: createEventBus(),
    log: silentLog,
    now: () => new Date(1_700_000_600_000),
  });
  await second.refresh();
  assert.ok(entry !== undefined);
  const listed = await second.listHistory(booted.id);
  assert.equal(listed.length, 1);
  const preview = await second.readHistory(booted.id, entry.versionId);
  assert.ok(preview.text.includes('v0'), '重启后可读取历史正文');
});

void test('索引损坏按无历史处理，下次保存重建', async () => {
  const id = createUlid(1_700_000_700_000);
  const initial = { [PATH]: encoder.encode(docText(id, 'v0\n')) };
  const { vault, service } = setup(initial);
  const booted = await boot(service, initial);
  await updateBody(service, booted.id, 'v1\n');

  vault.writeRaw(indexRaw(booted.id), encoder.encode('{not-json'));
  assert.deepEqual(await service.listHistory(booted.id), [], '损坏索引返回空列表而不抛错');

  await updateBody(service, booted.id, 'v2\n');
  const rebuilt = await service.listHistory(booted.id);
  assert.equal(rebuilt.length, 1, '下次保存以新表覆盖损坏索引');
  assert.ok(rebuilt[0] !== undefined);
  const preview = await service.readHistory(booted.id, rebuilt[0].versionId);
  assert.ok(preview.text.includes('v1'), '重建后的索引指向本次写入前的版本');
});

void test('列表与预览零写入', async () => {
  const id = createUlid(1_700_000_800_000);
  const initial = { [PATH]: encoder.encode(docText(id, 'v0\n')) };
  const { vault, service } = setup(initial);
  const booted = await boot(service, initial);
  await updateBody(service, booted.id, 'v1\n');

  const before = new Map([...vault.files].map(([path, bytes]) => [path, [...bytes]]));
  const history = await service.listHistory(booted.id);
  for (const entry of history) {
    await service.readHistory(booted.id, entry.versionId);
  }
  assert.deepEqual([...vault.files.keys()].sort(), [...before.keys()].sort(), '文件集合不变');
  for (const [path, bytes] of before) {
    assert.deepEqual([...(vault.files.get(path) ?? new Uint8Array())], bytes, `${path} 字节不变`);
  }
});

void test('恢复基线过期：主文不变、落冲突副本、历史不新增', async () => {
  const id = createUlid(1_700_000_900_000);
  const initial = { [PATH]: encoder.encode(docText(id, 'v0\n')) };
  const { vault, service } = setup(initial);
  const booted = await boot(service, initial);
  await updateBody(service, booted.id, 'v1\n');
  const [target] = await service.listHistory(booted.id);
  assert.ok(target !== undefined);
  const snapshot = await service.read(booted.id);

  const external = encoder.encode(docText(id, 'external\n'));
  vault.writeRaw(PATH, external);

  const outcome = await service.restoreHistory(booted.id, target.versionId, {
    base: snapshot.meta.rev,
    intent: 'user',
  });
  assert.equal(outcome.merged, false);
  assert.notEqual(outcome.conflict, null, '应生成冲突副本');
  assert.deepEqual([...(vault.files.get(PATH) ?? new Uint8Array())], [...external], '主文保持磁盘内容');
  assert.equal((await service.listHistory(booted.id)).length, 1, '历史不新增');
});

void test('恢复成功：当前正文变目标版，恢复前版本入历史且后续历史保留', async () => {
  const id = createUlid(1_700_001_000_000);
  const initial = { [PATH]: encoder.encode(docText(id, 'v0\n')) };
  const { vault, service } = setup(initial);
  const booted = await boot(service, initial);
  await updateBody(service, booted.id, 'v1\n');
  await updateBody(service, booted.id, 'v2\n');

  const history = await service.listHistory(booted.id);
  assert.equal(history.length, 2, 'v1 与 v0');
  const target = history[history.length - 1];
  assert.ok(target !== undefined);
  const snapshot = await service.read(booted.id);

  const outcome = await service.restoreHistory(booted.id, target.versionId, {
    base: snapshot.meta.rev,
    intent: 'user',
  });
  assert.equal(outcome.merged, true);
  assert.equal(outcome.conflict, null);
  assert.ok(decoder.decode(vault.files.get(PATH)).includes('v0'), '主文恢复为目标版');
  assert.equal(outcome.snapshot.meta.rev.rev, snapshot.meta.rev.rev + 1, 'rev 推进一次');

  const after = await service.listHistory(booted.id);
  assert.equal(after.length, 3, '恢复前的 v2 进入历史，v1 仍在');
  assert.ok(decoder.decode(vault.files.get(PATH)).includes('v0'));
  const v1 = history[0];
  assert.ok(v1 !== undefined);
  assert.equal(after.some((entry) => entry.hash === v1.hash), true, '后续历史不删除');
});

void test('纯 rename 与冲突副本创建都不记录历史', async () => {
  const id = createUlid(1_700_001_100_000);
  const initial = { [PATH]: encoder.encode(docText(id, 'v0\n')) };
  const first = setup(initial);
  const booted = await boot(first.service, initial);

  await first.service.rename(booted.id, unsafeVaultPath('notes/renamed.md'), {
    base: booted.rev,
    intent: 'user',
  });
  assert.equal((await first.service.listHistory(booted.id)).length, 0, 'rename 不记内容版本');

  const snapshot = await first.service.read(booted.id);
  first.vault.writeRaw('notes/renamed.md', encoder.encode(docText(id, 'external\n')));
  const outcome = await first.service.update(
    booted.id,
    { body: 'local\n' },
    { base: snapshot.meta.rev, intent: 'user' },
  );
  assert.notEqual(outcome.conflict, null);
  assert.equal((await first.service.listHistory(booted.id)).length, 0, '冲突副本创建不记历史');
});

void test('非法版本 id、缺失文件与哈希不符都拒绝预览/恢复', async () => {
  const id = createUlid(1_700_001_200_000);
  const initial = { [PATH]: encoder.encode(docText(id, 'v0\n')) };
  const { vault, service } = setup(initial);
  const booted = await boot(service, initial);
  await updateBody(service, booted.id, 'v1\n');
  const [entry] = await service.listHistory(booted.id);
  assert.ok(entry !== undefined);
  const snapshot = await service.read(booted.id);

  await assert.rejects(service.readHistory(booted.id, '../escape'), (error: unknown) => {
    return error instanceof EmberError && error.code === 'invalid_payload';
  });
  await assert.rejects(
    service.restoreHistory(booted.id, '../escape', { base: snapshot.meta.rev, intent: 'user' }),
    (error: unknown) => error instanceof EmberError && error.code === 'invalid_payload',
  );

  const stored = vault.files.get(versionRaw(booted.id, entry.versionId));
  assert.ok(stored !== undefined);
  vault.writeRaw(versionRaw(booted.id, entry.versionId), encoder.encode('tampered'));
  await assert.rejects(service.readHistory(booted.id, entry.versionId), (error: unknown) => {
    return error instanceof EmberError && error.code === 'invalid_payload';
  });
  await assert.rejects(
    service.restoreHistory(booted.id, entry.versionId, { base: snapshot.meta.rev, intent: 'user' }),
    (error: unknown) => error instanceof EmberError && error.code === 'invalid_payload',
  );

  vault.removeRaw(versionRaw(booted.id, entry.versionId));
  await assert.rejects(service.readHistory(booted.id, entry.versionId), (error: unknown) => {
    return error instanceof EmberError && error.code === 'doc_not_found';
  });
  const body = decoder.decode(vault.files.get(PATH));
  assert.ok(body.includes('v1'), '拒绝路径不得改动主文');
});
