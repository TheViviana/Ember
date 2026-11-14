import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_AI,
  DEFAULT_AI_PANEL,
  DEFAULT_POMODORO,
  DEFAULT_TRANSLATION_CHANNEL,
  DOC_TREE_EXPANDED_LIMIT,
  normalizeTreeExpanded,
  parseMachineUi,
  serializeMachineUi,
} from '../../src/data/stores/machine-store.ts';

void test('normalizeTreeExpanded：丢弃非字符串 / 空串 / 重复项', () => {
  assert.deepEqual(normalizeTreeExpanded(['notes', 'notes', '', 3, null, 'notes/sub']), ['notes', 'notes/sub']);
  assert.deepEqual(normalizeTreeExpanded('not-an-array'), []);
});

void test('normalizeTreeExpanded：单个库最多保留 500 条', () => {
  const many = Array.from({ length: DOC_TREE_EXPANDED_LIMIT + 25 }, (_, index) => `dir-${index}`);
  assert.equal(normalizeTreeExpanded(many).length, DOC_TREE_EXPANDED_LIMIT);
});

void test('docTreeExpanded 按 vaultId 分桶并可完整往返', () => {
  const text = serializeMachineUi(
    {},
    {},
    DEFAULT_POMODORO,
    DEFAULT_AI,
    DEFAULT_AI_PANEL,
    {},
    DEFAULT_TRANSLATION_CHANNEL,
    { '01VAULT_A': ['notes', 'notes/sub'], '01VAULT_B': [] },
  );
  const parsed = parseMachineUi(text);
  assert.notEqual(parsed, null);
  assert.deepEqual(parsed?.docTreeExpanded, { '01VAULT_A': ['notes', 'notes/sub'] });
});

void test('旧 ui.json 缺 docTreeExpanded 时按空表读入', () => {
  const parsed = parseMachineUi(JSON.stringify({ schemaVersion: 1 }));
  assert.notEqual(parsed, null);
  assert.deepEqual(parsed?.docTreeExpanded, {});
});
