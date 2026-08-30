import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vite-plus/test';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const VITE_CONFIG = join(REPO_ROOT, 'vite.config.ts');

/**
 * A Vite+ task definition, keyed by task name.
 *
 * The parse is deliberately literal rather than an import of the config: the
 * config imports `vite-plus` and runs a `spawnSync` probe at module scope, and
 * the property this test guards is a source-level one (`cache: false` is
 * present in the task's block) that survives being read as text.
 */
function taskBlocks(): Map<string, string> {
  const source = readFileSync(VITE_CONFIG, 'utf8');
  const blocks = new Map<string, string>();
  // `name: {` or `'name:with-colon': {`, at the task-map indentation.
  const opener = /^ {6}'?([A-Za-z][\w:-]*)'?: \{$/gm;
  for (let m = opener.exec(source); m !== null; m = opener.exec(source)) {
    const start = m.index + m[0].length;
    const end = source.indexOf('\n      },', start);
    if (end === -1) continue;
    blocks.set(m[1] as string, source.slice(start, end));
  }
  return blocks;
}

/**
 * The tasks whose verdict is EVIDENCE — a type check, a test run, a hook suite.
 * Written out as literals rather than derived from the config, because a table
 * driven off the set it validates goes green when an entry is DELETED: no entry,
 * no case, nothing to fail.
 */
const CORRECTNESS_GATE_TASKS = [
  'test',
  'typecheck',
  'typecheck:test',
  'test:once-leak',
  'test:once-leak-canary',
  'test:hooks',
] as const;

describe('vite.config.ts — a correctness gate must never replay a cached green', () => {
  const blocks = taskBlocks();

  it('parses the task map at all', () => {
    // Guards every assertion below from passing vacuously on a config whose
    // formatting drifted out of the parser's shape.
    expect(blocks.has('build')).toBe(true);
    expect(blocks.has('lint')).toBe(true);
    expect(blocks.size).toBeGreaterThan(10);
  });

  it.each(CORRECTNESS_GATE_TASKS)('`%s` is declared `cache: false`', (name) => {
    const block = blocks.get(name);
    expect(block, `task \`${name}\` not found in vite.config.ts`).toBeDefined();
    expect(
      /\bcache: false\b/.test(block as string),
      `task \`${name}\` must carry \`cache: false\`: its verdict is evidence, and ` +
        `a cached replay reports a green that predates the edit under test`
    ).toBe(true);
  });

  it('no OTHER task runs vitest or tsc while still caching', () => {
    // The second direction, and the one the literal list above cannot cover: a
    // task added later that runs the suite or a type check inherits caching by
    // default, and nothing would notice.
    const offenders: string[] = [];
    for (const [name, block] of blocks) {
      const runsAGate = /vp test run\b|(?:^|\s)tsc /.test(block);
      if (runsAGate && !/\bcache: false\b/.test(block)) {
        offenders.push(name);
      }
    }
    expect(
      offenders,
      `these tasks run vitest or tsc but do not set \`cache: false\`: ${offenders.join(', ')}`
    ).toEqual([]);
  });
});
