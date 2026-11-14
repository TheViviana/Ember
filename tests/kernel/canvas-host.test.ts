import assert from 'node:assert/strict';
import test from 'node:test';
import type { CanvasMutation, CanvasNode } from '#canvas-engine';
import { asCanvasId, asVaultId, createUlid, type CanvasId } from '#doc-model';
import { createDocService } from '../../src/kernel/doc-service.ts';
import { createCanvasHost } from '../../src/kernel/canvas-host.ts';
import { createEventBus } from '../../src/kernel/events.ts';
import { createPathTools } from '../../src/kernel/paths.ts';
import { createSettingsService } from '../../src/kernel/settings-service.ts';
import type { Logger } from '../../src/kernel/types.ts';
import { createMemoryState, createMemoryVault, type MemoryVault } from './fakes.ts';

const silentLog: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const BASE = Date.UTC(2026, 10, 11, 9, 0, 0);

const setup = (
  options: { readonlyMode?: boolean; files?: Record<string, string> } = {},
): {
  vault: MemoryVault;
  writes: string[];
  events: ReturnType<typeof createEventBus>;
  settings: ReturnType<typeof createSettingsService>;
  host: ReturnType<typeof createCanvasHost>;
} => {
  const vault = createMemoryVault({
    ...(options.readonlyMode === true ? { readonlyMode: true } : {}),
    ...(options.files === undefined ? {} : { files: options.files }),
  });
  const writes: string[] = [];
  const port = {
    ...vault.port,
    write: (
      path: Parameters<typeof vault.port.write>[0],
      bytes: Uint8Array,
      intent: Parameters<typeof vault.port.write>[2],
    ) => {
      writes.push(String(path));
      return vault.port.write(path, bytes, intent);
    },
  };
  const events = createEventBus();
  const paths = createPathTools();
  let tick = 0;
  const now = (): Date => new Date(BASE + tick++ * 1000);
  const vaultId = asVaultId(String(createUlid(BASE)));
  if (vaultId === null) throw new Error('ULID 非法');
  const settings = createSettingsService({
    port,
    paths,
    events,
    log: silentLog,
    vaultId,
    vaultName: '测试库',
    now,
  });
  const host = createCanvasHost({
    port,
    paths,
    events,
    settings,
    docs: createDocService({ port, state: createMemoryState(), paths, events, log: silentLog, now }),
    log: silentLog,
    now,
  });
  return { vault, writes, events, settings, host };
};

const canvasFile = (vault: MemoryVault, id: CanvasId): unknown => {
  const text = vault.dump()[`.workbench/canvas/${String(id)}.json`];
  if (text === undefined) throw new Error('画布文件不存在');
  return JSON.parse(text) as unknown;
};

const note = (id: string, overrides: Partial<CanvasNode> = {}): CanvasNode => ({
  id,
  kind: 'note',
  rect: { x: 0, y: 0, w: 200, h: 120 },
  z: 0,
  docId: null,
  text: '便签',
  groupId: null,
  meta: {},
  ...overrides,
});

const newCanvasId = (): CanvasId => {
  const id = asCanvasId(String(createUlid(BASE)));
  if (id === null) throw new Error('画布 id 非法');
  return id;
};

void test('ensureDefault 新建「主页」：落盘画布 + 写回 settings.ui.defaultCanvasId', async () => {
  const { host, vault } = setup();

  const summary = await host.ensureDefault();
  assert.equal(summary.title, '主页');

  const file = canvasFile(vault, summary.id);
  assert.equal((file as Record<string, unknown>)['schemaVersion'], 1);
  assert.equal((file as Record<string, unknown>)['title'], '主页');
  assert.deepEqual((file as Record<string, unknown>)['nodes'], []);
  assert.deepEqual((file as Record<string, unknown>)['grid'], { size: 8, snap: true });

  const settings = JSON.parse(vault.dump()['.workbench/settings.json'] ?? '{}') as {
    ui?: { defaultCanvasId?: string };
  };
  assert.equal(settings.ui?.defaultCanvasId, String(summary.id));
});

void test('ensureDefault 二次调用复用 defaultCanvasId，不再新建也不再写设置', async () => {
  const { host, writes } = setup();
  const first = await host.ensureDefault();
  const settingsWrites = writes.filter((path) => path.endsWith('settings.json')).length;

  const second = await host.ensureDefault();
  assert.equal(String(second.id), String(first.id));
  assert.equal(writes.filter((path) => path.endsWith('settings.json')).length, settingsWrites);
});

void test('defaultCanvasId 指向不存在的画布时回退到已有画布', async () => {
  const { host, settings } = setup();
  await settings.patch({ ui: { defaultCanvasId: String(newCanvasId()) } });

  const summary = await host.ensureDefault();
  assert.equal(summary.title, '主页');
  const after = await settings.read();
  assert.equal(after.ui.defaultCanvasId, String(summary.id));
});

void test('apply 一次原子写：场景更新、文件更新、canvas:changed 递增', async () => {
  const { host, vault, events } = setup();
  const summary = await host.ensureDefault();
  const revs: number[] = [];
  events.on('canvas:changed', ({ rev }) => revs.push(rev));

  const scene = await host.apply(summary.id, [{ type: 'addNode', node: note('n1') }]);

  assert.equal(scene.nodes.length, 1);
  const file = canvasFile(vault, summary.id) as { nodes: Array<Record<string, unknown>> };
  assert.equal(file.nodes.length, 1);
  assert.equal(file.nodes[0]?.['id'], 'n1');
  assert.deepEqual(revs, [1]);
});

void test('非法批次整批拒绝：内存与磁盘都不动', async () => {
  const { host, vault } = setup();
  const summary = await host.ensureDefault();
  await host.apply(summary.id, [{ type: 'addNode', node: note('n1') }]);
  const before = vault.dump()[`.workbench/canvas/${String(summary.id)}.json`];

  const ops: CanvasMutation[] = [
    { type: 'addNode', node: note('n2') },
    {
      type: 'addEdge',
      edge: { id: 'e1', from: 'n1', to: 'n2', label: null, arrow: 'end', kind: 'relation', meta: {} },
    },
    // 端点不存在：整批应被拒绝
    {
      type: 'addEdge',
      edge: { id: 'e2', from: 'n1', to: 'ghost', label: null, arrow: 'end', kind: 'relation', meta: {} },
    },
  ];

  await assert.rejects(
    () => host.apply(summary.id, ops),
    (error: unknown) =>
      (error as { code?: string }).code === 'canvas_invalid' &&
      String((error as Error).message).includes('ghost'),
  );

  assert.equal(vault.dump()[`.workbench/canvas/${String(summary.id)}.json`], before);
  const session = await host.open(summary.id);
  assert.equal(session.scene.nodes.length, 1);
  assert.equal(session.scene.edges.length, 0);
  session.close();
});

void test('删除组会解散成员但不删成员；删除节点会连带删掉相关边', async () => {
  const { host } = setup();
  const summary = await host.ensureDefault();
  const group: CanvasNode = {
    id: 'g1',
    kind: 'group',
    rect: { x: 0, y: 0, w: 600, h: 400 },
    z: 0,
    docId: null,
    text: '组',
    groupId: null,
    meta: {},
  };
  await host.apply(summary.id, [
    { type: 'addNode', node: group },
    { type: 'addNode', node: note('n1', { z: 1, groupId: 'g1' }) },
    { type: 'addNode', node: note('n2', { z: 2 }) },
    {
      type: 'addEdge',
      edge: { id: 'e1', from: 'n1', to: 'n2', label: null, arrow: 'end', kind: 'relation', meta: {} },
    },
  ]);

  const ungrouped = await host.apply(summary.id, [{ type: 'removeNodes', ids: ['g1'] }]);
  assert.equal(ungrouped.nodes.length, 2);
  assert.equal(ungrouped.nodes.find((node) => node.id === 'n1')?.groupId, null);
  assert.equal(ungrouped.edges.length, 1);

  const pruned = await host.apply(summary.id, [{ type: 'removeNodes', ids: ['n2'] }]);
  assert.equal(pruned.nodes.length, 1);
  assert.equal(pruned.edges.length, 0);
});

void test('视口变更走 400ms 防抖：先改内存，flush 后落盘', async () => {
  const { host, vault } = setup();
  const summary = await host.ensureDefault();
  await host.apply(summary.id, [{ type: 'addNode', node: note('n1') }]);

  await host.apply(summary.id, [{ type: 'setViewport', viewport: { x: 40, y: 60, zoom: 1.5 } }]);
  const before = canvasFile(vault, summary.id) as { viewport: Record<string, number> };
  assert.deepEqual(before.viewport, { x: 0, y: 0, zoom: 1 });

  const session = await host.open(summary.id);
  assert.deepEqual(session.scene.viewport, { x: 40, y: 60, zoom: 1.5 });
  session.close();

  await host.flush();
  const after = canvasFile(vault, summary.id) as { viewport: Record<string, number> };
  assert.deepEqual(after.viewport, { x: 40, y: 60, zoom: 1.5 });
});

void test('视口变更不广播场景通知，内容变更才广播', async () => {
  const { host } = setup();
  const summary = await host.ensureDefault();
  const session = await host.open(summary.id);
  const scenes: string[] = [];
  const subscription = session.on((scene) => scenes.push(`${scene.nodes.length}`));

  // 平移/缩放：每帧一次 apply，订阅者不得被逐帧重建场景树
  await host.apply(summary.id, [{ type: 'setViewport', viewport: { x: 10, y: 10, zoom: 2 } }]);
  await host.apply(summary.id, [{ type: 'setViewport', viewport: { x: 20, y: 20, zoom: 2 } }]);
  assert.deepEqual(scenes, []);

  // 内容变更：一次通知，且携带视口在内的最新场景
  await host.apply(summary.id, [{ type: 'addNode', node: note('n1') }]);
  assert.deepEqual(scenes, ['1']);

  subscription.dispose();
  session.close();
});

void test('内容变更记录上一版，纯视口落盘不新增历史', async () => {
  const { host, vault } = setup();
  const summary = await host.ensureDefault();
  const historyPath = `.workbench/history/${String(summary.id)}.1.json`;

  assert.equal(await host.hasHistory(summary.id), false);
  await assert.rejects(
    () => host.restorePrevious(summary.id),
    (error: unknown) => (error as { code?: string }).code === 'doc_not_found',
  );
  await host.apply(summary.id, [{ type: 'addNode', node: note('n1') }]);

  const firstHistory = vault.dump()[historyPath];
  assert.ok(firstHistory !== undefined);
  assert.deepEqual((JSON.parse(firstHistory) as { nodes: unknown[] }).nodes, []);
  assert.equal(await host.hasHistory(summary.id), true);

  await host.apply(summary.id, [{ type: 'setViewport', viewport: { x: 40, y: 60, zoom: 1.5 } }]);
  await host.flush();
  assert.equal(vault.dump()[historyPath], firstHistory);
  assert.deepEqual(
    Object.keys(vault.dump()).filter((path) => path.startsWith(`.workbench/history/${String(summary.id)}.`)),
    [historyPath],
  );
});

void test('恢复上一版同步内存与磁盘，再次恢复可撤销本次恢复', async () => {
  const { host, vault } = setup();
  const summary = await host.ensureDefault();
  await host.apply(summary.id, [{ type: 'addNode', node: note('n1') }]);
  await host.apply(summary.id, [{ type: 'addNode', node: note('n2') }]);
  const session = await host.open(summary.id);
  const notifications: string[][] = [];
  const subscription = session.on((scene) => notifications.push(scene.nodes.map((node) => node.id)));

  const restored = await host.restorePrevious(summary.id);
  assert.deepEqual(restored.nodes.map((node) => node.id), ['n1']);
  assert.deepEqual(
    (canvasFile(vault, summary.id) as { nodes: Array<{ id: string }> }).nodes.map((node) => node.id),
    ['n1'],
  );

  const reapplied = await host.restorePrevious(summary.id);
  assert.deepEqual(reapplied.nodes.map((node) => node.id), ['n1', 'n2']);
  assert.deepEqual(
    (canvasFile(vault, summary.id) as { nodes: Array<{ id: string }> }).nodes.map((node) => node.id),
    ['n1', 'n2'],
  );
  assert.deepEqual(notifications, [['n1'], ['n1', 'n2']]);
  subscription.dispose();
  session.close();
});

void test('每张画布最多保留 5 版，最旧版本先被淘汰', async () => {
  const { host, vault } = setup();
  const summary = await host.ensureDefault();
  for (let index = 1; index <= 7; index += 1) {
    await host.apply(summary.id, [{ type: 'addNode', node: note(`n${index}`) }]);
  }

  const prefix = `.workbench/history/${String(summary.id)}.`;
  const paths = Object.keys(vault.dump()).filter((path) => path.startsWith(prefix)).sort();
  assert.deepEqual(paths, [1, 2, 3, 4, 5].map((n) => `${prefix}${n}.json`));
  const oldest = JSON.parse(vault.dump()[`${prefix}5.json`] ?? '{}') as {
    nodes?: Array<{ id: string }>;
  };
  assert.deepEqual(oldest.nodes?.map((node) => node.id), ['n1', 'n2']);
});

const hashOf = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
};

const historyFile = (vault: MemoryVault, id: CanvasId, slot: number): string => {
  const text = vault.dump()[`.workbench/history/${String(id)}.${slot}.json`];
  if (text === undefined) throw new Error(`历史文件不存在：${slot}`);
  return text;
};

void test('历史列表与只读预览：槽位元数据正确，预览不写盘', async () => {
  const { host, vault, writes } = setup();
  const summary = await host.ensureDefault();
  await host.apply(summary.id, [{ type: 'addNode', node: note('n1') }]);
  await host.apply(summary.id, [{ type: 'addNode', node: note('n2') }]);

  const entries = await host.listHistory(summary.id);
  assert.deepEqual(entries.map((entry) => entry.slot), [1, 2]);
  assert.equal(entries[0]?.nodeCount, 1);
  assert.equal(entries[1]?.nodeCount, 0);
  assert.equal(entries[0]?.hash, await hashOf(historyFile(vault, summary.id, 1)));
  assert.equal(entries.every((entry) => entry.readable), true);

  const writesBefore = writes.length;
  const preview = await host.readHistory(summary.id, 1);
  assert.deepEqual(preview.scene.nodes.map((node) => node.id), ['n1']);
  assert.equal(preview.entry.hash, entries[0]?.hash);
  assert.equal(writes.length, writesBefore);
});

void test('损坏的历史仍被列出但不可预览或恢复', async () => {
  const { host, vault, writes } = setup();
  const summary = await host.ensureDefault();
  await host.apply(summary.id, [{ type: 'addNode', node: note('n1') }]);
  const broken = `.workbench/history/${String(summary.id)}.1.json`;
  vault.writeRaw(broken, '{ not json');
  const mainBefore = historyFile(vault, summary.id, 1);
  const canvasBefore = JSON.stringify(canvasFile(vault, summary.id));

  const entries = await host.listHistory(summary.id);
  assert.equal(entries[0]?.readable, false);
  await assert.rejects(
    () => host.readHistory(summary.id, 1),
    (error: unknown) => (error as { code?: string }).code === 'canvas_invalid',
  );
  const writesBefore = writes.length;
  await assert.rejects(
    () => host.restoreHistory(summary.id, 1, entries[0]?.hash ?? ''),
    (error: unknown) => (error as { code?: string }).code === 'canvas_invalid',
  );
  assert.equal(writes.length, writesBefore);
  assert.equal(historyFile(vault, summary.id, 1), mainBefore);
  assert.equal(JSON.stringify(canvasFile(vault, summary.id)), canvasBefore);
});

void test('按槽恢复：hash 校验通过后写入，过期 hash 抛 stale_revision 且不写盘', async () => {
  const { host, vault } = setup();
  const summary = await host.ensureDefault();
  await host.apply(summary.id, [{ type: 'addNode', node: note('n1') }]);
  await host.apply(summary.id, [{ type: 'addNode', node: note('n2') }]);
  await host.apply(summary.id, [{ type: 'addNode', node: note('n3') }]);

  const entries = await host.listHistory(summary.id);
  const oldest = entries.find((entry) => entry.slot === 3);
  assert.ok(oldest !== undefined);

  const restored = await host.restoreHistory(summary.id, 3, oldest.hash);
  assert.deepEqual(restored.nodes, []);
  assert.deepEqual((canvasFile(vault, summary.id) as { nodes: unknown[] }).nodes, []);

  // 当前版本已推进历史：恢复可撤销
  const afterRestore = await host.listHistory(summary.id);
  const previous = afterRestore.find((entry) => entry.slot === 1);
  assert.ok(previous !== undefined);
  const undone = await host.restoreHistory(summary.id, 1, previous.hash);
  assert.deepEqual(undone.nodes.map((node) => node.id), ['n1', 'n2', 'n3']);
  assert.deepEqual(
    (canvasFile(vault, summary.id) as { nodes: Array<{ id: string }> }).nodes.map((node) => node.id),
    ['n1', 'n2', 'n3'],
  );

  const before = JSON.stringify(canvasFile(vault, summary.id));
  await assert.rejects(
    () => host.restoreHistory(summary.id, 2, oldest.hash),
    (error: unknown) => (error as { code?: string }).code === 'stale_revision',
  );
  assert.equal(JSON.stringify(canvasFile(vault, summary.id)), before);
});

void test('历史槽位越界与只读库恢复都被拒绝', async () => {
  const { host, vault } = setup();
  const summary = await host.ensureDefault();
  await host.apply(summary.id, [{ type: 'addNode', node: note('n1') }]);

  await assert.rejects(
    () => host.readHistory(summary.id, 0),
    (error: unknown) => (error as { code?: string }).code === 'invalid_payload',
  );

  const readonly = setup({ readonlyMode: true, files: vault.dump() });
  const entry = (await readonly.host.listHistory(summary.id)).find((item) => item.slot === 1);
  assert.ok(entry !== undefined);
  await assert.rejects(
    () => readonly.host.restoreHistory(summary.id, 1, entry.hash),
    (error: unknown) => (error as { code?: string }).code === 'vault_locked',
  );
});

void test('只读库：create 与 apply 都抛 vault_locked', async () => {
  const { host } = setup({ readonlyMode: true });

  await assert.rejects(
    () => host.create({ title: '只读画布' }),
    (error: unknown) => (error as { code?: string }).code === 'vault_locked',
  );

  const id = newCanvasId();
  await assert.rejects(
    () => host.apply(id, [{ type: 'setTitle', title: 'x' }]),
    (error: unknown) => (error as { code?: string }).code === 'vault_locked',
  );
});

void test('同一画布多次 open 返回同一个会话对象，全部 close 后才释放', async () => {
  const { host } = setup();
  const summary = await host.ensureDefault();

  const a = await host.open(summary.id);
  const b = await host.open(summary.id);
  assert.equal(a, b);

  // 引用计数：只关一个（refs 2→1）仍可再 open 并拿到同一会话
  a.close();
  const c = await host.open(summary.id); // refs 1→2
  assert.equal(c, a);
  b.close(); // refs 2→1
  c.close(); // refs 1→0，释放

  const fresh = await host.open(summary.id);
  assert.notEqual(fresh, a);
  fresh.close();
});
