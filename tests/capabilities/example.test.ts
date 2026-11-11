import assert from 'node:assert/strict';
import test from 'node:test';
import { asVaultId, asCommandId, asCapabilityId } from '#doc-model';
import { CAPABILITIES } from '../../src/capabilities/index.ts';
import { bootKernel } from '../../src/kernel/boot.ts';
import type { Logger } from '../../src/kernel/types.ts';
import { createMemoryIndex, createMemoryVault } from '../kernel/fakes.ts';

const VAULT_ID = asVaultId('01JB8ZQ3K4M5N6P7Q8R9S0T1V2');
const HELLO = asCommandId('example.hello.greet');
const CORE = asCapabilityId('ember.core');
const EXAMPLE = asCapabilityId('ember.example.hello');
assert.ok(VAULT_ID !== null && HELLO !== null && CORE !== null && EXAMPLE !== null);

const silentLogger: Logger = {
  debug: (): void => {},
  info: (): void => {},
  warn: (): void => {},
  error: (): void => {},
};

void test('装配表里的能力全部激活，示例命令可执行', async () => {
  const vault = createMemoryVault();
  const kernel = await bootKernel({
    vaultId: VAULT_ID,
    ports: { vault: vault.port, index: createMemoryIndex().port },
    capabilities: CAPABILITIES,
    log: silentLogger,
  });

  const states = kernel.context.capabilities.list();
  assert.deepEqual(
    states.map((state) => `${String(state.id)}:${String(state.active)}`),
    ['ember.core:true', 'ember.example.hello:true'],
  );

  const result = await kernel.context.commands.execute(HELLO);
  assert.equal(result.ok, true);
  assert.equal(result.error, null);

  await kernel.shutdown();
  assert.equal(kernel.context.capabilities.isActive(EXAMPLE), false);
});

void test('示例能力只通过 KernelContext 注册，命令 owner 归属自身', async () => {
  const vault = createMemoryVault();
  const kernel = await bootKernel({
    vaultId: VAULT_ID,
    ports: { vault: vault.port, index: createMemoryIndex().port },
    capabilities: CAPABILITIES,
    log: silentLogger,
  });

  const owned = kernel.context.commands.list().filter((descriptor) => descriptor.owner === EXAMPLE);
  assert.deepEqual(owned.map((descriptor) => String(descriptor.id)), ['example.hello.greet']);

  await kernel.shutdown();
});
