import { describe, it, expect } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Issue [#2567](https://github.com/go-to-k/cdkd/issues/2567), the CLI half.
 *
 * The engine honours a `--recreate-via-*` target only while deploying
 * `recreateTargets.stackName`
 * (`tests/unit/deployment/deploy-engine-recreate-targets-stack-scope.test.ts`
 * pins that). Which makes `deploy.ts` load-bearing in a way no engine test can
 * see: it writes BOTH ends of that comparison — the `stackName` it stamps on
 * the target set, and the name it hands `DeployEngine.deploy()`. If those two
 * expressions ever stop being the same one, the scope check matches nothing,
 * BOTH flags go silently inert (no wrong deletion — the failure is that the
 * user's explicit, consented migration never happens and the run still exits
 * 0), and every unit test in the repo stays green.
 *
 * A behavioural test cannot reach this: `runStackInner` is ~300 lines deep in a
 * command that synthesizes a CDK app, resolves a state bucket, takes an S3
 * lock and constructs an engine. So this reads the SOURCE and asserts the two
 * expressions agree — the same shape as
 * `tests/unit/cli/cli-region-fold.test.ts` and
 * `tests/unit/cli/drift-leaf-region-walk-mirrors-replay.test.ts`.
 *
 * The pairing is what the fence watches, NOT the spelling: change both sides to
 * some other expression and this still passes, which is correct — any single
 * expression is fine as long as one value reaches both ends.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DEPLOY_TS = join(here, '../../../src/cli/commands/deploy.ts');

describe('deploy.ts binds the recreate target set to the stack it deploys (#2567)', () => {
  const source = readFileSync(DEPLOY_TS, 'utf8');

  /**
   * The `stackName:` member of the `recreateTargets` object literal. Anchored
   * on the assignment so a `stackName:` elsewhere in this 1000-line file cannot
   * satisfy it.
   */
  const assignments = [
    ...source.matchAll(/recreateTargets\s*=\s*\{\s*(?:\/\/[^\n]*\n\s*)*stackName:\s*([^,\n]+),/g),
  ];

  /** The first argument of the engine call this command drives. */
  const deployCalls = [...source.matchAll(/\bstackDeployEngine\.deploy\(\s*([^,)]+)\s*,/g)];

  it('finds exactly one of each site — the floor that keeps the rest non-vacuous', () => {
    // Without this, a rename that makes either regex match NOTHING would leave
    // the comparison below trivially true over two empty lists.
    expect(
      assignments.length,
      'expected exactly one `recreateTargets = { stackName: ... }` assignment in deploy.ts'
    ).toBe(1);
    expect(
      deployCalls.length,
      'expected exactly one `stackDeployEngine.deploy(<stackName>, ...)` call in deploy.ts'
    ).toBe(1);
  });

  it('stamps the target set with the SAME expression it deploys', () => {
    const stamped = assignments[0]![1]!.trim();
    const deployed = deployCalls[0]![1]!.trim();
    expect(
      stamped,
      'the recreate target set names a different stack than the engine deploys — ' +
        'both --recreate-via-* flags would be silently inert (issue #2567)'
    ).toBe(deployed);
  });

  it('threads the object into the engine options — the second inert spelling', () => {
    // The pairing above is one of TWO ways both flags can go silently inert.
    // The other is the conditional spread that puts the object on
    // `deployEngineOptions`: drop the key, or negate its guard, and the engine
    // never receives a target set at all. Nothing else in the suite asserts
    // that threading, because every engine-side test constructs the option bag
    // itself.
    // Slice the option literal rather than regexing the whole file, so a
    // `recreateTargets` mention anywhere else cannot satisfy this.
    const literalStart = source.indexOf('const deployEngineOptions: DeployEngineOptions = {');
    expect(literalStart, 'the deployEngineOptions literal was not found').toBeGreaterThan(-1);
    const literalEnd = source.indexOf('\n        };', literalStart);
    // Guard the END too. `indexOf` returns -1 when the close sentinel moves,
    // and `slice(start, -1)` would silently widen to the rest of the file —
    // defeating the scoping this case exists for, while still passing.
    expect(literalEnd, 'the deployEngineOptions literal close was not found').toBeGreaterThan(
      literalStart
    );
    const literal = source.slice(literalStart, literalEnd);
    expect(
      literal,
      'the deployEngineOptions literal does not carry `recreateTargets` as a member — ' +
        'the engine receives no target set and both --recreate-via-* flags are inert'
    ).toMatch(/^\s*recreateTargets,\s*$/m);
    // The guard's WHOLE EXPRESSION, as one assertion.
    //
    // Five independent substring tests stood here and four inert mutations
    // walked through them, each measured green: an inverted polarity
    // (`size === 0 && size === 0`), a leading third conjunct
    // (`migrationGate && recreateTargets && ...`), a trailing one
    // (`... && options.dryRun && {`), and a negation wrapper
    // (`!(... || ...) && {`). Every one leaves both --recreate-via-* flags
    // inert. Independent substring tests cannot bound a conjunction: they
    // constrain what must APPEAR, never what must not be added beside it.
    // Four spellings in two rounds is the signal to change instrument, so this
    // pins the guard text itself and refuses everything not modelled.
    const guardStart = literal.indexOf('...(recreateTargets');
    expect(guardStart, 'no `...(recreateTargets` spread in the option literal').toBeGreaterThan(-1);
    const guardEnd = literal.indexOf('&& {', guardStart);
    expect(guardEnd, 'the recreateTargets spread has no `&& {` payload').toBeGreaterThan(guardStart);
    const guard = literal
      .slice(guardStart + '...('.length, guardEnd)
      .replace(/\s+/g, ' ')
      .trim();
    expect(
      guard,
      'the `recreateTargets` spread guard is not the expected expression. It must open with ' +
        '`recreateTargets`, test at least one direction set for being NON-empty, join the two ' +
        'tests with `||`, and carry NO other operand and no negation — anything else threads ' +
        'the option in the wrong cases and silently disables both --recreate-via-* flags. If ' +
        'you rewrote it deliberately (hoisting the guard into a named const, say), update ' +
        'this expectation to the new text rather than deleting the check.'
    ).toBe(
      'recreateTargets && (recreateTargets.viaCcApi.size > 0 || recreateTargets.viaSdkProvider.size > 0)'
    );
  });

  it('binds an expression, not a literal', () => {
    // A hardcoded name would satisfy the equality above while pinning every
    // deploy to one stack; the value has to come from the stack being deployed.
    const stamped = assignments[0]![1]!.trim();
    expect(stamped).not.toMatch(/^['"`]/);
    expect(stamped.length).toBeGreaterThan(0);
  });
});
