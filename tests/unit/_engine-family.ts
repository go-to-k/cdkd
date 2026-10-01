import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `DeployEngine` is split across modules (issues #4200, #4350): the class stays
 * in `deploy-engine.ts`, and its method groups live in `deploy-engine/*.ts`. A
 * fence that scans "the engine" for a site or a declaration reads this family,
 * so moving code between the files never takes it out of the scan.
 */
const SPLIT_DIR = join(import.meta.dirname, '../../src/deployment/deploy-engine');

/** Repo-relative paths, host first, then the split modules in name order. */
export const ENGINE_FAMILY: readonly string[] = [
  'src/deployment/deploy-engine.ts',
  ...readdirSync(SPLIT_DIR)
    .filter((f) => f.endsWith('.ts'))
    .sort()
    .map((f) => `src/deployment/deploy-engine/${f}`),
];

// A floor: a renamed directory would leave the family as the host alone, and
// every fence counting an ABSENCE over it would shrink silently rather than red.
if (ENGINE_FAMILY.length < 2) {
  throw new Error(`the engine family resolved to ${ENGINE_FAMILY.join(', ')} only`);
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
