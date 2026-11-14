pub mod atomic;
pub mod backup;
pub mod clock;
pub mod config;
pub mod lock;
pub mod media;
pub mod paths;
pub mod picker;
pub mod session;
pub mod trash;
pub mod ulid;
pub mod watcher;

use std::fs;
#[cfg(unix)]
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, SystemTime};

use crate::error::{VaultError, VaultResult};

/// 当前 `.workbench/` schema 版本（规范 §8）。
const SETTINGS_SCHEMA_VERSION: u64 = 1;

/// 画布目录（规范 §8.2）：`vault_list` 保持只含 `.md`，画布清单走 `list_canvases`。
const CANVAS_DIR: &str = ".workbench/canvas";

/// 孤儿临时文件保留期：正常一次原子写远不到 1 小时，超龄的 `.ember-tmp-`
/// 必然是崩溃遗留的孤儿（索引与画布都是派生数据，残留清扫即可恢复）。
const ORPHAN_TEMP_MAX_AGE: Duration = Duration::from_secs(24 * 3600);
/// 历史遗留的库内回收目录（`.workbench/trash/<ULID>/`）保留期：v1 起删除不再
/// 降级到库内，这里只为还没被清理的老副本保留一次惰性清扫。
const TRASH_RETENTION: Duration = Duration::from_secs(30 * 24 * 3600);

/// 文件元信息。`dev` / `ino` 供严格重绑判定同一文件（改名/移动后 inode 不变）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatInfo {
    pub mtime: String,
    pub size: u64,
    pub dev: u64,
    pub ino: u64,
}

/// 默认忽略的目录名：依赖缓存与版本库元数据。它们可能含成百上千个 `.md`
/// （README、依赖文档），既不属于知识库内容，也不该被 watcher 每轮轮询。
pub const DEFAULT_IGNORED_DIRS: [&str; 2] = ["node_modules", ".git"];

/// 合并默认忽略目录与 `.workbench/settings.json` 的 `watcherIgnoreDirs`。
/// 只接受单段目录名（不含 `/`、`\`、`.`、`..`），避免把忽略规则写成路径通配；
/// 读不到或格式不合法时退回默认值，不让一份坏设置阻断启动。
pub fn ignored_dirs(root: &Path) -> Vec<String> {
    let mut names: Vec<String> = DEFAULT_IGNORED_DIRS
        .iter()
        .map(|name| (*name).to_string())
        .collect();
    if let Ok(text) = fs::read_to_string(paths::settings_file(root)) {
        if let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(serde_json::Value::Array(items)) = map.get("watcherIgnoreDirs") {
                for item in items {
                    let Some(raw) = item.as_str() else { continue };
                    let name = raw.trim();
                    if name.is_empty()
                        || name == "."
                        || name == ".."
                        || name == paths::WORKBENCH_DIR
                        || name.contains('/')
                        || name.contains('\\')
                    {
                        continue;
                    }
                    names.push(name.to_string());
                }
            }
        }
    }
    names.sort();
    names.dedup();
    names
}

/// 目录名是否在忽略清单中（只看单段 basename，不解释路径）。
pub(crate) fn is_ignored_dir(name: &str, ignored: &[String]) -> bool {
    ignored.iter().any(|item| item == name)
}

/// IPC 可接受的写入意图（kernel types.ts 的 WriteIntent）：仅校验来源合法性，不落盘。
const WRITE_INTENTS: [&str; 3] = ["user", "migration", "system"];

/// 库运行态：根路径、身份、锁与写入串行化。
pub struct Vault {
    root: PathBuf,
    id: String,
    /// 启动时是否抢到锁（只读观察者）。独占创建 + pid 存活模型下，
    /// 锁一旦持有即贯穿整个会话（pid 存活期间无人能接管），运行期不会降级。
    initially_readonly: bool,
    /// 启动时进入只读的原因（被占用）。
    startup_readonly_reason: Option<lock::ReadonlyReason>,
    /// 拿到锁才持有；抢占不到时为 None，整个会话只读。
    /// 独占创建模型下写一次不再变更，不需要 Mutex。
    _lock: Option<lock::VaultLock>,
    /// 串行化写入：rename 的检查与落盘必须按顺序发生。
    write_gate: Mutex<()>,
}

impl Vault {
    /// 打开已存在的库：确保身份文件 → 抢锁（独占创建 + pid 存活判定）→ 启动清扫。
    /// 抢不到锁进入只读观察者模式（被另一实例占用）；库位置不可写时降级为
    /// `FilesystemReadonly` 只读会话，而不是把用户挡在错误页。
    /// 不创建库根：只有显式选择/新建路径的 `open_or_init` 允许落盘。
    pub fn open(root: PathBuf) -> VaultResult<Self> {
        if !root.is_dir() {
            return Err(VaultError::Startup(format!(
                "库目录不存在：{}",
                root.display()
            )));
        }
        let id = ensure_identity(&root)?;

        let mut startup_readonly_reason: Option<lock::ReadonlyReason> = None;
        let guard: Option<lock::VaultLock> = match lock::acquire_detailed(&root, &id) {
            Ok(value) => Some(value),
            Err(lock::AcquireFailure::Readonly(reason)) => {
                eprintln!(
                    "库只读（{}），进入观察者模式：{}",
                    match reason {
                        lock::ReadonlyReason::LockedByOther => "已被其它实例打开",
                        lock::ReadonlyReason::LockLost => "库锁丢失",
                        lock::ReadonlyReason::FilesystemReadonly => "库位置不可写",
                    },
                    root.display()
                );
                startup_readonly_reason = Some(reason);
                None
            }
            // 只读卷/只读目录：身份可读但无法建锁。降级为只读会话，保留浏览能力。
            Err(lock::AcquireFailure::Error(VaultError::PermissionDenied(message))) => {
                eprintln!("库位置不可写（{message}），进入只读模式：{}", root.display());
                startup_readonly_reason = Some(lock::ReadonlyReason::FilesystemReadonly);
                None
            }
            Err(lock::AcquireFailure::Error(error)) => return Err(error),
        };
        // 锁在库外，锁的创建不再能代表库位置可写：用 settings.json 的只写打开
        // （不截断、不写字节）补一次探测，只读卷仍然降级为观察者。
        let mut guard = guard;
        if guard.is_some() && !writable_probe(&root) {
            guard = None;
            startup_readonly_reason = Some(lock::ReadonlyReason::FilesystemReadonly);
        }
        let initially_readonly = guard.is_none();

        // 只有持锁实例才执行启动清扫；另一实例可能正在写。
        if !initially_readonly {
            sweep_housekeeping(&root);
        }

        // 抢锁后重读：两个实例首次启动可能都写过身份，以磁盘上的胜者为准。
        let id = ensure_identity(&root)?;

        Ok(Vault {
            root,
            id,
            initially_readonly,
            startup_readonly_reason,
            _lock: guard,
            write_gate: Mutex::new(()),
        })
    }

    /// 打开配置里记录的既有库：不创建库根，也不在身份缺失时"顺手初始化"。
    /// 缺 `.workbench/settings.json` 说明这个目录不是（或不再是）Ember 库，
    /// 必须交给错误页让用户决定，而不是静默换一个新库 ID。
    pub fn open_existing(root: PathBuf) -> VaultResult<Self> {
        if !root.is_dir() {
            return Err(VaultError::Startup(format!(
                "库目录不存在：{}",
                root.display()
            )));
        }
        if !paths::settings_file(&root).is_file() {
            return Err(VaultError::Startup(format!(
                "这个文件夹还不是 Ember 库（缺少 .workbench/settings.json）：{}",
                root.display()
            )));
        }
        Self::open(root)
    }

    /// 用户显式选择/新建的目录：允许初始化库根、`.workbench/settings.json` 与画布目录。
    /// 只读位置上的建目录失败不在这里判死：交给 `open` 走只读降级。
    pub fn open_or_init(root: PathBuf) -> VaultResult<Self> {
        match fs::create_dir_all(&root).and_then(|()| fs::create_dir_all(root.join(CANVAS_DIR))) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {}
            Err(error) => return Err(error.into()),
        }
        Self::open(root)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    /// 当前只读原因；可写时返回 None。
    /// 独占创建模型下只读只发生在启动时（被另一实例占用）；
    /// 兜底分支构造 `LockLost`，保证契约的两态文案始终可用。
    pub fn readonly_reason(&self) -> Option<lock::ReadonlyReason> {
        if let Some(reason) = self.startup_readonly_reason {
            return Some(reason);
        }
        if self.initially_readonly {
            return Some(lock::ReadonlyReason::LockLost);
        }
        None
    }

    pub fn read(&self, relative: &str) -> VaultResult<Option<Vec<u8>>> {
        let (absolute, _) = paths::resolve(&self.root, relative)?;
        match fs::read(&absolute) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    pub fn write(&self, relative: &str, bytes: &[u8], intent: &str) -> VaultResult<()> {
        // intent 表达写入来源；非法值在入口拒绝。
        if !WRITE_INTENTS.contains(&intent) {
            return Err(VaultError::Encoding(format!("非法的写入意图：{intent}")));
        }
        self.ensure_writable()?;
        let (absolute, normalized) = paths::resolve(&self.root, relative)?;
        paths::ensure_not_reserved(&normalized)?;
        let _gate = self.begin_write()?;
        // 原子写：临时文件 fsync → rename → 目录 fsync，与其它一切落盘共用同一保证。
        // 正文唯一真相在文件本身；索引/画布都是派生数据，崩溃残留由启动清扫兜底。
        atomic::write_atomic(&absolute, bytes).map_err(|error| with_path(error, &absolute))
    }

    /// 删除：移入系统回收站（Finder 代删的落点同样是系统回收站），不可用即失败；
    /// 库内不再有降级副本。返回实际落点；文件不存在视为成功并返回 `None`，便于内核做幂等对账。
    pub fn remove(&self, relative: &str) -> VaultResult<Option<trash::TrashDestination>> {
        self.ensure_writable()?;
        let (absolute, normalized) = paths::resolve(&self.root, relative)?;
        paths::ensure_not_reserved(&normalized)?;
        let _gate = self.begin_write()?;
        match fs::symlink_metadata(&absolute) {
            Ok(_) => Ok(Some(trash::trash(&self.root, &absolute)?)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(with_path(error.into(), &absolute)),
        }
    }

    /// 永久删除：**仅供内核回滚内部使用**（文章创建后画布写入失败），
    /// 不是用户删除入口——用户删除一律走 [`Vault::remove`] 进系统回收站。
    /// 不注册为用户可调用的 `core.doc.purge` 命令（契约里该项仍为 v1 未实现）。
    pub fn purge(&self, relative: &str) -> VaultResult<()> {
        self.ensure_writable()?;
        let (absolute, normalized) = paths::resolve(&self.root, relative)?;
        paths::ensure_not_reserved(&normalized)?;
        let _gate = self.begin_write()?;
        match fs::remove_file(&absolute) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(with_path(error.into(), &absolute)),
        }
    }

    pub fn rename(&self, from: &str, to: &str) -> VaultResult<()> {
        self.ensure_writable()?;
        let (source, from_normalized) = paths::resolve(&self.root, from)?;
        let (target, to_normalized) = paths::resolve(&self.root, to)?;
        paths::ensure_not_reserved(&from_normalized)?;
        paths::ensure_not_reserved(&to_normalized)?;
        let _gate = self.begin_write()?;
        if !source.is_file() {
            return Err(VaultError::NotFound(from.to_string()));
        }
        if source == target {
            return Ok(());
        }
        // 目标已存在时拒绝覆盖。注意：这是降低概率而非杜绝——检查与 fs::rename 之间
        // 仍有窗口，外部进程此时创建同名文件仍会被覆盖（POSIX rename 是覆盖语义）。
        if fs::symlink_metadata(&target).is_ok() {
            return Err(VaultError::PathExists(to.to_string()));
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::rename(&source, &target)?;
        Ok(())
    }

    /// 新建单层文件夹：父目录必须已存在，命名与保留路径在这里独立校验。
    /// 返回归一化后的相对路径。
    pub fn create_dir(&self, relative: &str) -> VaultResult<String> {
        self.ensure_writable()?;
        let (absolute, normalized) = paths::resolve(&self.root, relative)?;
        validate_dir_name(&normalized)?;
        paths::ensure_not_reserved(&normalized)?;
        let parent = absolute
            .parent()
            .ok_or_else(|| VaultError::PathOutside(relative.to_string()))?;
        let _gate = self.begin_write()?;
        // 父目录缺失时明确报错，而不是让 fs::create_dir 抛一个没有上下文的 ENOENT。
        match fs::symlink_metadata(parent) {
            Ok(metadata) if metadata.is_dir() => {}
            Ok(_) => {
                return Err(VaultError::NotFound(format!(
                    "上级路径不是文件夹：{}",
                    parent.display()
                )));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(VaultError::NotFound(format!(
                    "上级文件夹不存在：{}",
                    parent.display()
                )));
            }
            Err(error) => return Err(with_path(error.into(), parent)),
        }
        // 同名目录与同名文件的文案分开，前端可直接展示。
        match fs::symlink_metadata(&absolute) {
            Ok(metadata) if metadata.is_dir() => {
                return Err(VaultError::PathExists(format!(
                    "同名文件夹已存在：{normalized}"
                )));
            }
            Ok(_) => {
                return Err(VaultError::PathExists(format!(
                    "已有同名文件：{normalized}"
                )));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(with_path(error.into(), &absolute)),
        }
        match fs::create_dir(&absolute) {
            Ok(()) => Ok(normalized),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                Err(VaultError::PathExists(format!(
                    "同名文件夹已存在：{normalized}"
                )))
            }
            Err(error) => Err(with_path(error.into(), &absolute)),
        }
    }

    /// 删除文件夹：整个目录（连同文档与子目录）一次性进系统回收站。
    /// 系统回收站不可用即失败，不降级库内、不拆成逐个文件删除。
    /// 目录本就不存在时视为成功，便于幂等对账。
    pub fn remove_dir(&self, relative: &str) -> VaultResult<()> {
        self.remove_dir_with(relative, trash::trash_system_only)
    }

    /// `remove_dir` 的落点注入版本：单测用假回收站验证「整体一次移走」，
    /// 生产只经由 [`trash::trash_system_only`]。
    fn remove_dir_with(
        &self,
        relative: &str,
        trash: impl FnOnce(&Path, &Path) -> VaultResult<()>,
    ) -> VaultResult<()> {
        self.ensure_writable()?;
        let (absolute, normalized) = paths::resolve(&self.root, relative)?;
        paths::ensure_not_reserved(&normalized)?;
        let _gate = self.begin_write()?;
        let metadata = match fs::symlink_metadata(&absolute) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(with_path(error.into(), &absolute)),
        };
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(VaultError::IoAt {
                path: absolute.display().to_string(),
                message: "只能删除文件夹（符号链接与普通文件请走文章删除）".to_string(),
            });
        }
        trash(&self.root, &absolute)
    }

    /// 全库目录清单（相对 POSIX 路径，字典序）：空目录也会出现，供文档树与「移动到…」使用。
    /// 跳过规则与 `list` 一致，额外排除 `media/`（内核自管存储）与保留路径；不跟随符号链接。
    pub fn list_dirs(&self) -> VaultResult<Vec<String>> {
        let ignored = ignored_dirs(&self.root);
        let mut dirs = Vec::new();
        collect_dirs(&self.root, &self.root, &ignored, &mut dirs)?;
        dirs.sort();
        Ok(dirs)
    }

    /// 全库 Markdown 文件清单（相对 POSIX 路径，字典序），跳过 `.workbench/`、
    /// 隐藏目录与忽略目录（`node_modules`、`.git` 及 settings 配置项）。
    pub fn list(&self) -> VaultResult<Vec<String>> {
        let ignored = ignored_dirs(&self.root);
        let mut files = Vec::new();
        collect_documents(&self.root, &self.root, &ignored, &mut files)?;
        files.sort();
        Ok(files)
    }

    /// 画布清单（`.workbench/canvas/<id>.json` 的相对路径，字典序）。
    /// 与 `list` 分开：文档对账只关心 `.md`，画布库需要 `.json`；
    /// `vault_list` 保持只返回 Markdown 的契约，避免文档目录混入画布文件。
    pub fn list_canvases(&self) -> VaultResult<Vec<String>> {
        let dir = paths::workbench(&self.root).join("canvas");
        let entries = match fs::read_dir(&dir) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.into()),
        };
        let mut files = Vec::new();
        for entry in entries {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().to_string();
            if !entry.file_type()?.is_file() || !name.ends_with(".json") {
                continue;
            }
            files.push(format!("{CANVAS_DIR}/{name}"));
        }
        files.sort();
        Ok(files)
    }

    /// 库健康检查清单：只读遍历，返回文档、`.workbench` 画布/历史 JSON 与符号链接。
    /// 不跟随符号链接；`media/` 与 `settings.json` 等无关文件不返回，避免清单膨胀。
    pub fn scan(&self) -> VaultResult<Vec<ScanEntry>> {
        let ignored = ignored_dirs(&self.root);
        let mut entries = Vec::new();
        collect_scan(&self.root, &self.root, &ignored, &mut entries)?;
        entries.sort_by(|left, right| left.path.cmp(&right.path));
        Ok(entries)
    }

    pub fn stat(&self, relative: &str) -> VaultResult<Option<StatInfo>> {
        let (absolute, _) = paths::resolve(&self.root, relative)?;
        let metadata = match fs::metadata(&absolute) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let millis = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or_default();
        #[cfg(unix)]
        let (dev, ino) = (metadata.dev(), metadata.ino());
        #[cfg(not(unix))]
        let (dev, ino) = (0, 0);
        Ok(Some(StatInfo {
            mtime: clock::iso8601(millis),
            size: metadata.len(),
            dev,
            ino,
        }))
    }

    /// 库外状态根（迁移快照、历史日志、锁之外的所有派生记录）。
    pub fn state_dir(&self) -> PathBuf {
        paths::vault_state_dir(&self.root)
    }

    /// 读库外状态；不存在返回 None。只读会话也允许读（历史预览本身不写盘）。
    pub fn state_read(&self, relative: &str) -> VaultResult<Option<Vec<u8>>> {
        let (absolute, _) = paths::resolve(&self.state_dir(), relative)?;
        match fs::read(&absolute) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    /// 原子写库外状态；自动创建父目录。库只读时同样拒绝（历史是写入的派生数据）。
    pub fn state_write(&self, relative: &str, bytes: &[u8]) -> VaultResult<()> {
        self.ensure_writable()?;
        let (absolute, _) = paths::resolve(&self.state_dir(), relative)?;
        let _gate = self.begin_write()?;
        if let Some(parent) = absolute.parent() {
            fs::create_dir_all(parent)?;
        }
        atomic::write_atomic(&absolute, bytes).map_err(|error| with_path(error, &absolute))
    }

    /// 列出库外某个目录下的直接子项名称（文件与文件夹都返回，字典序）。
    /// `relative` 为空串表示状态根本身。
    pub fn state_list(&self, relative: &str) -> VaultResult<Vec<String>> {
        let dir = if relative.is_empty() {
            self.state_dir()
        } else {
            paths::resolve(&self.state_dir(), relative)?.0
        };
        let entries = match fs::read_dir(&dir) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.into()),
        };
        let mut names = Vec::new();
        for entry in entries {
            names.push(entry?.file_name().to_string_lossy().to_string());
        }
        names.sort();
        Ok(names)
    }

    /// 永久删除库外状态；不存在视为成功（历史裁剪与回滚都是幂等的）。
    pub fn state_purge(&self, relative: &str) -> VaultResult<()> {
        self.ensure_writable()?;
        let (absolute, _) = paths::resolve(&self.state_dir(), relative)?;
        let _gate = self.begin_write()?;
        match fs::remove_file(&absolute) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(with_path(error.into(), &absolute)),
        }
    }

    /// 当前是否允许写入：启动即持锁则整个会话可写（独占创建模型下运行期不会失守）。
    pub fn writable(&self) -> bool {
        self.ensure_writable().is_ok()
    }

    pub(crate) fn ensure_writable(&self) -> VaultResult<()> {
        // 启动时没抢到锁（被其它实例占用）→ 拒绝写入。
        if self.initially_readonly {
            return Err(VaultError::Readonly);
        }
        Ok(())
    }

    /// 进入写入临界区：write_gate 串行化所有落盘路径（正文、删除、改名、图片），
    /// 保证同一实例内的检查与写盘不被其它写操作插入。
    pub(crate) fn begin_write(&self) -> VaultResult<MutexGuard<'_, ()>> {
        let gate = self
            .write_gate
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        Ok(gate)
    }
}

/// 用户可见文件夹名的后端校验：只看归一化路径的最后一段。
/// 前端与服务层各有同一套规则，这里独立再判一次，不信任调用方。
fn validate_dir_name(normalized: &str) -> VaultResult<()> {
    let name = normalized.rsplit('/').next().unwrap_or(normalized);
    let reject = |message: &str| Err(VaultError::Encoding(message.to_string()));
    if name.is_empty() {
        return reject("文件夹名称不能为空");
    }
    if name == "." || name == ".." {
        return reject("文件夹名称不能是 . 或 ..");
    }
    if name.contains('/') || name.contains('\\') {
        return reject("文件夹名称不能包含斜杠");
    }
    // 隐藏目录不进入库索引范围，用户也不该从 UI 造出看不见的文件夹。
    // 逐段检查：直接 IPC 传入 `.workbench/x` 这类路径同样要拦住。
    if normalized
        .split('/')
        .any(|segment| segment.starts_with('.'))
    {
        return reject("路径不能包含隐藏目录");
    }
    if name.eq_ignore_ascii_case(paths::MEDIA_DIR) {
        return reject("media 是库保留目录，不能用作文件夹名");
    }
    if name.chars().any(|character| character.is_control()) {
        return reject("文件夹名称包含非法字符");
    }
    Ok(())
}

/// 库位置可写探测：锁已迁到库外，不能再靠「能否在 `.workbench` 建锁」判断。
/// 这里只看库根目录的写权限位——不写任何文件，避免在 iCloud 库里制造临时文件。
#[cfg(unix)]
fn writable_probe(root: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;

    match fs::metadata(root) {
        Ok(metadata) => metadata.permissions().mode() & 0o222 != 0,
        Err(_) => false,
    }
}

#[cfg(not(unix))]
fn writable_probe(root: &Path) -> bool {
    fs::metadata(root)
        .map(|metadata| !metadata.permissions().readonly())
        .unwrap_or(false)
}

/// 给 IO 错误补上绝对磁盘路径，便于用户直接定位文件。
fn with_path(error: VaultError, path: &Path) -> VaultError {
    match error {
        VaultError::Io(inner) => VaultError::IoAt {
            path: path.display().to_string(),
            message: inner.to_string(),
        },
        other => other,
    }
}

/// 启动期惰性清扫（持锁后执行；只读观察者不执行）。
///
/// - `.workbench/` 与内容区里孤儿 `.ember-tmp-` 临时文件（>24h）：崩溃遗留，按
///   原子写临时名整名精确匹配 + 普通文件校验，用户文件即使名字含该子串也不碰；
/// - `.workbench/trash/<ULID>/`（>30 天）：删除降级到库内回收目录后的惰性回收
///   （系统回收站可用时不会产生这类副本）。
///
/// 全部失败只记日志不影响启动；mtime 不可读按保守不删处理。
/// 24h 年龄门槛远大于一次原子写的存活时间，不会误删在途 temp。
fn sweep_housekeeping(root: &Path) {
    let now = SystemTime::now();
    let workbench = paths::workbench(root);
    // `.workbench` 单独扫一遍；内容区扫描排除该子树，避免重复计数
    let temps =
        sweep_orphan_temps(&workbench, now, None) + sweep_orphan_temps(root, now, Some(&workbench));
    let claims = sweep_claim_copies(root, now);
    let trash = sweep_expired_trash(root, now);
    if temps > 0 || claims > 0 || trash > 0 {
        eprintln!("启动清扫：清理 {temps} 个孤儿临时文件、{claims} 个失效锁认领副本、{trash} 个过期回收目录");
    }
}

/// 锁目录顶层：认领者在 rename 拿走死锁之后、删除副本之前崩溃留下的
/// `lock.claim.<pid>.<seq>` 文件。锁已迁到库外；`.workbench/` 也扫一遍，
/// 清理旧版本遗留的认领副本。复用孤儿 temp 的 24h 门槛——认领到删除只隔
/// 几条指令，超龄副本必然是崩溃残留；只匹配数字后缀形态，`lock` 本身一律不碰。
fn sweep_claim_copies(root: &Path, now: SystemTime) -> usize {
    let mut removed = 0usize;
    for dir in [paths::lock_dir(root), paths::workbench(root)] {
        let entries = match fs::read_dir(&dir) {
            Ok(value) => value,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            if !entry.file_type().map(|kind| kind.is_file()).unwrap_or(false) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let Some(rest) = name.strip_prefix("lock.claim.") else {
                continue;
            };
            let numeric = rest
                .split('.')
                .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()));
            if !numeric || rest.is_empty() {
                continue;
            }
            let path = entry.path();
            if !older_than(&path, now, ORPHAN_TEMP_MAX_AGE) {
                continue;
            }
            if fs::remove_file(&path).is_ok() {
                removed += 1;
            }
        }
    }
    removed
}

/// 原子写临时名形如 `.{目标文件名}.ember-tmp-{纳秒}-{序号}`（见 `atomic::temp_path`）。
/// 只认整名精确匹配：用户自带 `.ember-tmp-` 子串的文件不得被当作孤儿。
fn is_orphan_temp_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix('.') else {
        return false;
    };
    let Some(index) = rest.rfind(".ember-tmp-") else {
        return false;
    };
    if index == 0 {
        return false;
    }
    let suffix = &rest[index + ".ember-tmp-".len()..];
    let mut parts = suffix.split('-');
    let (Some(nanos), Some(counter), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    [nanos, counter]
        .iter()
        .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
}

fn sweep_orphan_temps(dir: &Path, now: SystemTime, excluded: Option<&Path>) -> usize {
    let mut removed = 0usize;
    let entries = match fs::read_dir(dir) {
        Ok(value) => value,
        Err(_) => return 0,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if excluded == Some(path.as_path()) {
            continue;
        }
        match entry.file_type() {
            // 符号链接两臂都不命中（与 resolve 的拒链接策略一致）
            Ok(file_type) if file_type.is_dir() => {
                removed += sweep_orphan_temps(&path, now, excluded);
            }
            Ok(file_type) if file_type.is_file() => {
                let name = entry.file_name();
                if !is_orphan_temp_name(&name.to_string_lossy()) {
                    continue;
                }
                if !older_than(&path, now, ORPHAN_TEMP_MAX_AGE) {
                    continue;
                }
                // 删前复核：symlink_metadata 不跟随链接，符号链接一律跳过
                let regular = fs::symlink_metadata(&path)
                    .map(|meta| meta.file_type().is_file())
                    .unwrap_or(false);
                if !regular {
                    continue;
                }
                if fs::remove_file(&path).is_ok() {
                    removed += 1;
                }
            }
            _ => {}
        }
    }
    removed
}

fn sweep_expired_trash(root: &Path, now: SystemTime) -> usize {
    let trash = root.join(paths::WORKBENCH_DIR).join("trash");
    let mut removed = 0usize;
    let entries = match fs::read_dir(&trash) {
        Ok(value) => value,
        Err(_) => return 0,
    };
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        if !older_than(&entry.path(), now, TRASH_RETENTION) {
            continue;
        }
        if fs::remove_dir_all(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

fn older_than(path: &Path, now: SystemTime, max_age: Duration) -> bool {
    match fs::metadata(path).and_then(|metadata| metadata.modified()) {
        Ok(modified) => now
            .duration_since(modified)
            .map(|age| age > max_age)
            .unwrap_or(false),
        Err(_) => false,
    }
}

/// 读取 `<vault>/.workbench/settings.json` 的库身份；缺失时生成 ULID 并落盘。
/// 只读不改写，未知键原样保留（v1 不重写该文件）。
fn ensure_identity(root: &Path) -> VaultResult<String> {
    let file = paths::settings_file(root);
    match fs::read_to_string(&file) {
        Ok(text) => identity_from(&text),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => create_identity(root, &file),
        // 存在但读不出来时不能重建身份，否则会静默换掉库 ID。
        Err(error) => Err(error.into()),
    }
}

fn create_identity(root: &Path, file: &Path) -> VaultResult<String> {
    let id = ulid::generate();
    let name = root
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "Ember Vault".to_string());
    let settings = serde_json::json!({
        "schemaVersion": SETTINGS_SCHEMA_VERSION,
        "vault": {
            "id": id,
            "name": name,
            "createdAt": clock::now_iso8601(),
        },
        "ui": {},
        "linkOverrides": {},
    });
    fs::create_dir_all(paths::workbench(root))?;
    atomic::write_atomic(file, &serde_json::to_vec_pretty(&settings)?)?;
    Ok(id)
}

fn identity_from(text: &str) -> VaultResult<String> {
    let value: serde_json::Value = serde_json::from_str(text)?;
    let version = value
        .get("schemaVersion")
        .and_then(|item| item.as_u64())
        .ok_or_else(|| VaultError::Encoding("settings.json 缺少 schemaVersion".to_string()))?;
    if version != SETTINGS_SCHEMA_VERSION {
        return Err(VaultError::Encoding(format!(
            "settings.json schemaVersion={version}，当前应用只支持 {SETTINGS_SCHEMA_VERSION}"
        )));
    }
    let id = value
        .pointer("/vault/id")
        .and_then(|item| item.as_str())
        .ok_or(VaultError::Uninitialized)?;
    if !ulid::is_ulid(id) {
        return Err(VaultError::Uninitialized);
    }
    Ok(id.to_string())
}

/// 目录清单遍历：与 `collect_documents` 同一套跳过规则，但不要求目录里有 `.md`，
/// 因此空目录（含多级空目录）也会被收录。
fn collect_dirs(
    root: &Path,
    dir: &Path,
    ignored: &[String],
    out: &mut Vec<String>,
) -> VaultResult<()> {
    let entries = match fs::read_dir(dir) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name == paths::WORKBENCH_DIR || name.starts_with('.') || is_ignored_dir(&name, ignored) {
            continue;
        }
        // file_type 不跟随符号链接：指向库外的目录链接在这里直接跳过。
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let relative = match entry.path().strip_prefix(root) {
            Ok(value) => value.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        if relative == paths::MEDIA_DIR || paths::is_reserved(&relative) {
            continue;
        }
        out.push(relative);
        collect_dirs(root, &entry.path(), ignored, out)?;
    }
    Ok(())
}

fn collect_documents(
    root: &Path,
    dir: &Path,
    ignored: &[String],
    out: &mut Vec<String>,
) -> VaultResult<()> {
    let entries = match fs::read_dir(dir) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name == paths::WORKBENCH_DIR || name.starts_with('.') || is_ignored_dir(&name, ignored) {
            continue;
        }
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            collect_documents(root, &entry.path(), ignored, out)?;
            continue;
        }
        if !file_type.is_file() || !name.ends_with(".md") {
            continue;
        }
        let relative = entry.path();
        if let Ok(stripped) = relative.strip_prefix(root) {
            out.push(stripped.to_string_lossy().replace('\\', "/"));
        }
    }
    Ok(())
}

/// 库健康检查清单条目：`kind` 为 `file` 或 `symlink`。
#[derive(serde::Serialize)]
pub struct ScanEntry {
    pub path: String,
    pub kind: String,
    /// 普通文件为字节数；符号链接为链接自身长度
    pub size: u64,
}

fn collect_scan(
    root: &Path,
    dir: &Path,
    ignored: &[String],
    out: &mut Vec<ScanEntry>,
) -> VaultResult<()> {
    let entries = match fs::read_dir(dir) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if is_ignored_dir(&name, ignored) {
            continue;
        }
        // 除 .workbench 外，隐藏项不进入库索引范围（与 collect_documents 一致）
        if name.starts_with('.') && name != paths::WORKBENCH_DIR {
            continue;
        }
        let absolute = entry.path();
        let relative = match absolute.strip_prefix(root) {
            Ok(value) => value.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        // 历史回收与备份不属于体检范围
        if relative == ".workbench/trash" || relative == ".workbench/backup" {
            continue;
        }
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            // 只记录链接自身，绝不跟随到库外目录
            let size = fs::symlink_metadata(&absolute)
                .map(|metadata| metadata.len())
                .unwrap_or_default();
            out.push(ScanEntry {
                path: relative,
                kind: "symlink".to_string(),
                size,
            });
            continue;
        }
        if file_type.is_dir() {
            collect_scan(root, &absolute, ignored, out)?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let in_workbench_json = (relative.starts_with(".workbench/canvas/")
            || relative.starts_with(".workbench/history/"))
            && name.ends_with(".json");
        let is_markdown = name.ends_with(".md") || name.ends_with(".markdown");
        if !is_markdown && !in_workbench_json {
            continue;
        }
        out.push(ScanEntry {
            path: relative,
            kind: "file".to_string(),
            size: entry.metadata()?.len(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    static TEMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    struct TempVault {
        vault: Vault,
        root: PathBuf,
    }

    impl TempVault {
        fn new() -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or_default();
            let seq = TEMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let root = std::env::temp_dir()
                .join(format!("ember-vault-{}-{nanos}-{seq}", std::process::id()));
            fs::create_dir_all(&root).unwrap();
            let vault = Vault::open(root.clone()).unwrap();
            Self { vault, root }
        }
    }

    impl Drop for TempVault {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
            // 锁与库外状态都在 App Support：测试自己清掉，避免污染真实目录。
            let _ = fs::remove_dir_all(paths::lock_dir(&self.root));
            let _ = fs::remove_dir_all(paths::vault_state_dir(&self.root));
        }
    }

    fn reserved_code(error: VaultError) -> String {
        assert!(
            matches!(error, VaultError::PathOutside(ref message) if message.contains("保留路径")),
            "应为保留路径错误：{error}"
        );
        error.code().to_string()
    }

    #[test]
    fn write_rejects_reserved_paths_but_keeps_frontend_targets() {
        let temp = TempVault::new();

        for path in [
            ".workbench/.lock",
            ".workbench",
            ".doc.md.ember-tmp-1731234567-1",
            "media/ab/01J.png",
        ] {
            let error = temp.vault.write(path, b"x", "user").unwrap_err();
            assert_eq!(reserved_code(error), "path_outside_vault", "路径：{path}");
        }

        // 前端合法写入目标不受影响。
        temp.vault.write("notes/a.md", b"# hi", "user").unwrap();
        temp.vault
            .write(".workbench/settings.json", b"{}", "user")
            .unwrap();
        temp.vault
            .write(".workbench/canvas/01J.json", b"{}", "user")
            .unwrap();
    }

    #[test]
    fn remove_rejects_reserved_paths() {
        let temp = TempVault::new();
        temp.vault.write("notes/a.md", b"x", "user").unwrap();

        for path in [".workbench/.lock", "media/x.png"] {
            let error = temp.vault.remove(path).unwrap_err();
            assert_eq!(reserved_code(error), "path_outside_vault", "路径：{path}");
        }
        // 保留路径之外的清理走 purge，避免把测试文件塞进用户回收站（真实落点由下方专测覆盖）
        temp.vault.purge("notes/a.md").unwrap();
    }

    #[test]
    fn list_skips_dependency_and_configured_dirs() {
        let temp = TempVault::new();
        temp.vault.write("notes/a.md", b"x", "user").unwrap();
        temp.vault
            .write("node_modules/pkg/readme.md", b"x", "user")
            .unwrap();
        temp.vault.write("vendor/dep/doc.md", b"x", "user").unwrap();
        temp.vault
            .write(
                ".workbench/settings.json",
                br#"{"watcherIgnoreDirs":["vendor"]}"#,
                "user",
            )
            .unwrap();

        assert_eq!(temp.vault.list().unwrap(), vec!["notes/a.md".to_string()]);
    }

    #[test]
    fn remove_missing_file_is_idempotent() {
        let temp = TempVault::new();
        // 内核做幂等对账：不存在就是成功，不报错、不产生回收站动作
        assert_eq!(temp.vault.remove("notes/never-existent.md").unwrap(), None);
        temp.vault.purge("notes/never-existent.md").unwrap();
    }

    #[test]
    fn remove_on_readonly_vault_is_rejected() {
        let temp = TempVault::new();
        temp.vault.write("notes/a.md", b"x", "user").unwrap();

        // 同库第二个实例抢不到锁 → 只读观察者；删除必须在触盘前被拒
        let observer = Vault::open(temp.root.clone()).unwrap();
        assert!(!observer.writable(), "第二个实例应为只读观察者");
        let error = observer.remove("notes/a.md").unwrap_err();
        assert!(matches!(error, VaultError::Readonly), "只读库删除应被拒：{error}");
        assert_eq!(error.code(), "vault_locked");
        assert!(temp.root.join("notes/a.md").exists(), "文件必须保持原样");
    }

    /// 系统回收站落点（本地卷：`~/.Trash/<name>`）。测试只接受绝对落点，避免误删。
    #[cfg(target_os = "macos")]
    fn system_trash_path(name: &str) -> PathBuf {
        let home = std::env::var("HOME").expect("测试机应有 HOME");
        PathBuf::from(home).join(".Trash").join(name)
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn remove_moves_document_into_system_trash() {
        let temp = TempVault::new();
        let name = format!("ember-trash-{}.md", ulid::generate());
        let relative = format!("notes/{name}");
        temp.vault.write(&relative, b"trash me", "user").unwrap();
        let source = temp.root.join("notes").join(&name);
        let landed = system_trash_path(&name);
        assert!(!landed.exists(), "回收站不应已有同名残留：{}", landed.display());

        let destination = temp.vault.remove(&relative).unwrap();

        assert_eq!(destination, Some(trash::TrashDestination::System));
        assert!(!source.exists(), "源文件必须离开库内");
        assert!(
            temp.vault
                .list()
                .unwrap()
                .iter()
                .all(|path| path != &relative),
            "库清单不得再包含被删文档"
        );
        assert!(
            landed.exists(),
            "文件应出现在系统回收站：{}",
            landed.display()
        );
        // 清理：测完从回收站删除，不污染用户回收站
        fs::remove_file(&landed).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn purge_deletes_permanently_without_touching_trash() {
        let temp = TempVault::new();
        let name = format!("ember-purge-{}.md", ulid::generate());
        let relative = format!("notes/{name}");
        temp.vault.write(&relative, b"purge me", "user").unwrap();
        let landed = system_trash_path(&name);

        temp.vault.purge(&relative).unwrap();

        assert!(!temp.root.join("notes").join(&name).exists());
        assert!(!landed.exists(), "回滚用永久删除不得在回收站留痕");
    }

    #[test]
    fn rename_rejects_reserved_paths_on_both_ends() {
        let temp = TempVault::new();
        temp.vault.write("notes/a.md", b"x", "user").unwrap();

        // 改名进保留路径
        let error = temp
            .vault
            .rename("notes/a.md", ".workbench/.lock")
            .unwrap_err();
        assert_eq!(reserved_code(error), "path_outside_vault");
        // 合法改名不受影响
        temp.vault.rename("notes/a.md", "notes/b.md").unwrap();
        assert!(temp.vault.read("notes/b.md").unwrap().is_some());
    }

    #[test]
    fn rename_refuses_existing_target_and_keeps_both_files() {
        let temp = TempVault::new();
        temp.vault.write("notes/a.md", b"source", "user").unwrap();
        temp.vault.write("notes/b.md", b"target", "user").unwrap();

        let error = temp.vault.rename("notes/a.md", "notes/b.md").unwrap_err();
        assert_eq!(error.code(), "path_exists");
        assert_eq!(
            temp.vault.read("notes/a.md").unwrap().unwrap().as_slice(),
            b"source"
        );
        assert_eq!(
            temp.vault.read("notes/b.md").unwrap().unwrap().as_slice(),
            b"target"
        );

        // 目标空出来之后仍可正常改名
        temp.vault.rename("notes/a.md", "notes/c.md").unwrap();
        assert!(temp.vault.read("notes/c.md").unwrap().is_some());
        assert!(temp.vault.read("notes/a.md").unwrap().is_none());
    }

    #[test]
    fn write_rejects_unknown_intent_and_accepts_the_three_known_ones() {
        let temp = TempVault::new();

        let error = temp.vault.write("notes/a.md", b"x", "renderer").unwrap_err();
        assert_eq!(error.code(), "invalid_payload");
        assert!(temp.vault.read("notes/a.md").unwrap().is_none());

        for intent in ["user", "migration", "system"] {
            temp.vault.write("notes/a.md", b"x", intent).unwrap();
        }
    }

    #[test]
    fn write_rejects_traversal_still_works() {
        let temp = TempVault::new();
        let error = temp.vault.write("../outside.md", b"x", "user").unwrap_err();
        assert!(matches!(error, VaultError::PathOutside(_)));
    }

    #[test]
    fn write_rejects_case_variant_reserved_paths() {
        let temp = TempVault::new();
        // 字符串层大小写折叠拦截（不依赖文件系统是否大小写不敏感）。
        for path in [".WORKBENCH/.lock", "Media/ab/x.png"] {
            let error = temp.vault.write(path, b"x", "user").unwrap_err();
            assert_eq!(reserved_code(error), "path_outside_vault", "路径：{path}");
        }
    }

    #[test]
    fn stale_lock_from_dead_process_is_reclaimed_on_open() {
        let temp = TempVault::new();
        temp.vault.write("notes/a.md", b"first", "user").unwrap();

        // 上个实例崩溃遗留的锁（pid 已死）：本次启动直接接管，可写。
        let stale = lock::LockPayload {
            vault_id: temp.vault.id().to_string(),
            pid: 999_999_999,
            machine_id: "01JFORGEDMACHINEID000000".to_string(),
            started_at: clock::now_iso8601(),
            app: "0.0.0".to_string(),
        };
        atomic::write_atomic(
            &paths::lock_file(&temp.root),
            &serde_json::to_vec(&stale).unwrap(),
        )
        .unwrap();

        let reopened = Vault::open(temp.root.clone()).unwrap();
        assert!(reopened.writable(), "死 pid 的遗留锁应被接管而不是只读");
        reopened.write("notes/a.md", b"second", "user").unwrap();
        assert_eq!(fs::read(temp.root.join("notes/a.md")).unwrap(), b"second");
    }

    #[test]
    fn unsupported_settings_version_fails_without_rewriting_file() {
        let temp = TempVault::new();
        let settings = paths::settings_file(&temp.root);
        let mut value: serde_json::Value =
            serde_json::from_slice(&fs::read(&settings).unwrap()).unwrap();
        value["schemaVersion"] = serde_json::json!(2);
        let bytes = serde_json::to_vec_pretty(&value).unwrap();
        fs::write(&settings, &bytes).unwrap();

        // 启动失败要带回可读原因（前端据此显示启动失败页），且不得覆盖用户文件
        let Err(error) = Vault::open(temp.root.clone()) else {
            panic!("高版本 settings 不应打开成功");
        };
        assert!(
            matches!(error, VaultError::Encoding(ref message) if message.contains("schemaVersion=2")),
            "应为版本错误：{error}"
        );
        assert_eq!(fs::read(&settings).unwrap(), bytes, "不得改写用户文件");
    }

    /// 用 touch -t 把目标 mtime 拨到 2020-01-01，模拟「早已存在」。
    fn backdate(path: &Path) {
        let status = std::process::Command::new("/usr/bin/touch")
            .args(["-t", "202001010000"])
            .arg(path)
            .status()
            .expect("touch 可用");
        assert!(status.success(), "touch -t 执行失败");
    }

    #[test]
    fn housekeeping_sweeps_orphan_temps_and_expired_trash() {
        let temp = TempVault::new();
        temp.vault.write("notes/a.md", b"body", "user").unwrap();

        // 内容区崩溃遗留的临时文件：与 .workbench 同样的精确匹配 + 超龄即回收
        let orphan = temp.root.join("notes").join(".a.md.ember-tmp-100-1");
        fs::write(&orphan, b"half").unwrap();
        backdate(&orphan);
        // 新鲜临时文件：在途写入，不得误删
        let fresh = temp.root.join("notes").join(".b.md.ember-tmp-200-2");
        fs::write(&fresh, b"writing").unwrap();
        // `.workbench/` 内崩溃遗留的锁 temp 也要回收，但在途 temp 不得误删
        let stale_internal = temp.root.join(".workbench").join(".lock.ember-tmp-100-3");
        fs::write(&stale_internal, b"stale").unwrap();
        backdate(&stale_internal);
        let fresh_internal = temp.root.join(".workbench").join(".lock.ember-tmp-200-4");
        fs::write(&fresh_internal, b"writing").unwrap();
        // 过期与保留期内的回收目录
        let expired_trash = temp.root.join(".workbench").join("trash").join("01JOLD");
        let fresh_trash = temp.root.join(".workbench").join("trash").join("01JNEW");
        fs::create_dir_all(expired_trash.join("a.md")).unwrap();
        fs::write(expired_trash.join("a.md").join("x.md"), b"deleted").unwrap();
        fs::create_dir_all(&fresh_trash).unwrap();
        backdate(&expired_trash);

        let now = SystemTime::now();
        let temps = sweep_orphan_temps(&paths::workbench(&temp.root), now, None)
            + sweep_orphan_temps(&temp.root, now, Some(&paths::workbench(&temp.root)));
        let trash = sweep_expired_trash(&temp.root, now);

        assert_eq!(temps, 2, "回收 .workbench 与内容区的孤儿临时文件");
        assert_eq!(trash, 1, "只清理过期回收目录");
        assert!(!orphan.exists(), "内容区超龄孤儿临时文件应被回收");
        assert!(fresh.exists(), "在途临时文件不得误删");
        assert!(!stale_internal.exists(), ".workbench 内超龄 temp 应被回收");
        assert!(fresh_internal.exists(), "在途 temp 不得误删");
        assert!(!expired_trash.exists(), "过期回收目录应被回收");
        assert!(fresh_trash.exists(), "保留期内的回收目录不得误删");
        assert!(temp.vault.read("notes/a.md").unwrap().is_some(), "正文不受清扫影响");
    }

    #[test]
    fn housekeeping_sweeps_content_area_only_on_exact_orphan_names() {
        let temp = TempVault::new();
        let workbench = paths::workbench(&temp.root);
        let notes = temp.root.join("notes");
        fs::create_dir_all(&notes).unwrap();
        // 内容区精确名超龄 → 删
        let exact = notes.join(".a.md.ember-tmp-100-1");
        fs::write(&exact, b"orphan").unwrap();
        backdate(&exact);
        // 只含子串（缺纳秒/序号）→ 不删，库根与内容区各一
        let lookalike_root = temp.root.join("report.ember-tmp-backup.md");
        fs::write(&lookalike_root, b"user data").unwrap();
        backdate(&lookalike_root);
        let lookalike_notes = notes.join("notes.ember-tmp-backup.md");
        fs::write(&lookalike_notes, b"user data").unwrap();
        backdate(&lookalike_notes);
        // 符号链接即使名字精确也不删
        let target = notes.join("keep.txt");
        fs::write(&target, b"keep").unwrap();
        backdate(&target);
        #[cfg(unix)]
        {
            let link = notes.join(".link.ember-tmp-100-2");
            std::os::unix::fs::symlink(&target, &link).unwrap();
        }

        let removed = sweep_orphan_temps(&temp.root, SystemTime::now(), Some(&workbench));

        assert_eq!(removed, 1);
        assert!(!exact.exists(), "内容区精确名超龄 temp 应被回收");
        assert!(lookalike_root.exists(), "只含子串的用户文件不得删除");
        assert!(lookalike_notes.exists(), "只含子串的用户文件不得删除");
        #[cfg(unix)]
        {
            assert!(target.exists(), "符号链接目标不得删除");
            assert!(notes.join(".link.ember-tmp-100-2").symlink_metadata().is_ok());
        }
    }

    #[test]
    fn housekeeping_sweeps_only_exact_temp_names_in_workbench() {
        let temp = TempVault::new();
        let workbench = paths::workbench(&temp.root);
        let exact = workbench.join(".lock.ember-tmp-100-1");
        fs::write(&exact, b"stale").unwrap();
        backdate(&exact);
        // 只有子串命中（缺纳秒/序号）的文件不得删除
        let embedded = workbench.join("notes.ember-tmp-backup.md");
        fs::write(&embedded, b"user").unwrap();
        backdate(&embedded);
        // 符号链接即使名字精确也不删
        let outside = tempfile_dir("ember-orphan-symlink");
        fs::create_dir_all(&outside).unwrap();
        let target = outside.join(".lock.ember-tmp-100-2");
        fs::write(&target, b"outside").unwrap();
        backdate(&target);
        #[cfg(unix)]
        {
            let link = workbench.join(".x.ember-tmp-100-3");
            std::os::unix::fs::symlink(&target, &link).unwrap();
        }

        let removed = sweep_orphan_temps(&workbench, SystemTime::now(), None);

        assert_eq!(removed, 1);
        assert!(!exact.exists(), "精确命名的超龄 temp 应被回收");
        assert!(embedded.exists(), "子串命中不得删除");
        #[cfg(unix)]
        {
            assert!(target.exists(), "符号链接目标不得删除");
            let link = workbench.join(".x.ember-tmp-100-3");
            assert!(link.symlink_metadata().is_ok(), "符号链接本身不得删除");
        }
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn symlink_prefixes_are_rejected() {
        let temp = TempVault::new();
        let outside = tempfile_dir("ember-symlink-outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.md"), b"outside").unwrap();

        let link_dir = temp.root.join("notes");
        fs::create_dir_all(&link_dir).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, link_dir.join("escape")).unwrap();

        // 目录链接：读/写都不得穿透
        let error = temp.vault.read("notes/escape/secret.md").unwrap_err();
        assert!(matches!(error, VaultError::PathOutside(_)));
        let error = temp
            .vault
            .write("notes/escape/planted.md", b"x", "user")
            .unwrap_err();
        assert!(matches!(error, VaultError::PathOutside(_)));
        let error = temp.vault.stat("notes/escape/secret.md").unwrap_err();
        assert!(matches!(error, VaultError::PathOutside(_)));

        fs::remove_dir_all(&outside).unwrap();
    }

    fn tempfile_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let seq = TEMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "{label}-{}-{nanos}-{seq}",
            std::process::id()
        ))
    }

    #[test]
    fn scan_reports_markdown_and_symlinks_without_following() {
        let temp = TempVault::new();
        temp.vault.write("notes/a.md", b"# a", "user").unwrap();
        temp.vault
            .write("notes/b.markdown", b"# b", "user")
            .unwrap();
        temp.vault
            .write(".workbench/canvas/x.json", b"{}", "user")
            .unwrap();
        temp.vault
            .write(".workbench/history/x.1.json", b"{}", "user")
            .unwrap();
        fs::create_dir_all(temp.root.join("media")).unwrap();
        fs::write(temp.root.join("media/pic.png"), b"png").unwrap();
        fs::create_dir_all(temp.root.join(".git")).unwrap();
        fs::write(temp.root.join(".git/config"), b"git").unwrap();

        let outside = tempfile_dir("ember-scan-outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.md"), b"# secret").unwrap();
        std::os::unix::fs::symlink(&outside, temp.root.join("notes/escape")).unwrap();

        let entries = temp.vault.scan().unwrap();
        let paths: Vec<&str> = entries.iter().map(|entry| entry.path.as_str()).collect();

        assert!(paths.contains(&"notes/a.md"));
        assert!(paths.contains(&"notes/b.markdown"));
        assert!(paths.contains(&".workbench/canvas/x.json"));
        assert!(paths.contains(&".workbench/history/x.1.json"));
        assert!(paths.contains(&"notes/escape"));
        assert!(!paths.iter().any(|path| path.ends_with("secret.md")));
        assert!(!paths.contains(&"media/pic.png"));
        assert!(!paths.contains(&".git/config"));

        let link = entries
            .iter()
            .find(|entry| entry.path == "notes/escape")
            .expect("符号链接应出现在清单中");
        assert_eq!(link.kind, "symlink");

        fs::remove_dir_all(&outside).unwrap();
    }

    #[test]
    fn open_missing_root_does_not_create_it() {
        let root = tempfile_dir("ember-missing-root");
        let Err(error) = Vault::open(root.clone()) else {
            panic!("不存在的库根不应打开成功");
        };
        assert!(matches!(error, VaultError::Startup(_)), "应为启动错误：{error}");
        assert!(!root.exists(), "打开既有库不得凭空创建目录");
    }

    #[test]
    fn open_existing_requires_identity_and_does_not_initialize() {
        let root = tempfile_dir("ember-existing-empty");
        fs::create_dir_all(&root).unwrap();

        let Err(error) = Vault::open_existing(root.clone()) else {
            panic!("缺少身份的目录不应打开成功");
        };
        assert!(matches!(error, VaultError::Startup(_)), "应为启动错误：{error}");
        assert!(
            !paths::workbench(&root).exists(),
            "既有目录缺身份时不得顺手初始化"
        );

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn open_or_init_prepares_settings_and_canvas() {
        let root = tempfile_dir("ember-init-root");
        let vault = Vault::open_or_init(root.clone()).unwrap();

        assert!(paths::settings_file(&root).is_file(), "应写入库身份");
        assert!(
            root.join(CANVAS_DIR).is_dir(),
            "应准备画布目录：{}",
            root.join(CANVAS_DIR).display()
        );
        assert!(vault.writable());
        drop(vault);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn create_dir_rejects_invalid_names_and_missing_parent() {
        let temp = TempVault::new();
        for path in [
            "",
            ".",
            "..",
            ".hidden",
            ".workbench/nested",
            "media",
            "MEDIA",
            "a\\b",
            "bad\u{0}name",
        ] {
            let error = temp.vault.create_dir(path).unwrap_err();
            assert!(
                matches!(error, VaultError::Encoding(_) | VaultError::PathOutside(_)),
                "应拒绝 {path}：{error}"
            );
        }
        let error = temp.vault.create_dir("missing/child").unwrap_err();
        assert!(matches!(error, VaultError::NotFound(_)), "父目录缺失应报不存在：{error}");
    }

    #[test]
    fn create_dir_reports_same_name_dir_and_file() {
        let temp = TempVault::new();
        assert_eq!(temp.vault.create_dir("notes").unwrap(), "notes");

        let error = temp.vault.create_dir("notes").unwrap_err();
        assert_eq!(error.code(), "path_exists");
        assert!(error.to_string().contains("同名文件夹"), "{error}");

        temp.vault.write("root.md", b"x", "user").unwrap();
        let error = temp.vault.create_dir("root.md").unwrap_err();
        assert_eq!(error.code(), "path_exists");
        assert!(error.to_string().contains("同名文件"), "{error}");
    }

    #[test]
    fn list_dirs_includes_empty_directories_and_skips_ignored() {
        let temp = TempVault::new();
        temp.vault.create_dir("empty").unwrap();
        temp.vault.create_dir("empty/deep").unwrap();
        temp.vault.create_dir("notes").unwrap();
        temp.vault.write("notes/a.md", b"x", "user").unwrap();
        fs::create_dir_all(temp.root.join("node_modules/pkg")).unwrap();
        fs::create_dir_all(temp.root.join(".hidden")).unwrap();
        fs::create_dir_all(temp.root.join("media/ab")).unwrap();

        assert_eq!(
            temp.vault.list_dirs().unwrap(),
            vec!["empty".to_string(), "empty/deep".to_string(), "notes".to_string()]
        );
    }

    #[test]
    fn remove_dir_rejects_files_and_reserved_paths() {
        let temp = TempVault::new();
        temp.vault.write("a.md", b"x", "user").unwrap();
        let error = temp.vault.remove_dir("a.md").unwrap_err();
        assert_eq!(error.code(), "io_failed");
        assert!(error.to_string().contains("只能删除文件夹"), "{error}");

        let error = temp.vault.remove_dir(".workbench").unwrap_err();
        assert_eq!(error.code(), "path_outside_vault");
        // 不存在的目录视为已删除，便于幂等对账。
        temp.vault.remove_dir("gone").unwrap();
    }

    #[test]
    fn remove_dir_trashes_non_empty_tree_as_one_unit() {
        let temp = TempVault::new();
        temp.vault.create_dir("notes").unwrap();
        temp.vault.create_dir("notes/sub").unwrap();
        temp.vault.write("notes/a.md", b"a", "user").unwrap();
        temp.vault.write("notes/sub/b.md", b"b", "user").unwrap();

        let trash_root = temp.root.join("fake-trash");
        let mut calls = 0;
        temp.vault
            .remove_dir_with("notes", |_, absolute| {
                calls += 1;
                fs::create_dir_all(&trash_root)?;
                let target = trash_root.join(absolute.file_name().unwrap());
                // 模拟系统回收站：整个目录一次 rename，不逐个文件删除。
                fs::rename(absolute, target)?;
                Ok(())
            })
            .unwrap();

        assert_eq!(calls, 1, "只应触发一次入篓动作");
        assert!(!temp.root.join("notes").exists(), "源目录应整体消失");
        assert!(trash_root.join("notes/a.md").is_file());
        assert!(trash_root.join("notes/sub/b.md").is_file());
    }

    #[test]
    fn remove_dir_failure_keeps_tree_intact() {
        let temp = TempVault::new();
        temp.vault.create_dir("notes").unwrap();
        temp.vault.create_dir("notes/sub").unwrap();
        temp.vault.write("notes/a.md", b"a", "user").unwrap();

        let error = temp
            .vault
            .remove_dir_with("notes", |_, absolute| {
                Err(VaultError::IoAt {
                    path: absolute.display().to_string(),
                    message: "系统回收站不可用".to_string(),
                })
            })
            .unwrap_err();

        assert!(error.to_string().contains("系统回收站不可用"), "{error}");
        assert!(temp.root.join("notes/a.md").is_file(), "失败时不得留下半删状态");
        assert!(temp.root.join("notes/sub").is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn readonly_location_degrades_to_observer_mode() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile_dir("ember-readonly-root");
        {
            let vault = Vault::open_or_init(root.clone()).unwrap();
            drop(vault);
        }
        // 锁文件在 .workbench 内：只读位置要连子目录一起收权，库根仍需可遍历。
        fs::set_permissions(&root, fs::Permissions::from_mode(0o555)).unwrap();
        fs::set_permissions(
            paths::workbench(&root),
            fs::Permissions::from_mode(0o555),
        )
        .unwrap();

        let opened = Vault::open(root.clone()).unwrap();
        assert!(!opened.writable(), "不可写位置应降级为只读");
        assert_eq!(
            opened.readonly_reason(),
            Some(lock::ReadonlyReason::FilesystemReadonly)
        );
        drop(opened);

        fs::set_permissions(
            paths::workbench(&root),
            fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
        fs::remove_dir_all(&root).unwrap();
    }
}
