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

/** `media/` 下全部合法图片，相对路径字典序。 */
export const listAssets = (): Promise<readonly AssetEntry[]> =>
  invoke<readonly AssetEntry[]>('asset_list');

/** 读单张图片；只接受 `media/` 下的资产路径。 */
export const readAsset = (path: string): Promise<AssetData> => invoke<AssetData>('asset_read', { path });

/** 导入图片：内容与声明的 MIME 必须一致，同内容返回 deduped。 */
export const saveAsset = (data: string, mime: string): Promise<AssetSaved> =>
  invoke<AssetSaved>('asset_save', { data, mime });
