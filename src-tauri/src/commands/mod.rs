use std::fs;
use std::path::PathBuf;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, LogicalPosition, LogicalSize, State, Window};

use crate::error::{VaultError, VaultResult};
use crate::vault::session::{self, StartupView, VaultApp, VaultIdentity, VaultInfo};
use crate::vault::{atomic, backup, lock, media, paths, ScanEntry};

pub mod ai;

/// 启动闸门三态：前端据此决定渲染选择页、错误页还是进入内核。
#[tauri::command]
pub fn vault_startup_state(state: State<'_, VaultApp>) -> StartupView {
    state.view()
}

/// 用户显式选择/新建/最近列表切换；失败时 Rust 侧保留当前库不动。
#[tauri::command]
pub async fn vault_open(
    state: State<'_, VaultApp>,
    root: String,
    mode: String,
) -> VaultResult<StartupView> {
    state.open_user(&root, &mode)
}

/// 错误页「重试」：重跑启动时的解析候选。
#[tauri::command]
pub async fn vault_retry(state: State<'_, VaultApp>) -> VaultResult<StartupView> {
    Ok(state.retry())
}

/// 原生目录面板：`mode=create` 允许新建文件夹；取消返回 null。
#[tauri::command]
pub async fn vault_choose_directory(
    app: AppHandle,
    mode: String,
) -> VaultResult<Option<String>> {
    let allow_create = match mode.as_str() {
        "create" => true,
        "existing" => false,
        other => {
            return Err(VaultError::Encoding(format!("未知的目录选择模式：{other}")));
        }
    };
    tauri::async_runtime::spawn_blocking(move || {
        crate::vault::picker::choose_directory(&app, allow_create)
    })
    .await
    .map_err(|error| VaultError::Startup(format!("目录选择器未完成：{error}")))
}

/// 设置页展示：当前库根与最近列表。未打开库时返回未初始化。
#[tauri::command]
pub async fn vault_current_info(state: State<'_, VaultApp>) -> VaultResult<VaultInfo> {
    state.info()
}


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
pub struct FileStat {
    mtime: String,
    size: u64,
    /// 设备号与 inode：内核用它们判定「改名/移动后仍是同一个文件」（严格重绑）
    dev: u64,
    ino: u64,
}

/// vault 文档读入上限：整文件 + base64（×4/3）都驻留内存，超限拒绝而非读入
const MAX_VAULT_READ_BYTES: u64 = 32 * 1024 * 1024;
/// vault 写入上限：与读取对称，避免被攻破的 renderer 一次性灌入超大文件
const MAX_VAULT_WRITE_BYTES: u64 = 32 * 1024 * 1024;
/// ui.json 是机器本地小文件，远超实际需要的载荷直接拒绝
const MAX_MACHINE_UI_BYTES: usize = 1024 * 1024;

/// 前端启动第二步：拿库身份与只读标志（只读标志来自库锁获取结果）。
/// 启动闸门已保证此处有库；未就绪时返回可读错误而不是让原生进程 panic。
#[tauri::command]
pub fn vault_identity(state: State<'_, VaultApp>) -> VaultResult<VaultIdentity> {
    let session = state.session()?;
    Ok(session::identity_of(session.vault()?))
}

/// 字节以 base64 过 IPC；文件不存在返回 null。
#[tauri::command]
pub async fn vault_read(
    state: State<'_, VaultApp>,
    path: String,
) -> VaultResult<Option<String>> {
    let session = state.session()?;
    let vault = session.vault()?;
    // stat 先行：外部塞进库里的超大文件不读入内存
    if let Some(stat) = vault.stat(&path)? {
        if stat.size > MAX_VAULT_READ_BYTES {
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
    state: State<'_, VaultApp>,
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
    let session = state.session()?;
    session.vault()?.write(&path, &bytes, &intent)
}

/// 用户删除：只进系统回收站（含 Finder 代删），不可用即失败，不降级库内回收。
/// 返回 `system`；文件本就不存在时返回 `null`。
#[tauri::command]
pub async fn vault_remove(
    state: State<'_, VaultApp>,
    path: String,
) -> VaultResult<Option<&'static str>> {
    let session = state.session()?;
    Ok(session
        .vault()?
        .remove(&path)?
        .map(crate::vault::trash::TrashDestination::as_str))
}

/// 永久删除：仅供内核回滚内部使用，不是用户命令（`core.doc.purge` 仍为 v1 未实现）。
#[tauri::command]
pub async fn vault_purge(state: State<'_, VaultApp>, path: String) -> VaultResult<()> {
    let session = state.session()?;
    session.vault()?.purge(&path)
}

/// 目标路径已存在时返回 `path_exists`。该检查只降低覆盖概率，不能杜绝：
/// 检查与 `fs::rename` 之间仍有窗口，外部进程此时创建同名文件仍会被覆盖。
#[tauri::command]
pub async fn vault_rename(
    state: State<'_, VaultApp>,
    from: String,
    to: String,
) -> VaultResult<()> {
    let session = state.session()?;
    session.vault()?.rename(&from, &to)
}

#[tauri::command]
pub async fn vault_list(state: State<'_, VaultApp>) -> VaultResult<Vec<String>> {
    let session = state.session()?;
    session.vault()?.list()
}

/// 新建单层文件夹：父目录必须已存在；命名与保留路径在 Rust 侧独立校验。
#[tauri::command]
pub async fn vault_create_dir(
    state: State<'_, VaultApp>,
    path: String,
) -> VaultResult<String> {
    let session = state.session()?;
    session.vault()?.create_dir(&path)
}

/// 删除文件夹：只进系统回收站，系统回收站不可用即失败（不降级库内回收）。
#[tauri::command]
pub async fn vault_remove_dir(state: State<'_, VaultApp>, path: String) -> VaultResult<()> {
    let session = state.session()?;
    session.vault()?.remove_dir(&path)
}

/// 全库目录清单（含空目录），供文档树与「移动到…」使用。
#[tauri::command]
pub async fn vault_list_dirs(state: State<'_, VaultApp>) -> VaultResult<Vec<String>> {
    let session = state.session()?;
    session.vault()?.list_dirs()
}

#[tauri::command]
pub async fn vault_list_canvases(state: State<'_, VaultApp>) -> VaultResult<Vec<String>> {
    let session = state.session()?;
    session.vault()?.list_canvases()
}

/// 库健康检查清单：只读，不跟随符号链接。
#[tauri::command]
pub async fn vault_scan(state: State<'_, VaultApp>) -> VaultResult<Vec<ScanEntry>> {
    let session = state.session()?;
    session.vault()?.scan()
}

#[tauri::command]
pub async fn vault_stat(
    state: State<'_, VaultApp>,
    path: String,
) -> VaultResult<Option<FileStat>> {
    let session = state.session()?;
    Ok(session.vault()?.stat(&path)?.map(|stat| FileStat {
        mtime: stat.mtime,
        size: stat.size,
        dev: stat.dev,
        ino: stat.ino,
    }))
}

/// 读库外状态（迁移快照、历史日志）；不存在返回 null。路径相对于库外状态根。
#[tauri::command]
pub async fn vault_state_read(
    state: State<'_, VaultApp>,
    path: String,
) -> VaultResult<Option<String>> {
    let session = state.session()?;
    let vault = session.vault()?;
    if let Some(bytes) = vault.state_read(&path)? {
        if bytes.len() as u64 > MAX_VAULT_READ_BYTES {
            return Err(VaultError::Encoding(format!(
                "状态文件超过读入上限 {} MB：{path}",
                MAX_VAULT_READ_BYTES / (1024 * 1024)
            )));
        }
        return Ok(Some(STANDARD.encode(bytes)));
    }
    Ok(None)
}

/// 原子写库外状态；父目录自动创建。路径相对于库外状态根。
#[tauri::command]
pub async fn vault_state_write(
    state: State<'_, VaultApp>,
    path: String,
    data: String,
) -> VaultResult<()> {
    if (data.len() as u64) * 3 / 4 > MAX_VAULT_WRITE_BYTES {
        return Err(VaultError::Encoding(format!(
            "状态写入超过 {} MB 上限：{path}",
            MAX_VAULT_WRITE_BYTES / (1024 * 1024)
        )));
    }
    let bytes = STANDARD
        .decode(data.as_bytes())
        .map_err(|error| VaultError::Encoding(error.to_string()))?;
    let session = state.session()?;
    session.vault()?.state_write(&path, &bytes)
}

/// 列库外状态目录的直接子项名称；目录不存在返回空。
#[tauri::command]
pub async fn vault_state_list(
    state: State<'_, VaultApp>,
    path: String,
) -> VaultResult<Vec<String>> {
    let session = state.session()?;
    session.vault()?.state_list(&path)
}

/// 永久删除库外状态项；不存在视为成功。
#[tauri::command]
pub async fn vault_state_purge(
    state: State<'_, VaultApp>,
    path: String,
) -> VaultResult<()> {
    let session = state.session()?;
    session.vault()?.state_purge(&path)
}

/// 图库清单：`media/` 内容寻址资产 + 指针型库里按真实布局散落的磁盘图片。
#[tauri::command]
pub async fn asset_list(state: State<'_, VaultApp>) -> VaultResult<Vec<media::AssetEntry>> {
    let session = state.session()?;
    media::list(session.vault()?)
}

/// 读单张图库图片，字节以 base64 过 IPC。
/// `media/` 路径仍走内容寻址校验；其余路径只允许读库内、白名单扩展名、非符号链接的图片。
#[tauri::command]
pub async fn asset_read(
    state: State<'_, VaultApp>,
    path: String,
) -> VaultResult<media::AssetData> {
    let session = state.session()?;
    media::read(session.vault()?, &path)
}

/// 正文图片解析：按文章目录 → 文章目录/images → 库根依次探测，只读、不改正文。
#[tauri::command]
pub async fn asset_resolve(
    state: State<'_, VaultApp>,
    document_path: String,
    reference: String,
) -> VaultResult<media::ImageResolution> {
    let session = state.session()?;
    media::resolve_reference(session.vault()?, &document_path, &reference)
}

/// 导入图片：校验白名单类型 / magic bytes / 20 MB 上限，按 sha256 内容寻址去重。
#[tauri::command]
pub async fn asset_save(
    state: State<'_, VaultApp>,
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
    let session = state.session()?;
    media::save(session.vault()?, &bytes, &mime)
}

/// 删除单张图库图片：移入系统回收站（与文档删除同一落点）。
/// 不存在按幂等成功；只读库拒绝。
#[tauri::command]
pub async fn asset_delete(
    state: State<'_, VaultApp>,
    path: String,
) -> VaultResult<&'static str> {
    let session = state.session()?;
    media::delete(session.vault()?, &path)
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
pub fn vault_backup_default_destination(state: State<'_, VaultApp>) -> VaultResult<String> {
    let session = state.session()?;
    Ok(backup::default_destination(session.vault()?))
}

/// 整库导出到指定目录：staging → 逐文件校验 → 原子改名。
/// 只读库同样允许导出（导出不写库）。
#[tauri::command]
pub async fn vault_backup_export(
    state: State<'_, VaultApp>,
    options: backup::ExportOptions,
) -> VaultResult<backup::ExportReport> {
    let session = state.session()?;
    backup::export(session.vault()?, &options)
}

/// 导出包只读预检：格式/版本、内容 hash、路径穿越、重复路径与 id、大小写碰撞、目标占用。
/// 不写盘、不读库。
#[tauri::command]
pub async fn vault_backup_inspect(directory: String) -> VaultResult<backup::InspectReport> {
    backup::inspect(&directory)
}
