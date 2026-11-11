/** 编辑器光标位置（1 基行号 / 列号），状态栏与浮窗共用 */
export interface CursorPosition {
  readonly line: number;
  readonly column: number;
}
