import type { ReactElement } from 'react';
import { useWindowPort } from '../kernel-provider.tsx';
import styles from './WindowControls.module.css';

/**
 * 无边框窗口的自绘交通灯。
 * 按钮是可点击元素，Tauri 的 data-tauri-drag-region 会自动跳过它们，不会误触发拖拽。
 */
export const WindowControls = (): ReactElement | null => {
  const windowPort = useWindowPort();
  if (!windowPort.native) return null;

  return (
    <div className={styles.controls}>
      <button
        type="button"
        className={`${styles.light} ${styles.close}`}
        title="关闭"
        aria-label="关闭窗口"
        onClick={() => {
          void windowPort.close();
        }}
      />
      <button
        type="button"
        className={`${styles.light} ${styles.minimize}`}
        title="最小化"
        aria-label="最小化窗口"
        onClick={() => {
          void windowPort.minimize();
        }}
      />
      <button
        type="button"
        className={`${styles.light} ${styles.zoom}`}
        title="缩放"
        aria-label="缩放窗口"
        onClick={() => {
          void windowPort.toggleZoom();
        }}
      />
    </div>
  );
};
