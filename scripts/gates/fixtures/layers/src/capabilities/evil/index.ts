import { invoke } from '@tauri-apps/api/core';

export const call = (): Promise<unknown> => invoke('fixture.evil');
