import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { asVaultId, createUlid } from '#doc-model';
import { createDocService } from '../../src/kernel/doc-service.ts';
import { createEventBus } from '../../src/kernel/events.ts';
import { createMigrationService } from '../../src/kernel/migration-service.ts';
import { createPathTools } from '../../src/kernel/paths.ts';
import { createSettingsService } from '../../src/kernel/settings-service.ts';
import type { Logger } from '../../src/kernel/types.ts';
import { createMemoryState, createMemoryVault } from './fakes.ts';

const silentLog: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const BASE = 1_700_000_000_000;
const OLD_ID = String(createUlid(BASE + 1));
const UNKNOWN_ID = String(createUlid(BASE + 2));
const CANVAS_ID = String(createUlid(BASE + 3));

const docText = (title: string, id: string): string =>
  `---\nid: ${id}\ntitle: ${title}\n---\n\n${title} 正文\n`;

const canvasText = (): string =>
  `${JSON.stringify(
    {
      schemaVersion: 1,
      id: CANVAS_ID,
      title: '测试画布',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      viewport: { x: 0, y: 0, zoom: 1 },
      grid: { size: 8, snap: true },
      nodes: [
        {
          id: 'node-a',
          kind: 'doc',
          docId: OLD_ID,
          text: null,
          x: 0,
          y: 0,
          w: 240,
          h: 140,
          z: 0,
          groupId: null,
          meta: {},
        },
        {
          id: 'node-b',
          kind: 'doc',
          docId: UNKNOWN_ID,
          text: null,
          x: 300,
          y: 0,
          w: 240,
          h: 140,
          z: 0,
          groupId: null,
          meta: {},
        },
      ],
      edges: [],
      bookmarks: [],
    },
    null,
    2,
  )}\n`;

const setup = () => {
  const vaultId = asVaultId(String(createUlid(BASE + 10)));
  if (vaultId === null) throw new Error('vault id 非法');
  const initial: Record<string, Uint8Array> = {
    'notes/a.md': new TextEncoder().encode(docText('A', OLD_ID)),
    'notes/b.md': new TextEncoder().encode('---\ntitle: B\n---\n\nB 正文\n'),
    [`${'.workbench/canvas'}/${CANVAS_ID}.json`]: new TextEncoder().encode(canvasText()),
    '.workbench/settings.json': new TextEncoder().encode(
      `${JSON.stringify(
        {
          schemaVersion: 1,
          vault: { id: vaultId },
          linkOverrides: { '[[a]]': OLD_ID, '[[keep]]': 'notes/b.md' },
        },
        null,
        2,
      )}\n`,
    ),
  };
  const vault = createMemoryVault({ rawFiles: initial });
  const state = createMemoryState();
  const events = createEventBus();
  const paths = createPathTools();
  let tick = 0;
  const now = (): Date => new Date(BASE + tick++ * 1000);
  const settings = createSettingsService({
    port: vault.port,
    paths,
    events,
    log: silentLog,
    vaultId,
    vaultName: '迁移测试库',
    now,
  });
  const docs = createDocService({ port: vault.port, state, paths, events, log: silentLog, now });
  const migration = createMigrationService({ port: vault.port, state, paths, settings, docs, log: silentLog, now });
  return { vault, state, settings, migration };
};

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

const canvasOf = (vault: ReturnType<typeof createMemoryVault>): Record<string, unknown> =>
  JSON.parse(vault.dump()[`.workbench/canvas/${CANVAS_ID}.json`] ?? '{}') as Record<string, unknown>;

void test('迁移：唯一候选改写 docId，未知 ULID 转 note 并留线索，快照落库外', async () => {
  const { vault, state, settings, migration } = setup();
  const beforeDocs = ['notes/a.md', 'notes/b.md'].map((path) => vault.dump()[path] ?? '');
  const beforeHashes = beforeDocs.map(sha);

  const report = await migration.migrate();

  assert.equal(report.status, 'migrated');
  assert.equal(report.docs, 1);
  assert.equal(report.canvases, 1);
  assert.equal(report.placeholders, 1);
  assert.equal(report.overrides, 1);

  const nodes = canvasOf(vault)['nodes'] as readonly Record<string, unknown>[];
  assert.equal(nodes[0]?.['kind'], 'doc');
  assert.equal(nodes[0]?.['docId'], 'notes/a.md');
  assert.equal(nodes[1]?.['kind'], 'note');
  assert.equal(nodes[1]?.['docId'], null);
  assert.ok(String(nodes[1]?.['text']).includes(UNKNOWN_ID));

  const current = await settings.read();
  assert.equal(current.docIdScheme, 'path');
  assert.equal(String(current.linkOverrides['[[a]]']), 'notes/a.md');
  assert.equal(String(current.linkOverrides['[[keep]]']), 'notes/b.md');

  const snapshot = state.dump()[`migrations/${String(report.snapshotId)}/snapshot.json`];
  assert.ok(snapshot !== undefined, '快照必须落在库外');
  assert.equal(vault.dump()['.workbench/migrations/x'], undefined);
  assert.equal(Object.keys(vault.dump()).some((path) => path.startsWith('.workbench/history/')), false);

  const afterHashes = ['notes/a.md', 'notes/b.md'].map((path) => sha(vault.dump()[path] ?? ''));
  assert.deepEqual(afterHashes, beforeHashes, '迁移不得改动任何 .md 字节');
});

void test('二次迁移是 noop，不重复写快照', async () => {
  const { state, migration } = setup();
  await migration.migrate();
  const count = Object.keys(state.dump()).filter((path) => path.endsWith('snapshot.json')).length;
  const second = await migration.migrate();
  assert.equal(second.status, 'noop');
  assert.equal(
    Object.keys(state.dump()).filter((path) => path.endsWith('snapshot.json')).length,
    count,
  );
});

void test('回滚：画布与 linkOverrides 原样恢复，再来一次结果一致', async () => {
  const { vault, settings, migration } = setup();
  const originalCanvas = vault.dump()[`.workbench/canvas/${CANVAS_ID}.json`];
  const beforeDocs = ['notes/a.md', 'notes/b.md'].map((path) => vault.dump()[path] ?? '');
  const beforeHashes = beforeDocs.map(sha);

  await migration.migrate();
  const migratedCanvas = vault.dump()[`.workbench/canvas/${CANVAS_ID}.json`];

  const rolled = await migration.rollback();
  assert.equal(rolled.status, 'rolledBack');
  assert.equal(vault.dump()[`.workbench/canvas/${CANVAS_ID}.json`], originalCanvas);
  const restored = await settings.read();
  assert.equal(restored.docIdScheme, undefined);
  assert.equal(String(restored.linkOverrides['[[a]]']), OLD_ID);

  const again = await migration.migrate();
  assert.equal(again.status, 'migrated');
  assert.equal(vault.dump()[`.workbench/canvas/${CANVAS_ID}.json`], migratedCanvas);

  const afterHashes = ['notes/a.md', 'notes/b.md'].map((path) => sha(vault.dump()[path] ?? ''));
  assert.deepEqual(afterHashes, beforeHashes, '迁移→回滚→再迁移不得改动 .md 字节');
});

void test('映射不到的 linkOverrides 丢弃并告警', async () => {
  const { vault, settings, migration } = setup();
  const settingsText = JSON.parse(vault.dump()['.workbench/settings.json'] ?? '{}') as Record<
    string,
    unknown
  >;
  settingsText['linkOverrides'] = { '[[gone]]': UNKNOWN_ID };
  vault.writeRaw('.workbench/settings.json', JSON.stringify(settingsText));
  const report = await migration.migrate();
  assert.equal(report.droppedOverrides, 1);
  assert.ok(report.warnings.some((warning) => warning.includes('[[gone]]')));
  const current = await settings.read();
  assert.equal(current.linkOverrides['[[gone]]'], undefined);
});
