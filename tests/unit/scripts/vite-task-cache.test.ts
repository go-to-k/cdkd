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
const TASKS_MAP_OPEN = '\n    tasks: {\n';

/** The `run.tasks` map only, so a same-indentation block elsewhere is not read as a task. */
function taskMapSource(text: string): string {
  const start = text.indexOf(TASKS_MAP_OPEN);
  if (start === -1) return '';
  const end = text.indexOf('\n    },', start + TASKS_MAP_OPEN.length);
  return end === -1 ? '' : text.slice(start, end);
}

function taskBlocks(text: string): Map<string, string> {
  const map = taskMapSource(text);
  const blocks = new Map<string, string>();
  // Only an opener whose brace ENDS the line has a block this reads; the
  // count guards below are what make the other shapes a failure rather than a
  // blind spot.
  const opener = /^ {6}(?:'([^']*)'|"([^"]*)"|([A-Za-z_$][\w$:-]*)): \{$/gm;
  for (let m = opener.exec(map); m !== null; m = opener.exec(map)) {
    const start = m.index + m[0].length;
    const end = map.indexOf('\n      },', start);
    if (end === -1) continue;
    blocks.set((m[1] ?? m[2] ?? m[3]) as string, map.slice(start, end));
  }
  return blocks;
}

/** Whole-line comments dropped, so prose discussing `cache: false` is not counted as code. */
const stripComments = (text: string): string =>
  text
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\/?\*)/.test(line))
    .join('\n');

/**
 * `cache: false` as its own STATEMENT, not merely as text somewhere in the block.
 *
 * `/\bcache: false\b/` over the raw block passes on
 * `// cache: false was dropped on purpose` sitting above a `cache: true`, and on
 * `env: { FOO: 'cache: false' }`. This file's own config discusses `cache: false`
 * in comments, so that collision is not hypothetical.
 */
const declaresCacheFalse = (block: string): boolean =>
  /^\s*cache: false,?\s*(?:\/\/.*)?$/m.test(stripComments(block));

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

  it('sees every task in the map, so none can hide from the sweep below', () => {
    // The block reader only recognises an opener whose `{` ENDS the line. Three
    // shapes evade it and would inherit caching invisibly, so each is counted
    // rather than parsed:
    //
    //   'x': { command: 'vp test run' },     one line
    //   'x': { ...sharedTask },              spread, no `command:` token
    //   'x': makeTask('vp test run'),        helper call, no brace at all
    //
    // Measured, from a 46/46/46 baseline: the KEY count catches all three (a
    // spread goes 47/46/46, a helper call 47/46/46, a single-line task
    // 47/46/46). The `command:` count is not redundant -- it uniquely catches a
    // key the opener regex misses that still declares a command, e.g. a shape
    // the key pattern has not been widened for yet, which scores 46/47/46. Do
    // not drop either believing the other covers it.
    //
    // A key is matched at the map's six-space depth; a task's own properties
    // sit at eight, so nothing inside a block is counted. Bare, single- and
    // double-quoted keys and a leading `_` are all accepted, because each is a
    // legal property key and each was invisible while the pattern demanded
    // `'?[A-Za-z]`.
    const map = stripComments(taskMapSource(source()));
    const keys = (map.match(/^ {6}(?:'[^']*'|"[^"]*"|[A-Za-z_$][\w$:-]*):/gm) ?? []).length;
    const commands = (map.match(/\bcommand:/g) ?? []).length;
    const blocks = taskBlocks(source());
    const parsed = blocks.size;

    expect(
      keys,
      `the task map declares ${keys} tasks but only ${parsed} are blocks this suite can read. ` +
        'A task whose `{` does not end its line -- or which has no brace at all, being a call ' +
        'to a helper -- is invisible here and would inherit caching unchecked. Write it out as ' +
        'a multi-line object literal.'
    ).toBe(parsed);
    expect(
      commands,
      `the task map declares ${commands} \`command:\` entries against ${parsed} readable ` +
        'blocks. A task defined without a literal `command:` (a spread of a shared object, or ' +
        'a helper call) is invisible here -- write it out.'
    ).toBe(parsed);
  });

  it('does not read a same-indentation block outside the task map as a task', () => {
    // The openers are matched at six spaces, which is the task-map depth but
    // not unique to it: a `coverage: { thresholds: { ... } }` nested one level
    // deeper in `test:` would present the same shape and be reported as a
    // caching task. Slicing to `run.tasks` first is what prevents that.
    const map = taskMapSource(source());
    expect(map).not.toBe('');
    expect(map).toContain("command: 'vp test run'");
    // Two markers from OUTSIDE `run.tasks`: the vitest config block (which is
    // where a six-space `coverage: {` would appear) and the build config.
    expect(map).not.toContain('globals: true');
    expect(map).not.toContain('neverBundle');
  });

  it('the root run.cache.tasks switch is off, so a new task is safe by default', () => {
    // The per-task flags are what this suite mostly guards, but they only help
    // a task someone remembered to write them on. This switch is what makes the
    // DEFAULT safe, and nothing else asserts it.
    // Line-anchored for the same reason `declaresCacheFalse` is: `stripComments`
    // drops WHOLE-line comments only, so an unanchored pattern passes on
    // `tasks: true, // reverted from cache: { tasks: false } for speed`
    // (measured).
    const config = stripComments(source());
    expect(
      /^\s*tasks: false,?\s*(?:\/\/.*)?$/m.test(config) && /cache: \{/.test(config),
      'vite.config.ts must keep `run: { cache: { tasks: false } }`: it is what stops a task ' +
        'added without an explicit `cache: false` from inheriting a replayable cache'
    ).toBe(true);
  });

  it.each(CORRECTNESS_GATE_TASKS)('`%s` is declared `cache: false`', (name) => {
    const block = taskBlocks(source()).get(name);
    expect(block, `task \`${name}\` not found in vite.config.ts`).toBeDefined();
    expect(
      declaresCacheFalse(block as string),
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
      .filter(([, block]) => !declaresCacheFalse(block))
      .map(([name]) => name);
    expect(
      offenders,
      'these tasks do not set `cache: false`: ' +
        `${offenders.join(', ')}. If one genuinely may replay, say why in a comment beside it ` +
        'and carve it out here explicitly.'
    ).toEqual([]);
  });
});
