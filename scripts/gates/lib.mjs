import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';

/** 仓库根（scripts/gates/ 上两级） */
export const DEFAULT_ROOT = resolve(new URL('../..', import.meta.url).pathname);

const CODE_EXT = new Set(['.ts', '.tsx']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'target', 'gen', '.git']);

export const toPosix = (p) => p.split(sep).join('/');

/** 递归收集代码文件（跳过依赖、构建产物、隐藏目录） */
export function walk(dir, result = []) {
  const start = resolve(dir);
  let entries;
  try {
    entries = readdirSync(start, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
    const full = join(start, entry.name);
    if (entry.isDirectory()) {
      walk(full, result);
    } else if (CODE_EXT.has(extname(entry.name))) {
      result.push(full);
    }
  }
  return result;
}

/** 收集参与分层的模块：src/** 与 packages/*\/src/** */
export function listModules(root) {
  const base = resolve(root);
  return [...walk(join(base, 'src')), ...walk(join(base, 'packages'))].sort();
}

const IMPORT_PATTERNS = [
  /(?<keyword>import|export)\s+(?<clause>[^'"();]*?)\bfrom\s*['"](?<spec>[^'"]+)['"]/g,
  /\bimport\s*['"](?<spec>[^'"]+)['"]/g,
  /\bimport\s*\(\s*['"](?<spec>[^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"](?<spec>[^'"]+)['"]\s*\)/g,
];

/** 去掉整行注释与块注释，避免把注释掉的 import 当依赖 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^[ \t]*\/\/.*$/gm, (m) => m.replace(/[^\n]/g, ' '));
}

/** 判断一条 import/export 语句是否纯类型（编译后被完全擦除，不产生运行期依赖） */
function isTypeOnlyClause(keyword, clause) {
  const text = clause.trim();
  if (text.startsWith('type ')) return true;
  const braced = /^\{([\s\S]*)\}$/.exec(text);
  if (braced === null) return false;
  const items = (braced[1] ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (items.length === 0) return false;
  return items.every((item) => item.startsWith('type '));
}

/** 抽取 import/export 说明符、行号与是否纯类型 */
export function extractImports(source) {
  const text = stripComments(source);
  const found = [];
  for (const re of IMPORT_PATTERNS) {
    re.lastIndex = 0;
    let match = re.exec(text);
    while (match !== null) {
      const spec = match.groups?.spec;
      if (spec !== undefined) {
        const line = text.slice(0, match.index).split('\n').length;
        const typeOnly = isTypeOnlyClause(match.groups?.keyword ?? '', match.groups?.clause ?? '');
        found.push({ spec, line, typeOnly });
      }
      match = re.exec(text);
    }
  }
  return found;
}

/** 仅解析相对说明符，返回绝对文件路径 */
export function resolveRelative(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), spec);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // 候选不存在，继续
    }
  }
  return null;
}

/**
 * 分层判定。
 * 返回 { layer, capability } 或 null（不参与边界的文件）。
 */
export function classify(root, absolutePath) {
  const rel = toPosix(relative(root, absolutePath));
  if (rel.startsWith('packages/doc-model/')) return { layer: 'pkg:doc-model', capability: null };
  if (rel.startsWith('packages/canvas-engine/')) return { layer: 'pkg:canvas-engine', capability: null };
  if (rel === 'src/capabilities/index.ts') return { layer: 'assembly', capability: null };
  if (rel.startsWith('src/capabilities/core/')) return { layer: 'capabilities', capability: 'core' };
  if (rel.startsWith('src/capabilities/')) {
    const segment = rel.slice('src/capabilities/'.length).split('/')[0];
    return { layer: 'capabilities', capability: segment ?? null };
  }
  if (rel.startsWith('src/kernel/')) return { layer: 'kernel', capability: null };
  if (rel.startsWith('src/data/')) return { layer: 'data', capability: null };
  if (rel.startsWith('src/shell/')) return { layer: 'shell', capability: null };
  if (rel.startsWith('tests/')) return { layer: 'tests', capability: null };
  return null;
}

const NODE_BUILTIN = /^(?:node:|fs$|path$|fs\/promises$|os$|crypto$|url$|child_process$)/;
const TAURI = /^@tauri-apps\//;
const REACT = /^react(?:-dom)?(?:\/|$)/;
const STATE_LIBS = /^(?:zustand|@tanstack\/)/;

/** 各层的外部依赖禁令与内部层禁令 */
export const LAYER_RULES = {
  'pkg:doc-model': {
    denyLayers: [],
    denyExternal: [REACT, TAURI, NODE_BUILTIN, STATE_LIBS, /^@codemirror\//],
  },
  'pkg:canvas-engine': {
    denyLayers: [],
    denyExternal: [REACT, TAURI, NODE_BUILTIN, STATE_LIBS, /^@codemirror\//],
  },
  kernel: {
    denyLayers: ['shell', 'data', 'capabilities', 'assembly', 'tests'],
    denyExternal: [TAURI, REACT, STATE_LIBS],
  },
  capabilities: {
    denyLayers: ['shell', 'data', 'tests'],
    denyExternal: [TAURI, NODE_BUILTIN, REACT, STATE_LIBS],
  },
  assembly: {
    denyLayers: [],
    denyExternal: [TAURI, REACT, STATE_LIBS],
  },
  data: {
    denyLayers: ['shell', 'capabilities', 'assembly', 'tests'],
    denyExternal: [],
  },
  shell: { denyLayers: [], denyExternal: [] },
  tests: { denyLayers: [], denyExternal: [] },
};

/**
 * 检查一条边，返回违规或 null。
 * @param {{layer:string,capability:string|null}} from
 * @param {{layer:string,capability:string|null}} to
 * @param {string} spec 原始说明符
 */
export function checkEdge(from, to, spec) {
  const rules = LAYER_RULES[from.layer];
  if (rules === undefined) return null;

  if (from.layer === 'capabilities' && to.layer === 'capabilities') {
    if (from.capability !== null && to.capability !== null && from.capability !== to.capability) {
      return { rule: 'capability-cross-import', detail: `${from.capability} → ${to.capability}` };
    }
    return null;
  }

  if (rules.denyLayers.includes(to.layer)) {
    return { rule: 'forbidden-internal', detail: `${from.layer} → ${to.layer} (${spec})` };
  }
  return null;
}

/** 外部说明符检查 */
export function checkExternal(from, spec) {
  const rules = LAYER_RULES[from.layer];
  if (rules === undefined) return null;
  for (const pattern of rules.denyExternal) {
    if (pattern.test(spec)) {
      return { rule: 'forbidden-external', detail: `${from.layer} → ${spec}` };
    }
  }
  return null;
}

/** 读取文件（统一 UTF-8） */
export const readSource = (file) => readFileSync(file, 'utf8');
