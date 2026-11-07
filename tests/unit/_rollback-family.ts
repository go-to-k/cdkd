import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The rollback replay is split across modules (issue #4426): the entry points stay
 * in `rollback-executor.ts`, and its helpers live in `rollback-executor/*.ts`. A
 * fence that scans "the replay" for a site or a declaration reads this family,
 * so moving code between the files never takes it out of the scan.
 */
const SPLIT_DIR = join(import.meta.dirname, '../../src/deployment/rollback-executor');

/**
 * The `.ts` files under `rel` (relative to {@link SPLIT_DIR}), recursively: a
 * family module split further into a nested directory of its own (#5835, e.g.
 * `replay-reverse-replacement.ts` + `replay-reverse-replacement/`) keeps its
 * moved code in the family.
 */
function familyFiles(rel: string): string[] {
  return readdirSync(join(SPLIT_DIR, rel), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const path = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) return familyFiles(path);
      return entry.name.endsWith('.ts') ? [`src/deployment/rollback-executor/${path}`] : [];
    });
}

/** Repo-relative paths, host first, then the split modules in name order. */
export const ROLLBACK_FAMILY: readonly string[] = [
  'src/deployment/rollback-executor.ts',
  ...familyFiles(''),
];

// A floor at the host plus the eleven modules of #4426: a renamed directory or a
// module moved out of it would shrink the family, and every fence counting an
// ABSENCE over it would shrink silently rather than red.
if (ROLLBACK_FAMILY.length < 12) {
  throw new Error(`the rollback family resolved to ${ROLLBACK_FAMILY.join(', ')} only`);
}

// A floor per nested directory (#5835): one the walk stopped descending into
// would drop its modules without moving the total floor above.
const NESTED_FLOORS: Readonly<Record<string, number>> = {
  'replay-reverse-replacement': 4,
};
for (const [dir, floor] of Object.entries(NESTED_FLOORS)) {
  const prefix = `src/deployment/rollback-executor/${dir}/`;
  const found = ROLLBACK_FAMILY.filter((rel) => rel.startsWith(prefix)).length;
  if (found < floor) {
    throw new Error(`the rollback family holds ${found} file(s) under ${prefix}, expected ${floor}+`);
  }
}

/** Every family file's source, joined with a newline. */
export function readRollbackFamily(): string {
  const root = join(import.meta.dirname, '../..');
  return ROLLBACK_FAMILY.map((rel) => readFileSync(join(root, rel), 'utf8')).join('\n');
}

/** Maps a 1-based line of {@link readRollbackFamily}'s text back to `file:line`. */
export function familyLocation(line: number): string {
  const root = join(import.meta.dirname, '../..');
  let first = 1;
  for (const rel of ROLLBACK_FAMILY) {
    const count = readFileSync(join(root, rel), 'utf8').split('\n').length;
    if (line < first + count) return `${rel}:${line - first + 1}`;
    first += count;
  }
  return `<past the family>:${line}`;
}
