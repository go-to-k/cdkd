import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import type { StackState } from '../../../src/types/state.js';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { getLogger } from '../../../src/utils/logger.js';
import {
  createLocalCommand,
  maybeSuggestAssumeRole,
} from '../../../src/cli/commands/local-invoke.js';

/**
 * Issue [#2523](https://github.com/go-to-k/cdkd/issues/2523): every
 * `cdkd local *` command whose `--assume-role` help enumerates
 * `(3) --no-assume-role` had the flag REJECTED by the parser, because
 * commander synthesizes no negation for an option declared with an optional
 * value (`--assume-role [arn]`) — only for one declared as `--no-x` in its own
 * right. `options.assumeRole` was therefore a string, `true` or `undefined` and
 * never `false`, so every `=== false` arm was dead code, and the documented
 * "explicit opt-out" was unreachable.
 *
 * Two halves are pinned here, and the SECOND is the one that keeps the defect
 * from coming back:
 *
 *   1. The behaviour: on each of the four commands, `--no-assume-role` parses to
 *      `false` — and `false` is DISTINCT from `undefined`, which is the whole
 *      point of the precedence table (`false` means "declined", `undefined`
 *      means "did not ask", and under `--from-state` those differ: only the
 *      second prints the "re-run with --assume-role" hint).
 *   2. The parity fence: any command whose `--assume-role` DESCRIPTION names
 *      `--no-assume-role` must also register it. That is the exact drift that
 *      shipped — a help string and a parser disagreeing — and a behavioural test
 *      alone cannot see it on a command added later.
 *
 * The inclusion rule is "the command's own `--assume-role` help ADVERTISES the
 * opt-out", not "the command's resolver distinguishes `false` from
 * `undefined`" — on `start-agentcore` and `start-cloudfront` the two are
 * behaviourally identical (both take cdk-local's `assumeRole !== true` arm and
 * forward ambient credentials). The defect being fixed is the help naming a
 * flag the parser rejects, so the population is the set that makes that claim.
 *
 * Deliberately NOT extended to `local start-api` / `start-service` /
 * `start-alb`: none of the three advertises the negation, and on each of them
 * `assumeRole === false` would reach code written for a different shape (a
 * required-value repeatable accumulator on `start-api`, whose
 * `normalizeStartApiAssumeRole` would assign `bareAutoResolve` onto a boolean;
 * cdk-local's `resolveEcsAssumeRoleOption` on the other two, which returns the
 * raw value into an engine that never modelled `false`). Registering it there
 * would be a new flag with a new failure mode, not a fix — see the PR body for
 * go-to-k/cdkd#2523.
 */

/** The four commands whose `--assume-role` help advertises the opt-out. */
const NEGATABLE = ['invoke', 'invoke-agentcore', 'start-agentcore', 'start-cloudfront'] as const;

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TARGET = 'MyStack/MyThing';
const EXPLICIT_ARN = 'arn:aws:iam::111111111111:role/Explicit';

/**
 * The full `cdkd local` tree with every subcommand's action stubbed out.
 *
 * `parse()` runs the registered action; the production ones boot Docker
 * containers and long-running servers, so each is replaced by a no-op (the
 * `cmd-parse-stub-gate` hook requires this for any `cmd.parse()` in a test).
 * `preAction` hooks are NOT replaced and still run — which is deliberate, since
 * they are part of what these commands do to their option bag.
 */
function localTree(): Command {
  const local = createLocalCommand();
  for (const sub of local.commands) sub.action(() => {});
  return local;
}

function parseOpts(name: string, argv: string[]): Record<string, unknown> {
  const local = localTree();
  local.parse([name, TARGET, ...argv], { from: 'user' });
  const sub = local.commands.find((c) => c.name() === name);
  if (!sub) throw new Error(`no such subcommand: ${name}`);
  return sub.opts();
}

describe('cdkd local *: --no-assume-role is registered where it is advertised (#2523)', () => {
  it.each(NEGATABLE)('%s: --no-assume-role parses to false', (name) => {
    expect(parseOpts(name, ['--no-assume-role']).assumeRole).toBe(false);
  });

  it.each(NEGATABLE)('%s: false is DISTINCT from an absent flag', (name) => {
    // The discriminator, not "the flag was accepted": a registration that
    // defaulted `assumeRole` to `false` would satisfy the case above while
    // collapsing "declined" into "did not ask" — which is the distinction the
    // hint path and the state-auto-resolve path both branch on.
    expect(parseOpts(name, []).assumeRole).toBeUndefined();
    expect(parseOpts(name, ['--no-assume-role']).assumeRole).toBe(false);
  });

  it.each(NEGATABLE)('%s: the positive forms still parse unchanged', (name) => {
    // Registering the negation AFTER the positive form must not disturb either
    // of the other two rows of the precedence table.
    expect(parseOpts(name, ['--assume-role']).assumeRole).toBe(true);
    expect(parseOpts(name, ['--assume-role', EXPLICIT_ARN]).assumeRole).toBe(EXPLICIT_ARN);
  });

  it('the help string and the parser cannot drift apart again', () => {
    const local = localTree();
    const advertising: string[] = [];
    const unregistered: string[] = [];
    for (const sub of local.commands) {
      const positive = sub.options.find((option) => option.long === '--assume-role');
      if (positive?.description.includes('--no-assume-role') !== true) continue;
      advertising.push(sub.name());
      if (!sub.options.some((option) => option.long === '--no-assume-role')) {
        unregistered.push(sub.name());
      }
    }
    expect(
      unregistered,
      `these commands advertise --no-assume-role in their --assume-role help but do not register it: ${unregistered.join(', ')}`
    ).toEqual([]);
    // FLOOR, so a rewrite that drops the advertisement everywhere (making the
    // loop above iterate over nothing) fails instead of passing vacuously.
    expect(advertising.sort()).toEqual([...NEGATABLE].sort());
  });

  it('no OTHER `cdkd local *` command silently grew an unregistered negation', () => {
    // The population is derived from the tree rather than from NEGATABLE, so a
    // ninth `local` command copying the advertisement is caught by the loop
    // above rather than by someone remembering to extend a list here.
    const local = localTree();
    const withPositive = local.commands
      .filter((sub) => sub.options.some((option) => option.long === '--assume-role'))
      .map((sub) => sub.name())
      .sort();
    expect(withPositive).toEqual(
      [
        'invoke',
        'invoke-agentcore',
        'start-agentcore',
        'start-alb',
        'start-api',
        'start-cloudfront',
        'start-service',
      ].sort()
    );
    // The three that carry `--assume-role` but deliberately have NO negation.
    // Asserted as the complement rather than left implicit, so DROPPING the
    // advertisement from one of the four (rather than adding it to one of the
    // three) also reds — the parity fence above would go quiet either way.
    expect(withPositive.filter((name) => !NEGATABLE.includes(name as never))).toEqual([
      'start-alb',
      'start-api',
      'start-service',
    ]);
  });
});

/**
 * The PAYOFF, which the parse-level cases above cannot reach.
 *
 * Registering the flag is only worth doing because `false` and `undefined`
 * DIVERGE somewhere. They diverge in exactly one place —
 * {@link maybeSuggestAssumeRole} — and a test that only proves the flag parses
 * would stay green while `--no-assume-role` printed the very hint it exists to
 * suppress.
 *
 * Asserted through the LOGGER rather than through a returned boolean alone,
 * because the returned boolean is the thing a mutation would most easily keep
 * correct while dropping the emission.
 */
describe('--no-assume-role is DISTINGUISHABLE from an absent flag (#2523)', () => {
  afterEach(() => vi.restoreAllMocks());

  /** A state record whose Lambda carries a literal execution-role ARN. */
  const STATE = {
    version: 1,
    stackName: 'MyStack',
    resources: {
      Fn: {
        physicalId: 'fn-1',
        resourceType: 'AWS::Lambda::Function',
        properties: { Role: 'arn:aws:iam::111111111111:role/Deployed' },
      },
    },
    outputs: {},
    lastModified: 0,
  } as unknown as StackState;

  function hintedLines(
    assumeRole: string | boolean | undefined,
    fromState: boolean,
    // NOT a default parameter: passing `undefined` explicitly would fall back
    // to the default and silently re-run the state-present case, which is the
    // one arm this helper exists to distinguish.
    state: StackState | undefined
  ): { hinted: boolean; logged: string[] } {
    const info = vi.spyOn(getLogger(), 'info').mockImplementation(() => {});
    const hinted = maybeSuggestAssumeRole({ assumeRole, fromState }, state, 'Fn');
    const logged = info.mock.calls.map((call) => String(call[0]));
    info.mockRestore();
    return { hinted, logged };
  }

  it('hints when the user did not ask, and stays SILENT when they declined', () => {
    const absent = hintedLines(undefined, true, STATE);
    expect(absent.hinted).toBe(true);
    expect(absent.logged.join('\n')).toContain('Re-run with --assume-role');
    // The discriminator. Under the pre-fix code this arm was unreachable, and
    // under the mutation that motivated it this line is the only one that moves.
    const declined = hintedLines(false, true, STATE);
    expect(declined.hinted).toBe(false);
    expect(declined.logged.join('\n')).not.toContain('Re-run with --assume-role');
  });

  /**
   * Every silent case asserts the LOG as well as the return value.
   *
   * Asserting `.hinted` alone is the trap this file's own header names: a
   * mutation that emits before the guard while keeping the return value exact
   * passes. Measured — moving the `suggestAssumeRoleFromState` call above the
   * `fromState` check left all 19 cases green, and no other test file touches
   * the hint. `stateForRoleHint` is populated by `--from-cfn-stack` too, so
   * "has state" and "asked for state substitution" are genuinely different
   * questions and the conjunct is load-bearing.
   */
  const expectSilent = (
    assumeRole: string | boolean | undefined,
    fromState: boolean,
    state: StackState | undefined
  ): void => {
    const { hinted, logged } = hintedLines(assumeRole, fromState, state);
    expect(hinted).toBe(false);
    expect(logged.join('\n')).not.toContain('Re-run with --assume-role');
  };

  it('never hints when the user DID ask, in either positive form', () => {
    expectSilent(true, true, STATE);
    expectSilent(EXPLICIT_ARN, true, STATE);
  });

  it('never hints without --from-state, whatever the flag says', () => {
    // A separate discriminator: dropping this conjunct would make every plain
    // `cdkd local invoke` advertise a role it never loaded.
    for (const assumeRole of [undefined, false, true, EXPLICIT_ARN]) {
      expectSilent(assumeRole, false, STATE);
    }
  });

  it('never hints without a state record, even under --from-state', () => {
    expectSilent(undefined, true, undefined);
  });

  /**
   * The COUPLING, which is what round 2 of the review found missing.
   *
   * A probe replaced the handler's `else if` condition with the pre-fix
   * `stateForRoleHint && options.fromState` — reintroducing the defect in
   * full — and every case above stayed green, because they exercised an
   * exported predicate the handler was no longer obliged to consult. The
   * decision and the emission now live in ONE function, so the handler cannot
   * re-implement the decision without deleting the call; this pins that it
   * still makes exactly that call, and that no second arm re-decides.
   */
  it('the handler delegates the whole decision to the helper', () => {
    const source = readFileSync(
      join(REPO_ROOT, 'src', 'cli', 'commands', 'local-invoke.ts'),
      'utf8'
    );
    // The arm SHAPE, not just the call's presence. Counting call sites was the
    // first cut and its comment was false: wrapping the call in
    // `if (stateForRoleHint && options.fromState) { ... }` — the exact defect
    // being fenced — keeps both counts at 2 and satisfies a `toContain`. This
    // pins that the arm is a bare `else` whose only statement is the call, so
    // any re-added condition breaks it.
    // The comment-tolerance group is `\s*//...` — a line whose FIRST non-space
    // token is `//` — not "any line containing //". The looser spelling let the
    // restored guard smuggle itself in behind a trailing comment:
    // `if (stateForRoleHint && options.fromState) { // restored pre-fix guard`
    // is a line containing `//`, so it was skipped as though it were a comment
    // and all 19 cases stayed green.
    expect(
      source,
      'the handler re-decides before calling maybeSuggestAssumeRole, or no longer calls it'
    ).toMatch(
      /\}\s*else\s*\{\n(?:\s*\/\/[^\n]*\n)*\s*maybeSuggestAssumeRole\(options, stateForRoleHint, lambda\.logicalId\);\n\s*\}/
    );
    // The COUNT, kept alongside the shape rather than replaced by it — the
    // mistake this whole review loop kept making. The shape regex cannot see a
    // SECOND call added before the `if/else` chain, which would hint on every
    // invocation; the count cannot see a re-added condition. Neither subsumes
    // the other.
    expect(
      [...source.matchAll(/maybeSuggestAssumeRole\(/g)],
      'maybeSuggestAssumeRole gained or lost a call site; it must have exactly one, ' +
        'in the final arm of the assume-role chain'
    ).toHaveLength(2); // its declaration + the single call in the handler
    // ...and the emitter has exactly one caller, so no other arm can hint
    // behind the helper's back. A legitimate third call site is a real change
    // to this contract, not a false alarm — read the message, then decide.
    expect(
      [...source.matchAll(/suggestAssumeRoleFromState\(/g)],
      'suggestAssumeRoleFromState gained or lost a call site; it must have exactly one, ' +
        'inside maybeSuggestAssumeRole, or a second arm can emit the hint unchecked'
    ).toHaveLength(2); // its declaration + the single call in the helper
  });
});
