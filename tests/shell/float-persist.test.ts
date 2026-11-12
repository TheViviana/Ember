import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { QueryClient } from '@tanstack/react-query';
import { unsafeContentHash, unsafeDocId, unsafeVaultPath } from '#doc-model';
import type { DocId } from '#doc-model';
import type { KernelContext } from '../../src/kernel/context.ts';
import type { DocSnapshot, WriteOutcome } from '../../src/kernel/types.ts';
import { createFloatPersister } from '../../src/shell/editor/float-persist.ts';
import type { MetaField } from '../../src/shell/editor/float-editor-model.ts';

const DOC_ID: DocId = unsafeDocId('01JB8ZQ3K4M5N6P7Q8R9S0T1V2');

const snapshotOf = (body: string, rev: number): DocSnapshot => ({
  meta: {
    id: DOC_ID,
    path: unsafeVaultPath('笔记/测试.md'),
    title: '测试',
    summary: '',
    tags: [],
    aliases: [],
    created: '2026-01-01T00:00:00Z',
    updated: '2026-01-01T00:00:00Z',
    rev: { rev, hash: unsafeContentHash('hash') },
    flags: { needsAdoption: false, idInvalid: false, duplicateId: false },
  },
  frontmatter: {
    id: String(DOC_ID),
    title: '测试',
    summary: null,
    tags: [],
    aliases: [],
    created: null,
    updated: null,
    ember: {},
    extra: {},
  },
  text: body,
});

/** 轮询等待条件成立，避免依赖固定的微任务次数 */
const waitFor = async (condition: () => boolean, label: string): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await delay(0);
  }
  throw new Error(`等待超时：${label}`);
};

interface Harness {
  readonly persister: ReturnType<typeof createFloatPersister>;
  readonly updates: Array<{ readonly body: string | undefined }>;
  readonly releases: Array<() => void>;
  readonly setBody: (value: string) => void;
}

interface HarnessOptions {
  /** 让 docs.update 在放行后失败，用来验证失败会被向上抛出 */
  readonly failUpdate?: boolean;
}

const harness = (options: HarnessOptions = {}): Harness => {
  const updates: Array<{ readonly body: string | undefined }> = [];
  const releases: Array<() => void> = [];
  let current = '';
  let rev = 0;

  const update = async (
    _docId: DocId,
    patch: { readonly body?: string },
  ): Promise<WriteOutcome> => {
    updates.push({ body: patch.body });
    // 写入挂起，由测试决定何时完成，用来稳定复现「保存中再次 persist」
    await new Promise<void>((resolve) => releases.push(resolve));
    if (options.failUpdate === true) throw new Error('disk full');
    rev += 1;
    return {
      snapshot: snapshotOf(patch.body ?? '', rev),
      merged: true,
      conflict: null,
    };
  };

  const kernel = {
    docs: {
      update,
      rename: (): Promise<WriteOutcome> =>
        Promise.reject(new Error('本用例不应触发改名')),
    },
  } as unknown as KernelContext;
  const queryClient = {
    invalidateQueries: (): Promise<void> => Promise.resolve(),
  } as unknown as QueryClient;

  const dirty: { current: Record<MetaField, boolean> } = {
    current: { title: false, tags: false, summary: false },
  };
  const persister = createFloatPersister({
    kernel,
    queryClient,
    docId: DOC_ID,
    getBody: () => current,
    titleField: { current: '测试' },
    tagsField: { current: [] },
    summaryField: { current: '' },
    dirty,
    isDisposed: () => false,
    setPhase: (): void => undefined,
    setBanner: (): void => undefined,
    setHasSummary: (): void => undefined,
  });

  return {
    persister,
    updates,
    releases,
    setBody: (value: string): void => {
      current = value;
    },
  };
};

void test('保存中再次 persist，flushOnClose 仍会返回并以关闭正文落盘', async () => {
  const { persister, updates, releases, setBody } = harness();
  persister.reset(snapshotOf('初始正文', 0));

  setBody('第一版');
  const first = persister.persist();
  await waitFor(() => updates.length === 1, '第一次写入进入挂起');

  // 关窗补写：此时在途写入未结束，必须挂起等待
  let flushed = false;
  const flush = persister.flushOnClose('关闭正文').then(() => {
    flushed = true;
  });
  await delay(0);
  assert.equal(flushed, false, '在途写入结束前 flushOnClose 不能返回');

  // 保存期间又触发一次 persist：单槽排队写入会覆盖 pending，
  // 修复前这里会把 flushOnClose 的 resolve 一起覆盖掉，导致关窗永久挂起。
  setBody('中间正文');
  void persister.persist();
  releases.shift()?.();

  await first;
  await waitFor(() => updates.length === 2, '排队写入开始');
  assert.equal(updates[1]?.body, '中间正文');

  releases.shift()?.();
  await waitFor(() => updates.length === 3, '关闭正文补写开始');
  assert.equal(updates[2]?.body, '关闭正文');
  releases.shift()?.();

  await Promise.race([
    flush,
    delay(1000).then(() => {
      throw new Error('flushOnClose 未在超时前返回');
    }),
  ]);
  assert.equal(flushed, true);

  assert.equal(persister.getSavedBody(), '关闭正文', '最终落盘内容为关闭瞬间的正文');
  assert.equal(persister.isSaving(), false);
});

void test('保存失败向上抛出，不再只留在状态栏', async () => {
  const { persister, releases, setBody } = harness({ failUpdate: true });
  persister.reset(snapshotOf('初始正文', 0));

  setBody('会失败的改动');
  const saving = persister.persist();
  await waitFor(() => releases.length === 1, '写入开始');
  releases.shift()?.();

  await assert.rejects(saving, /disk full/, 'persist 必须把失败交给调用方');
});

void test('flushOnClose 补写失败同样抛出（关窗据此阻止关闭）', async () => {
  const { persister, releases } = harness({ failUpdate: true });
  persister.reset(snapshotOf('初始正文', 0));

  const flushing = persister.flushOnClose('关闭正文');
  await waitFor(() => releases.length === 1, '关闭补写开始');
  releases.shift()?.();

  await assert.rejects(flushing, /disk full/, 'flushOnClose 必须把窗口内的失败抛给关窗流程');
});
