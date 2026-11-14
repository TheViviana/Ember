import assert from 'node:assert/strict';
import test from 'node:test';
import { DOC_MENU_INSET, placeDocMenu, type DocMenuAnchor } from '../../src/shell/documents/doc-menu-placement.ts';

const VIEWPORT = { width: 1280, height: 820 };

const row = (left: number, top: number, width = 260): DocMenuAnchor => ({
  left,
  top,
  bottom: top + 30,
  width,
});

void test('常规行：顶边与左边对齐被右键的条目，宽度继承条目', () => {
  const placed = placeDocMenu(row(24, 200), 212, VIEWPORT);
  assert.deepEqual(placed, { left: 24, top: 200, width: 260 });
});

void test('下缘放不下：整体上移，底边对齐条目底边', () => {
  const anchor = row(24, 780);
  const placed = placeDocMenu(anchor, 212, VIEWPORT);
  assert.equal(placed.top, anchor.bottom - 212, '向上翻，底边贴住条目');
  assert.ok(placed.top + 212 <= VIEWPORT.height - DOC_MENU_INSET);
});

void test('下缘附近但没有翻的余量：底边对齐条目后仍夹在视口内', () => {
  const anchor = row(24, 700);
  const placed = placeDocMenu(anchor, 400, VIEWPORT);
  assert.equal(placed.top, anchor.bottom - 400);
  assert.ok(placed.top + 400 <= VIEWPORT.height - DOC_MENU_INSET);
  assert.ok(placed.top >= DOC_MENU_INSET);
});

void test('左缘：左移出视口时夹到留白处', () => {
  const placed = placeDocMenu(row(-40, 200, 260), 212, VIEWPORT);
  assert.equal(placed.left, DOC_MENU_INSET);
});

void test('右缘：条目太靠右时整体左移，右缘留在视口内', () => {
  const placed = placeDocMenu(row(1100, 200, 260), 212, VIEWPORT);
  assert.equal(placed.left + placed.width, VIEWPORT.width - DOC_MENU_INSET);
});

void test('视口比条目窄：宽度收缩到视口内，左边贴留白', () => {
  const placed = placeDocMenu(row(12, 100, 400), 212, { width: 240, height: 600 });
  assert.equal(placed.width, 240 - DOC_MENU_INSET * 2);
  assert.equal(placed.left, DOC_MENU_INSET);
});

void test('菜单比视口还高：顶边落在留白处，由 CSS 滚动接管溢出', () => {
  const placed = placeDocMenu(row(24, 400), 2000, { width: 1280, height: 600 });
  assert.equal(placed.top, DOC_MENU_INSET);
});

void test('滚动后的行：锚点已是视口坐标，直接跟随，不再叠面板偏移', () => {
  const scrolled = row(24, 12);
  assert.equal(placeDocMenu(scrolled, 212, VIEWPORT).top, 12);
});
