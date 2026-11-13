import { useMemo, type ReactElement } from 'react';
import { buildHeatmap, type HeatmapGrid } from './activity-heatmap.ts';
import styles from './SettingsPanel.module.css';

export interface ActivityHeatmapProps {
  /** 文档清单：id + updated；来自 docs.list() 的缓存 */
  readonly docs: readonly { readonly id: string; readonly updatedAt: string }[];
  readonly today?: Date;
}

const LEVEL_CLASS = ['', 'level1', 'level2', 'level3', 'level4'] as const;

const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'] as const;

const cellTitle = (day: { readonly key: string; readonly count: number; readonly future: boolean }): string =>
  day.future ? day.key : day.count === 0 ? `${day.key}：无更新` : `${day.key}：更新 ${day.count} 篇`;

/** 写作活动热力图：最近 26 周，按天聚合文档更新（同一天多篇按篇计） */
export const ActivityHeatmap = ({ docs, today = new Date() }: ActivityHeatmapProps): ReactElement => {
  const grid: HeatmapGrid = useMemo(() => buildHeatmap(docs, today), [docs, today]);

  const since = grid.weeks[0]?.[0]?.key ?? '';

  return (
    <div className={styles.heatmap} data-testid="activity-heatmap">
      <p className={styles.sectionTitle}>写作活动</p>
      <div className={styles.heatmapGrid} role="img" aria-label={`最近 26 周写作活动：${grid.activeDays} 天有更新，共 ${grid.totalDocs} 篇次`}>
        <div className={styles.heatmapWeekdays} aria-hidden="true">
          {WEEKDAY_LABELS.map((label, index) => (
            <span key={label} className={index % 2 === 0 ? styles.heatmapWeekday : styles.heatmapWeekdayHidden}>
              {label}
            </span>
          ))}
        </div>
        <div className={styles.heatmapCells}>
          {grid.weeks.map((week, weekIndex) => (
            <div key={weekIndex} className={styles.heatmapColumn}>
              {week.map((day) => (
                <span
                  key={day.key}
                  className={`${styles.heatmapCell} ${day.future ? styles.heatmapFuture : styles[LEVEL_CLASS[day.level]] ?? ''}`}
                  title={cellTitle(day)}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      <p className={styles.heatmapLegend}>
        <span>自 {since}</span>
        <span className={styles.heatmapLegendScale} aria-hidden="true">
          <span className={`${styles.heatmapCell} ${styles.heatmapCell0}`} />
          <span className={`${styles.heatmapCell} ${styles.level1}`} />
          <span className={`${styles.heatmapCell} ${styles.level2}`} />
          <span className={`${styles.heatmapCell} ${styles.level3}`} />
          <span className={`${styles.heatmapCell} ${styles.level4}`} />
        </span>
        <span>
          {grid.activeDays} 天有更新 · 共 {grid.totalDocs} 篇次
        </span>
      </p>
    </div>
  );
};
