import type { CapabilityModule } from '../kernel/capability-host.ts';
import { coreCapability } from './core/index.ts';
import { exampleHelloCapability } from './example-hello/index.ts';

/**
 * 编译期静态装配表（C1）：新增能力 = 新增目录 + 在这里加一行。
 * 内核不感知具体能力，boot 只接收这个数组。
 */
export const CAPABILITIES: readonly CapabilityModule[] = [coreCapability, exampleHelloCapability];
