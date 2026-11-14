use std::fs;
use std::path::PathBuf;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, State, Window};

use crate::error::{VaultError, VaultResult};
use crate::vault::{atomic, backup, lock, media, paths, ScanEntry, Vault};

pub mod ai;

/// 无边框窗口的自绘缩放：一次 IPC 同时落位置与尺寸，避免两帧撕裂。
/// macOS 上 `startResizeDragging` 是 `NotSupported` 且错误被运行时吞掉，因此缩放必须走这里。
#[tauri::command]
pub fn window_resize_frame(
    window: Window,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    window
        .set_position(LogicalPosition::new(x, y))
        .map_err(|error| error.to_string())?;
    window
        .set_size(LogicalSize::new(width.max(1.0), height.max(1.0)))
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct VaultIdentity {
    #[serde(rename = "vaultId")]
    vault_id: String,
    readonly: bool,
    /// 只读原因；可写时省略（additive 字段，老前端不受影响）
    #[serde(rename = "readonlyReason", skip_serializing_if = "Option::is_none")]
    readonly_reason: Option<crate::vault::lock::ReadonlyReason>,
}

#[derive(Debug, Serialize)]
pub struct FileStat {
    mtime: String,
    size: u64,
}

/// vault 文档读入上限：整文件 + base64（×4/3）都驻留内存，超限拒绝而非读入
const MAX_VAULT_READ_BYTES: u64 = 32 * 1024 * 1024;
/// vault 写入上限：与读取对称，避免被攻破的 renderer 一次性灌入超大文件
const MAX_VAULT_WRITE_BYTES: u64 = 32 * 1024 * 1024;
/// ui.json 是机器本地小文件，远超实际需要的载荷直接拒绝
const MAX_MACHINE_UI_BYTES: usize = 1024 * 1024;

fn identity_of(vault: &Vault) -> VaultIdentity {
    VaultIdentity {
        vault_id: vault.id().to_string(),
        // 用 writable()：启动未抢到锁（被另一实例占用）的实例如实告知前端
        readonly: !vault.writable(),
        readonly_reason: vault.readonly_reason(),
    }
}

/// 前端启动第一步：拿库身份与只读标志（只读标志来自库锁获取结果）。
/// 建库失败时返回可读错误，交给启动页展示，而不是让原生进程 panic。
#[tauri::command]
pub fn vault_identity(app: AppHandle) -> VaultResult<VaultIdentity> {
    match (
        app.try_state::<crate::StartupFailure>(),
        app.try_state::<Vault>(),
    ) {
        (Some(failure), _) => Err(VaultError::Startup(failure.0.clone())),
        (None, Some(vault)) => Ok(identity_of(&vault)),
        (None, None) => Err(VaultError::Uninitialized),
    }
}

/// 字节以 base64 过 IPC；文件不存在返回 null。
#[tauri::command]
pub async fn vault_read(vault: State<'_, Vault>, path: String) -> VaultResult<Option<String>> {
    // stat 先行：外部塞进库里的超大文件不读入内存
    if let Some((_, size)) = vault.stat(&path)? {
        if size > MAX_VAULT_READ_BYTES {
            return Err(VaultError::Encoding(format!(
                "文件超过读入上限 {} MB：{path}",
                MAX_VAULT_READ_BYTES / (1024 * 1024)
            )));
        }
    }
    Ok(vault.read(&path)?.map(|bytes| STANDARD.encode(bytes)))
}

#[tauri::command]
pub async fn vault_write(
    vault: State<'_, Vault>,
    path: String,
    data: String,
    intent: String,
) -> VaultResult<()> {
    // 解码前按 base64 长度（×3/4）估算：与读取上限对称，超大载荷直接拒绝
    if (data.len() as u64) * 3 / 4 > MAX_VAULT_WRITE_BYTES {
        return Err(VaultError::Encoding(format!(
            "写入超过 {} MB 上限：{path}",
            MAX_VAULT_WRITE_BYTES / (1024 * 1024)
        )));
    }
    let bytes = STANDARD
        .decode(data.as_bytes())
        .map_err(|error| VaultError::Encoding(error.to_string()))?;
    vault.write(&path, &bytes, &intent)
}

/// 用户删除：优先系统回收站，不可用时降级 Finder 与库内回收目录（vault-format §8.3）。
/// 返回实际落点 `system` / `internal`；文件本就不存在时返回 `null`。
#[tauri::command]
pub async fn vault_remove(
    vault: State<'_, Vault>,
    path: String,
) -> VaultResult<Option<&'static str>> {
    Ok(vault.remove(&path)?.map(crate::vault::trash::TrashDestination::as_str))
}

/// 永久删除：仅供内核回滚内部使用，不是用户命令（`core.doc.purge` 仍为 v1 未实现）。
#[tauri::command]
pub async fn vault_purge(vault: State<'_, Vault>, path: String) -> VaultResult<()> {
    vault.purge(&path)
}

/// 目标路径已存在时返回 `path_exists`。该检查只降低覆盖概率，不能杜绝：
/// 检查与 `fs::rename` 之间仍有窗口，外部进程此时创建同名文件仍会被覆盖。
#[tauri::command]
pub async fn vault_rename(vault: State<'_, Vault>, from: String, to: String) -> VaultResult<()> {
    vault.rename(&from, &to)
}

#[tauri::command]
pub async fn vault_list(vault: State<'_, Vault>) -> VaultResult<Vec<String>> {
    vault.list()
}

#[tauri::command]
pub async fn vault_list_canvases(vault: State<'_, Vault>) -> VaultResult<Vec<String>> {
    vault.list_canvases()
}

/// 库健康检查清单：只读，不跟随符号链接。
#[tauri::command]
pub async fn vault_scan(vault: State<'_, Vault>) -> VaultResult<Vec<ScanEntry>> {
    vault.scan()
}

#[tauri::command]
pub async fn vault_stat(vault: State<'_, Vault>, path: String) -> VaultResult<Option<FileStat>> {
    Ok(vault
        .stat(&path)?
        .map(|(mtime, size)| FileStat { mtime, size }))
}

/// 图库清单：`media/` 下所有合法图片，相对路径字典序。
#[tauri::command]
pub async fn asset_list(vault: State<'_, Vault>) -> VaultResult<Vec<media::AssetEntry>> {
    media::list(&vault)
}

/// 读单张图库图片，字节以 base64 过 IPC；只接受 `media/` 下的资产路径。
#[tauri::command]
pub async fn asset_read(vault: State<'_, Vault>, path: String) -> VaultResult<media::AssetData> {
    media::read(&vault, &path)
}

/// 导入图片：校验白名单类型 / magic bytes / 20 MB 上限，按 sha256 内容寻址去重。
#[tauri::command]
pub async fn asset_save(
    vault: State<'_, Vault>,
    data: String,
    mime: String,
) -> VaultResult<media::AssetSaved> {
    // 解码前按 base64 长度（×3/4）估算：被攻破的 renderer 传超大载荷时先拒绝，不做解码
    if (data.len() as u64) * 3 / 4 > media::MAX_ASSET_BYTES {
        return Err(VaultError::Encoding(format!(
            "图片超过 {} MB 上限",
            media::MAX_ASSET_BYTES / (1024 * 1024)
        )));
    }
    let bytes = STANDARD
        .decode(data.as_bytes())
        .map_err(|error| VaultError::Encoding(error.to_string()))?;
    media::save(&vault, &bytes, &mime)
}

/// 删除单张图库图片：移入系统回收站（与文档删除同一落点）。
/// 不存在按幂等成功；只读库拒绝。
#[tauri::command]
pub async fn asset_delete(vault: State<'_, Vault>, path: String) -> VaultResult<&'static str> {
    media::delete(&vault, &path)
}

/// 机器标识与库锁共用 `machine-id` 文件，保证 ui.json 落在同一台机器的目录下：
/// `~/Library/Application Support/Ember/machines/<machineId>/ui.json`，绝不写进库目录。
fn machine_ui_file() -> VaultResult<PathBuf> {
    let dir = paths::app_support_dir().join("machines").join(lock::machine_id()?);
    Ok(dir.join("ui.json"))
}

/// 读取机器本地 UI 状态；文件不存在返回 null。
#[tauri::command]
pub async fn machine_ui_read() -> VaultResult<Option<String>> {
    let file = machine_ui_file()?;
    match fs::read_to_string(&file) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

/// 原子写入机器本地 UI 状态；先校验载荷大小与 JSON，避免把半截内容落盘。
#[tauri::command]
pub async fn machine_ui_write(data: String) -> VaultResult<()> {
    if data.len() > MAX_MACHINE_UI_BYTES {
        return Err(VaultError::Encoding(format!(
            "ui.json 载荷超过 {} KB 上限",
            MAX_MACHINE_UI_BYTES / 1024
        )));
    }
    let _: serde_json::Value = serde_json::from_str(&data)?;
    let file = machine_ui_file()?;
    atomic::write_atomic(&file, data.as_bytes())
}

// -------- AI session（阶段 7） --------

/// AI 会话文件单库一份，体量与 ui.json 同量级：≤ 1 MiB。
const MAX_MACHINE_AI_BYTES: usize = 1024 * 1024;

/// ai session 文件路径：`machines/<machineId>/ai/<vaultId>.json`
fn machine_ai_file(vault_id: &str) -> VaultResult<PathBuf> {
    if vault_id.is_empty()
        || vault_id.contains("..")
        || vault_id.contains('/')
        || vault_id.contains('\\')
    {
        return Err(VaultError::Encoding(format!("非法 vaultId：{vault_id}")));
    }
    let dir = paths::app_support_dir().join("machines").join(lock::machine_id()?).join("ai");
    Ok(dir.join(format!("{vault_id}.json")))
}

/// 读取机器本地 AI 会话；文件不存在返回 null。
#[tauri::command]
pub async fn machine_ai_read(vault_id: String) -> VaultResult<Option<String>> {
    let file = machine_ai_file(&vault_id)?;
    match fs::read_to_string(&file) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

/// 原子写入机器本地 AI 会话；先校验载荷大小与 JSON 合法性。
#[tauri::command]
pub async fn machine_ai_write(vault_id: String, data: String) -> VaultResult<()> {
    if data.len() > MAX_MACHINE_AI_BYTES {
        return Err(VaultError::Encoding(format!(
            "ai 会话载荷超过 {} KB 上限",
            MAX_MACHINE_AI_BYTES / 1024
        )));
    }
    let _: serde_json::Value = serde_json::from_str(&data)?;
    let file = machine_ai_file(&vault_id)?;
    atomic::write_atomic(&file, data.as_bytes())
}

/// 默认导出目录（库外）：`~/Documents/Ember Export <库名> <YYYY-MM-DD>`。
#[tauri::command]
pub fn vault_backup_default_destination(vault: State<'_, Vault>) -> VaultResult<String> {
    Ok(backup::default_destination(&vault))
}

/// 整库导出到指定目录：staging → 逐文件校验 → 原子改名。
/// 只读库同样允许导出（导出不写库）。
#[tauri::command]
pub async fn vault_backup_export(
    vault: State<'_, Vault>,
    options: backup::ExportOptions,
) -> VaultResult<backup::ExportReport> {
    backup::export(&vault, &options)
}

/// 导出包只读预检：格式/版本、内容 hash、路径穿越、重复路径与 id、大小写碰撞、目标占用。
/// 不写盘、不读库。
#[tauri::command]
pub async fn vault_backup_inspect(directory: String) -> VaultResult<backup::InspectReport> {
    backup::inspect(&directory)
}
