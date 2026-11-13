import assert from 'node:assert/strict';
import test from 'node:test';
import { unsafeVaultPath } from '#doc-model';
import {
  CASCADE_MAX_STEPS,
  CASCADE_STEP_PX,
  cascadeFloatFrame,
  clampFloatSize,
  FLOAT_ZONES,
  initialFloatFrame,
  MIN_FLOAT_SIZE,
  moveFloatFrame,
  resolveFloatResize,
  splitTitleForEllipsis,
  titlePathCandidates,
  type FloatFrame,
} from '../../src/shell/editor/float-layout.ts';

const START: FloatFrame = { left: 100, top: 100, width: 600, height: 400 };
const ROOMY = { maxWidth: 2000, maxHeight: 1400 };

void test('尺寸夹紧：低于下限回到 480×320，高于工作区回到工作区', () => {
  assert.deepEqual(clampFloatSize({ width: 200, height: 120 }, ROOMY), MIN_FLOAT_SIZE);
  assert.deepEqual(clampFloatSize({ width: 9999, height: 9999 }, { maxWidth: 1024, maxHeight: 768 }), {
    width: 1024,
    height: 768,
  });
  assert.deepEqual(clampFloatSize({ width: Number.NaN, height: 500 }, ROOMY), {
    width: MIN_FLOAT_SIZE.width,
    height: 500,
  });
});

void test('对角固定：东南角缩放时左上角不动，西北角缩放时右下角不动', () => {
  assert.deepEqual(resolveFloatResize('se', START, 50, 25, ROOMY), {
    left: 100,
    top: 100,
    width: 650,
    height: 425,
  });
  assert.deepEqual(resolveFloatResize('nw', START, -50, -25, ROOMY), {
    left: 50,
    top: 75,
    width: 650,
    height: 425,
  });
  assert.deepEqual(resolveFloatResize('ne', START, 50, -25, ROOMY), {
    left: 100,
    top: 75,
    width: 650,
    height: 425,
  });
  assert.deepEqual(resolveFloatResize('sw', START, -50, 25, ROOMY), {
    left: 50,
    top: 100,
    width: 650,
    height: 425,
  });
});

void test('缩放只有四角：没有四边手柄', () => {
  assert.deepEqual([...FLOAT_ZONES], ['ne', 'nw', 'se', 'sw']);
  for (const zone of FLOAT_ZONES) assert.equal(zone.length, 2, '每个 zone 都是对角');
});

void test('四角缩放：最小尺寸夹紧后手柄停住，左上角跟着宽高回退', () => {
  assert.deepEqual(resolveFloatResize('nw', START, 500, 500, ROOMY), {
    left: 220,
    top: 180,
    width: 480,
    height: 320,
  });
  assert.deepEqual(resolveFloatResize('sw', START, 500, 0, ROOMY), {
    left: 220,
    top: 100,
    width: 480,
    height: 400,
  });
  assert.deepEqual(resolveFloatResize('se', START, 500, 500, { maxWidth: 700, maxHeight: 500 }), {
    left: 100,
    top: 100,
    width: 700,
    height: 500,
  });
  assert.deepEqual(resolveFloatResize('ne', START, 0, 0, ROOMY), START);
});

void test('拖动浮窗：跟手移动，整块夹在容器内', () => {
  const container = { width: 1200, height: 800 };
  assert.deepEqual(moveFloatFrame(START, 60, 40, container), {
    left: 160,
    top: 140,
    width: 600,
    height: 400,
  });
  // 四边都拖不出去：右下到 (600, 400)，左上到 (0, 0)
  assert.deepEqual(moveFloatFrame(START, 9999, 9999, container), {
    left: 600,
    top: 400,
    width: 600,
    height: 400,
  });
  assert.deepEqual(moveFloatFrame(START, -9999, -9999, container), {
    left: 0,
    top: 0,
    width: 600,
    height: 400,
  });
  // 浮窗比容器还大：横向压到边界，纵向钉住顶边（标题栏永远可见）
  const wide: FloatFrame = { left: 0, top: 0, width: 900, height: 700 };
  assert.deepEqual(moveFloatFrame(wide, -500, -500, { width: 800, height: 600 }), {
    left: -100,
    top: 0,
    width: 900,
    height: 700,
  });
});

void test('顶部留出外壳高度：拖到最顶也停在顶栏下方，比容器高时同样不越界', () => {
  const container = { width: 1200, height: 800, topInset: 60 };
  assert.deepEqual(moveFloatFrame(START, -9999, -9999, container), {
    left: 0,
    top: 60,
    width: 600,
    height: 400,
  });
  // 浮窗比容器还高时钉在留白下沿，标题栏仍可点
  const tall: FloatFrame = { left: 0, top: 60, width: 600, height: 900 };
  assert.deepEqual(moveFloatFrame(tall, 0, -50, container), {
    left: 0,
    top: 60,
    width: 600,
    height: 900,
  });
  // 恢复记忆位置时也按同样下限夹紧
  assert.equal(moveFloatFrame({ ...START, top: 0 }, 0, 0, container).top, 60);
});

void test('向北放大同样受顶部留白约束', () => {
  const frame: FloatFrame = { left: 100, top: 60, width: 600, height: 400 };
  const next = resolveFloatResize('nw', frame, 0, -200, { ...ROOMY, topInset: 60 });
  assert.equal(next.top, 60);
});

void test('首次摆放贴住右下角，尺寸只来自记忆值', () => {
  assert.deepEqual(initialFloatFrame({ width: 1200, height: 800 }, { width: 640, height: 480 }, { right: 24, bottom: 50 }), {
    left: 536,
    top: 270,
    width: 640,
    height: 480,
  });
});

void test('标题中间省略拆分可无损还原，短标题不拆', () => {
  for (const title of ['文章标题过长需要中间省略', 'A', '双字']) {
    const parts = splitTitleForEllipsis(title);
    assert.equal(parts.head + parts.tail, title);
  }
  assert.deepEqual(splitTitleForEllipsis('双字'), { head: '双字', tail: '' });
});

void test('标题改文件名：保留目录与后缀，同名冲突给出 -2 候选', () => {
  const current = unsafeVaultPath('notes/旧标题.md');
  const candidates = titlePathCandidates(current, '新/标题');
  assert.equal(String(candidates[0]), 'notes/新 标题.md');
  assert.equal(String(candidates[1]), 'notes/新 标题-2.md');

  assert.equal(String(titlePathCandidates(current, '旧标题')[0]), 'notes/旧标题.md');
  assert.equal(String(titlePathCandidates(current, '')[0]), 'notes/未命名.md');
});

const CASCADE_CONTAINER = { width: 1200, height: 800 };
const CASCADE_SIZE = { width: 560, height: 420 };
const CASCADE_INSET = { right: 24, bottom: 32 };

void test('默认层叠：右下角起，按槽位向左上偏移固定步长', () => {
  assert.deepEqual(
    cascadeFloatFrame(CASCADE_CONTAINER, CASCADE_SIZE, CASCADE_INSET, 0),
    { left: 616, top: 348, width: 560, height: 420 },
  );
  assert.deepEqual(
    cascadeFloatFrame(CASCADE_CONTAINER, CASCADE_SIZE, CASCADE_INSET, 2),
    {
      left: 616 - CASCADE_STEP_PX * 2,
      top: 348 - CASCADE_STEP_PX * 2,
      width: 560,
      height: 420,
    },
  );
  // 负槽位按 0 处理，避免越界
  assert.deepEqual(
    cascadeFloatFrame(CASCADE_CONTAINER, CASCADE_SIZE, CASCADE_INSET, -3),
    cascadeFloatFrame(CASCADE_CONTAINER, CASCADE_SIZE, CASCADE_INSET, 0),
  );
});

void test('四边夹紧：无论槽位多大，窗口始终落在容器内', () => {
  const container = { width: 800, height: 600 };
  for (const slot of [0, 1, 5, 20]) {
    const frame = cascadeFloatFrame(container, CASCADE_SIZE, { right: 24, bottom: 32 }, slot);
    assert.ok(frame.left >= 0);
    assert.ok(frame.top >= 0);
    assert.ok(frame.left + frame.width <= container.width);
    assert.ok(frame.top + frame.height <= container.height);
  }
});

void test('极小容器：宽高都放不下时钉在左上角，尺寸不被压缩', () => {
  assert.deepEqual(
    cascadeFloatFrame({ width: 300, height: 200 }, CASCADE_SIZE, CASCADE_INSET, 3),
    { left: 0, top: 0, width: 560, height: 420 },
  );
});

void test('与已有窗口完全重合时继续步进，找到空位', () => {
  const first = cascadeFloatFrame(CASCADE_CONTAINER, CASCADE_SIZE, CASCADE_INSET, 0);
  const second = cascadeFloatFrame(CASCADE_CONTAINER, CASCADE_SIZE, CASCADE_INSET, 0, [first]);
  assert.deepEqual(second, {
    left: 616 - CASCADE_STEP_PX,
    top: 348 - CASCADE_STEP_PX,
    width: 560,
    height: 420,
  });
});

void test('步进上限：占满前 5 个候选仍能找到第 6 个空位', () => {
  const occupied = Array.from({ length: CASCADE_MAX_STEPS }, (_, index) =>
    cascadeFloatFrame(CASCADE_CONTAINER, CASCADE_SIZE, CASCADE_INSET, index),
  );
  assert.deepEqual(
    cascadeFloatFrame(CASCADE_CONTAINER, CASCADE_SIZE, CASCADE_INSET, 0, occupied),
    cascadeFloatFrame(CASCADE_CONTAINER, CASCADE_SIZE, CASCADE_INSET, CASCADE_MAX_STEPS),
  );
});

void test('超过 5 次仍冲突时接受重合，返回最后一个候选', () => {
  const occupied = Array.from({ length: CASCADE_MAX_STEPS + 1 }, (_, index) =>
    cascadeFloatFrame(CASCADE_CONTAINER, CASCADE_SIZE, CASCADE_INSET, index),
  );
  const fallback = cascadeFloatFrame(
    CASCADE_CONTAINER,
    CASCADE_SIZE,
    CASCADE_INSET,
    0,
    occupied,
  );
  assert.deepEqual(
    fallback,
    cascadeFloatFrame(CASCADE_CONTAINER, CASCADE_SIZE, CASCADE_INSET, CASCADE_MAX_STEPS),
  );
  assert.ok(occupied.some((frame) => frame.left === fallback.left && frame.top === fallback.top));
});
