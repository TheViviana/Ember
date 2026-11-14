/**
 * 只读原因 → 状态栏/顶栏文案。
 * 原因值来自 Rust `ReadonlyReason` 的 camelCase 序列化（收敛为两态：被占用 / 丢失）；
 * 未知或缺失时回退到通用文案。
 */
export const readonlyText = (reason: string | null): string => {
  switch (reason) {
    case 'lockedByOther':
      return '只读：另一实例已打开';
    case 'lockLost':
      return '只读：库锁已丢失';
    case 'vaultGuard':
      return '只读：库可能被整体替换或移走';
    default:
      return '只读模式';
  }
};
