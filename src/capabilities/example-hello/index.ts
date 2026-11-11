import { asCommandId, type CommandId } from '#doc-model';
import type { CapabilityModule } from '../../kernel/capability-host.ts';
import { EXAMPLE_MANIFEST } from './manifest.ts';

const commandId = (value: string): CommandId => {
  const parsed = asCommandId(value);
  if (parsed === null) throw new Error(`命令 id 非法：${value}`);
  return parsed;
};

const HELLO_COMMAND = commandId('example.hello.greet');

/** 最小示例能力：只用 ctx 注册一个命令，不碰内核内部、不持有 ctx（G3） */
export const exampleHelloCapability: CapabilityModule = {
  manifest: EXAMPLE_MANIFEST,
  activate: (ctx) => {
    ctx.commands.register<void>({
      id: HELLO_COMMAND,
      title: '示例：打招呼',
      scope: 'global',
      run: () => {
        ctx.log.info('hello from ember.example.hello');
      },
    });
  },
};
