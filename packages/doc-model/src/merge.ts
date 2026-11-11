/**
 * diff3 三方合并（vault-format §10.2）。
 * 以行为单位计算 base→local 与 base→disk 的变更块；重叠块产生冲突标记。
 * 只做纯计算，不落盘；冲突副本由 doc-service 负责创建。
 */
export interface ConflictLabels {
  readonly local: string;
  readonly disk: string;
}

export type MergeResult =
  | { readonly kind: 'clean'; readonly lines: readonly string[] }
  | { readonly kind: 'conflict'; readonly lines: readonly string[]; readonly conflicts: number }
  | { readonly kind: 'too_large' };

interface Hunk {
  readonly start: number;
  readonly end: number;
  readonly lines: readonly string[];
  readonly side: 'local' | 'disk';
}

/**
 * 单侧 diff 的复杂度上限：超过即拒绝合并（too_large），交给人工处理。
 * DP 表为 Uint32Array（4 字节/格）：8M 格 ≈ 32MB，local/disk 各算一次，峰值 64MB——
 * 这是「界面上卡死」与「普通长文（~2800 行 × ~2800 行）也能自动合并」的折中。
 * O(n·m) 的 Myers 替代实现留待有真实大文案例子时再做。
 */
const MAX_DIFF_CELLS = 8_000_000;

const splitLines = (text: string): readonly string[] => text.split('\n');

const diffHunks = (
  base: readonly string[],
  other: readonly string[],
  side: 'local' | 'disk',
): readonly Hunk[] | null => {
  const n = base.length;
  const m = other.length;
  if ((n + 1) * (m + 1) > MAX_DIFF_CELLS) return null;

  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * width + j] =
        base[i] === other[j]
          ? (dp[(i + 1) * width + (j + 1)] ?? 0) + 1
          : Math.max(dp[(i + 1) * width + j] ?? 0, dp[i * width + (j + 1)] ?? 0);
    }
  }

  const hunks: Hunk[] = [];
  let start = -1;
  let replacement: string[] = [];
  let i = 0;
  let j = 0;

  const flush = (end: number): void => {
    if (start >= 0) {
      hunks.push({ start, end, lines: replacement, side });
      start = -1;
      replacement = [];
    }
  };

  while (i < n && j < m) {
    if (base[i] === other[j]) {
      flush(i);
      i += 1;
      j += 1;
      continue;
    }
    if (start < 0) start = i;
    if ((dp[(i + 1) * width + j] ?? 0) >= (dp[i * width + (j + 1)] ?? 0)) {
      i += 1;
    } else {
      replacement.push(other[j] ?? '');
      j += 1;
    }
  }
  while (i < n) {
    if (start < 0) start = i;
    i += 1;
  }
  while (j < m) {
    if (start < 0) start = i;
    replacement.push(other[j] ?? '');
    j += 1;
  }
  flush(i);

  return hunks;
};

/**
 * 冲突判定用半开区间语义：纯插入（start === end）只是把内容插在某一行的前面，
 * 与「始于该行的替换」可以共存，不能算冲突；只有插在替换区间严格内部才冲突。
 */
const overlaps = (left: Hunk, right: Hunk): boolean => {
  const leftEmpty = left.start === left.end;
  const rightEmpty = right.start === right.end;
  if (leftEmpty && rightEmpty) return left.start === right.start;
  if (leftEmpty) return right.start < left.start && left.start < right.end;
  if (rightEmpty) return left.start < right.start && right.start < left.end;
  return left.start < right.end && right.start < left.end;
};

interface Cluster {
  start: number;
  end: number;
  readonly hunks: Hunk[];
}

const clusterize = (hunks: readonly Hunk[]): Cluster[] => {
  const sorted = [...hunks].sort(
    (left, right) => left.start - right.start || left.end - right.end || left.side.localeCompare(right.side),
  );
  const clusters: Cluster[] = [];
  for (const hunk of sorted) {
    const current = clusters.at(-1);
    if (current !== undefined && overlaps(hunk, { start: current.start, end: current.end, lines: [], side: hunk.side })) {
      current.hunks.push(hunk);
      current.end = Math.max(current.end, hunk.end);
      current.start = Math.min(current.start, hunk.start);
    } else {
      clusters.push({ start: hunk.start, end: hunk.end, hunks: [hunk] });
    }
  }
  return clusters;
};

/** 把同一簇里同一侧的多个 hunk 合成为一段文本（用 base 填充空隙） */
const compose = (base: readonly string[], cluster: Cluster, side: 'local' | 'disk'): readonly string[] => {
  const hunks = cluster.hunks.filter((hunk) => hunk.side === side);
  const output: string[] = [];
  let cursor = cluster.start;
  for (const hunk of hunks) {
    output.push(...base.slice(cursor, hunk.start), ...hunk.lines);
    cursor = hunk.end;
  }
  output.push(...base.slice(cursor, cluster.end));
  return output;
};

const sameLines = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((line, index) => line === right[index]);

/** 三方合并入口 */
export const merge3 = (
  baseText: string,
  localText: string,
  diskText: string,
  labels: ConflictLabels,
): MergeResult => {
  const base = splitLines(baseText);
  const localHunks = diffHunks(base, splitLines(localText), 'local');
  const diskHunks = diffHunks(base, splitLines(diskText), 'disk');
  if (localHunks === null || diskHunks === null) return { kind: 'too_large' };

  const clusters = clusterize([...localHunks, ...diskHunks]).sort((left, right) => left.start - right.start);
  const output: string[] = [];
  let cursor = 0;
  let conflicts = 0;

  for (const cluster of clusters) {
    output.push(...base.slice(cursor, cluster.start));
    const local = compose(base, cluster, 'local');
    const disk = compose(base, cluster, 'disk');
    const hasLocal = cluster.hunks.some((hunk) => hunk.side === 'local');
    const hasDisk = cluster.hunks.some((hunk) => hunk.side === 'disk');

    if (hasLocal && hasDisk) {
      if (sameLines(local, disk)) {
        output.push(...local);
      } else {
        conflicts += 1;
        output.push(
          `<<<<<<< ${labels.local}`,
          ...local,
          '=======',
          ...disk,
          `>>>>>>> ${labels.disk}`,
        );
      }
    } else if (hasLocal) {
      output.push(...local);
    } else {
      output.push(...disk);
    }
    cursor = cluster.end;
  }

  output.push(...base.slice(cursor));
  return conflicts === 0
    ? { kind: 'clean', lines: output }
    : { kind: 'conflict', lines: output, conflicts };
};
