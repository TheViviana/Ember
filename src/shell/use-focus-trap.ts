import { useEffect, type RefObject } from 'react';

/**
 * 模态对话框的 Tab 边界循环（S3）。
 *
 * 只做一件事：焦点已经在首/尾元素上时，Tab 回到另一端。
 * 不监听 Escape（Esc 全部交给 esc-arbiter 仲裁，本 hook 不注册、不吞、不关窗），
 * 也不用 focusin 回收焦点：设置面板与命令面板/健康检查允许同屏共存，
 * 把焦点拽回对话框会直接破坏这种多窗操作。
 */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  'audio[controls]',
  'video[controls]',
  '[contenteditable="true"]',
].join(',');

const focusableIn = (root: HTMLElement): readonly HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (element) => element.tabIndex >= 0 && element.getClientRects().length > 0,
  );

/**
 * root 挂在 role="dialog" aria-modal="true" 的根节点上；active=false 时完全不介入。
 * 收起时只在原焦点元素仍连在文档上时才还回去，避免把焦点丢进已卸载的节点。
 */
export const useFocusTrap = (root: RefObject<HTMLElement | null>, active = true): void => {
  useEffect(() => {
    if (!active) return undefined;
    const node = root.current;
    if (node === null) return undefined;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return;
      const items = focusableIn(node);
      const first = items[0];
      if (first === undefined) return;
      const last = items[items.length - 1] ?? first;
      const current = document.activeElement;
      if (event.shiftKey) {
        if (current === first || !node.contains(current)) {
          event.preventDefault();
          last.focus();
        }
        return;
      }
      if (current === last || !node.contains(current)) {
        event.preventDefault();
        first.focus();
      }
    };

    node.addEventListener('keydown', onKeyDown);
    return () => {
      node.removeEventListener('keydown', onKeyDown);
      if (previous !== null && previous.isConnected) previous.focus();
    };
  }, [root, active]);
};
