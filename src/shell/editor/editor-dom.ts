import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { saveAsset } from '../../data/tauri/asset-port.ts';
import { toErrorText } from '../../kernel/errors.ts';
import type { Notice } from './float-editor-model.ts';
import { findWikiLinkAt, isInsideCode } from './wiki-link.ts';
import type { WikiLink } from '#doc-model';

export interface EditorDomHandlersOptions {
  /** 双链点击：交给浮窗链接解析（直接打开或列候选） */
  readonly onWikiClick: (link: WikiLink | null) => void;
  /** 右键优先给选区菜单：先收起菜单 */
  readonly clearSelectionMenu: () => void;
  readonly setBanner: (notice: Notice | null) => void;
  readonly isDisposed: () => boolean;
}

/**
 * 编辑器 DOM 事件：双链点击跳转、图片粘贴入库、右键让位给选区菜单。
 * 抽成扩展工厂，让 use-float-document 专注会话状态；这里只做事件层。
 */
export const editorDomHandlers = (options: EditorDomHandlersOptions): Extension =>
  EditorView.domEventHandlers({
    paste: (event, editor) => {
      // 截图 / 复制的图片直接入库：内容去重后插入 media/ 相对路径的嵌入语法
      const clipboard = event.clipboardData;
      if (clipboard === null) return false;
      const files = Array.from(clipboard.files).filter((file) => file.type.startsWith('image/'));
      if (files.length === 0) return false;
      if (isInsideCode(editor.state, editor.state.selection.main.head)) return false;
      event.preventDefault();
      void (async () => {
        const inserted: string[] = [];
        for (const file of files) {
          try {
            const dataUrl = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
              reader.onerror = () => reject(new Error('读取剪贴板图片失败'));
              reader.readAsDataURL(file);
            });
            const marker = 'base64,';
            const markerAt = dataUrl.indexOf(marker);
            if (markerAt < 0) throw new Error('不是可用的 data URL');
            const saved = await saveAsset(dataUrl.slice(markerAt + marker.length), file.type);
            const alt = file.name.replace(/\.[^.]*$/, '').replace(/]/g, '') || '图片';
            inserted.push(`![${alt}](${saved.path})`);
          } catch (error) {
            if (!options.isDisposed()) {
              options.setBanner({ tone: 'alert', text: `图片入库失败：${toErrorText(error)}` });
            }
          }
        }
        if (inserted.length === 0 || options.isDisposed()) return;
        const main = editor.state.selection.main;
        editor.dispatch({
          changes: { from: main.from, to: main.to, insert: inserted.join('\n') },
          selection: { anchor: main.from + inserted.join('\n').length },
          userEvent: 'input.paste',
        });
      })();
      return true;
    },
    click: (event, editor) => {
      const element = event.target;
      if (!(element instanceof Element) || element.closest('.ember-wikilink') === null) {
        return false;
      }
      const pos = editor.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return false;
      const link = findWikiLinkAt(editor.state.doc, pos);
      if (link === null) return false;
      // 代码块与行内代码里的 [[...]] 继续不参与跳转
      if (isInsideCode(editor.state, pos)) return false;
      event.preventDefault();
      options.onWikiClick(link);
      return true;
    },
    contextmenu: () => {
      // 右键菜单优先：选区菜单先收起，不与它抢位置
      options.clearSelectionMenu();
      return false;
    },
  });
