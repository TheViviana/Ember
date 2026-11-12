import assert from 'node:assert/strict';
import test from 'node:test';
import { asVaultId, createUlid, type VaultId } from '#doc-model';
import { createEventBus } from '../../src/kernel/events.ts';
import { createPathTools } from '../../src/kernel/paths.ts';
import { createSettingsService } from '../../src/kernel/settings-service.ts';
import type { Logger } from '../../src/kernel/types.ts';
import { createMemoryVault, type MemoryVault } from './fakes.ts';

const SETTINGS = '.workbench/settings.json';

const silentLog: Logger & { warnings: string[] } = {
  warnings: [],
  debug: () => undefined,
  info: () => undefined,
  warn(message, fields) {
    silentLog.warnings.push(`${message}${fields === undefined ? '' : ` ${JSON.stringify(fields)}`}`);
  },
  error: () => undefined,
};

const newVaultId = (): VaultId => {
  const id = asVaultId(String(createUlid()));
  if (id === null) throw new Error('生成的 ULID 非法');
  return id;
};

const setup = (
  options: { readonlyMode?: boolean; files?: Record<string, string> } = {},
): {
  vault: MemoryVault;
  vaultId: VaultId;
  writes: string[];
  service: ReturnType<typeof createSettingsService>;
  events: ReturnType<typeof createEventBus>;
} => {
  const vault = createMemoryVault({
    ...(options.readonlyMode === true ? { readonlyMode: true } : {}),
    ...(options.files === undefined ? {} : { files: options.files }),
  });
  const vaultId = newVaultId();
  const writes: string[] = [];
  const countingPort = {
    ...vault.port,
    write: (path: Parameters<typeof vault.port.write>[0], bytes: Uint8Array, intent: Parameters<typeof vault.port.write>[2]) => {
      writes.push(String(path));
      return vault.port.write(path, bytes, intent);
    },
  };
  const events = createEventBus();
  const service = createSettingsService({
    port: countingPort,
    paths: createPathTools(),
    events,
    log: silentLog,
    vaultId,
    vaultName: '测试库',
    now: () => new Date('2026-11-11T00:00:00Z'),
  });
  return { vault, vaultId, writes, service, events };
};

void test('缺文件时返回默认设置且读取不写盘', async () => {
  const { service, writes } = setup();
  const settings = await service.read();
  assert.equal(settings.ui.sidebar, 'auto');
  assert.deepEqual(settings.ui.canvasGrid, { size: 8, snap: true });
  assert.equal(settings.vault.name, '测试库');
  assert.deepEqual(writes, []);
});

void test('patch 只写一次，且新实例能读回同样内容（随库走）', async () => {
  const { vault, vaultId, service, writes } = setup();
  await service.patch({ ui: { sidebar: 'off', canvasGrid: { size: 32 } } });
  assert.deepEqual(writes, [SETTINGS]);
  assert.equal(
    (JSON.parse(vault.dump()[SETTINGS] ?? '{}') as { ui: { sidebar: string } }).ui.sidebar,
    'off',
  );

  const reopened = createSettingsService({
    port: vault.port,
    paths: createPathTools(),
    events: createEventBus(),
    log: silentLog,
    vaultId,
  });
  const settings = await reopened.read();
  assert.equal(settings.ui.sidebar, 'off');
  assert.deepEqual(settings.ui.canvasGrid, { size: 32, snap: true });
});

void test('未知顶层键与未知 ui 键原样保留', async () => {
  const { service, vault } = setup({
    files: {
      [SETTINGS]: JSON.stringify({
        schemaVersion: 1,
        futureFeature: { a: 1 },
        ui: { sidebar: 'auto', customPanel: 'keep-me' },
        capabilities: { 'x.y': { enabled: true, config: { n: 2 } } },
      }),
    },
  });
  await service.patch({ ui: { sidebar: 'off' } });
  const stored = JSON.parse(vault.dump()[SETTINGS] ?? '{}') as Record<string, unknown>;
  assert.deepEqual(stored['futureFeature'], { a: 1 });
  assert.equal((stored['ui'] as Record<string, unknown>)['customPanel'], 'keep-me');
  assert.equal((stored['capabilities'] as Record<string, { enabled: boolean }>)['x.y']?.enabled, true);
});

void test('只读模式 patch 抛 vault_locked，read 仍可用', async () => {
  const { service } = setup({ readonlyMode: true });
  const settings = await service.read();
  assert.equal(settings.ui.sidebar, 'auto');
  await assert.rejects(service.patch({ ui: { sidebar: 'off' } }), (error: unknown) => {
    return error instanceof Error && 'code' in error && (error as { code: string }).code === 'vault_locked';
  });
});

void test('损坏的 settings.json 回退默认值、不抛错、不覆盖磁盘', async () => {
  const { service, vault, writes } = setup({ files: { [SETTINGS]: '{ not json' } });
  const settings = await service.read();
  assert.equal(settings.ui.sidebar, 'auto');
  assert.deepEqual(writes, []);
  assert.equal(vault.dump()[SETTINGS], '{ not json');
});

void test('patch 后同时触发 settings:changed 事件与 watch 监听', async () => {
  const { service, events } = setup();
  const seen: string[] = [];
  const subscription = events.on('settings:changed', ({ settings }) => {
    seen.push(settings.ui.sidebar);
  });
  const watched: string[] = [];
  const handle = service.watch((next) => watched.push(next.ui.sidebar));

  await service.patch({ ui: { sidebar: 'off' } });
  await service.flush();

  assert.deepEqual(seen, ['off']);
  assert.deepEqual(watched, ['off']);
  subscription.dispose();
  handle.dispose();
  await service.patch({ ui: { sidebar: 'auto' } });
  assert.deepEqual(seen, ['off']);
  assert.deepEqual(watched, ['off']);
});

void test('读缓存后外部改写 settings.json，patch 不覆盖外部修改', async () => {
  const { vault, service } = setup();
  // 先读一次，让服务持有旧缓存
  await service.read();

  vault.writeRaw(
    SETTINGS,
    JSON.stringify({
      schemaVersion: 1,
      externalFlag: true,
      ui: { sidebar: 'off', extra: 'from-external' },
    }),
  );

  await service.patch({ ui: { defaultView: 'editor' } });

  const stored = JSON.parse(vault.dump()[SETTINGS] ?? '{}') as Record<string, unknown>;
  assert.equal(stored['externalFlag'], true, '外部新增的顶层键应保留');
  const ui = stored['ui'] as Record<string, unknown>;
  assert.equal(ui['extra'], 'from-external', '外部新增的 ui 键应保留');
  assert.equal(ui['sidebar'], 'off', '外部修改不能被旧缓存覆盖');
  assert.equal(ui['defaultView'], 'editor', '本次 patch 仍要生效');
});

void test('并发 patch 串行排队，互不丢失更新', async () => {
  const { vault, service } = setup();

  const [, second] = await Promise.all([
    service.patch({ ui: { sidebar: 'off' } }),
    service.patch({ ui: { defaultView: 'editor' } }),
  ]);

  // 第二个 patch 必须建立在第一个的结果之上，而不是旧缓存
  assert.equal(second.ui.sidebar, 'off');
  assert.equal(second.ui.defaultView, 'editor');
  const stored = JSON.parse(vault.dump()[SETTINGS] ?? '{}') as {
    ui: { sidebar: string; defaultView: string };
  };
  assert.equal(stored.ui.sidebar, 'off');
  assert.equal(stored.ui.defaultView, 'editor');
});

void test('patch 落盘失败向调用方抛错，且不阻断后续 patch', async () => {
  const mem = createMemoryVault();
  let failNextWrite = true;
  const failingPort = {
    ...mem.port,
    write: (
      path: Parameters<typeof mem.port.write>[0],
      bytes: Uint8Array,
      intent: Parameters<typeof mem.port.write>[2],
    ) => {
      if (failNextWrite) {
        failNextWrite = false;
        return Promise.reject(new Error('disk full'));
      }
      return mem.port.write(path, bytes, intent);
    },
  };
  const service = createSettingsService({
    port: failingPort,
    paths: createPathTools(),
    events: createEventBus(),
    log: silentLog,
    vaultId: newVaultId(),
  });

  await assert.rejects(service.patch({ ui: { sidebar: 'off' } }), /disk full/);
  // 队列未被毒化：下一次 patch 正常落盘
  const next = await service.patch({ ui: { defaultView: 'editor' } });
  assert.equal(next.ui.defaultView, 'editor');
  const stored = JSON.parse(mem.dump()[SETTINGS] ?? '{}') as { ui: { defaultView: string } };
  assert.equal(stored.ui.defaultView, 'editor');
});
