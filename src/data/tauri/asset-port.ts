import { invoke } from '@tauri-apps/api/core';

/**
 * 图库资产的 Tauri 适配层。
 * 磁盘布局与校验（白名单 / magic bytes / 20 MB / sha256 去重）全在 Rust 侧，
 * 这里只做命令名映射与类型声明；字节统一以 base64 过 IPC。
 */

export interface AssetEntry {
  readonly path: string;
  readonly name: string;
  readonly hash: string;
  readonly mime: string;
  readonly bytes: number;
}

export interface AssetData {
  readonly path: string;
  readonly mime: string;
  readonly bytes: number;
  /** base64；前端拼 `data:<mime>;base64,...` 给 <img> */
  readonly data: string;
}

export interface AssetSaved {
  readonly path: string;
  readonly name: string;
  readonly hash: string;
  readonly mime: string;
  readonly bytes: number;
  /** 同一内容已存在时为 true，此时没有重写磁盘 */
  readonly deduped: boolean;
}

/** 正文图片解析结果；缺失时带原因码，供占位文案使用。 */
export type ImageResolution =
  | {
      readonly status: 'found';
      readonly path: string;
      readonly mime: string;
      readonly bytes: number;
      readonly data: string;
    }
  | {
      readonly status: 'missing';
      readonly reason:
        | 'notFound'
        | 'outsideVault'
        | 'unsupportedType'
        | 'tooLarge'
        | 'unreadable'
        | 'external';
    };

/** `media/` 内容寻址资产 + 指针型库中按真实布局散落的磁盘图片。 */
export const listAssets = (): Promise<readonly AssetEntry[]> =>
  invoke<readonly AssetEntry[]>('asset_list');

/** 读单张图片；`media/` 走内容寻址，其余走库内磁盘图片安全校验。 */
export const readAsset = (path: string): Promise<AssetData> => invoke<AssetData>('asset_read', { path });

/**
 * 按文章路径解析正文图片引用：文章目录 → 文章目录/images → 库根，命中即停。
 * 只读，不改正文；缺失时返回原因而不抛错。
 */
export const resolveArticleImage = (documentPath: string, reference: string): Promise<ImageResolution> =>
  invoke<ImageResolution>('asset_resolve', { documentPath, reference });

/** 导入图片：内容与声明的 MIME 必须一致，同内容返回 deduped。 */
export const saveAsset = (data: string, mime: string): Promise<AssetSaved> =>
  invoke<AssetSaved>('asset_save', { data, mime });

/** 删除单张图片落点：system = 系统回收站；internal = 库内回收目录（30 天后自动清理）。 */
export type AssetDeleteDestination = 'system' | 'internal';

/** 删除单张图片：优先系统回收站，权限不足时自动降级为库内回收目录；不存在按幂等成功。 */
export const deleteAsset = (path: string): Promise<AssetDeleteDestination> =>
  invoke<AssetDeleteDestination>('asset_delete', { path });
