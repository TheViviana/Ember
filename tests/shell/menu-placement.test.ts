import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MENU_EDGE_INSET,
  SUBMENU_OVERLAP,
  placeSubmenu,
  type SubmenuPlacementInput,
} from '../../src/shell/canvas/menu-placement.ts';

const CONTAINER = { width: 1000, height: 800 };

const place = (input: Partial<SubmenuPlacementInput> & Pick<SubmenuPlacementInput, 'level' | 'anchor'>) =>
  placeSubmenu({
    container: CONTAINER,
    submenu: { width: 220, height: 260 },
    ...input,
  });

void test('四角：右下与左下向左翻，右上与左上向右展开', () => {
  const topLeft = place({
    level: { left: 100, top: 80, width: 220, height: 320 },
    anchor: { top: 100, bottom: 130 },
  });
  assert.equal(topLeft.side, 'right');
  assert.deepEqual([topLeft.left, topLeft.top], [316, 96]);
  assert.equal(topLeft.relativeTop, 16, '贴住鼠标所在项');
  assert.equal(topLeft.horizontalOffset, 220 - SUBMENU_OVERLAP);

  const bottomLeft = place({
    level: { left: 100, top: 400, width: 220, height: 380 },
    anchor: { top: 700, bottom: 730 },
  });
  assert.equal(bottomLeft.side, 'right');
  assert.deepEqual([bottomLeft.left, bottomLeft.top], [316, 474], '下缘不够时整体上移');

  const topRight = place({
    level: { left: 680, top: 80, width: 220, height: 320 },
    anchor: { top: 100, bottom: 130 },
  });
  assert.equal(topRight.side, 'left');
  assert.equal(topRight.left, 464, '右缘不够时向左翻');

  const bottomRight = place({
    level: { left: 680, top: 400, width: 220, height: 380 },
    anchor: { top: 700, bottom: 730 },
  });
  assert.equal(bottomRight.side, 'left');
  assert.deepEqual([bottomRight.left, bottomRight.top], [464, 474]);
});

void test('四边：上缘夹紧、下缘上移、左缘向右、右缘向左', () => {
  const topEdge = place({
    level: { left: 100, top: 8, width: 220, height: 100 },
    anchor: { top: 2, bottom: 22 },
  });
  assert.equal(topEdge.top, MENU_EDGE_INSET, '上缘不得越过留白');

  const bottomEdge = place({
    level: { left: 100, top: 500, width: 220, height: 280 },
    anchor: { top: 780, bottom: 790 },
  });
  assert.equal(bottomEdge.top, 532, '下缘贴住容器内缘');

  const leftEdge = place({
    level: { left: 8, top: 80, width: 220, height: 320 },
    anchor: { top: 100, bottom: 130 },
  });
  assert.equal(leftEdge.side, 'right', '左侧没有空间时仍向右展开');

  const rightEdge = place({
    level: { left: 760, top: 80, width: 220, height: 320 },
    anchor: { top: 100, bottom: 130 },
  });
  assert.equal(rightEdge.side, 'left');
  assert.equal(rightEdge.left, 544);
});

void test('高度夹紧：超高子菜单不越出容器，顶部回到留白处', () => {
  const tall = place({
    level: { left: 100, top: 80, width: 220, height: 320 },
    anchor: { top: 100, bottom: 130 },
    submenu: { width: 220, height: 2000 },
  });
  assert.equal(tall.maxHeight, CONTAINER.height - MENU_EDGE_INSET * 2);
  assert.equal(tall.top, MENU_EDGE_INSET);
  assert.equal(tall.top + tall.maxHeight, CONTAINER.height - MENU_EDGE_INSET, '底边仍在容器内');
});

void test('极窄容器：左右都放不下时优先向右，并水平夹紧', () => {
  const narrow = placeSubmenu({
    container: { width: 240, height: 300 },
    level: { left: 8, top: 40, width: 220, height: 200 },
    anchor: { top: 100, bottom: 130 },
    submenu: { width: 220, height: 200 },
  });
  assert.equal(narrow.side, 'right');
  assert.equal(narrow.left, 12);
  assert.equal(narrow.top, MENU_EDGE_INSET);
});

void test('多级递归：以父层而不是根层为参照，参数一致时结果只随父层移动', () => {
  const rootLevel = { left: 100, top: 80, width: 220, height: 320 };
  const childLevel = { left: 316, top: 96, width: 220, height: 260 };
  const anchor = { top: 300, bottom: 330 };

  const fromRoot = place({ level: rootLevel, anchor });
  const fromChild = place({ level: childLevel, anchor });
  assert.equal(fromRoot.side, 'right');
  assert.equal(fromChild.side, 'right');
  assert.equal(
    fromChild.horizontalOffset,
    childLevel.width - SUBMENU_OVERLAP,
    '每层都以自身宽度计算重叠',
  );
  assert.equal(fromChild.top, fromRoot.top, '同一绝对锚点得到同一绝对位置');
  assert.equal(
    fromChild.relativeTop,
    fromRoot.relativeTop - (childLevel.top - rootLevel.top),
    '相对偏移以各自父层为参照',
  );
});
