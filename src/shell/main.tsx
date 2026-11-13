import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createKernel } from '../data/bootstrap.ts';
import { createQueryClient } from '../data/query-client.ts';
import { App } from './App.tsx';
import { KernelProvider } from './kernel-provider.tsx';
import '../styles/global.css';

const queryClient = createQueryClient();

const container = document.getElementById('root');
if (container === null) throw new Error('缺少 #root 挂载点');

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <KernelProvider start={() => createKernel()}>
        <App />
      </KernelProvider>
    </QueryClientProvider>
  </StrictMode>,
);

// 透明窗口：等首帧不透明底真正绘制完成后再开启毛玻璃，避免启动时闪一下桌面
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    document.documentElement.dataset.vibrancy = 'on';
  });
});
