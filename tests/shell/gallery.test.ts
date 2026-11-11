import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildFilters,
  buildUsages,
  displayName,
  filterGallery,
  formatBytes,
  galleryItems,
  parseImageRefs,
  type GalleryAsset,
  type GalleryDoc,
} from '../../src/shell/tools/gallery.ts';

const asset = (hash: string, ext = 'png'): GalleryAsset => ({
  path: `media/${hash.slice(0, 2)}/${hash}.${ext}`,
  name: `${hash}.${ext}`,
  hash,
  mime: ext === 'png' ? 'image/png' : 'image/jpeg',
  bytes: 2048,
});

const doc = (id: string, path: string, text: string, title = `文档 ${id}`): GalleryDoc => ({
  id,
  path,
  title,
  text,
});

void test('引用扫描：wikilink 嵌入与 markdown 图片都认，保持顺序并去重', () => {
  const text = [
    '![[abc.png]]',
    '![封面](media/ab/abc.png)',
    '![[abc.png|300]]',
    '![带标题](<media/ab/def.jpeg> "截图")',
  ].join('\n');
  assert.deepEqual(parseImageRefs(text), ['abc.png', 'media/ab/abc.png', 'media/ab/def.jpeg']);
});

void test('引用扫描：代码块、行内代码、外链与 svg 一律忽略', () => {
  const text = [
    '```md',
    '![[code.png]]',
    '```',
    '`![[inline.png]]`',
    '![remote](https://example.com/a.png)',
    '![data](data:image/png;base64,xxx)',
    '![vector](icons/a.svg)',
    '![no-ext](media/ab/plain)',
  ].join('\n');
  assert.deepEqual(parseImageRefs(text), []);
});

void test('引用扫描：查询串与锚点被剥离，百分号编码会解码', () => {
  assert.deepEqual(parseImageRefs('![x](media/ab/a%20b.png?raw=1#p1)'), ['media/ab/a b.png']);
});

void test('引用关系：完整路径与文件名两种写法都命中，同一文档只记一次', () => {
  const image = asset('a'.repeat(64));
  const docs = [
    doc('1', 'notes/one.md', `![[${image.name}]]\n![[${image.name}]]`),
    doc('2', 'notes/two.md', `![x](${image.path})`),
    doc('3', 'root.md', '没有引用'),
  ];
  const usages = buildUsages([image], docs);
  assert.deepEqual(
    usages.get(image.path)?.map((item) => item.id),
    ['1', '2'],
  );
});

void test('引用关系：同一张图被多目录引用时，两个顶层目录各自计数', () => {
  const image = asset('b'.repeat(64));
  const docs = [
    doc('1', 'notes/one.md', `![[${image.name}]]`),
    doc('2', 'journal/two.md', `![[${image.name}]]`),
    doc('3', 'notes/three.md', `![[${image.name}]]`),
  ];
  const items = galleryItems([image], docs);
  assert.deepEqual(
    buildFilters(items).map((option) => [option.value, option.count]),
    [
      ['all', 1],
      ['dir:journal', 1],
      ['dir:notes', 1],
    ],
  );
});

void test('筛选选项：全部在最前、目录按字典序、未引用垫底', () => {
  const used = asset('c'.repeat(64));
  const orphan = asset('d'.repeat(64), 'jpeg');
  const docs = [doc('1', 'notes/one.md', `![[${used.name}]]`), doc('2', 'root.md', `![[${used.name}]]`)];
  const options = buildFilters(galleryItems([used, orphan], docs));
  assert.deepEqual(
    options.map((option) => [option.value, option.label, option.count]),
    [
      ['all', '全部', 2],
      ['dir:', '根目录', 1],
      ['dir:notes', 'notes', 1],
      ['unused', '未引用', 1],
    ],
  );
});

void test('筛选：未引用只留孤儿图，目录筛选按引用文档的顶层目录', () => {
  const inNotes = asset('e'.repeat(64));
  const orphan = asset('f'.repeat(64), 'jpeg');
  const docs = [doc('1', 'notes/one.md', `![[${inNotes.name}]]`)];
  const items = galleryItems([inNotes, orphan], docs);

  assert.deepEqual(
    filterGallery(items, 'unused', '').map((item) => item.asset.path),
    [orphan.path],
  );
  assert.deepEqual(
    filterGallery(items, 'dir:notes', '').map((item) => item.asset.path),
    [inNotes.path],
  );
  assert.deepEqual(filterGallery(items, 'dir:journal', ''), []);
});

void test('搜索：命中文件名，或命中引用文档的标题与路径', () => {
  const image = asset('1'.repeat(64));
  const docs = [doc('1', 'notes/产品/路线图.md', `![[${image.name}]]`, '季度路线图')];
  const items = galleryItems([image], docs);

  assert.equal(filterGallery(items, 'all', image.name.slice(0, 12)).length, 1);
  assert.equal(filterGallery(items, 'all', '路线图').length, 1);
  assert.equal(filterGallery(items, 'all', 'notes/产品').length, 1);
  assert.equal(filterGallery(items, 'all', '不存在').length, 0);
});

void test('展示格式：hash 文件名截断、字节单位换算', () => {
  assert.equal(displayName(`${'a'.repeat(64)}.png`), 'aaaaaaaa….png');
  assert.equal(displayName('short.png'), 'short.png');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB');
});
