/**
 * 只读原因 → 状态栏/顶栏文案。
 * 原因值来自 Rust `ReadonlyReason` 的 camelCase 序列化；未知或缺失时回退到通用文案。
 */
export const readonlyText = (reason: string | null): string => {
  switch (reason) {
    case 'lockedByOther':
      return '只读：另一实例已打开';
    case 'lockedByStalled':
      return '只读：另一实例无响应，请关闭后重试';
    case 'claimFailed':
      return '只读：抢锁失败，请重试';
    case 'lockLost':
      return '只读：库锁已丢失';
    case 'journalCorrupt':
      return '只读：journal 损坏，已保留现场，需人工处理';
    default:
      return '只读模式';
  }
};
