import { asCapabilityId, type CapabilityId } from '#doc-model';
import type { CapabilityModule } from '../../kernel/capability-host.ts';

const id = (value: string): CapabilityId => {
  const parsed = asCapabilityId(value);
  if (parsed === null) throw new Error(`能力 id 非法：${value}`);
  return parsed;
};

/** 内核能力的装配位：核心编辑/检索能力后续挂在这里，与外部能力走同一接口（G1） */
export const CORE_CAPABILITY_ID = id('ember.core');

export const coreCapability: CapabilityModule = {
  manifest: {
    id: CORE_CAPABILITY_ID,
    version: '1.0.0',
    displayName: 'Ember 核心',
    description: '内核自带能力槽；v1 尚未注册任何命令或装饰',
    requiresKernel: '^1.0.0',
    defaultEnabled: true,
  },
  activate: () => {
    // v1 空槽：核心能力的注册动作会随骨架迭代补入，接口与外部能力完全一致
  },
};
