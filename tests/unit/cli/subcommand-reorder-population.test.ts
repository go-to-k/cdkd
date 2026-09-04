import { describe, it, expect } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildProgram } from '../../../src/cli/program.js';

/**
 * Fences `src/cli/index.ts`'s `SUBCOMMANDS` set against the real Commander
 * tree, in BOTH directions.
 *
 * `reorderArgs` moves options written BEFORE the subcommand to after it, so
 * `cdkd -c ENV=dev deploy` reaches `deploy`. It finds the subcommand by
 * testing each argument against `SUBCOMMANDS`, which is a hand-maintained
 * literal — so a name missing from it silently disables the reorder for that
 * command, and a name left in it after the command is gone is a dangling
 * entry.
 *
 * Both had happened by the time this file was written (found while removing
 * `cdkd migrate` for issue
 * [#2572](https://github.com/go-to-k/cdkd/issues/2572)):
 *
 *   - `migrate` was still listed after its command was deleted;
 *   - `events`, `rollback` and `scrub` had NEVER been added, so a global
 *     option written BEFORE one of them was rejected instead of forwarded.
 *     Measured against the built CLI, both sets, rebuilt each way:
 *
 *       cdkd --state-bucket mybucket rollback
 *         before: error: unknown option '--state-bucket'
 *         after:  reaches rollback (fails on the bucket's region)
 *       cdkd -c Foo=bar scrub
 *         before: error: unknown option '-c'
 *         after:  reaches scrub (asks for --app)
 *
 *     The example matters: `cdkd -c Foo=bar rollback` is UNCHANGED by the fix,
 *     because `rollback` declares no `-c`. A first draft of this note used
 *     that invocation and was wrong -- the reorder only helps an option the
 *     target command actually accepts.
 *
 * The second is the direction that gets skipped: removing an entry is forced
 * by the deletion that motivated it, while a command added years later
 * silently never joins the set. Hence a two-way `toEqual`, not a subset check.
 *
 * The set is read from the SOURCE TEXT rather than imported, because
 * `src/cli/index.ts` exports nothing and runs `main()` as an import side
 * effect — the same reason `buildProgram` lives in its own module. That makes
 * this a scanner fence, so the extraction is deliberately narrow: the literal
 * array passed to `new Set([...])`, single-quoted members only. If the
 * declaration is ever rewritten into a shape this cannot read, the parse
 * yields nothing and the assertion below reds on an empty set rather than
 * passing vacuously — which is why the extraction failure is asserted
 * separately first.
 */
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const INDEX_TS = join(REPO_ROOT, 'src', 'cli', 'index.ts');

function declaredSubcommands(): string[] {
  const src = readFileSync(INDEX_TS, 'utf-8');
  const block = /const SUBCOMMANDS = new Set\(\[([\s\S]*?)\]\)/.exec(src);
  if (!block) return [];
  return [...block[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

/**
 * Every name Commander will actually dispatch on: each top-level command plus
 * its aliases. Aliases are load-bearing here — an alias is a name commander
 * dispatches on, so `cdkd <global-opt> ls` must reorder exactly as `list`
 * does. Reading only `.name()` would report the already-present `ls` as a
 * spurious EXTRA and fail this fence on a correct set.
 */
function dispatchableNames(): string[] {
  return buildProgram()
    .commands.flatMap((c) => [c.name(), ...c.aliases()])
    // Defensive, and currently INERT: commander's auto-generated `help` is not
    // in `.commands` today (measured: 19 names, none of them `help`). It is
    // filtered anyway because `cdkd help deploy` must not be reordered as
    // though `help` were a target, and whether the auto command appears here
    // is commander's choice, not ours.
    .filter((n) => n !== 'help');
}

describe('src/cli/index.ts SUBCOMMANDS vs the real command tree', () => {
  it('parses the declaration (so a rewrite cannot make the fence vacuous)', () => {
    const declared = declaredSubcommands();
    // 10 is a backstop against a DEAD parser, not a measurement -- the live
    // count is 19 (18 commands + the `ls` alias), and pinning it here would
    // duplicate the exact assertion below and make every command addition a
    // two-line edit. It only has to sit far enough above zero that a regex
    // matching a stray fragment cannot clear it.
    expect(
      declared.length,
      'Could not extract SUBCOMMANDS from src/cli/index.ts. The declaration was ' +
        'probably rewritten into a shape the regex above cannot read. Update the ' +
        'extraction rather than deleting this test. The assertion below would ' +
        'still FAIL on an empty set rather than pass vacuously -- what this case ' +
        'buys is a message naming the PARSE as the cause, instead of an empty-vs-' +
        'nineteen diff that reads as if every command had been deleted.'
    ).toBeGreaterThan(10);
  });

  it('lists exactly the dispatchable command names, in both directions', () => {
    const declared = [...declaredSubcommands()].sort();
    const actual = [...dispatchableNames()].sort();
    expect(
      declared,
      'SUBCOMMANDS in src/cli/index.ts must name every dispatchable top-level ' +
        'command (and alias) and nothing else. A MISSING name silently disables ' +
        'the pre-subcommand option reorder for that command, so a global option ' +
        'written before it is REJECTED rather than forwarded ' +
        '(`cdkd --state-bucket b rollback` -> unknown option). An EXTRA name is a ' +
        'dangling entry for a command that no longer exists.'
    ).toEqual(actual);
  });
});
