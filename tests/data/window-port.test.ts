import assert from 'node:assert/strict';
import test from 'node:test';
import { createTauriWindowPort } from '../../src/data/tauri/window-port.ts';

// 浏览器 dev / node 测试环境下没有 Tauri 运行时：端口应整体退化为 no-op
void test('非 Tauri 环境下窗口端口为 no-op，native 为 false', async () => {
  const port = createTauriWindowPort();
  assert.equal(port.native, false);

  await port.close();
  await port.minimize();
  await port.toggleZoom();
  assert.equal(await port.readFrame(), null);
  await port.applyFrame({ x: 0, y: 0, width: 960, height: 640 });

  const unlisten = await port.onCloseRequested(() => Promise.resolve());
  assert.equal(typeof unlisten, 'function');
  unlisten();
});
