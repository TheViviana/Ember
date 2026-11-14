import assert from 'node:assert/strict';
import test from 'node:test';
import { unsafeVaultPath } from '#doc-model';
import { EmberError } from '../../src/kernel/errors.ts';
import { createFolderService, validateFolderName } from '../../src/kernel/folder-service.ts';
import { createPathTools } from '../../src/kernel/paths.ts';
import { createMemoryVault, type MemoryVaultOptions } from './fakes.ts';

const setup = (options: MemoryVaultOptions = {}) => {
  const vault = createMemoryVault(options);
  const folders = createFolderService({ port: vault.port, paths: createPathTools() });
  return { vault, folders };
};

const isErrorCode = (code: string) => (error: unknown): boolean =>
  error instanceof EmberError && error.code === code;

void test('validateFolderName：拒绝空名、斜杠、控制字符、. / .. 与隐藏目录', () => {
  for (const [name, pattern] of [
    ['', /不能为空/],
    ['   ', /不能为空/],
    [' 前后空格 ', /首尾不能有空白/],
    ['a/b', /不能包含斜杠/],
    ['a\\b', /不能包含斜杠/],
    ['a\u0000b', /非法字符/],
    ['a\u0007b', /非法字符/],
    ['.', /不能是 \. 或 \.\./],
    ['..', /不能是 \. 或 \.\./],
    ['.workbench', /不能以点开头/],
    ['.hidden', /不能以点开头/],
    ['media', /保留目录/],
    ['MEDIA', /保留目录/],
  ] as const) {
    assert.throws(() => validateFolderName(name), pattern, `应拒绝：${JSON.stringify(name)}`);
  }
  assert.equal(validateFolderName('notes'), 'notes');
  assert.equal(validateFolderName('2-方案'), '2-方案');
});

void test('FolderService.create：库根与子目录都能建，空目录立即可列举', async () => {
  const { vault, folders } = setup();
  assert.equal(String(await folders.create('', 'notes')), 'notes');
  assert.equal(String(await folders.create('notes', 'deep')), 'notes/deep');
  assert.deepEqual(
    (await folders.list()).map((path) => String(path)),
    ['notes', 'notes/deep'],
  );
  assert.deepEqual(
    (await vault.port.listDirs()).map((path) => String(path)),
    ['notes', 'notes/deep'],
  );
});

void test('FolderService.create：同名目录 / 同名文件 / 父目录缺失分别报错', async () => {
  const { folders } = setup({ files: { 'notes.md': 'x' }, dirs: ['notes'] });
  await assert.rejects(folders.create('', 'notes'), isErrorCode('path_exists'));
  await assert.rejects(folders.create('', 'notes.md'), isErrorCode('path_exists'));
  await assert.rejects(folders.create('missing', 'child'), isErrorCode('doc_not_found'));
});

void test('FolderService.create：只读库拒绝写入', async () => {
  const { folders } = setup({ readonlyMode: true });
  await assert.rejects(folders.create('', 'notes'), isErrorCode('vault_locked'));
});

void test('FolderService.remove：不存在报错，空目录调用 trashDir 后从清单消失', async () => {
  const { vault, folders } = setup({ dirs: ['notes', 'notes/deep'] });
  await assert.rejects(
    folders.remove(unsafeVaultPath('missing')),
    isErrorCode('doc_not_found'),
  );
  await folders.remove(unsafeVaultPath('notes/deep'));
  assert.deepEqual(
    (await vault.port.listDirs()).map((path) => String(path)),
    ['notes'],
  );
});

void test('FolderService.remove：非空目录被端口拒绝（后端同样拦截）', async () => {
  const { folders } = setup({ files: { 'notes/a.md': 'x' } });
  await assert.rejects(folders.remove(unsafeVaultPath('notes')), /not empty/);
});
