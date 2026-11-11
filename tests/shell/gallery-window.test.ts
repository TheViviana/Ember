import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clampGalleryFrame,
  defaultGalleryFrame,
  GALLERY_BOTTOM_RESERVE,
  GALLERY_DEFAULT_HEIGHT,
  GALLERY_DEFAULT_WIDTH,
  GALLERY_MARGIN,
  GALLERY_MIN_HEIGHT,
  GALLERY_MIN_WIDTH,
  GALLERY_TOP_RESERVE,
  galleryBounds,
  galleryFrameFromMemory,
} from '../../src/shell/tools/gallery-window.ts';

void test('图库浮窗：默认停靠安全区右下，避开顶栏与底部结构件', () => {
  const frame = defaultGalleryFrame({ width: 1440, height: 900 });
  assert.deepEqual(frame, {
    left: 1440 - GALLERY_DEFAULT_WIDTH - GALLERY_MARGIN,
    top: 900 - GALLERY_BOTTOM_RESERVE - GALLERY_DEFAULT_HEIGHT,
    width: GALLERY_DEFAULT_WIDTH,
    height: GALLERY_DEFAULT_HEIGHT,
  });
  assert.equal(frame.top + frame.height, 900 - GALLERY_BOTTOM_RESERVE);
});

void test('图库浮窗：越界位置与尺寸被夹回四边之内', () => {
  const frame = clampGalleryFrame({ left: -200, top: -100, width: 9999, height: 9999 }, { width: 1280, height: 800 });
  assert.equal(frame.left, GALLERY_MARGIN);
  assert.equal(frame.top, GALLERY_TOP_RESERVE);
  assert.equal(frame.width, 1280 - GALLERY_MARGIN * 2);
  assert.equal(frame.height, 800 - GALLERY_TOP_RESERVE - GALLERY_BOTTOM_RESERVE);

  const bottomRight = clampGalleryFrame({ left: 5000, top: 5000, width: 400, height: 300 }, { width: 1280, height: 800 });
  assert.equal(bottomRight.left, 1280 - 400 - GALLERY_MARGIN);
  assert.equal(bottomRight.top, 800 - GALLERY_BOTTOM_RESERVE - 300);
});

void test('图库浮窗：窗口过小时优先让出结构件，最小尺寸随安全区收缩', () => {
  const viewport = { width: 500, height: 400 };
  const bounds = galleryBounds(viewport);
  assert.equal(bounds.maxWidth, viewport.width - GALLERY_MARGIN * 2);
  assert.equal(bounds.maxHeight, viewport.height - GALLERY_TOP_RESERVE - GALLERY_BOTTOM_RESERVE);
  assert.ok((bounds.minWidth ?? 0) <= GALLERY_MIN_WIDTH);
  assert.ok((bounds.minHeight ?? 0) <= GALLERY_MIN_HEIGHT);

  const frame = clampGalleryFrame({ left: 0, top: 0, width: 900, height: 900 }, viewport);
  assert.ok(frame.width <= bounds.maxWidth);
  assert.ok(frame.height <= bounds.maxHeight);
  assert.ok(frame.left >= GALLERY_MARGIN);
  assert.ok(frame.top >= GALLERY_TOP_RESERVE);
  assert.ok(frame.top + frame.height <= viewport.height - GALLERY_BOTTOM_RESERVE);
});

void test('图库浮窗：记忆里的位置尺寸缺失或越界时回落到安全值', () => {
  const viewport = { width: 1280, height: 800 };
  const fresh = galleryFrameFromMemory(undefined, undefined, viewport);
  assert.deepEqual(fresh, defaultGalleryFrame(viewport));

  const partial = galleryFrameFromMemory({ left: 100, top: 100 }, undefined, viewport);
  assert.equal(partial.left, 100);
  assert.equal(partial.top, 100);
  assert.equal(partial.width, GALLERY_DEFAULT_WIDTH);

  const stale = galleryFrameFromMemory({ left: 9000, top: 9000 }, { width: 100, height: 90 }, viewport);
  assert.ok(stale.left + stale.width <= viewport.width - GALLERY_MARGIN);
  assert.ok(stale.top + stale.height <= viewport.height - GALLERY_BOTTOM_RESERVE);
  assert.ok(stale.width >= GALLERY_MIN_WIDTH);
});
