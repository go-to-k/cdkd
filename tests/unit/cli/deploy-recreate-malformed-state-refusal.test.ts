/**
 * Issue go-to-k/cdkd#3202, the `--recreate-via-*` half.
 *
 * `cdkd deploy` refuses an unreadable `resources` bag and an unreadable ROW at
 * `DeployEngine`'s state load. That load does NOT dominate the CLI's pre-lock
 * `--recreate-via-cc-api` / `--recreate-via-sdk-provider` check in
 * `deploy.ts`, which reads the same record itself and hands it to
 * `validateRecreateTargets` — whose falsy test cannot tell an ABSENT row from
 * a `null` one. So a `null` named row was reported as "missing from state",
 * with a diagnostic telling the operator to DROP the flag for it (leaving the
 * resource un-recreated with the broken row in place), and a typeless row
 * reached the confirmation prompt as `resourceType: undefined` before the
 * engine refused.
 *
 * `runStackInner` is ~300 lines deep in a command that synthesizes a CDK app,
 * resolves a state bucket and constructs an engine, so this reads the SOURCE
 * — the shape `deploy-recreate-targets-stack-binding.test.ts` takes for the
 * same block — and asserts the two refusals sit between the pre-lock
 * `getState` and the `validateRecreateTargets` call, on the record that read
 * returned. The premise (that the validator alone misreports a `null` row) is
 * pinned behaviourally in `tests/unit/deployment/recreate-targets.test.ts`.
 */
import { describe, it, expect } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '../../../src/cli/commands/deploy.ts'), 'utf8');

describe('deploy.ts refuses a malformed record on the pre-lock recreate check (go-to-k/cdkd#3202)', () => {
  const readAt = source.indexOf('const stateForRecreateCheck = await stackStateBackend.getState(');
  // The span ends at the DECLARATION that receives the validator's result, so
  // the tail check below sees nothing of the validator call itself.
  const validateAt = source.indexOf('const syncValidation = validateRecreateTargets({', readAt);

  it('finds the pre-lock read and the validator call, in that order — the floor', () => {
    expect(readAt, 'the pre-lock getState for the recreate check was renamed').toBeGreaterThan(-1);
    expect(
      validateAt,
      '`const syncValidation = validateRecreateTargets({` no longer follows the read'
    ).toBeGreaterThan(readAt);
  });

  const between = source.slice(readAt, validateAt);

  it('refuses the BAG and the ROWS of the record that read returned, before validating', () => {
    // Both calls, on `stateForRecreateCheck.state` specifically — a refusal on
    // some other record would satisfy a bare `includes`.
    expect(between).toMatch(
      /refuseMalformedResourcesForDeploy\(\s*stateForRecreateCheck\.state,\s*stackInfo\.stackName,\s*stackRegion\s*\)/
    );
    expect(between).toMatch(
      /refuseMalformedResourceEntriesForDeploy\(\s*stateForRecreateCheck\.state,\s*stackInfo\.stackName,\s*stackRegion\s*\)/
    );
    // BAG first — the CONVENTION every call site of the pair takes, pinned as
    // one. It is not a correctness need: `unreadableResourceEntries` returns
    // `[]` for an unreadable bag by design, so in the reverse order the row
    // guard would return and the bag guard would still refuse.
    expect(between.indexOf('refuseMalformedResourcesForDeploy(')).toBeLessThan(
      between.indexOf('refuseMalformedResourceEntriesForDeploy(')
    );
  });

  it('guards on the read having returned a record — a first deploy has none to refuse', () => {
    expect(between).toMatch(/if \(stateForRecreateCheck\) \{/);
  });

  /**
   * CONTAINMENT, not presence: the two cases above are satisfied by an empty
   * `if (stateForRecreateCheck) {}` followed by two unconditional calls (which
   * would throw on a first deploy's `undefined`), and by both calls wrapped in
   * a further `if (false)`. Walk the braces from the guard to its close and
   * demand that the block's executable lines are EXACTLY the two calls.
   */
  it('the guard block holds exactly the two refusals and nothing that could gate them', () => {
    const open = between.indexOf('if (stateForRecreateCheck) {');
    expect(open).toBeGreaterThan(-1);
    let depth = 0;
    let close = -1;
    for (let i = between.indexOf('{', open); i < between.length; i++) {
      if (between[i] === '{') depth++;
      else if (between[i] === '}' && --depth === 0) {
        close = i;
        break;
      }
    }
    expect(close, 'the guard block never closes inside the read→validate span').toBeGreaterThan(open);
    const body = between.slice(between.indexOf('{', open) + 1, close);
    // Comment-stripped, whitespace-collapsed executable text of the block —
    // with the whitespace inside the parentheses dropped too, so a prettier
    // reflow of the argument list cannot red this on its own (review nit).
    const executable = body
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('//'))
      .join(' ')
      .replace(/\s+/g, ' ')
      .replace(/\(\s+/g, '(')
      .replace(/\s+\)/g, ')');
    expect(executable).toBe(
      'refuseMalformedResourcesForDeploy(stateForRecreateCheck.state, stackInfo.stackName, stackRegion); ' +
        'refuseMalformedResourceEntriesForDeploy(stateForRecreateCheck.state, stackInfo.stackName, stackRegion);'
    );
    // And no THIRD occurrence of either call sits outside the block in this
    // span — the unconditional-duplicate shape.
    for (const call of ['refuseMalformedResourcesForDeploy(', 'refuseMalformedResourceEntriesForDeploy(']) {
      expect(between.split(call).length - 1, `${call} appears more than once in the span`).toBe(1);
    }
    // The ENCLOSING control flow: nothing executable may sit between the read's
    // closing `);` and the guard — an outer `if (false) {` wrapped around the
    // whole block would land exactly there and leave every assertion above
    // green over refusals that never run.
    const readEnd = between.indexOf(');') + 2;
    const gap = between
      .slice(readEnd, open)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('//'));
    expect(gap, 'something executable sits between the getState read and its guard').toEqual([]);
    // ...and the guard closes onto the validator with nothing in between either,
    // so the block is not the FIRST arm of a wider construct.
    const tail = between
      .slice(close + 1)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('//'));
    expect(tail, 'something executable sits between the guard block and the validator').toEqual([]);
  });

  it('is the SAME pair the engine raises, imported from the module rather than re-spelled', () => {
    expect(source).toMatch(
      /import \{\s*refuseMalformedResourceEntriesForDeploy,\s*refuseMalformedResourcesForDeploy,\s*\} from '\.\.\/\.\.\/state\/malformed-resources-bag\.js';/
    );
  });
});
