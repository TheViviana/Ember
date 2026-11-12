import assert from 'node:assert/strict';
import test from 'node:test';
import { safeFileName } from '#doc-model';

const base = { fallback: '未命名', maxLength: 60 } as const;

void test('safeFileName：控制字符与路径符号统一收敛为空格', () => {
  assert.equal(
    safeFileName('a\u0000b\u001fc\\d/e:f*g?h"i<j>k|l', base),
    'a b c d e f g h i j k l',
  );
  assert.equal(safeFileName('  多   余\t空白  ', base), '多 余 空白');
});

void test('safeFileName：超长标题按字符截断，且不留尾随空格', () => {
  assert.equal(safeFileName('字'.repeat(70), base).length, 60);
  // 第 60 个字符正好是空格：截断后要去掉，避免文件名以空格结尾
  assert.equal(safeFileName(`${'a'.repeat(59)} b`, base), 'a'.repeat(59));
});

void test('safeFileName：空标题回落调用方给的 fallback', () => {
  assert.equal(safeFileName('', base), '未命名');
  assert.equal(safeFileName('   \u0001\t ', base), '未命名');
  assert.equal(safeFileName('...', base), '未命名');
  assert.equal(safeFileName('. . .', base), '未命名');
});

void test('safeFileName：前导点被剥掉，不会生成隐藏文档', () => {
  assert.equal(safeFileName('.隐藏笔记', base), '隐藏笔记');
  assert.equal(safeFileName('..a', base), 'a');
  assert.equal(safeFileName('  . 前导点 ', base), '前导点');
  assert.equal(safeFileName('.a.b', base), 'a.b', '只剥前导点，不碰中间的点');
});
