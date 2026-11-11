pub mod ai;
mod commands;
mod error;
mod vault;

use std::path::PathBuf;

use tauri::Manager;

use crate::vault::watcher::Watcher;

/// 库根：`EMBER_VAULT` 优先，缺省 `~/Documents/EmberVault`。
fn resolve_root() -> PathBuf {
    if let Ok(value) = std::env::var("EMBER_VAULT") {
        if !value.is_empty() {
            return PathBuf::from(value);
        }
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join("Documents").join("EmberVault")
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let root = resolve_root();
            let vault = vault::Vault::open(root)?;
            let watcher = vault::watcher::spawn(app.handle().clone(), vault.root().to_path_buf());
            app.manage(vault);
            app.manage::<Watcher>(watcher);
            app.manage(commands::ai::AiState::new());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::vault_identity,
            commands::vault_init,
            commands::vault_read,
            commands::vault_write,
            commands::vault_remove,
            commands::vault_rename,
            commands::vault_list,
            commands::vault_stat,
            commands::asset_list,
            commands::asset_read,
            commands::asset_save,
            commands::machine_ui_read,
            commands::machine_ui_write,
            commands::window_resize_frame,
            commands::ai::ai_key_save,
            commands::ai::ai_key_status,
            commands::ai::ai_key_delete,
            commands::ai::ai_test_connection,
            commands::ai::ai_list_models,
            commands::ai::ai_chat_stream,
            commands::ai::ai_chat_cancel,
        ])
        .run(tauri::generate_context!())
        .expect("Ember 启动失败");
}
