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

/**
 * 模块目录登记表（有序，支持目录前缀与精确文件）。
 * 未登记目录一律 `gate-unclassified`：新增 src 子目录或 packages 子包必须先登记。
 * tests/ 不参与模块扫描（listModules 只走 src 与 packages），因此这里也不登记。
 */
export const MODULE_LAYOUT = Object.freeze([
  { prefix: 'packages/doc-model/', layer: 'pkg:doc-model' },
  { prefix: 'packages/canvas-engine/', layer: 'pkg:canvas-engine' },
  { exact: 'src/capabilities/index.ts', layer: 'assembly' },
  { prefix: 'src/capabilities/', layer: 'capabilities', capabilityFromSegment: true },
  { prefix: 'src/kernel/', layer: 'kernel' },
  { prefix: 'src/data/', layer: 'data' },
  { prefix: 'src/shell/', layer: 'shell' },
]);

/** 精确文件豁免：只接受 *.d.ts（无运行期依赖的声明文件），且必须写清 reason */
export const MODULE_EXEMPTIONS = Object.freeze([
  { file: 'src/vite-env.d.ts', reason: 'Vite 客户端类型声明，无 import/export' },
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

const probeModule = (base) => {
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // 候选不存在，继续
    }
  }
  return null;
};

/** 仅解析相对说明符，返回绝对文件路径 */
export function resolveRelative(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  return probeModule(resolve(dirname(fromFile), spec));
}

const readJsonFile = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

/**
 * 加载别名映射：package.json#imports 为权威（运行期真实解析），
 * tsconfig.json#paths 仅做一致性校验，不一致报 gate-alias-drift。
 * 支持精确键与 `#foo/*` 最长前缀通配；目标统一解析为绝对路径。
 */
export function loadAliasConfig(root) {
  const base = resolve(root);
  const pkg = readJsonFile(join(base, 'package.json'));
  const tsconfig = readJsonFile(join(base, 'tsconfig.json'));
  const imports =
    typeof pkg?.imports === 'object' && pkg.imports !== null ? pkg.imports : {};
  const compilerOptions =
    typeof tsconfig?.compilerOptions === 'object' && tsconfig.compilerOptions !== null
      ? tsconfig.compilerOptions
      : {};
  const paths =
    typeof compilerOptions.paths === 'object' && compilerOptions.paths !== null
      ? compilerOptions.paths
      : {};
  const baseUrl = typeof compilerOptions.baseUrl === 'string' ? compilerOptions.baseUrl : '.';

  const entries = [];
  for (const [key, value] of Object.entries(imports)) {
    if (typeof value !== 'string') continue;
    entries.push({ key, target: resolve(base, value) });
  }

  const pathEntries = new Map();
  for (const [key, values] of Object.entries(paths)) {
    if (!Array.isArray(values)) continue;
    pathEntries.set(
      key,
      values
        .filter((value) => typeof value === 'string')
        .map((value) => resolve(base, baseUrl, value)),
    );
  }

  const violations = [];
  const keys = [...new Set([...entries.map((entry) => entry.key), ...pathEntries.keys()])].sort();
  for (const key of keys) {
    const imported = entries.find((entry) => entry.key === key);
    const tsTargets = pathEntries.get(key) ?? [];
    if (imported === undefined) {
      violations.push(
        gateViolation(
          '.',
          'gate-alias-drift',
          `${key}：期望在 package.json#imports 登记，实际只在 tsconfig paths 中出现`,
        ),
      );
      continue;
    }
    if (tsTargets.length === 0) {
      violations.push(
        gateViolation(
          '.',
          'gate-alias-drift',
          `${key}：期望在 tsconfig paths 登记，实际缺失（package.json 指向 ${toPosix(relative(base, imported.target))}）`,
        ),
      );
      continue;
    }
    if (tsTargets[0] !== imported.target) {
      violations.push(
        gateViolation(
          '.',
          'gate-alias-drift',
          `${key}：package.json 目标 ${toPosix(relative(base, imported.target))}，tsconfig 目标 ${toPosix(relative(base, tsTargets[0]))}`,
        ),
      );
    }
  }

  const resolveAlias = (spec) => {
    const exact = entries.find((entry) => entry.key === spec);
    if (exact !== undefined) return exact.target;
    let best = null;
    for (const entry of entries) {
      const star = entry.key.indexOf('*');
      if (star < 0) continue;
      const prefix = entry.key.slice(0, star);
      const suffix = entry.key.slice(star + 1);
      if (!spec.startsWith(prefix) || !spec.endsWith(suffix)) continue;
      if (spec.length < prefix.length + suffix.length) continue;
      if (best === null || prefix.length > best.prefix.length) {
        best = { prefix, suffix, target: entry.target };
      }
    }
    if (best === null) return null;
    const middle = spec.slice(best.prefix.length, spec.length - best.suffix.length);
    return best.target.replace('*', middle);
  };

  return { resolve: resolveAlias, violations };
}

/**
 * 统一说明符解析：relative 保持原逻辑，alias 走 imports 映射，其它视为 external。
 * 目标统一为绝对路径；解析失败时 target 为 null 并给出 reason。
 */
export function resolveSpecifier(fromFile, spec, aliases) {
  if (spec.startsWith('#')) {
    const mapped = aliases.resolve(spec);
    if (mapped === null) return { kind: 'alias', target: null, reason: '无映射' };
    const target = probeModule(mapped);
    return { kind: 'alias', target, reason: target === null ? '目标文件不存在' : null };
  }
  if (spec.startsWith('.')) {
    return { kind: 'relative', target: resolveRelative(fromFile, spec), reason: null };
  }
  return { kind: 'external', target: null, reason: null };
}

/** 校验别名目标：必须位于仓库内、在模块清单中且已登记分层；否则报 gate-alias-unresolved */
export function aliasViolations(root, file, line, spec, resolved, moduleSet) {
  const fail = (detail) => [
    {
      file: toPosix(relative(resolve(root), file)),
      line,
      rule: 'gate-alias-unresolved',
      detail: `${spec}：${detail}`,
    },
  ];
  if (resolved.target === null) {
    return fail(`期望解析到仓库内模块，实际${resolved.reason ?? '无法解析'}`);
  }
  const targetRel = toPosix(relative(resolve(root), resolved.target));
  if (targetRel.startsWith('..') || targetRel.split('/').includes('node_modules')) {
    return fail(`期望仓库内模块，实际指向 ${targetRel}`);
  }
  if (!moduleSet.has(resolved.target)) {
    return fail(`期望目标是受扫描的 .ts/.tsx 模块，实际 ${targetRel} 不在模块清单`);
  }
  if (classify(root, resolved.target) === null) {
    return fail(`期望目标是已登记分层的模块，实际 ${targetRel} 未登记`);
  }
  return [];
}

/**
 * 分层判定（按 MODULE_LAYOUT 登记表）。
 * 返回 { layer, capability } 或 null（未登记且不在豁免表中的文件）。
 */
export function classify(root, absolutePath) {
  const rel = toPosix(relative(root, absolutePath));
  for (const entry of MODULE_LAYOUT) {
    if (entry.exact !== undefined) {
      if (rel === entry.exact) return { layer: entry.layer, capability: null };
      continue;
    }
    if (!rel.startsWith(entry.prefix)) continue;
    if (entry.capabilityFromSegment === true) {
      const segment = rel.slice(entry.prefix.length).split('/')[0];
      return { layer: entry.layer, capability: segment ?? null };
    }
    return { layer: entry.layer, capability: null };
  }
  return null;
}

const LAYOUT_HINT = MODULE_LAYOUT.filter((entry) => entry.prefix !== undefined)
  .map((entry) => entry.prefix.replace(/\/$/, ''))
  .join('|');

const isExempt = (rel) => MODULE_EXEMPTIONS.some((entry) => entry.file === rel);

/** 未登记目录 → gate-unclassified（三 gate 共用；豁免文件不报） */
export const unclassifiedViolations = (root, modules) =>
  modules
    .filter((file) => {
      const rel = toPosix(relative(root, file));
      return !isExempt(rel) && classify(root, file) === null;
    })
    .map((file) => {
      const rel = toPosix(relative(root, file));
      return gateViolation(
        rel,
        'gate-unclassified',
        `${rel}：期望位于已登记目录（${LAYOUT_HINT}），实际未登记`,
      );
    });

const NODE_BUILTIN = /^(?:node:|fs$|path$|fs\/promises$|os$|crypto$|url$|child_process$)/;
const TAURI = /^@tauri-apps\//;
const REACT = /^react(?:-dom)?(?:\/|$)/;
const STATE_LIBS = /^(?:zustand|@tanstack\/)/;

/** 各层的外部依赖禁令与内部层禁令 */
export const LAYER_RULES = {
  'pkg:doc-model': {
    denyLayers: ['shell', 'data', 'kernel', 'capabilities', 'assembly', 'tests'],
    denyExternal: [REACT, TAURI, NODE_BUILTIN, STATE_LIBS, /^@codemirror\//],
  },
  'pkg:canvas-engine': {
    denyLayers: ['shell', 'data', 'kernel', 'capabilities', 'assembly', 'tests'],
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
