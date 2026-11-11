import assert from 'node:assert/strict';
import test from 'node:test';
import {
  conflictCopyName,
  normalizePath,
  splitPath,
  stem,
  titleFromPath,
} from '../../packages/doc-model/src/path.ts';
import { unsafeVaultPath } from '../../packages/doc-model/src/ids.ts';

void test('路径归一化：折叠分隔符，拒绝越界', () => {
  const ok = normalizePath('notes//a.md');
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.value, 'notes/a.md');

  assert.equal(normalizePath('/etc/passwd').ok, false);
  assert.equal(normalizePath('../outside.md').ok, false);
  assert.equal(normalizePath('notes/../../x.md').ok, false);
  assert.equal(normalizePath('notes/').ok, false);
  assert.equal(normalizePath('').ok, false);
});

void test('冲突副本命名符合 vault-format §10.3', () => {
  const name = conflictCopyName(
    unsafeVaultPath('notes/方案.md'),
    new Date('2026-11-11T10:32:05.123Z'),
    '01JB7F3K',
  );
  assert.equal(name, 'notes/方案 (conflict 20261111T103205Z-01JB).md');
});

void test('冲突后缀不污染标题', () => {
  const path = unsafeVaultPath('notes/方案 (conflict 20261111T103205Z-01JB).md');
  assert.equal(stem(path), '方案');
  assert.equal(titleFromPath(path), '方案');
  assert.equal(splitPath(path).ext, '.md');
});

void test('冲突名对同一秒不同 uid 不碰撞', () => {
  const at = new Date('2026-11-11T10:32:05Z');
  const left = conflictCopyName(unsafeVaultPath('a.md'), at, 'AAAA');
  const right = conflictCopyName(unsafeVaultPath('a.md'), at, 'BBBB');
  assert.notEqual(left, right);
});
