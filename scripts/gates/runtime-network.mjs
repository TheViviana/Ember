import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const AUDIT_URL = `http://127.0.0.1:${PREVIEW_PORT}/`;
const WAIT_AFTER_LOAD_MS = 2500;
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

async function waitFor(label, predicate, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await predicate();
      if (value !== null && value !== undefined) return value;
    } catch {
      // 服务还没就绪，继续等
    }
    await sleep(200);
  }
  throw new Error(`${label} 启动超时`);
}

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
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
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

  const userDataDir = join(tmpdir(), PROFILE_DIR_NAME);
  mkdirSync(userDataDir, { recursive: true });
  const preview = spawn(join(DEFAULT_ROOT, 'node_modules', '.bin', 'vite'), ['preview', '--port', String(PREVIEW_PORT), '--strictPort'], {
    cwd: DEFAULT_ROOT,
    stdio: 'ignore',
  });
  let browser = null;
  let socket = null;
  const requests = [];

  try {
    await waitFor('vite preview', async () => {
      const response = await fetch(AUDIT_URL);
      return response.ok ? true : null;
    });

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

    await waitFor('Chromium 调试端口', async () => {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      return response.ok ? true : null;
    });

    const created = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' });
    const target = await created.json();
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true });
    });

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
    await waitFor('页面加载', async () => (loaded ? true : null), 15000);
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
        ? 'gate:runtime-network 通过：启动后零外域请求\n'
        : 'gate:runtime-network 失败：存在外域请求\n',
    );
    if (external.length > 0) process.exitCode = 1;
  } finally {
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

await main();
