/**
 * `cdkd diff --recursive` over a nested stack whose input `Parameters` carry a
 * SECRET dynamic reference (issue
 * [#1903](https://github.com/go-to-k/cdkd/issues/1903)).
 *
 * `resolveChildStackParameters` used to build its resolver context with neither
 * `skipDynamicReferences` nor `recordedSecretValues`, so the diff DECRYPTED the
 * reference at plan time and printed the plaintext in the child's diff.
 *
 * The two halves of the issue are COUPLED, and this file is where that shows:
 * the flag is only correct because the deploy half now persists the
 * `{{resolve:...}}` EXPRESSION into the child's state. Both directions are
 * asserted — the freshly-deployed tree must report NO_CHANGE (the spurious
 * perpetual change the issue warns about), and a genuine change must still be
 * detected.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

/**
 * Any live secret fetch is a FAILURE of this file's premise, so the fake throws
 * rather than returning a value: a test that starts decrypting must go red, not
 * quietly assert against a plaintext.
 */
const secretSend = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-secrets-manager', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    SecretsManagerClient: vi.fn().mockImplementation(() => ({
      send: secretSend,
      config: { region: () => Promise.resolve('us-east-1') },
      destroy: () => undefined,
    })),
  };
});

import {
  buildDiffTree,
  nodeHasChanges,
  treeHasChanges,
} from '../../../src/cli/commands/diff-recursive.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import { getLogger } from '../../../src/utils/logger.js';

const NESTED = 'AWS::CloudFormation::Stack';
const PARAM = 'referencetoParentDbPassword';
const SECRET_EXPR = '{{resolve:secretsmanager:prod/db/cred:SecretString:password::}}';
const SECRET_PLAINTEXT = 'diff-recursive-plaintext-1903';

function res(resourceType: string, properties: Record<string, unknown>): ResourceState {
  return { physicalId: 'pid', resourceType, properties, attributes: {}, dependencies: [] };
}

function st(stackName: string, resources: Record<string, ResourceState>): StackState {
  return { stackName, region: 'us-east-1', resources, outputs: {}, version: 6, lastModified: 0 };
}

function fakeBackend(states: Record<string, StackState>): S3StateBackend {
  return {
    getState: async (stackName: string) => {
      const state = states[stackName];
      return state ? { state, etag: 'fake' } : null;
    },
  } as unknown as S3StateBackend;
}

describe('diff --recursive: a secret-bearing nested-stack Parameter (#1903)', () => {
  let dir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    secretSend.mockImplementation(() => {
      throw new Error('cdkd diff must not fetch a secret value at plan time');
    });
    dir = mkdtempSync(join(tmpdir(), 'cdkd-diff-secret-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Child consumes the down-passed parameter; no `{{resolve:` in its own template. */
  function writeChildTemplate(): string {
    const childPath = join(dir, 'child.json');
    writeFileSync(
      childPath,
      JSON.stringify({
        Parameters: { [PARAM]: { Type: 'String' } },
        Resources: {
          ChildRes: {
            Type: 'AWS::SSM::Parameter',
            Properties: { Type: 'String', Value: { Ref: PARAM } },
          },
        },
      })
    );
    return childPath;
  }

  /** Parent hands the secret DOWN through the nested row's `Parameters` block. */
  function parentTemplate(): CloudFormationTemplate {
    return {
      Resources: {
        Child: {
          Type: NESTED,
          Metadata: { 'aws:asset:path': 'child.json' },
          Properties: { Parameters: { [PARAM]: SECRET_EXPR } },
        },
      },
    };
  }

  /**
   * A freshly-deployed tree under the POST-fix persist shape: both the parent's
   * nested row and the child's resource hold the EXPRESSION, never the value.
   */
  function freshStates(): Record<string, StackState> {
    return {
      Parent: st('Parent', { Child: res(NESTED, { Parameters: { [PARAM]: SECRET_EXPR } }) }),
      'Parent~Child': st('Parent~Child', {
        ChildRes: res('AWS::SSM::Parameter', { Type: 'String', Value: SECRET_EXPR }),
      }),
    };
  }

  async function diff(states: Record<string, StackState>) {
    return await buildDiffTree({
      stackName: 'Parent',
      displayName: 'Parent',
      region: 'us-east-1',
      template: parentTemplate(),
      nestedTemplates: { Child: writeChildTemplate() },
      recursive: true,
      stateBackend: fakeBackend(states),
      diffCalculator: new DiffCalculator(),
    });
  }

  it('reports NO_CHANGE on a freshly-deployed tree and never fetches the secret', async () => {
    const root = await diff(freshStates());

    expect(root.changes.get('Child')!.changeType).toBe('NO_CHANGE');
    const child = root.children[0]!;
    expect(child.stackName).toBe('Parent~Child');
    // The crux: the child's down-passed SECRET parameter must not surface as a
    // spurious change. Before the fix the desired side decrypted to plaintext
    // while state held the expression, so this was a permanent UPDATE.
    expect(child.changes.get('ChildRes')!.changeType).toBe('NO_CHANGE');
    expect(nodeHasChanges(child)).toBe(false);
    expect(treeHasChanges(root)).toBe(false);
    // ...and no live GetSecretValue was issued at plan time.
    expect(secretSend).not.toHaveBeenCalled();
  });

  it('never puts the plaintext into the rendered child diff — with a secret the fake WOULD hand over', async () => {
    // The DISCLOSURE half of the issue, stated independently of the change
    // classification.
    //
    // THE FAKE IS DELIBERATELY MADE ANSWERABLE HERE, overriding the file's
    // throwing default. With the default in place `not.toContain(PLAINTEXT)`
    // is UNFALSIFIABLE: no path could produce that string, so the assertion
    // passes on any implementation whatsoever, including one that dropped
    // `skipDynamicReferences` entirely. Handing back a real value gives the
    // wrong answer somewhere to show up — a diff that decrypts at plan time
    // now embeds the plaintext and this test goes red.
    secretSend.mockResolvedValue({
      SecretString: JSON.stringify({ password: SECRET_PLAINTEXT }),
    });

    const root = await diff(freshStates());

    expect(JSON.stringify(root)).not.toContain(SECRET_PLAINTEXT);
    // ...and the reason it is absent is that nothing asked AWS for it.
    expect(secretSend).not.toHaveBeenCalled();
  });

  it('still detects a genuine change to the down-passed reference', async () => {
    // Regression guard: a CHANGED expression (a different secret / a different
    // JSON key) is a real change and must still diff. `skipDynamicReferences`
    // compares expressions, so this is exactly what it can still see.
    const states = freshStates();
    states['Parent~Child']!.resources['ChildRes']!.properties['Value'] =
      '{{resolve:secretsmanager:prod/db/cred:SecretString:OLD_KEY::}}';

    const root = await diff(states);

    const child = root.children[0]!;
    expect(child.changes.get('ChildRes')!.changeType).toBe('UPDATE');
    expect(treeHasChanges(root)).toBe(true);
    expect(secretSend).not.toHaveBeenCalled();
  });

  it('does not PRUNE the child by a condition evaluated over the redacted token', async () => {
    // The flag that keeps the plaintext out of the diff also hands
    // `evaluateConditions` an EXPRESSION where deploy has the real value — the
    // deploy engine deliberately gives its CONDITION context the unredacted
    // parameters, because substituting an expression flips an `Fn::Equals`. So
    // the condition verdict on this side is not trustworthy, and pruning by it
    // would report a phantom DELETE of a condition-gated child resource that
    // deploy keeps (or a phantom CREATE of one it drops).
    //
    // The guard falls back to the WHOLE template — the same fallback the
    // existing `parametersBound` guard already takes for the same reason.
    const childPath = join(dir, 'child.json');
    writeFileSync(
      childPath,
      JSON.stringify({
        Parameters: { [PARAM]: { Type: 'String' } },
        Conditions: { IsProd: { 'Fn::Equals': [{ Ref: PARAM }, 'diff-recursive-plaintext-1903'] } },
        Resources: {
          ChildRes: {
            Type: 'AWS::SSM::Parameter',
            Condition: 'IsProd',
            Properties: { Type: 'String', Value: { Ref: PARAM } },
          },
        },
      })
    );

    const root = await buildDiffTree({
      stackName: 'Parent',
      displayName: 'Parent',
      region: 'us-east-1',
      template: parentTemplate(),
      nestedTemplates: { Child: childPath },
      recursive: true,
      stateBackend: fakeBackend(freshStates()),
      diffCalculator: new DiffCalculator(),
    });

    const child = root.children[0]!;
    // `Fn::Equals` over the TOKEN answers false, so a pruning pass would drop
    // `ChildRes` from the template while it is still in state — i.e. report it
    // as a DELETE. Deploy compares the real plaintext, keeps it, and reports
    // nothing.
    expect(child.changes.get('ChildRes')!.changeType).not.toBe('DELETE');
    expect(child.changes.get('ChildRes')!.changeType).toBe('NO_CHANGE');
    expect(secretSend).not.toHaveBeenCalled();
  });

  it('STILL prunes when the child\u2019s conditions reference no token parameter (the narrowed skip)', async () => {
    // THE NARROWING (review round 2). The skip used to fire whenever ANY bound
    // parameter was a redacted token, whether or not a condition mentioned one.
    // That is not merely conservative: with the condition map left undefined,
    // `resolveIf` warns and takes the FALSE branch for every `Fn::If` in every
    // property VALUE, so a condition-true property diffs as a spurious UPDATE
    // (perpetual, and `--fail` exits 1) on top of the phantom CREATEs.
    //
    // Here the secret parameter is present and the condition depends only on an
    // ORDINARY one, so the verdict is trustworthy and pruning is correct: the
    // condition-FALSE `DisabledRes` must not surface as a CREATE, and the
    // `Fn::If` on the kept resource must take its TRUE branch.
    const childPath = join(dir, 'child.json');
    writeFileSync(
      childPath,
      JSON.stringify({
        Parameters: { [PARAM]: { Type: 'String' }, Stage: { Type: 'String' } },
        Conditions: {
          IsProd: { 'Fn::Equals': [{ Ref: 'Stage' }, 'prod'] },
          IsDev: { 'Fn::Not': [{ Condition: 'IsProd' }] },
        },
        Resources: {
          ChildRes: {
            Type: 'AWS::SSM::Parameter',
            Properties: {
              Type: 'String',
              Value: { 'Fn::If': ['IsProd', 'prod-value', 'dev-value'] },
            },
          },
          DisabledRes: {
            Type: 'AWS::SSM::Parameter',
            Condition: 'IsDev',
            Properties: { Type: 'String', Value: 'never' },
          },
        },
      })
    );

    const root = await buildDiffTree({
      stackName: 'Parent',
      displayName: 'Parent',
      region: 'us-east-1',
      template: {
        Resources: {
          Child: {
            Type: NESTED,
            Metadata: { 'aws:asset:path': 'child.json' },
            Properties: { Parameters: { [PARAM]: SECRET_EXPR, Stage: 'prod' } },
          },
        },
      },
      nestedTemplates: { Child: childPath },
      recursive: true,
      stateBackend: fakeBackend({
        Parent: st('Parent', {
          Child: res(NESTED, { Parameters: { [PARAM]: SECRET_EXPR, Stage: 'prod' } }),
        }),
        'Parent~Child': st('Parent~Child', {
          // What deploy persists under `Stage: prod`: the TRUE branch.
          ChildRes: res('AWS::SSM::Parameter', { Type: 'String', Value: 'prod-value' }),
        }),
      }),
      diffCalculator: new DiffCalculator(),
    });

    const child = root.children[0]!;
    // The `Fn::If` resolved through the evaluated conditions rather than
    // defaulting to FALSE, so the desired side matches state.
    expect(child.changes.get('ChildRes')!.changeType).toBe('NO_CHANGE');
    // ...and the condition-FALSE resource was PRUNED rather than reported.
    expect(child.changes.get('DisabledRes')).toBeUndefined();
    expect(treeHasChanges(root)).toBe(false);
    expect(secretSend).not.toHaveBeenCalled();
  });

  it('goes back to NOT pruning when the token parameter is reached through a {Condition: X} chain', async () => {
    // The CHAINED shape (issue #840's `Fn::And`-over-a-named-condition), kept
    // as a regression guard rather than as a fence on a transitive walk: the
    // resource is gated on `IsDev`, which never names the secret parameter and
    // only wraps `IsProd`, which does. The scan answers correctly WITHOUT
    // following the chain, because `IsProd` is itself an entry in the same
    // `Conditions` map and every entry is visited — measured, which is why the
    // chain walk the first cut carried was removed as dead code. What this case
    // pins is the OUTCOME for the shape, so a future narrowing that scans only
    // the conditions a resource is gated on would go red here.
    const childPath = join(dir, 'child.json');
    writeFileSync(
      childPath,
      JSON.stringify({
        Parameters: { [PARAM]: { Type: 'String' } },
        Conditions: {
          IsProd: { 'Fn::Equals': [{ Ref: PARAM }, SECRET_PLAINTEXT] },
          // Gated on the CHAINED condition, and in the polarity that
          // discriminates: over the TOKEN `IsProd` answers false, so a pruning
          // pass drops `ChildRes` from the template while it is still in state
          // and reports a phantom DELETE. Deploy compares the real plaintext,
          // answers true, and reports nothing. (The opposite polarity —
          // `Fn::Not` — keeps the resource under BOTH verdicts and could not
          // tell the two apart.)
          IsProdChained: {
            'Fn::And': [{ Condition: 'IsProd' }, { 'Fn::Equals': ['always', 'always'] }],
          },
        },
        Resources: {
          ChildRes: {
            Type: 'AWS::SSM::Parameter',
            Condition: 'IsProdChained',
            Properties: { Type: 'String', Value: { Ref: PARAM } },
          },
        },
      })
    );

    const root = await buildDiffTree({
      stackName: 'Parent',
      displayName: 'Parent',
      region: 'us-east-1',
      template: parentTemplate(),
      nestedTemplates: { Child: childPath },
      recursive: true,
      stateBackend: fakeBackend(freshStates()),
      diffCalculator: new DiffCalculator(),
    });

    const child = root.children[0]!;
    // Not pruned: `ChildRes` is still compared against state rather than
    // vanishing from the template (which would report it as a DELETE).
    expect(child.changes.get('ChildRes')!.changeType).not.toBe('DELETE');
    expect(child.changes.get('ChildRes')!.changeType).toBe('NO_CHANGE');
    expect(secretSend).not.toHaveBeenCalled();
  });

  it('keeps a Number-typed child parameter as the token, and WARNS that deploy refuses the shape', async () => {
    // `resolveParameters` coerces by the declared `Type`, and `Number(token)`
    // is `NaN` — which then compares unequal to whatever is in state on every
    // single run, so the diff keeps the unresolved token instead.
    //
    // WHAT THIS TEST DOES NOT CLAIM (review round 2). The child state below is
    // seeded holding the EXPRESSION, and for a `Type: Number` parameter the
    // DEPLOY path can no longer produce that shape at all: cdkd's redaction is
    // string-keyed end to end, coercion drops the value out of it, and
    // `resolveParameters` now REFUSES such a parameter outright
    // (`refuseCoercedInheritedSecret`, fenced in
    // `intrinsic-resolver-inherited-parameter-secrets.test.ts`). The earlier
    // version of this test read as though it were fencing the deploy round-trip
    // and therefore passed over BOTH halves of that gap.
    //
    // What is genuinely under test here is the PLAN side, which must stay
    // best-effort rather than throwing: no `NaN`, no decryption, and a warning
    // that names the parameter so the user learns about the refusal before the
    // deploy rather than from it.
    const NUM_PARAM = 'referencetoParentPort';
    const childPath = join(dir, 'child.json');
    writeFileSync(
      childPath,
      JSON.stringify({
        Parameters: { [NUM_PARAM]: { Type: 'Number' } },
        Resources: {
          ChildRes: {
            Type: 'AWS::SSM::Parameter',
            Properties: { Type: 'String', Value: { Ref: NUM_PARAM } },
          },
        },
      })
    );

    const root = await buildDiffTree({
      stackName: 'Parent',
      displayName: 'Parent',
      region: 'us-east-1',
      template: {
        Resources: {
          Child: {
            Type: NESTED,
            Metadata: { 'aws:asset:path': 'child.json' },
            Properties: { Parameters: { [NUM_PARAM]: SECRET_EXPR } },
          },
        },
      },
      nestedTemplates: { Child: childPath },
      recursive: true,
      stateBackend: fakeBackend({
        Parent: st('Parent', { Child: res(NESTED, { Parameters: { [NUM_PARAM]: SECRET_EXPR } }) }),
        'Parent~Child': st('Parent~Child', {
          ChildRes: res('AWS::SSM::Parameter', { Type: 'String', Value: SECRET_EXPR }),
        }),
      }),
      diffCalculator: new DiffCalculator(),
    });

    const child = root.children[0]!;
    expect(child.changes.get('ChildRes')!.changeType).toBe('NO_CHANGE');
    // Stated directly too, so the assertion above cannot pass because the
    // comparison happened to be skipped: `NaN` would have surfaced here.
    expect(JSON.stringify(child)).not.toContain('null');
    expect(secretSend).not.toHaveBeenCalled();

    // The warning that mirrors the deploy-side refusal, naming BOTH the
    // parameter and the declared type.
    const warned = (getLogger().warn as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((call) => String(call[0]))
      .join('\n');
    expect(warned).toContain(NUM_PARAM);
    expect(warned).toContain('Type: Number');
    // ...and it must not quote the reference it is warning about resolving.
    expect(warned).not.toContain(SECRET_PLAINTEXT);
  });

  it('binds a CommaDelimitedList child parameter as the token SPLIT BY TYPE, matching the ARRAY state holds (#2327)', async () => {
    // The twin of the `Type: Number` case above, and its OPPOSITE verdict.
    // There the coercion produces `NaN`, which matches neither side, so the raw
    // token is kept. Here the deploy's own `coerceParameterValue` split the
    // RESOLVED value on `,` before redaction, so the child's state holds an
    // ARRAY of expressions -- and keeping the raw token compared a STRING
    // against that list and reported a phantom change on every single run.
    //
    // The comment this replaces justified the blanket raw-token rule as
    // "exactly what the child's state holds for such a parameter". That is true
    // only for a SCALAR one, which is what made it durable: an over-stated
    // invariant stops the next reader looking.
    //
    // Splitting the TOKEN reproduces the array because a `{{resolve:...}}`
    // expression carries no comma. A comma-BEARING secret never reaches a
    // deployed state to disagree with: `refuseCoercedInheritedSecret` refuses
    // the deploy outright.
    const LIST_PARAM = 'referencetoParentList';
    const childPath = join(dir, 'child.json');
    writeFileSync(
      childPath,
      JSON.stringify({
        Parameters: { [LIST_PARAM]: { Type: 'CommaDelimitedList' } },
        Resources: {
          ChildRule: {
            Type: 'AWS::Events::Rule',
            Properties: { EventPattern: { detail: { listA: { Ref: LIST_PARAM } } } },
          },
        },
      })
    );

    const root = await buildDiffTree({
      stackName: 'Parent',
      displayName: 'Parent',
      region: 'us-east-1',
      template: {
        Resources: {
          Child: {
            Type: NESTED,
            Metadata: { 'aws:asset:path': 'child.json' },
            Properties: { Parameters: { [LIST_PARAM]: SECRET_EXPR } },
          },
        },
      },
      nestedTemplates: { Child: childPath },
      recursive: true,
      stateBackend: fakeBackend({
        Parent: st('Parent', { Child: res(NESTED, { Parameters: { [LIST_PARAM]: SECRET_EXPR } }) }),
        'Parent~Child': st('Parent~Child', {
          // What the deploy path persists for this leaf: a ONE-element ARRAY.
          ChildRule: res('AWS::Events::Rule', {
            EventPattern: { detail: { listA: [SECRET_EXPR] } },
          }),
        }),
      }),
      diffCalculator: new DiffCalculator(),
    });

    const child = root.children[0]!;
    expect(child.changes.get('ChildRule')!.changeType).toBe('NO_CHANGE');
    expect(secretSend).not.toHaveBeenCalled();
  });

  it('binds a List<AWS::...> child parameter as the token SPLIT BY TYPE too, now that the coercion widened (#2347)', async () => {
    // Issue #2347: `tokenValueForComparison` moved TRANSITIVELY. It never
    // named the splitting types -- it asks what the coercion PRODUCED -- so
    // widening `coerceParameterTypedValue` silently changed its answer for the
    // whole `List<...>` family, and nothing in this file covered a single one
    // of them (only `CommaDelimitedList` and `List<Number>` were pinned).
    //
    // The verdict must match the `CommaDelimitedList` case above, for the same
    // reason: the deploy's own `coerceParameterValue` now splits a
    // `List<AWS::EC2::Subnet::Id>` value on `,` before redaction, so the child's
    // state holds an ARRAY of expressions, and keeping the raw token would
    // compare a STRING against that list and report a phantom change on every
    // run. Deleting the widened arm from the coercion makes this fail.
    const LIST_PARAM = 'referencetoParentSubnets';
    const childPath = join(dir, 'child.json');
    writeFileSync(
      childPath,
      JSON.stringify({
        Parameters: { [LIST_PARAM]: { Type: 'List<AWS::EC2::Subnet::Id>' } },
        Resources: {
          ChildRule: {
            Type: 'AWS::Events::Rule',
            Properties: { EventPattern: { detail: { listA: { Ref: LIST_PARAM } } } },
          },
        },
      })
    );

    const root = await buildDiffTree({
      stackName: 'Parent',
      displayName: 'Parent',
      region: 'us-east-1',
      template: {
        Resources: {
          Child: {
            Type: NESTED,
            Metadata: { 'aws:asset:path': 'child.json' },
            Properties: { Parameters: { [LIST_PARAM]: SECRET_EXPR } },
          },
        },
      },
      nestedTemplates: { Child: childPath },
      recursive: true,
      stateBackend: fakeBackend({
        Parent: st('Parent', { Child: res(NESTED, { Parameters: { [LIST_PARAM]: SECRET_EXPR } }) }),
        'Parent~Child': st('Parent~Child', {
          // What the deploy path persists for this leaf: a ONE-element ARRAY.
          ChildRule: res('AWS::Events::Rule', {
            EventPattern: { detail: { listA: [SECRET_EXPR] } },
          }),
        }),
      }),
      diffCalculator: new DiffCalculator(),
    });

    const child = root.children[0]!;
    expect(child.changes.get('ChildRule')!.changeType).toBe('NO_CHANGE');
    expect(secretSend).not.toHaveBeenCalled();
  });

  it('keeps a List<Number>-typed child parameter as the token, not an array of NaN (#2327)', async () => {
    // THE FLOOR under the case above, and it was UNFENCED: deleting
    // `tokenValueForComparison`'s "every element is a string" guard left all
    // 181 tests in this repo green, because no test declared a `List<Number>`
    // parameter at all. Its coercion produces an ARRAY -- so the `Number` case
    // above, which refuses on `!Array.isArray`, cannot reach this guard -- and
    // the elements are `NaN`, which matches neither side.
    //
    // PLAN-SIDE ONLY, exactly like the `Type: Number` case: the deploy path
    // refuses such a parameter outright (`refuseCoercedInheritedSecret`), so the
    // seeded state below is not a shape a deploy can produce. What is under test
    // is that the diff stays best-effort and produces no `NaN`.
    const NUMLIST_PARAM = 'referencetoParentPorts';
    const childPath = join(dir, 'child.json');
    writeFileSync(
      childPath,
      JSON.stringify({
        Parameters: { [NUMLIST_PARAM]: { Type: 'List<Number>' } },
        Resources: {
          ChildRes: {
            Type: 'AWS::SSM::Parameter',
            Properties: { Type: 'String', Value: { Ref: NUMLIST_PARAM } },
          },
        },
      })
    );

    const root = await buildDiffTree({
      stackName: 'Parent',
      displayName: 'Parent',
      region: 'us-east-1',
      template: {
        Resources: {
          Child: {
            Type: NESTED,
            Metadata: { 'aws:asset:path': 'child.json' },
            Properties: { Parameters: { [NUMLIST_PARAM]: SECRET_EXPR } },
          },
        },
      },
      nestedTemplates: { Child: childPath },
      recursive: true,
      stateBackend: fakeBackend({
        Parent: st('Parent', {
          Child: res(NESTED, { Parameters: { [NUMLIST_PARAM]: SECRET_EXPR } }),
        }),
        'Parent~Child': st('Parent~Child', {
          ChildRes: res('AWS::SSM::Parameter', { Type: 'String', Value: SECRET_EXPR }),
        }),
      }),
      diffCalculator: new DiffCalculator(),
    });

    const child = root.children[0]!;
    expect(child.changes.get('ChildRes')!.changeType).toBe('NO_CHANGE');
    // Stated directly too: a coerced `List<Number>` serialises its `NaN`
    // elements as `null`, so this would surface here if the guard were gone.
    expect(JSON.stringify(child)).not.toContain('null');
    expect(secretSend).not.toHaveBeenCalled();
  });

  it('still resolves a NON-secret down-passed parameter (scope control)', async () => {
    // The flag must not stop ordinary literal / intrinsic parameters from
    // resolving, or every nested child would report spurious drift instead.
    const childPath = join(dir, 'child.json');
    writeFileSync(
      childPath,
      JSON.stringify({
        Parameters: { Plain: { Type: 'String' } },
        Resources: {
          ChildRes: {
            Type: 'AWS::SSM::Parameter',
            Properties: { Type: 'String', Value: { 'Fn::Join': ['', ['prefix:', { Ref: 'Plain' }]] } },
          },
        },
      })
    );
    const root = await buildDiffTree({
      stackName: 'Parent',
      displayName: 'Parent',
      region: 'us-east-1',
      template: {
        Resources: {
          Child: {
            Type: NESTED,
            Metadata: { 'aws:asset:path': 'child.json' },
            Properties: { Parameters: { Plain: 'public-value' } },
          },
        },
      },
      nestedTemplates: { Child: childPath },
      recursive: true,
      stateBackend: fakeBackend({
        Parent: st('Parent', { Child: res(NESTED, { Parameters: { Plain: 'public-value' } }) }),
        'Parent~Child': st('Parent~Child', {
          ChildRes: res('AWS::SSM::Parameter', { Type: 'String', Value: 'prefix:public-value' }),
        }),
      }),
      diffCalculator: new DiffCalculator(),
    });

    expect(root.children[0]!.changes.get('ChildRes')!.changeType).toBe('NO_CHANGE');
    expect(treeHasChanges(root)).toBe(false);
  });
});
