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
 * Recursive: a split module can itself split into a directory named after its
 * stem (`cross-stack.ts` + `cross-stack/`, #5835), and its pieces are as much
 * the resolver as the entry that re-exports them.
 */
export const RESOLVER_FAMILY: readonly string[] = [
  'src/deployment/intrinsic-function-resolver.ts',
  ...readdirSync(SPLIT_DIR, { recursive: true, encoding: 'utf8' })
    .map((f) => f.split(sep).join('/'))
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

// And a cross-check by an independent directory walk: a module in a nested
// split directory (#5835) that the listing above missed would drop out of
// every family fence silently, since none of them counts an absence per file.
const walkTs = (dir: string, rel: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? walkTs(join(dir, e.name), `${rel}${e.name}/`)
      : e.name.endsWith('.ts')
        ? [`src/deployment/intrinsic-resolver/${rel}${e.name}`]
        : []
  );
const missing = walkTs(SPLIT_DIR, '').filter((f) => !RESOLVER_FAMILY.includes(f));
if (missing.length > 0) {
  throw new Error(`the resolver family is missing ${missing.join(', ')}`);
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
