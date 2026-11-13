import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EmberError, errorCodeOf, isPermissionDenied, toErrorText } from '../../src/kernel/errors.ts';

void test('permission_denied 同时识别 IPC 拒绝值与旧文案', () => {
  assert.equal(errorCodeOf({ code: 'permission_denied', message: '无权限访问库文件' }), 'permission_denied');
  assert.equal(isPermissionDenied({ code: 'permission_denied', message: '无权限访问库文件' }), true);
  assert.equal(isPermissionDenied(new EmberError('permission_denied', '无权限访问库文件')), true);
  // 后端尚未重编译时只有 io_failed + OS 文案，仍要识别成权限问题
  assert.equal(isPermissionDenied({ code: 'io_failed', message: 'IO 错误：Permission denied (os error 13)' }), true);
});

void test('普通读取错误不会被误判成权限问题', () => {
  assert.equal(isPermissionDenied({ code: 'io_failed', message: 'IO 错误：No such file or directory' }), false);
  assert.equal(isPermissionDenied(new EmberError('doc_not_found', '文档不存在')), false);
  assert.equal(isPermissionDenied(null), false);
  assert.equal(toErrorText({ code: 'permission_denied', message: '无权限访问库文件' }), 'permission_denied: 无权限访问库文件');
});
