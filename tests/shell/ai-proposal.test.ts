import assert from 'node:assert/strict';
import test from 'node:test';
import {
  asDocId,
  normalizeFrontmatter,
  unsafeContentHash,
  unsafeVaultPath,
  type DocId,
} from '#doc-model';
import type {
  CreateDocInput,
  DocPatch,
  DocSnapshot,
  WriteOptions,
  WriteOutcome,
} from '../../src/kernel/types.ts';
import {
  applyProposalDoc,
  undoProposalDoc,
  type ProposalDocs,
} from '../../src/shell/ai/proposal.ts';

const DOC_ID_VALUE = '01JBQZ8K2N4M6P8R0T2V4X6Z8A';
const DOC_ID: DocId = (() => {
  const id = asDocId(DOC_ID_VALUE);
  if (id === null) throw new Error('测试 fixture 的 ULID 非法');
  return id;
})();

const makeSnapshot = (hashText: string, rev = 1): DocSnapshot => {
  const { frontmatter } = normalizeFrontmatter({
    id: DOC_ID_VALUE,
    title: '示例文章',
    summary: '摘要',
    tags: ['架构', '检索'],
    aliases: ['示例别名'],
  });
  return {
    meta: {
      id: DOC_ID,
      path: unsafeVaultPath('notes/示例文章.md'),
      title: '示例文章',
      summary: '摘要',
      tags: ['架构', '检索'],
      aliases: ['示例别名'],
      created: '2026-11-11T10:00:00Z',
      updated: '2026-11-11T10:00:00Z',
      rev: { rev, hash: unsafeContentHash(hashText) },
      flags: { needsAdoption: false, idInvalid: false, duplicateId: false },
      conflictOf: null,
    },
    frontmatter,
    text: '旧正文',
  };
};

interface FakeOptions {
  readonly snapshot: DocSnapshot;
  readonly update?: (id: DocId, patch: DocPatch, opts: WriteOptions) => Promise<WriteOutcome>;
  readonly create?: (input: CreateDocInput) => Promise<DocSnapshot>;
}

interface FakeCalls {
  readonly update: DocPatch[];
  readonly create: CreateDocInput[];
  readonly remove: DocId[];
}

const makeDocs = (options: FakeOptions): { docs: ProposalDocs; calls: FakeCalls } => {
  const calls: FakeCalls = { update: [], create: [], remove: [] };
  // 有状态 fake：update(body) 后 read 返回已更新的正文，模拟真实磁盘
  let current: DocSnapshot = options.snapshot;
  const docs: ProposalDocs = {
    read: () => Promise.resolve(current),
    update: (id, patch, opts) => {
      calls.update.push(patch);
      if (patch.body !== undefined) {
        current = { ...current, text: patch.body };
      }
      if (options.update !== undefined) return options.update(id, patch, opts);
      return Promise.resolve({ snapshot: current, merged: true, conflict: null });
    },
    create: (input) => {
      calls.create.push(input);
      if (options.create !== undefined) return options.create(input);
      return Promise.resolve(options.snapshot);
    },
    remove: (id) => {
      calls.remove.push(id);
      return Promise.resolve();
    },
  };
  return { docs, calls };
};

const paths = {
  normalize: (value: string) => unsafeVaultPath(value),
};

const FIXED_NOW = (): Date => new Date('2026-11-11T12:34:56');

void test('stale：base.hash 与磁盘不一致时提案作废，且不产生任何写盘调用', async () => {
  const { docs, calls } = makeDocs({ snapshot: makeSnapshot('sha256:disk-changed') });
  const result = await applyProposalDoc(docs, paths, {
    kind: 'replace',
    docId: DOC_ID,
    base: { rev: 1, hash: unsafeContentHash('sha256:proposal-base') },
    title: '示例文章',
    body: 'AI 新正文',
    previousBody: '旧正文',
  });
  assert.equal(result.kind, 'error');
  if (result.kind === 'error') assert.match(result.message, /已被修改/);
  assert.equal(calls.update.length, 0);
  assert.equal(calls.create.length, 0);
  assert.equal(calls.remove.length, 0);
});

void test('冲突：报出冲突副本路径且不生成撤销条', async () => {
  const snapshot = makeSnapshot('sha256:same');
  const { docs, calls } = makeDocs({
    snapshot,
    update: () =>
      Promise.resolve({
        snapshot,
        merged: false,
        conflict: {
          id: DOC_ID,
          path: unsafeVaultPath('notes/示例文章 (conflict 20261111T123456Z-ABCD).md'),
          of: DOC_ID,
        },
      }),
  });
  const result = await applyProposalDoc(docs, paths, {
    kind: 'replace',
    docId: DOC_ID,
    base: snapshot.meta.rev,
    title: '示例文章',
    body: 'AI 新正文',
    previousBody: '旧正文',
  });
  assert.equal(result.kind, 'error');
  if (result.kind === 'error') assert.match(result.message, /conflict 20261111T123456Z-ABCD/);
  assert.equal(calls.update.length, 1);
  assert.equal(calls.create.length, 0);
  assert.equal(calls.remove.length, 0);
});

void test('撤销替换：把旧正文按最新修订写回', async () => {
  const snapshot = makeSnapshot('sha256:same');
  const { docs, calls } = makeDocs({ snapshot });
  const applied = await applyProposalDoc(docs, paths, {
    kind: 'replace',
    docId: DOC_ID,
    base: snapshot.meta.rev,
    title: '示例文章',
    body: 'AI 新正文',
    previousBody: '旧正文',
  });
  if (applied.kind !== 'applied' || applied.undo === null) throw new Error('应生成替换撤销条');
  assert.equal(applied.undo.kind, 'restore-body');

  const notice = await undoProposalDoc(docs, applied.undo);
  assert.match(notice, /已撤销/);
  assert.equal(calls.update.length, 2);
  assert.equal(calls.update[0]?.body, 'AI 新正文');
  assert.equal(calls.update[1]?.body, '旧正文');
});

void test('撤销替换：正文已被人工改过时拒绝静默覆盖', async () => {
  const calls: FakeCalls = { update: [], create: [], remove: [] };
  // 人工编辑模拟：AI 应用后把磁盘正文改成别的，且 rev 前进（撤销以 latest 为 base 也合法）
  let current: DocSnapshot = makeSnapshot('sha256:same');
  const docs: ProposalDocs = {
    read: () => Promise.resolve(current),
    update: (_id, patch) => {
      calls.update.push(patch);
      current = {
        ...current,
        text: patch.body ?? current.text,
        meta: { ...current.meta, rev: { rev: current.meta.rev.rev + 1, hash: current.meta.rev.hash } },
      };
      return Promise.resolve({ snapshot: current, merged: true, conflict: null });
    },
    create: (input) => Promise.resolve(input.id === undefined ? current : current),
    remove: () => Promise.resolve(),
  };

  const applied = await applyProposalDoc(docs, paths, {
    kind: 'replace',
    docId: DOC_ID,
    base: current.meta.rev,
    title: '示例文章',
    body: 'AI 新正文',
    previousBody: '旧正文',
  });
  if (applied.kind !== 'applied' || applied.undo === null || applied.undo.kind !== 'restore-body') {
    throw new Error('应生成替换撤销条');
  }
  const undo = applied.undo;

  // 人工编辑：改成与 AI 应用后不同的正文
  current = { ...current, text: '人工补充', meta: { ...current.meta, rev: { rev: current.meta.rev.rev + 1, hash: current.meta.rev.hash } } };

  await assert.rejects(
    () => undoProposalDoc(docs, undo),
    /替换之后的正文又被修改过/,
  );
  assert.equal(calls.update.length, 1, '撤销不应产生第二次写盘');
});

void test('撤销删除：按原 id / 路径 / 正文 / frontmatter 重建', async () => {
  const snapshot = makeSnapshot('sha256:same');
  const { docs, calls } = makeDocs({ snapshot });
  const applied = await applyProposalDoc(docs, paths, {
    kind: 'delete',
    docId: DOC_ID,
    base: snapshot.meta.rev,
    title: '示例文章',
  });
  if (applied.kind !== 'applied' || applied.undo === null) throw new Error('应生成删除撤销条');
  assert.equal(applied.undo.kind, 'restore-deleted');
  assert.equal(calls.remove.length, 1);

  if (applied.undo.kind !== 'restore-deleted') throw new Error('撤销类型应为重建');
  const input = applied.undo.input;
  assert.equal(String(input.id), DOC_ID_VALUE);
  assert.equal(String(input.path), 'notes/示例文章.md');
  assert.equal(input.text, '旧正文');
  assert.equal(input.title, '示例文章');
  assert.deepEqual(input.tags, ['架构', '检索']);
  assert.deepEqual(input.aliases, ['示例别名']);
  assert.equal(input.summary, '摘要');

  const notice = await undoProposalDoc(docs, applied.undo);
  assert.match(notice, /已恢复/);
  assert.equal(calls.create.length, 1);
  assert.equal(String(calls.create[0]?.id), DOC_ID_VALUE);
});

void test('撤销新建：删除刚创建的文件', async () => {
  const created = makeSnapshot('sha256:created');
  const { docs, calls } = makeDocs({ snapshot: created, create: () => Promise.resolve(created) });
  const applied = await applyProposalDoc(
    docs,
    paths,
    { kind: 'create', title: 'AI 草稿', body: '新正文' },
    FIXED_NOW,
  );
  if (applied.kind !== 'applied' || applied.undo === null) throw new Error('应生成新建撤销条');
  assert.equal(String(applied.createdId), DOC_ID_VALUE);
  assert.equal(applied.undo.kind, 'remove-created');
  assert.equal(calls.create.length, 1);
  assert.match(String(calls.create[0]?.path), /^notes\/AI 草稿-20261111-123456\.md$/);

  const notice = await undoProposalDoc(docs, applied.undo);
  assert.match(notice, /已撤销新建/);
  assert.equal(calls.remove.length, 1);
  assert.equal(String(calls.remove[0]), DOC_ID_VALUE);
});
