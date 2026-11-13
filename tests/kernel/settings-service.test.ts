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
  assert.equal(settings.ui.toolPomodoro, undefined);
  assert.deepEqual(settings.ui.canvasGrid, { size: 8, snap: true });
  assert.equal(settings.vault.name, '测试库');
  assert.deepEqual(writes, []);
});

void test('patch 只写一次，且新实例能读回同样内容（随库走）', async () => {
  const { vault, vaultId, service, writes } = setup();
  await service.patch({ ui: { toolPomodoro: true, canvasGrid: { size: 32 } } });
  assert.deepEqual(writes, [SETTINGS]);
  assert.equal(
    (JSON.parse(vault.dump()[SETTINGS] ?? '{}') as { ui: { toolPomodoro: boolean } }).ui.toolPomodoro,
    true,
  );

  const reopened = createSettingsService({
    port: vault.port,
    paths: createPathTools(),
    events: createEventBus(),
    log: silentLog,
    vaultId,
  });
  const settings = await reopened.read();
  assert.equal(settings.ui.toolPomodoro, true);
  assert.deepEqual(settings.ui.canvasGrid, { size: 32, snap: true });
});

void test('未知顶层键与未知 ui 键原样保留', async () => {
  const { service, vault } = setup({
    files: {
      [SETTINGS]: JSON.stringify({
        schemaVersion: 1,
        futureFeature: { a: 1 },
        ui: { customPanel: 'keep-me', legacySidebar: 'auto' },
        legacyCapabilities: { 'x.y': { enabled: true } },
      }),
    },
  });
  await service.patch({ ui: { toolPomodoro: true } });
  const stored = JSON.parse(vault.dump()[SETTINGS] ?? '{}') as Record<string, unknown>;
  assert.deepEqual(stored['futureFeature'], { a: 1 });
  // 未知 ui 键与历史遗留顶层键原样保留（P2；capabilities 已不再是已知键）
  assert.equal((stored['ui'] as Record<string, unknown>)['customPanel'], 'keep-me');
  assert.equal((stored['ui'] as Record<string, unknown>)['legacySidebar'], 'auto');
  assert.deepEqual(stored['legacyCapabilities'], { 'x.y': { enabled: true } });
});

void test('只读模式 patch 抛 vault_locked，read 仍可用', async () => {
  const { service } = setup({ readonlyMode: true });
  const settings = await service.read();
  assert.equal(settings.ui.toolPomodoro, undefined);
  await assert.rejects(service.patch({ ui: { toolPomodoro: true } }), (error: unknown) => {
    return error instanceof Error && 'code' in error && (error as { code: string }).code === 'vault_locked';
  });
});

void test('损坏的 settings.json 回退默认值、不抛错、不覆盖磁盘', async () => {
  const { service, vault, writes } = setup({ files: { [SETTINGS]: '{ not json' } });
  const settings = await service.read();
  assert.equal(settings.ui.toolPomodoro, undefined);
  assert.deepEqual(writes, []);
  assert.equal(vault.dump()[SETTINGS], '{ not json');
});

void test('patch 后同时触发 settings:changed 事件与 watch 监听', async () => {
  const { service, events } = setup();
  const seen: boolean[] = [];
  const subscription = events.on('settings:changed', ({ settings }) => {
    seen.push(settings.ui.toolPomodoro === true);
  });
  const watched: boolean[] = [];
  const handle = service.watch((next) => watched.push(next.ui.toolPomodoro === true));

  await service.patch({ ui: { toolPomodoro: true } });
  await service.flush();

  assert.deepEqual(seen, [true]);
  assert.deepEqual(watched, [true]);
  subscription.dispose();
  handle.dispose();
  // 已注销的订阅不再收到第二次 patch
  await service.patch({ ui: { toolPomodoro: false } });
  assert.deepEqual(seen, [true]);
  assert.deepEqual(watched, [true]);
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
      ui: { toolPomodoro: true, extra: 'from-external' },
    }),
  );

  await service.patch({ ui: { toolGallery: true } });

  const stored = JSON.parse(vault.dump()[SETTINGS] ?? '{}') as Record<string, unknown>;
  assert.equal(stored['externalFlag'], true, '外部新增的顶层键应保留');
  const ui = stored['ui'] as Record<string, unknown>;
  assert.equal(ui['extra'], 'from-external', '外部新增的 ui 键应保留');
  assert.equal(ui['toolPomodoro'], true, '外部修改不能被旧缓存覆盖');
  assert.equal(ui['toolGallery'], true, '本次 patch 仍要生效');
});

void test('并发 patch 串行排队，互不丢失更新', async () => {
  const { vault, service } = setup();

  const [, second] = await Promise.all([
    service.patch({ ui: { toolPomodoro: true } }),
    service.patch({ ui: { toolGallery: true } }),
  ]);

  // 第二个 patch 必须建立在第一个的结果之上，而不是旧缓存
  assert.equal(second.ui.toolPomodoro, true);
  assert.equal(second.ui.toolGallery, true);
  const stored = JSON.parse(vault.dump()[SETTINGS] ?? '{}') as {
    ui: { toolPomodoro: boolean; toolGallery: boolean };
  };
  assert.equal(stored.ui.toolPomodoro, true);
  assert.equal(stored.ui.toolGallery, true);
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

  await assert.rejects(service.patch({ ui: { toolPomodoro: true } }), /disk full/);
  // 队列未被毒化：下一次 patch 正常落盘
  const next = await service.patch({ ui: { toolGallery: true } });
  assert.equal(next.ui.toolGallery, true);
  const stored = JSON.parse(mem.dump()[SETTINGS] ?? '{}') as { ui: { toolGallery: boolean } };
  assert.equal(stored.ui.toolGallery, true);
});

const createFailingService = (
  mem: MemoryVault,
  failures: number,
): { service: ReturnType<typeof createSettingsService>; remaining: () => number } => {
  let remaining = failures;
  const port = {
    ...mem.port,
    write: (
      path: Parameters<typeof mem.port.write>[0],
      bytes: Uint8Array,
      intent: Parameters<typeof mem.port.write>[2],
    ) => {
      if (remaining > 0) {
        remaining -= 1;
        return Promise.reject(new Error('disk full'));
      }
      return mem.port.write(path, bytes, intent);
    },
  };
  const service = createSettingsService({
    port,
    paths: createPathTools(),
    events: createEventBus(),
    log: silentLog,
    vaultId: newVaultId(),
  });
  return { service, remaining: () => remaining };
};

void test('正常路径 flush 等待落盘且不抛', async () => {
  const { service } = setup();
  await service.patch({ ui: { toolPomodoro: true } });
  await service.flush();
  await service.flush();
});

void test('flush 把写入失败抛一次，且不重复抛', async () => {
  const mem = createMemoryVault();
  const { service } = createFailingService(mem, 1);

  await assert.rejects(service.patch({ ui: { toolPomodoro: true } }), /disk full/);
  await assert.rejects(service.flush(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /设置写入失败（ui）/);
    assert.match(error.message, /disk full/);
    return true;
  });
  // 抛完清空：第二次 flush 不再重复抛
  await service.flush();
});

void test('flush 抛错后队列未被毒化：再次 patch 成功并落盘', async () => {
  const mem = createMemoryVault();
  const { service, remaining } = createFailingService(mem, 1);

  await assert.rejects(service.patch({ ui: { toolPomodoro: true } }), /disk full/);
  await assert.rejects(service.flush(), /设置写入失败/);
  assert.equal(remaining(), 0);

  const next = await service.patch({ ui: { defaultView: 'editor' } });
  assert.equal(next.ui.defaultView, 'editor');
  await service.flush();
  const stored = JSON.parse(mem.dump()[SETTINGS] ?? '{}') as { ui: { defaultView: string } };
  assert.equal(stored.ui.defaultView, 'editor');
});
