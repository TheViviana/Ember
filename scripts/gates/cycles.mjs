import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_ROOT,
  extractImports,
  listModules,
  readSource,
  resolveRelative,
  toPosix,
} from './lib.mjs';

/** 构建模块依赖图：仅保留仓库内的相对依赖；纯类型边编译后消失，不计入运行期环 */
function buildGraph(root) {
  const graph = new Map();
  for (const file of listModules(root)) {
    const deps = [];
    for (const { spec, typeOnly } of extractImports(readSource(file))) {
      if (typeOnly) continue;
      const target = resolveRelative(file, spec);
      if (target !== null) deps.push(target);
    }
    graph.set(file, deps);
  }
  return graph;
}

/** DFS 找环，返回去重后的环（文件路径序列，首尾相同） */
export function findCycles(root) {
  const graph = buildGraph(root);
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

  return cycles.map((cycle) => cycle.map((file) => toPosix(relative(root, file))));
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
  const cycles = findCycles(root);
  const violations = cycles.map((cycle) => ({
    file: cycle[0],
    line: 0,
    rule: 'cycle',
    detail: cycle.join(' → '),
  }));
  if (json) {
    process.stdout.write(`${JSON.stringify({ gate: 'cycles', root, violations }, null, 2)}\n`);
  } else {
    for (const cycle of cycles) process.stdout.write(`[cycle] ${cycle.join(' → ')}\n`);
    process.stdout.write(
      cycles.length === 0
        ? 'gate:cycles 通过：0 个模块环\n'
        : `gate:cycles 失败：${cycles.length} 个模块环\n`,
    );
  }
  process.exit(violations.length === 0 ? 0 : 1);
}
