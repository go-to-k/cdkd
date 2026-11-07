import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `DeployEngine` is split across modules (issues #4200, #4350): the class stays
 * in `deploy-engine.ts`, and its method groups live in `deploy-engine/*.ts`. A
 * fence that scans "the engine" for a site or a declaration reads this family,
 * so moving code between the files never takes it out of the scan. The directory
 * is read RECURSIVELY: a module split further into a nested directory named
 * after its stem (`update.ts` + `update/`, #5835) stays in the family.
 */
const SPLIT_DIR = join(import.meta.dirname, '../../src/deployment/deploy-engine');

/** Repo-relative paths, host first, then the split modules in name order. */
export const ENGINE_FAMILY: readonly string[] = [
  'src/deployment/deploy-engine.ts',
  ...readdirSync(SPLIT_DIR, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts'))
    .map((f) => f.split('\\').join('/'))
    .sort()
    .map((f) => `src/deployment/deploy-engine/${f}`),
];

// A floor: a renamed directory would leave the family as the host alone, and
// every fence counting an ABSENCE over it would shrink silently rather than red.
if (ENGINE_FAMILY.length < 2) {
  throw new Error(`the engine family resolved to ${ENGINE_FAMILY.join(', ')} only`);
}

// A floor per NESTED directory (#5835): a module split further into a
// directory named after its stem keeps its bodies there, and a read that stops
// recursing drops them from the family without taking it below the floor above.
for (const entry of readdirSync(SPLIT_DIR, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const prefix = `src/deployment/deploy-engine/${entry.name}/`;
  if (!ENGINE_FAMILY.some((rel) => rel.startsWith(prefix))) {
    throw new Error(`the engine family holds no module under ${prefix}`);
  }
}

/** Every family file's source, joined with a newline. */
export function readEngineFamily(): string {
  const root = join(import.meta.dirname, '../..');
  return ENGINE_FAMILY.map((rel) => readFileSync(join(root, rel), 'utf8')).join('\n');
}

/** Maps a 1-based line of {@link readEngineFamily}'s text back to `file:line`. */
export function familyLocation(line: number): string {
  const root = join(import.meta.dirname, '../..');
  let first = 1;
  for (const rel of ENGINE_FAMILY) {
    const count = readFileSync(join(root, rel), 'utf8').split('\n').length;
    if (line < first + count) return `${rel}:${line - first + 1}`;
    first += count;
  }
  return `<past the family>:${line}`;
}
