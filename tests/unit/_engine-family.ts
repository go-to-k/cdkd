import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `DeployEngine` is split across modules (issues #4200, #4350): the class stays
 * in `deploy-engine.ts`, and its method groups live in `deploy-engine/*.ts`. A
 * fence that scans "the engine" for a site or a declaration reads this family,
 * so moving code between the files never takes it out of the scan.
 */
const SPLIT_DIR = join(import.meta.dirname, '../../src/deployment/deploy-engine');

/**
 * The `.ts` modules under `dir`, read RECURSIVELY: a split module may itself be
 * split into a nested directory named after its stem (`masking.ts` +
 * `masking/`, go-to-k/cdkd#5835), and its moved code must stay in the family.
 * Each directory's own files in name order, then each subdirectory's. A
 * subdirectory contributing no module is a floor violation, so a renamed or
 * emptied nested directory reds here rather than shrinking every fence.
 */
function splitModules(dir: string, rel: string): string[] {
  const names = readdirSync(dir).sort();
  const files = names.filter((f) => f.endsWith('.ts')).map((f) => `${rel}/${f}`);
  const nested = names
    .filter((f) => statSync(join(dir, f)).isDirectory())
    .flatMap((d) => {
      const modules = splitModules(join(dir, d), `${rel}/${d}`);
      if (modules.length === 0) {
        throw new Error(`the engine family's nested directory ${rel}/${d} holds no module`);
      }
      return modules;
    });
  return [...files, ...nested];
}

/** Repo-relative paths, host first, then the split modules (see {@link splitModules}). */
export const ENGINE_FAMILY: readonly string[] = [
  'src/deployment/deploy-engine.ts',
  ...splitModules(SPLIT_DIR, 'src/deployment/deploy-engine'),
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
