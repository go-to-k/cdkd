import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `intrinsic-function-resolver.ts` is split across modules (issue #4337): the
 * class stays in the host file, and its module-scope helpers and method groups
 * live in `intrinsic-resolver/*.ts` beside it. A fence that scans "the
 * resolver" for a site or a declaration reads this family, so moving code
 * between the files never takes it out of the scan.
 */
const SPLIT_DIR = join(import.meta.dirname, '../../src/deployment/intrinsic-resolver');

/** Repo-relative paths, host first, then the split modules in name order. */
export const RESOLVER_FAMILY: readonly string[] = [
  'src/deployment/intrinsic-function-resolver.ts',
  ...readdirSync(SPLIT_DIR)
    .filter((f) => f.endsWith('.ts'))
    .sort()
    .map((f) => `src/deployment/intrinsic-resolver/${f}`),
];

// A floor: a split module renamed out of the glob would leave the family as
// the host alone, and every fence counting an ABSENCE over it would shrink
// silently rather than red.
if (RESOLVER_FAMILY.length < 2) {
  throw new Error(`the resolver family resolved to ${RESOLVER_FAMILY.join(', ')} only`);
}

/** Every family file's source, joined with a newline. */
export function readResolverFamily(): string {
  const root = join(import.meta.dirname, '../..');
  return RESOLVER_FAMILY.map((rel) => readFileSync(join(root, rel), 'utf8')).join('\n');
}

/** Maps a 1-based line of {@link readResolverFamily}'s text back to `file:line`. */
export function familyLocation(line: number): string {
  const root = join(import.meta.dirname, '../..');
  let first = 1;
  for (const rel of RESOLVER_FAMILY) {
    const count = readFileSync(join(root, rel), 'utf8').split('\n').length;
    if (line < first + count) return `${rel}:${line - first + 1}`;
    first += count;
  }
  return `<past the family>:${line}`;
}
