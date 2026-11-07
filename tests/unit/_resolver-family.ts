import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';

/**
 * `intrinsic-function-resolver.ts` is split across modules (issue #4337): the
 * class stays in the host file, and its module-scope helpers and method groups
 * live in `intrinsic-resolver/*.ts` beside it. A fence that scans "the
 * resolver" for a site or a declaration reads this family, so moving code
 * between the files never takes it out of the scan.
 */
const SPLIT_DIR = join(import.meta.dirname, '../../src/deployment/intrinsic-resolver');

/**
 * Repo-relative paths, host first, then the split modules in name order.
 *
 * RECURSIVE (#5835): a split module can itself be split into a nested
 * directory named after its stem (`getatt.ts` + `getatt/`), and a flat read
 * would drop those bodies out of every fence reading the family.
 */
export const RESOLVER_FAMILY: readonly string[] = [
  'src/deployment/intrinsic-function-resolver.ts',
  ...readdirSync(SPLIT_DIR, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts'))
    .map((f) => f.split(sep).join('/'))
    .sort()
    .map((f) => `src/deployment/intrinsic-resolver/${f}`),
];

// A floor: a split module renamed out of the glob would leave the family as
// the host alone, and every fence counting an ABSENCE over it would shrink
// silently rather than red.
if (RESOLVER_FAMILY.length < 2) {
  throw new Error(`the resolver family resolved to ${RESOLVER_FAMILY.join(', ')} only`);
}

// A per-directory floor (#5835): each nested directory of the split dir must
// contribute a file, so a read that stopped recursing reds here instead of
// dropping that directory's bodies out of every fence silently.
for (const entry of readdirSync(SPLIT_DIR, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const prefix = `src/deployment/intrinsic-resolver/${entry.name}/`;
  if (!RESOLVER_FAMILY.some((rel) => rel.startsWith(prefix))) {
    throw new Error(`the resolver family holds no file of ${prefix}`);
  }
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
