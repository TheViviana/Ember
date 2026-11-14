import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ROOT } from './lib.mjs';

/**
 * 运行期零外域请求自检：
 * 1. 启动 `vite preview` 服务构建产物（dist）；
 * 2. 用本机 Chromium 的 CDP Network 域抓取真实页面请求；
 * 3. 任何非本机回环的 http(s)/ws(s) 请求都判失败。
 *
 * 仅依赖 Node 内置 WebSocket 与本机已安装的 Chromium（Playwright 缓存亦可）。
 */

const PREVIEW_PORT = 4173;
const DEBUG_PORT = 9333;
/**
 * 必须与 `vite preview` 自己的绑定方式一致：vite 默认按主机名 `localhost` 监听，
 * 只绑到解析结果里的第一个地址（本机是 `[::1]`）。此处若写死 `127.0.0.1`，
 * 探测会连不上真实服务，并在 20s 后误判成「vite preview 启动超时」。
 * 端口预检也必须用同一个主机名，否则「预检认为空闲、实际已有服务占用」会分裂。
 */
const PREVIEW_HOST = 'localhost';
const AUDIT_URL = `http://${PREVIEW_HOST}:${PREVIEW_PORT}/`;
const WAIT_AFTER_LOAD_MS = 2500;
/** 每个无外部信号的等待点都必须有上限：超时判失败，绝不靠「反正不会卡」 */
const WS_OPEN_TIMEOUT_MS = 10000;
const CDP_COMMAND_TIMEOUT_MS = 10000;
const HTTP_TIMEOUT_MS = 10000;
const OVERALL_TIMEOUT_MS = 60000;
/** 端口预检的超时：本地连不上就是没人监听，不需要等太久 */
const PORT_PROBE_TIMEOUT_MS = 1000;
/**
 * 固定复用同一个 user-data-dir：
 * 每次 mkdtemp 换新路径时，Chromium 把「临时签名 + 新档案」当成另一个软件，
 * 于是每次启动都去钥匙串索要 "Chromium Safe Storage"，系统就弹登录密码框。
 * 目录留在项目临时目录里跨次复用，测试结束不删除。
 */
const PROFILE_DIR_NAME = 'ember-net-audit-profile';
const ALLOWED_PROTOCOL = /^(data|blob|about|devtools|chrome-extension):/;
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 永久性失败：重试没有意义。DNS 解析失败若被当成「服务还没就绪」吞掉，
 * 21s 后只会得到一句「vite preview 启动超时」，把人送去查一个不存在的构建问题。
 */
class FatalProbeError extends Error {}

const causeCodeOf = (error) => {
  const cause = error instanceof Error && 'cause' in error ? error.cause : null;
  if (!(cause instanceof Error) || !('code' in cause)) return null;
  return typeof cause.code === 'string' ? cause.code : null;
};

const isPermanentResolveError = (error) => {
  const code = causeCodeOf(error);
  return code === 'ENOTFOUND' || code === 'EAI_NONAME' || code === 'ERR_INVALID_URL';
};

async function waitFor(label, predicate, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await predicate();
      if (value !== null && value !== undefined) return value;
    } catch (error) {
      if (error instanceof FatalProbeError) throw error;
      // 服务还没就绪，继续等
    }
    await sleep(200);
  }
  throw new Error(`${label} 启动超时`);
}

/** 给任意 Promise 套一个硬上限；超时文案必须带调用点，才能判断卡在哪一步 */
export async function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}：${timeoutMs}ms 内未完成`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** 启动期失败的分类：只表达「环境不满足」，不含检查本身的判定 */
export function classifyStartupFailure({ stage, code = null, signal = null }) {
  const exit = code !== null ? `code=${code}` : signal !== null ? `signal=${signal}` : '退出原因未知';
  switch (stage) {
    case 'port-preview':
      return `环境不满足（端口 ${PREVIEW_PORT} 已被占用，vite preview 无法启动）`;
    case 'port-debug':
      return `环境不满足（端口 ${DEBUG_PORT} 已被占用，可能连到其他 Chromium 实例）`;
    case 'preview':
      return `环境不满足（vite preview 提前退出，${exit}；请确认 dist 与端口）`;
    case 'chromium':
      return `环境不满足（Chromium 提前退出，${exit}）`;
    default:
      return `环境不满足（启动失败，${exit}）`;
  }
}

/** 端口已被占用时继续跑，会连到别人的服务；必须在 spawn 之前拦住 */
const portInUse = (port) =>
  new Promise((resolveProbe) => {
    const probe = connect({ port, host: PREVIEW_HOST });
    const finish = (value) => {
      probe.destroy();
      resolveProbe(value);
    };
    probe.once('connect', () => finish(true));
    probe.once('error', () => finish(false));
    probe.setTimeout(PORT_PROBE_TIMEOUT_MS, () => finish(false));
  });

/** 子进程提前退出时立刻失败，而不是等固定超时 */
const guardChildExit = (child, stage) => {
  let rejectChild = () => {};
  const promise = new Promise((_, reject) => {
    rejectChild = reject;
  });
  const onExit = (code, signal) => rejectChild(new Error(classifyStartupFailure({ stage, code, signal })));
  child.once('exit', onExit);
  // 正常收尾后子进程退出是预期行为，不能让这个 promise 变成未处理拒绝
  promise.catch(() => {});
  return { promise, stop: () => child.removeListener('exit', onExit) };
};

function findChromium() {
  const cacheRoot = join(process.env.HOME ?? '', 'Library', 'Caches', 'ms-playwright');
  const explicit = process.env.EMBER_CHROMIUM;
  if (explicit !== undefined && existsSync(explicit)) return explicit;

  const candidates = [
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  try {
    for (const entry of readdirSync(cacheRoot).sort().reverse()) {
      if (!entry.startsWith('chromium-')) continue;
      const base = join(cacheRoot, entry);
      candidates.push(join(base, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'));
      candidates.push(join(base, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'));
      candidates.push(join(base, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'));
    }
  } catch {
    // 没有 Playwright 缓存
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

class CdpSession {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const entry = this.pending.get(message.id);
        if (entry === undefined) return;
        this.pending.delete(message.id);
        if (message.error !== undefined) entry.reject(new Error(message.error.message));
        else entry.resolve(message.result);
        return;
      }
      for (const listener of this.listeners) listener(message);
    });
    // 浏览器崩溃或主动断开时，排队中的命令必须立刻失败，而不是等各自的计时器
    socket.addEventListener('close', () => this.failAll(new Error('CDP WebSocket 已关闭')));
  }

  failAll(error) {
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }

  send(method, params = {}, timeoutMs = CDP_COMMAND_TIMEOUT_MS) {
    const id = this.nextId;
    this.nextId += 1;
    const answered = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
    return withTimeout(answered, timeoutMs, `CDP 命令 ${method}`);
  }

  on(listener) {
    this.listeners.add(listener);
  }
}

async function main() {
  const chromium = findChromium();
  if (chromium === null) {
    process.stdout.write('✗ runtime-network：找不到 Chromium，可用 EMBER_CHROMIUM 指定可执行文件\n');
    process.exit(1);
  }
  if (!existsSync(join(DEFAULT_ROOT, 'dist', 'index.html'))) {
    process.stdout.write('✗ runtime-network：dist 不存在，请先运行 pnpm build\n');
    process.exit(1);
  }

  if (await portInUse(PREVIEW_PORT)) {
    process.stdout.write(`✗ runtime-network：${classifyStartupFailure({ stage: 'port-preview' })}\n`);
    process.exit(1);
  }
  if (await portInUse(DEBUG_PORT)) {
    process.stdout.write(`✗ runtime-network：${classifyStartupFailure({ stage: 'port-debug' })}\n`);
    process.exit(1);
  }

  const userDataDir = join(tmpdir(), PROFILE_DIR_NAME);
  mkdirSync(userDataDir, { recursive: true });
  const preview = spawn(join(DEFAULT_ROOT, 'node_modules', '.bin', 'vite'), ['preview', '--port', String(PREVIEW_PORT), '--strictPort'], {
    cwd: DEFAULT_ROOT,
    stdio: 'ignore',
  });
  const previewGuard = guardChildExit(preview, 'preview');
  let browser = null;
  let browserGuard = null;
  let socket = null;
  const requests = [];
  // 兜底：任何未预料的挂起都在 60s 内结束，绝不留下卡死的进程
  const watchdog = setTimeout(() => {
    process.stdout.write(
      `✗ runtime-network：检查失败（整体超过 ${OVERALL_TIMEOUT_MS / 1000}s，已终止浏览器与 preview）\n`,
    );
    if (browser !== null) browser.kill('SIGKILL');
    preview.kill('SIGKILL');
    process.exit(1);
  }, OVERALL_TIMEOUT_MS);

  try {
    await Promise.race([
      waitFor('vite preview', async () => {
        let response;
        try {
          response = await fetch(AUDIT_URL, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
        } catch (error) {
          if (isPermanentResolveError(error)) {
            throw new FatalProbeError(`审计地址的主机名无法解析：${PREVIEW_HOST}`);
          }
          throw error;
        }
        return response.ok ? true : null;
      }),
      previewGuard.promise,
    ]);
    previewGuard.stop();

    browser = spawn(
      chromium,
      [
        '--headless=new',
        `--remote-debugging-port=${DEBUG_PORT}`,
        `--user-data-dir=${userDataDir}`,
        // 不碰登录钥匙串：mock keychain + basic 密码库，避免 macOS 反复弹「Chromium Safe Storage」
        '--use-mock-keychain',
        '--password-store=basic',
        // 复用档案后仍要保证审计看到的是真实请求，而不是被磁盘缓存吞掉的命中
        '--disk-cache-size=1',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--disable-domain-reliability',
        '--metrics-recording-only',
        'about:blank',
      ],
      { stdio: 'ignore' },
    );

    browserGuard = guardChildExit(browser, 'chromium');

    /**
     * 调试端点刻意保留 `127.0.0.1` 字面量：Chromium 的 --remote-debugging-port
     * 固定只监听 IPv4 回环，不按主机名解析，这里换成 `localhost` 反而可能先试 `::1`。
     * 与 vite 的「按主机名绑定」不是同一类服务，不要为了表面统一而改。
     */
    await Promise.race([
      waitFor('Chromium 调试端口', async () => {
        const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`, {
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
        return response.ok ? true : null;
      }),
      browserGuard.promise,
    ]);

    const created = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, {
      method: 'PUT',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const target = await created.json();
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await withTimeout(
      new Promise((resolveOpen, reject) => {
        socket.addEventListener('open', resolveOpen, { once: true });
        socket.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true });
        socket.addEventListener('close', () => reject(new Error('CDP WebSocket 提前关闭')), { once: true });
      }),
      WS_OPEN_TIMEOUT_MS,
      'CDP WebSocket 连接',
    );

    const session = new CdpSession(socket);
    let loaded = false;
    session.on((message) => {
      if (message.method === 'Network.requestWillBeSent') {
        requests.push({ url: message.params.request.url, type: message.params.type });
      }
      if (message.method === 'Network.webSocketCreated') {
        requests.push({ url: message.params.url, type: 'WebSocket' });
      }
      if (message.method === 'Page.loadEventFired') loaded = true;
    });

    await session.send('Network.enable');
    await session.send('Page.enable');
    await session.send('Page.navigate', { url: AUDIT_URL });
    await Promise.race([waitFor('页面加载', async () => (loaded ? true : null), 15000), browserGuard.promise]);
    await sleep(WAIT_AFTER_LOAD_MS);

    const classified = requests.map((request) => {
      let host;
      try {
        host = new URL(request.url).hostname;
      } catch {
        host = '';
      }
      const local = ALLOWED_PROTOCOL.test(request.url) || LOOPBACK_HOST.test(host);
      return { ...request, host, local };
    });
    const external = classified.filter((request) => !request.local);

    process.stdout.write(`runtime-network：审计地址 ${AUDIT_URL}\n`);
    for (const request of classified) {
      process.stdout.write(`  ${request.local ? '·' : '✗'} [${request.type}] ${request.url}\n`);
    }
    process.stdout.write(
      `runtime-network：共 ${classified.length} 个请求，外域 ${external.length} 个\n`,
    );
    process.stdout.write(
      external.length === 0
        ? 'gate:runtime-network 通过：启动窗口内零外域请求（用户后续操作不在覆盖范围）\n'
        : 'gate:runtime-network 失败：存在外域请求\n',
    );
    if (external.length > 0) process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
    previewGuard.stop();
    if (browserGuard !== null) browserGuard.stop();
    if (socket !== null) {
      try {
        socket.close();
      } catch {
        // 忽略关闭异常
      }
    }
    if (browser !== null) browser.kill('SIGKILL');
    preview.kill('SIGKILL');
    await sleep(300);
    // 档案目录刻意保留：下次复用同一路径，Chromium 才不会把它当成新软件再要一遍钥匙串密码
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`✗ runtime-network：检查失败（${message}）\n`);
    process.exitCode = 1;
  }
}
