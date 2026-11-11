import { useEffect } from 'react';

/**
 * Esc 键统一仲裁（shell 审查 M1）：多个浮层各自挂 window keydown 时，stopPropagation
 * 挡不住同一节点上的并列监听器，一次 Esc 会穿透多层（如同时关掉设置面板与专注模式）。
 *
 * 约定：
 * - 浮层打开（挂载/激活）时经 useEscLayer 入栈，关闭（卸载/失活）时出栈；
 * - handler 先用 isEscTop 确认自己是栈顶，不是则直接返回，不消费也不阻止；
 * - 捕获阶段消费 Esc 的 AI 浮层（选区菜单/内联结果）同样入栈：应用级模态
 *   （设置/命令面板）覆盖其上时按栈序优先响应。
 * - 画布手势取消不是浮层，不参与栈（拖拽中的 Esc 必须始终生效）。
 */
const stack: string[] = [];

export const escLayerPush = (id: string): void => {
  const index = stack.indexOf(id);
  if (index >= 0) stack.splice(index, 1);
  stack.push(id);
};

export const escLayerRemove = (id: string): void => {
  const index = stack.indexOf(id);
  if (index >= 0) stack.splice(index, 1);
};

/** 只有栈顶浮层响应 Esc；栈为空时恒为 false */
export const isEscTop = (id: string): boolean => stack[stack.length - 1] === id;

/** 浮层激活期间持有 Esc 栈顶资格；active 翻转（面板切换/关闭）时重新入栈到顶 */
export const useEscLayer = (id: string, active: boolean): void => {
  useEffect(() => {
    if (!active) return undefined;
    escLayerPush(id);
    return () => {
      escLayerRemove(id);
    };
  }, [id, active]);
};
