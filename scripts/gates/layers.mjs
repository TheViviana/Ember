import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_ROOT,
  checkEdge,
  checkExternal,
  classify,
  extractImports,
  listModules,
  readSource,
  resolveRelative,
  toPosix,
} from './lib.mjs';

/**
 * 跨层边界检查。
 * 挡的是：包层依赖 UI/运行时、能力绕过内核直连 Tauri 或文件系统、
 * 能力之间互相 import、内核反向依赖外壳。
 */
export function checkLayers(root) {
  const violations = [];
  for (const file of listModules(root)) {
    const from = classify(root, file);
    if (from === null) continue;
    const source = readSource(file);
    for (const { spec, line } of extractImports(source)) {
      const target = resolveRelative(file, spec);
      if (target === null) {
        const external = checkExternal(from, spec);
        if (external !== null) {
          violations.push({ file: toPosix(relative(root, file)), line, ...external });
        }
        continue;
      }
      const to = classify(root, target);
      if (to === null) continue;
      const edge = checkEdge(from, to, spec);
      if (edge !== null) {
        violations.push({ file: toPosix(relative(root, file)), line, ...edge });
      }
    }
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
