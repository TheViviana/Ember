import { asCapabilityId, type CapabilityId } from '#doc-model';
import type { CapabilityManifest } from '../../kernel/types.ts';

const id = (value: string): CapabilityId => {
  const parsed = asCapabilityId(value);
  if (parsed === null) throw new Error(`能力 id 非法：${value}`);
  return parsed;
};

export const EXAMPLE_CAPABILITY_ID = id('ember.example.hello');

export const EXAMPLE_MANIFEST: CapabilityManifest = {
  id: EXAMPLE_CAPABILITY_ID,
  version: '1.0.0',
  displayName: '示例：打招呼',
  description: '最小示例能力，只注册一个命令，用于验证能力接入路径',
  requiresKernel: '^1.0.0',
  defaultEnabled: true,
};
