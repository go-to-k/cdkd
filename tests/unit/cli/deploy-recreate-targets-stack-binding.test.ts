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
    const literal = source.slice(literalStart, source.indexOf('\n        };', literalStart));
    expect(
      literal,
      'the deployEngineOptions literal does not carry `recreateTargets` as a member — ' +
        'the engine receives no target set and both --recreate-via-* flags are inert'
    ).toMatch(/^\s*recreateTargets,\s*$/m);
    expect(
      literal,
      'the `recreateTargets` member is not guarded by the variable it threads'
    ).toContain('recreateTargets &&');
  });

  it('binds an expression, not a literal', () => {
    // A hardcoded name would satisfy the equality above while pinning every
    // deploy to one stack; the value has to come from the stack being deployed.
    const stamped = assignments[0]![1]!.trim();
    expect(stamped).not.toMatch(/^['"`]/);
    expect(stamped.length).toBeGreaterThan(0);
  });
});
