import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vite-plus/test';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const VITE_CONFIG = join(REPO_ROOT, 'vite.config.ts');

const source = (): string => readFileSync(VITE_CONFIG, 'utf8');

/**
 * The Vite+ task definitions, keyed by task name.
 *
 * The parse is deliberately literal rather than an import of the config: the
 * config imports `vite-plus` and runs a `spawnSync` probe at module scope, and
 * the property this suite guards is a source-level one (`cache: false` appears
 * in the task's block) that survives being read as text.
 */
function taskBlocks(text: string): Map<string, string> {
  const blocks = new Map<string, string>();
  // `name: {` or `'name:with-colon': {`, at the task-map indentation.
  const opener = /^ {6}'?([A-Za-z][\w:-]*)'?: \{$/gm;
  for (let m = opener.exec(text); m !== null; m = opener.exec(text)) {
    const start = m.index + m[0].length;
    const end = text.indexOf('\n      },', start);
    if (end === -1) continue;
    blocks.set(m[1] as string, text.slice(start, end));
  }
  return blocks;
}

/**
 * Tasks whose verdict is EVIDENCE — a type check, a lint, a format check, a test
 * run, a hook suite, or a chain of those. Written out as literals rather than
 * derived from the config, because a table driven off the set it validates is
 * blind to DELETIONS: remove an entry and there is no case left to fail.
 */
const CORRECTNESS_GATE_TASKS = [
  'check',
  'lint',
  'format:check',
  'test',
  'typecheck',
  'typecheck:test',
  'test:once-leak',
  'test:once-leak-canary',
  'test:hooks',
  'verify',
] as const;

describe('vite.config.ts — a correctness gate must never replay a cached green', () => {
  it('the parse actually finds the task map', () => {
    // Guards every assertion below from passing vacuously on a config whose
    // formatting drifted out of the parser's shape.
    const blocks = taskBlocks(source());
    expect(blocks.has('build')).toBe(true);
    expect(blocks.has('lint')).toBe(true);
    expect(blocks.size).toBeGreaterThan(10);
  });

  it('sees every task in the file, so none can hide from the sweep below', () => {
    // The parser only recognises a block whose brace ENDS the line. A task
    // written on one line -- `'test:bar': { command: 'vp test run' },` -- would
    // parse to nothing and inherit caching invisibly, and the vacuity guard
    // above would still pass on the other 40-odd blocks. Counting `command:`
    // occurrences is what makes that shape a failure rather than a blind spot.
    const text = source();
    // Counted WITHOUT a line anchor on purpose: a single-line task writes
    // `{ command: ...` mid-line, so an anchored count misses exactly the shape
    // this case exists to catch — measured, the anchored version passed the
    // probe. Both spellings currently agree at 46, so the loose pattern costs
    // no false positives here.
    const declared = (text.match(/\bcommand:/g) ?? []).length;
    const parsed = [...taskBlocks(text).values()].filter((b) => /\bcommand:/.test(b)).length;
    expect(
      parsed,
      `vite.config.ts declares ${declared} \`command:\` entries but only ${parsed} are inside a ` +
        'block this suite can read. A task whose `{` does not end its line is invisible here ' +
        'and would inherit caching unchecked -- put it on multiple lines.'
    ).toBe(declared);
  });

  it.each(CORRECTNESS_GATE_TASKS)('`%s` is declared `cache: false`', (name) => {
    const block = taskBlocks(source()).get(name);
    expect(block, `task \`${name}\` not found in vite.config.ts`).toBeDefined();
    expect(
      /\bcache: false\b/.test(block as string),
      `task \`${name}\` must carry \`cache: false\`: its verdict is read as evidence, and a ` +
        'cached replay reports a green that predates the edit under test'
    ).toBe(true);
  });

  it('no task caches at all', () => {
    // The second direction, and the one the literal list cannot cover: a task
    // added later inherits caching by default and nothing would notice.
    //
    // The sweep is a blanket rule rather than "tasks that run vitest or tsc",
    // and that is deliberate. Classifying by COMMAND TEXT was the first cut and
    // it was dead on arrival: a command is always a quoted literal, so a pattern
    // anchored on whitespace-or-start before `tsc` matched neither `typecheck`
    // nor `typecheck:test`, and an injected uncached `tsc` task went unflagged.
    // Every task in this file either produces a verdict read as evidence or
    // regenerates an artifact whose freshness is the point, so there is nothing
    // left for a classifier to be wrong about.
    const offenders = [...taskBlocks(source())]
      .filter(([, block]) => !/\bcache: false\b/.test(block))
      .map(([name]) => name);
    expect(
      offenders,
      'these tasks do not set `cache: false`: ' +
        `${offenders.join(', ')}. If one genuinely may replay, say why in a comment beside it ` +
        'and carve it out here explicitly.'
    ).toEqual([]);
  });
});
