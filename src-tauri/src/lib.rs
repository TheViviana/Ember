pub mod ai;
mod commands;
mod error;
mod vault;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // 库根解析与打开都收敛在 VaultApp：环境变量 → vaults.json →
            // 旧库（仅提示）→ 首启选择页；失败只记录，交给前端恢复入口。
            let session = vault::session::VaultApp::new(app.handle().clone());
            let view = session.startup();
            match &view {
                vault::session::StartupView::Ready { root, identity } => {
                    eprintln!(
                        "已打开库 {root}（vaultId={}，readonly={}）",
                        identity.vault_id, identity.readonly
                    );
                }
                vault::session::StartupView::Failed { message, .. } => {
                    eprintln!("库打开失败：{message}");
                }
                vault::session::StartupView::Choose { .. } => {
                    eprintln!("未找到已配置的库，等待用户选择");
                }
            }
            app.manage(session);
            app.manage(commands::ai::AiState::new());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::vault_startup_state,
            commands::vault_open,
            commands::vault_retry,
            commands::vault_choose_directory,
            commands::vault_current_info,
            commands::vault_identity,
            commands::vault_read,
            commands::vault_write,
            commands::vault_remove,
            commands::vault_purge,
            commands::vault_rename,
            commands::vault_list,
            commands::vault_create_dir,
            commands::vault_remove_dir,
            commands::vault_list_dirs,
            commands::vault_list_canvases,
            commands::vault_stat,
            commands::vault_scan,
            commands::asset_list,
            commands::asset_read,
            commands::asset_save,
            commands::asset_delete,
            commands::machine_ui_read,
            commands::machine_ui_write,
            commands::machine_ai_read,
            commands::machine_ai_write,
            commands::vault_backup_default_destination,
            commands::vault_backup_export,
            commands::vault_backup_inspect,
            commands::window_resize_frame,
            commands::ai::ai_key_save,
            commands::ai::ai_key_status,
            commands::ai::ai_key_delete,
            commands::ai::ai_test_connection,
            commands::ai::ai_list_models,
            commands::ai::ai_chat_stream,
            commands::ai::ai_chat_cancel,
            commands::ai::ai_translate_public,
        ])
        .run(tauri::generate_context!())
        .expect("Ember 启动失败");
}
