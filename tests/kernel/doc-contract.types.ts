import type { KernelContext } from '../../src/kernel/context.ts';
import type { DocService } from '../../src/kernel/doc-service.ts';

/**
 * 编译期断言（由 tests/tsconfig.json 的 tsc 执行，node --test 不加载该文件）：
 * 公开 DocService 与 shell/能力层拿到的 KernelContext.docs 都不得暴露永久删除入口。
 * 一旦 purge 被放回公开接口，条件类型变成 never，下面的赋值即编译失败。
 */
type NoPurge<T> = 'purge' extends keyof T ? never : true;

export const docServiceHasNoPurge: NoPurge<DocService> = true;
export const contextDocsHasNoPurge: NoPurge<KernelContext['docs']> = true;
