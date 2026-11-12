import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_ROOT,
  GATE_FLOORS,
  checkEdge,
  checkExternal,
  classify,
  extractImports,
  floorViolations,
  listModules,
  readSource,
  readViolations,
  resolveRelative,
  structureViolations,
  toPosix,
} from './lib.mjs';

/**
 * 跨层边界检查。
 * 挡的是：包层依赖 UI/运行时、能力绕过内核直连 Tauri 或文件系统、
 * 能力之间互相 import、内核反向依赖外壳。
 * 同时校验扫描充分性：空目录/路径给错/被清空时，0 违规不再等于通过。
 */
export function checkLayers(root) {
  const problems = [];
  const files = listModules(root, problems);
  const violations = structureViolations(root, files, problems);

  const layerCounts = new Map();
  let classified = 0;
  let edges = 0;

  for (const file of files) {
    const from = classify(root, file);
    if (from === null) continue;
    classified += 1;
    layerCounts.set(from.layer, (layerCounts.get(from.layer) ?? 0) + 1);

    let source;
    try {
      source = readSource(file);
    } catch (error) {
      problems.push({ path: file, detail: `读取文件失败：${error.code ?? error.message}` });
      continue;
    }
    for (const { spec, line, typeOnly } of extractImports(source)) {
      const target = resolveRelative(file, spec);
      if (target !== null) {
        if (!typeOnly) edges += 1;
        const to = classify(root, target);
        if (to === null) continue;
        const edge = checkEdge(from, to, spec);
        if (edge !== null) {
          violations.push({ file: toPosix(relative(root, file)), line, ...edge });
        }
        continue;
      }
      const external = checkExternal(from, spec);
      if (external !== null) {
        violations.push({ file: toPosix(relative(root, file)), line, ...external });
      }
    }
  }

  violations.push(...readViolations(root, problems));
  violations.push(
    ...floorViolations([
      { metric: '模块数', actual: files.length, expected: GATE_FLOORS.modules },
      { metric: '已分类模块数', actual: classified, expected: GATE_FLOORS.classified },
      { metric: '运行期相对 import 边', actual: edges, expected: GATE_FLOORS.edges },
      ...Object.entries(GATE_FLOORS)
        .filter(([key]) => key.startsWith('layer:'))
        .map(([key, expected]) => {
          const layer = key.slice('layer:'.length);
          return {
            metric: `${layer} 层模块数`,
            actual: layerCounts.get(layer) ?? 0,
            expected,
          };
        }),
    ]),
  );
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
  const violations = checkLayers(root);
  if (json) {
    process.stdout.write(`${JSON.stringify({ gate: 'layers', root, violations }, null, 2)}\n`);
  } else {
    for (const v of violations) {
      process.stdout.write(`${v.file}:${v.line}  [${v.rule}] ${v.detail}\n`);
    }
    process.stdout.write(
      violations.length === 0
        ? 'gate:layers 通过：0 处跨层违规\n'
        : `gate:layers 失败：${violations.length} 处违规\n`,
    );
  }
  process.exit(violations.length === 0 ? 0 : 1);
}
