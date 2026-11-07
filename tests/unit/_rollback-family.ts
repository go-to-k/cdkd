import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The rollback replay is split across modules (issue #4426): the entry points stay
 * in `rollback-executor.ts`, and its helpers live in `rollback-executor/*.ts`. A
 * fence that scans "the replay" for a site or a declaration reads this family,
 * so moving code between the files never takes it out of the scan. The directory
 * is read RECURSIVELY: a module split further into a nested directory named after
 * its stem (`plan.ts` + `plan/`, #5835) stays in the family.
 */
const SPLIT_DIR = join(import.meta.dirname, '../../src/deployment/rollback-executor');

/** Repo-relative paths, host first, then the split modules in name order. */
export const ROLLBACK_FAMILY: readonly string[] = [
  'src/deployment/rollback-executor.ts',
  ...readdirSync(SPLIT_DIR, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts'))
    .map((f) => f.split('\\').join('/'))
    .sort()
    .map((f) => `src/deployment/rollback-executor/${f}`),
];

// A floor at the host plus the eleven modules of #4426: a renamed directory or a
// module moved out of it would shrink the family, and every fence counting an
// ABSENCE over it would shrink silently rather than red.
if (ROLLBACK_FAMILY.length < 12) {
  throw new Error(`the rollback family resolved to ${ROLLBACK_FAMILY.join(', ')} only`);
}

// A floor per NESTED directory (#5835): a module split further into a
// directory named after its stem keeps its bodies there, and a read that stops
// recursing drops them from the family without taking it below the floor above.
for (const entry of readdirSync(SPLIT_DIR, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const prefix = `src/deployment/rollback-executor/${entry.name}/`;
  if (!ROLLBACK_FAMILY.some((rel) => rel.startsWith(prefix))) {
    throw new Error(`the rollback family holds no module under ${prefix}`);
  }
}

// And a cross-check by an independent directory walk: a module in a nested
// split directory (#5835) that the listing above missed would drop out of
// every family fence silently, since none of them counts an absence per file.
const walkTs = (dir: string, rel: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? walkTs(join(dir, e.name), `${rel}${e.name}/`)
      : e.name.endsWith('.ts')
        ? [`src/deployment/rollback-executor/${rel}${e.name}`]
        : []
  );
const missing = walkTs(SPLIT_DIR, '').filter((f) => !ROLLBACK_FAMILY.includes(f));
if (missing.length > 0) {
  throw new Error(`the rollback family is missing ${missing.join(', ')}`);
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
