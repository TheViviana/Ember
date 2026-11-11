import { QueryClient } from '@tanstack/react-query';

/** 查询层默认策略：本地优先，失败不自动重试，避免把磁盘错误放大成请求风暴 */
export const createQueryClient = (): QueryClient =>
  new QueryClient({
    defaultOptions: {
      queries: {
        retry: 0,
        staleTime: 5_000,
        refetchOnWindowFocus: false,
      },
    },
  });
