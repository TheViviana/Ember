import { DEFAULT_ROOT } from './lib.mjs';
import { scanBans } from './bans.mjs';
import { findCycles } from './cycles.mjs';
import { checkLayers } from './layers.mjs';
import { checkCsp } from './csp.mjs';

const root = process.argv.includes('--root')
  ? process.argv[process.argv.indexOf('--root') + 1]
  : DEFAULT_ROOT;

const results = [
  { name: 'cycles', violations: findCycles(root).map((cycle) => ({ detail: cycle.join(' → ') })) },
  { name: 'layers', violations: checkLayers(root) },
  { name: 'bans', violations: scanBans(root) },
  { name: 'csp', violations: checkCsp(root) },
];

let failed = 0;
for (const result of results) {
  if (result.violations.length === 0) {
    process.stdout.write(`✓ ${result.name}\n`);
  } else {
    failed += 1;
    process.stdout.write(`✗ ${result.name}：${result.violations.length} 处\n`);
    for (const v of result.violations) {
      const where = v.file === undefined ? '' : `${v.file}:${v.line ?? 0} `;
      process.stdout.write(`  ${where}[${v.rule ?? 'cycle'}] ${v.detail}\n`);
    }
  }
}

process.stdout.write(failed === 0 ? 'gate 全部通过\n' : `gate 失败：${failed} 项未通过\n`);
process.exit(failed === 0 ? 0 : 1);
