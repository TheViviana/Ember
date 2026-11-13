import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { asVaultId, createUlid, type VaultId } from '#doc-model';
import { createEventBus } from '../../src/kernel/events.ts';
import { createPathTools } from '../../src/kernel/paths.ts';
import { createSettingsService } from '../../src/kernel/settings-service.ts';
import type { Logger, SettingsService } from '../../src/kernel/types.ts';
import { runCloseFlow } from '../../src/shell/close-flow.ts';
import { createMemoryVault, type MemoryVault } from '../kernel/fakes.ts';

const SETTINGS = '.workbench/settings.json';

const silentLog: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const newVaultId = (): VaultId => {
  const id = asVaultId(String(createUlid()));
  if (id === null) throw new Error('生成的 ULID 非法');
  return id;
};

const createLog = (): { readonly errors: string[]; readonly error: (message: string) => void } => {
  const errors: string[] = [];
  return {
    errors,
    error: (message: string): void => {
      errors.push(message);
    },
  };
};

/** 复刻 settings-service.test.ts 的建服务方式，额外允许注入慢写/失败写 */
const createService = (
  mem: MemoryVault,
  write?: (
    path: Parameters<MemoryVault['port']['write']>[0],
    bytes: Uint8Array,
    intent: Parameters<MemoryVault['port']['write']>[2],
  ) => Promise<void>,
): SettingsService => {
  const port =
    write === undefined
      ? mem.port
      : {
          ...mem.port,
          write: (
            path: Parameters<MemoryVault['port']['write']>[0],
            bytes: Uint8Array,
            intent: Parameters<MemoryVault['port']['write']>[2],
          ): Promise<void> => write(path, bytes, intent),
        };
  return createSettingsService({
    port,
    paths: createPathTools(),
    events: createEventBus(),
    log: silentLog,
    vaultId: newVaultId(),
  });
};

const storedToolPomodoro = (raw: string | undefined): boolean | undefined => {
  if (raw === undefined) return undefined;
  return (JSON.parse(raw) as { ui?: { toolPomodoro?: boolean } }).ui?.toolPomodoro;
};

void test('App.tsx 的关窗阶段一包含 settings.flush（改前接线缺这一条）', () => {
  const source = readFileSync(new URL('../../src/shell/App.tsx', import.meta.url), 'utf8');
  const flushersAt = source.indexOf('flushers: [');
  const settingsAt = source.indexOf('() => kernel.settings.flush()');
  const shutdownAt = source.indexOf('shutdown,');
  assert.ok(flushersAt >= 0, 'App.tsx 应存在关窗 flushers 列表');
  assert.ok(
    settingsAt > flushersAt && settingsAt < shutdownAt,
    'settings.flush 必须列在阶段一 flushers 内',
  );
});

void test('场景一：设置写入失败时阶段一拦住关闭（改前旧实现返回 close）', async () => {
  const mem = createMemoryVault();
  const service = createService(mem, () => Promise.reject(new Error('disk full')));
  const pending = service.patch({ ui: { toolPomodoro: true } });
  void pending.catch(() => undefined);

  const outcome = await runCloseFlow({
    flushers: [() => service.flush()],
    shutdown: () => Promise.resolve(),
    log: createLog(),
  });

  assert.equal(outcome.kind, 'block');
  assert.ok(outcome.kind === 'block');
  assert.equal(outcome.failures.length, 1);
  assert.match(outcome.failures[0] ?? '', /设置写入失败（ui）/);
  assert.match(outcome.failures[0] ?? '', /disk full/);
  assert.equal(mem.dump()[SETTINGS], undefined, '失败时磁盘不得出现半写内容');
});

void test('场景二（改前接线）：shutdown 抛错瞬间磁盘仍是旧值', async () => {
  const mem = createMemoryVault();
  const service = createService(
    mem,
    (path, bytes, intent) =>
      new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          mem.port.write(path, bytes, intent).then(resolve, reject);
        }, 40);
      }),
  );
  const pending = service.patch({ ui: { toolPomodoro: true } });
  void pending.catch(() => undefined);

  let diskAtClose: string | undefined = '未取到';
  const outcome = await runCloseFlow({
    flushers: [() => Promise.resolve()],
    shutdown: () => {
      diskAtClose = mem.dump()[SETTINGS];
      return Promise.reject(new Error('teardown failed'));
    },
    log: createLog(),
  });

  assert.deepEqual(outcome, { kind: 'close' });
  assert.equal(diskAtClose, undefined, '旧接线没有等待设置写入，关窗瞬间磁盘没有新值');
  await pending;
  assert.equal(storedToolPomodoro(mem.dump()[SETTINGS]), true, '进程还活着时写入稍后才落盘，这正是丢更新的窗口');
});

void test('场景二（改后接线）：shutdown 抛错前设置已落盘', async () => {
  const mem = createMemoryVault();
  const service = createService(
    mem,
    (path, bytes, intent) =>
      new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          mem.port.write(path, bytes, intent).then(resolve, reject);
        }, 40);
      }),
  );
  const pending = service.patch({ ui: { toolPomodoro: true } });
  void pending.catch(() => undefined);

  let diskAtClose: string | undefined;
  // 与 App.tsx 的 flushers 一致：settings.flush 在阶段一内，先于 docs/canvas/shutdown
  const outcome = await runCloseFlow({
    flushers: [() => service.flush()],
    shutdown: () => {
      diskAtClose = mem.dump()[SETTINGS];
      return Promise.reject(new Error('teardown failed'));
    },
    log: createLog(),
  });

  assert.deepEqual(outcome, { kind: 'close' }, 'shutdown 失败仍放行关闭');
  assert.equal(storedToolPomodoro(diskAtClose), true, '关窗瞬间设置必须已经落盘');
});
