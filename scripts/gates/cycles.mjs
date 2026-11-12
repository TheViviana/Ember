import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_ROOT,
  GATE_FLOORS,
  aliasViolations,
  extractImports,
  floorViolations,
  listModules,
  loadAliasConfig,
  readSource,
  readViolations,
  resolveSpecifier,
  structureViolations,
  toPosix,
  unclassifiedViolations,
} from './lib.mjs';

/**
 * 构建模块依赖图：仅保留仓库内的依赖；纯类型边编译后消失，不计入运行期环。
 * 相对说明符与 `#` 别名统一经 resolveSpecifier 解析；别名无法解析时报 gate-alias-unresolved。
 */
function buildGraph(root, files, moduleSet, aliases, problems, violations) {
  const graph = new Map();
  let edges = 0;
  for (const file of files) {
    const deps = [];
    let source;
    try {
      source = readSource(file);
    } catch (error) {
      problems.push({ path: file, detail: `读取文件失败：${error.code ?? error.message}` });
      graph.set(file, deps);
      continue;
    }
    for (const { spec, line, typeOnly } of extractImports(source)) {
      if (typeOnly) continue;
      const resolved = resolveSpecifier(file, spec, aliases);
      if (resolved.kind === 'external') continue;
      if (resolved.kind === 'alias') {
        const bad = aliasViolations(root, file, line, spec, resolved, moduleSet);
        if (bad.length > 0) {
          violations.push(...bad);
          continue;
        }
      }
      if (resolved.target === null) continue;
      deps.push(resolved.target);
      edges += 1;
    }
    graph.set(file, deps);
  }
  return { graph, edges };
}

/** DFS 找环；同时校验扫描充分性与别名解析 */
export function findCycles(root) {
  const problems = [];
  const files = listModules(root, problems);
  const moduleSet = new Set(files);
  const aliases = loadAliasConfig(root);
  const violations = [
    ...aliases.violations,
    ...structureViolations(root, files, problems),
    ...unclassifiedViolations(root, files),
  ];
  const { graph, edges } = buildGraph(root, files, moduleSet, aliases, problems, violations);
  violations.push(...readViolations(root, problems));
  violations.push(
    ...floorViolations([
      { metric: '模块数', actual: graph.size, expected: GATE_FLOORS.modules },
      { metric: '运行期 import 边', actual: edges, expected: GATE_FLOORS.edges },
    ]),
  );

  const state = new Map();
  const stack = [];
  const cycles = [];
  const seen = new Set();

  const visit = (node) => {
    state.set(node, 1);
    stack.push(node);
    for (const dep of graph.get(node) ?? []) {
      if (!graph.has(dep)) continue;
      const depState = state.get(dep) ?? 0;
      if (depState === 1) {
        const start = stack.indexOf(dep);
        if (start >= 0) {
          const cycle = [...stack.slice(start), dep];
          const key = [...cycle].sort().join('|');
          if (!seen.has(key)) {
            seen.add(key);
            cycles.push(cycle);
          }
        }
      } else if (depState === 0) {
        visit(dep);
      }
    }
    stack.pop();
    state.set(node, 2);
  };

  for (const node of [...graph.keys()].sort()) {
    if ((state.get(node) ?? 0) === 0) visit(node);
  }

  for (const cycle of cycles) {
    const path = cycle.map((file) => toPosix(relative(root, file)));
    violations.push({
      file: path[0] ?? '.',
      line: 0,
      rule: 'cycle',
      detail: path.join(' → '),
    });
  }
  return violations;
}

function parseArgs(argv) {
  const rootIndex = argv.indexOf('--root');
  if (rootIndex >= 0 && argv[rootIndex + 1] === undefined) {
    throw new Error('--root 需要一个目录参数');
  }
  return {
    root: resolve(rootIndex >= 0 ? (argv[rootIndex + 1] ?? DEFAULT_ROOT) : DEFAULT_ROOT),
    json: argv.includes('--json'),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { root, json } = parseArgs(process.argv.slice(2));
  const violations = findCycles(root);
  if (json) {
    process.stdout.write(`${JSON.stringify({ gate: 'cycles', root, violations }, null, 2)}\n`);
  } else {
    for (const v of violations) process.stdout.write(`${v.file}:${v.line}  [${v.rule}] ${v.detail}\n`);
    process.stdout.write(
      violations.length === 0
        ? 'gate:cycles 通过：0 个模块环\n'
        : `gate:cycles 失败：${violations.length} 处问题\n`,
    );
  }
  process.exit(violations.length === 0 ? 0 : 1);
}
