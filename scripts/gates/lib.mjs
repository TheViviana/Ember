import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';

/** 仓库根（scripts/gates/ 上两级） */
export const DEFAULT_ROOT = resolve(new URL('../..', import.meta.url).pathname);

/**
 * 扫描充分性下限：空目录/路径给错/被清空/不可读时，0 违规不再等于通过。
 * 数值按 2026-11 真实规模留 ~35% 余量（实测模块 146、边 303、bans 文件 242）。
 * 结构调整导致下限不再成立时，必须同步修改这里并在 review 中可见。
 */
export const GATE_FLOORS = Object.freeze({
  modules: 100,
  classified: 95,
  edges: 200,
  'layer:shell': 40,
  'layer:kernel': 6,
  'layer:data': 4,
  'layer:capabilities': 2,
  'layer:assembly': 1,
  'layer:pkg:doc-model': 6,
  'layer:pkg:canvas-engine': 2,
  bansFiles: 140,
});

/** 结构断言：必须存在、是目录、且至少含 1 个 .ts/.tsx */
export const REQUIRED_DIRS = Object.freeze([
  'src/kernel',
  'src/shell',
  'src/data',
  'src/capabilities',
  'packages/doc-model',
  'packages/canvas-engine',
]);

const CODE_EXT = new Set(['.ts', '.tsx']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'target', 'gen', '.git']);

export const toPosix = (p) => p.split(sep).join('/');

/**
 * 递归收集代码文件（跳过依赖、构建产物、隐藏目录）。
 * 读取失败不再静默吞掉：问题写入 problems，由门禁报 `gate-read`。
 */
export function walk(dir, result = [], problems = []) {
  const start = resolve(dir);
  let entries;
  try {
    entries = readdirSync(start, { withFileTypes: true });
  } catch (error) {
    problems.push({ path: start, detail: `读取目录失败：${error.code ?? error.message}` });
    return result;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
    const full = join(start, entry.name);
    if (entry.isDirectory()) {
      walk(full, result, problems);
    } else if (CODE_EXT.has(extname(entry.name))) {
      result.push(full);
    }
  }
  return result;
}

/** 收集参与分层的模块：src/** 与 packages/*\/src/** */
export function listModules(root, problems = []) {
  const base = resolve(root);
  return [...walk(join(base, 'src'), [], problems), ...walk(join(base, 'packages'), [], problems)].sort();
}

const gateViolation = (file, rule, detail) => ({ file, line: 0, rule, detail });

/**
 * 结构与充分性：root 必须存在且是目录；必需目录必须存在、是目录、
 * 且至少含 1 个模块（该目录读取失败时只报 gate-read，不重复报缺失）。
 */
export const structureViolations = (root, modules, problems = []) => {
  const abs = resolve(root);
  try {
    if (!statSync(abs).isDirectory()) {
      return [gateViolation('.', 'gate-root', `${toPosix(abs)}：期望目录，实际是文件`)];
    }
  } catch (error) {
    return [
      gateViolation(
        '.',
        'gate-root',
        `${toPosix(abs)}：期望存在的目录，实际无法访问（${error.code ?? error.message}）`,
      ),
    ];
  }

  const unreadable = problems.map((problem) => toPosix(relative(abs, problem.path)));
  const violations = [];
  for (const dir of REQUIRED_DIRS) {
    try {
      if (!statSync(join(abs, dir)).isDirectory()) {
        violations.push(gateViolation(dir, 'gate-missing-dir', `${dir}：期望目录，实际不是目录`));
        continue;
      }
    } catch (error) {
      // 无权限不等同于缺失：已由 gate-read 报出，这里不重复、也不写成“缺失”
      if (error.code === 'EACCES' || error.code === 'EPERM') continue;
      violations.push(gateViolation(dir, 'gate-missing-dir', `${dir}：期望存在的目录，实际缺失`));
      continue;
    }
    if (unreadable.some((path) => path === dir || path.startsWith(`${dir}/`))) continue;
    const count = modules.filter((file) => {
      const rel = toPosix(relative(abs, file));
      return rel.startsWith(`${dir}/`);
    }).length;
    if (count === 0) {
      violations.push(
        gateViolation(dir, 'gate-missing-dir', `${dir}：期望至少 1 个 .ts/.tsx，实际 0 个`),
      );
    }
  }
  return violations;
};

/** 目录/文件读取失败 → gate-read（继续扫描其余部分，但仍以非 0 退出） */
export const readViolations = (root, problems) =>
  problems.map((problem) => {
    const label = toPosix(relative(resolve(root), problem.path)) || '.';
    return gateViolation(label, 'gate-read', `${label}：${problem.detail}`);
  });

/** 规模下限：低于期望才报；实际为 0 报 gate-empty，否则报 gate-floor，detail 统一写明指标/实际/期望 */
export const floorViolations = (checks) =>
  checks
    .filter(({ actual, expected }) => actual < expected)
    .map(({ metric, actual, expected }) =>
      gateViolation(
        '.',
        actual === 0 ? 'gate-empty' : 'gate-floor',
        `${metric}：实际 ${actual}，期望至少 ${expected}`,
      ),
    );

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
