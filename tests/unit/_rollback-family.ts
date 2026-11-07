import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';

/**
 * The rollback replay is split across modules (issue #4426): the entry points stay
 * in `rollback-executor.ts`, and its helpers live in `rollback-executor/*.ts`. A
 * fence that scans "the replay" for a site or a declaration reads this family,
 * so moving code between the files never takes it out of the scan.
 */
const SPLIT_DIR = join(import.meta.dirname, '../../src/deployment/rollback-executor');

/**
 * Repo-relative paths, host first, then the split modules in name order. Read
 * recursively: a family module split further keeps its own sibling directory
 * (`journaled-orphans.ts` + `journaled-orphans/`, go-to-k/cdkd#5835).
 */
export const ROLLBACK_FAMILY: readonly string[] = [
  'src/deployment/rollback-executor.ts',
  ...readdirSync(SPLIT_DIR, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts'))
    .map((f) => f.split(sep).join('/'))
    .sort()
    .map((f) => `src/deployment/rollback-executor/${f}`),
];

// A floor at the host plus the eleven modules of #4426: a renamed directory or a
// module moved out of it would shrink the family, and every fence counting an
// ABSENCE over it would shrink silently rather than red.
if (ROLLBACK_FAMILY.length < 12) {
  throw new Error(`the rollback family resolved to ${ROLLBACK_FAMILY.join(', ')} only`);
}

// A floor per nested directory (go-to-k/cdkd#5835): a recursive read that
// stopped descending would drop these modules while the total above still
// cleared its floor.
const NESTED_FLOORS: Record<string, number> = { 'journaled-orphans/': 2, 'replay-reverse-replacement/': 4 };
for (const [dir, floor] of Object.entries(NESTED_FLOORS)) {
  const found = ROLLBACK_FAMILY.filter((f) => f.startsWith(`src/deployment/rollback-executor/${dir}`));
  if (found.length < floor) {
    throw new Error(`the rollback family's ${dir} resolved to ${found.length} module(s), under its floor of ${floor}`);
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
