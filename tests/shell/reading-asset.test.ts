import assert from 'node:assert/strict';
import test from 'node:test';
import { localAssetPath } from '../../src/shell/editor/reading-asset.ts';

void test('本地资产路径：只放行 media/ 下的相对路径', () => {
  assert.equal(localAssetPath('media/a.png'), 'media/a.png');
  assert.equal(localAssetPath('./media/a.png'), 'media/a.png');
  assert.equal(localAssetPath('/media/sub/a.png'), 'media/sub/a.png');
  assert.equal(localAssetPath('  media/a.png  '), 'media/a.png');
});

void test('外链 / 协议相对 / 目录穿越一律拒绝', () => {
  assert.equal(localAssetPath(''), null);
  assert.equal(localAssetPath('https://example.com/a.png'), null);
  assert.equal(localAssetPath('HTTP://example.com/a.png'), null);
  assert.equal(localAssetPath('data:image/png;base64,xxx'), null);
  assert.equal(localAssetPath('blob:http://localhost/x'), null);
  assert.equal(localAssetPath('//cdn.example.com/a.png'), null);
  assert.equal(localAssetPath('media/../secret.png'), null);
  assert.equal(localAssetPath('media/./a.png'), null);
  assert.equal(localAssetPath('other/a.png'), null);
  assert.equal(localAssetPath('media/'), null);
});
