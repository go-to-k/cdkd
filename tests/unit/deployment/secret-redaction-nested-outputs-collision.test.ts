/**
 * A nested child's `Outputs` reading BOTH a literal-spelled parameter (issue
 * #4644) and a same-plaintext sibling keep each parameter's own spelling (issue
 * [#4913](https://github.com/go-to-k/cdkd/issues/4913)).
 *
 * The outputs pass records its parameter reads on its own bag, and
 * `absorbOutputsPassSecrets` folds that bag into `outputSecrets`, which the
 * outputs redaction walks. Without the reads table there, no output leaf is
 * positioned per parameter, so `poisonRenderedSpellingsCollidingIn` counted
 * every output read a slot read and withdrew the literal's spelling for the
 * whole child: state held the survivor while `cdkd diff --recursive` rendered
 * the literal.
 *
 * Drives a REAL `DeployEngine` outputs pass with the REAL resolver and the REAL
 * `redactOutputs`, and compares against the diff side the engine binds
 * (`redactParametersForDiff`), the literal binding `cdkd diff --recursive`
 * renders, and what `cdkd scrub` writes for the same child.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import {
  recordNestedStackParameterExpressions,
  recordResolvedPair,
  redactInheritedParameterValue,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';
import { poisonRenderedSpellingsCollidingIn } from '../../../src/deployment/intrinsic-resolver/parameter-secrets.js';
import { scrubStack } from '../../../src/cli/commands/scrub.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';

// No real AWS client: the create-only DescribeType prefetch reads the
// process-global client factory (see _inert-cloudformation-client.ts).
vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) =>
  (await import('./_inert-cloudformation-client.js')).withInertCloudFormationClient(importOriginal)
);

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

const EXPR_A = '{{resolve:secretsmanager:prod/db/cred:SecretString:out4913::}}';
const EXPR_B = '{{resolve:secretsmanager:prod/db/cred:SecretString:out4913:AWSCURRENT:}}';
const USER_EXPR = '{{resolve:secretsmanager:prod/db/cred:SecretString:out4913user::}}';
const SHARED = 'sh4red-0utputs-pl4intext-4913';
const USER = 'us3r-0utputs-4913';
const PARAM_A = 'ConnA';
const PARAM_B = 'SecretB';
const SPELLING = `postgres://${USER_EXPR}:${EXPR_A}@host`;
const CONN = `postgres://${USER}:${SHARED}@host`;
/** A public parameter: it carries no secret, so no association keys it. */
const PUB = 'Pub';
const PUB_VALUE = 'pl41n-v4lue-4913';
const PARAMETERS = { [PARAM_A]: CONN, [PARAM_B]: SHARED, [PUB]: PUB_VALUE };

const SEL_A = { 'Fn::Select': [0, [{ Ref: PARAM_A }]] };
const SEL_B = { 'Fn::Select': [0, [{ Ref: PARAM_B }]] };
const SPLIT_A = { 'Fn::Select': [0, { 'Fn::Split': ['@', { Ref: PARAM_A }] }] };
/** Re-read since issue #4919: an `Fn::Sub` under `Fn::Select`. */
const SUB_SEL_A = { 'Fn::Select': [0, [{ 'Fn::Sub': `\${${PARAM_A}}` }]] };
const SUB_B = { 'Fn::Sub': `x-\${${PARAM_B}}` };
const SUB_SEL_B = { 'Fn::Select': [0, [{ 'Fn::Sub': `\${${PARAM_B}}` }]] };
/** Slot reads no re-read evaluates: an intrinsic it does not evaluate in the list. */
const OPAQUE_SEL_A = { 'Fn::Select': [0, [{ Ref: PARAM_A }, { 'Fn::Base64': 'x' }]] };
const OPAQUE_SEL_B = { 'Fn::Select': [0, [{ Ref: PARAM_B }, { 'Fn::Base64': 'x' }]] };

/** One parent row's bag; `reversed` resolves `ConnA` first, so `EXPR_B` survives. */
function parentRow(reversed: boolean): RecordedSecretValues {
  const conn = [
    [USER_EXPR, USER],
    [EXPR_A, SHARED],
  ] as const;
  const order = reversed ? [...conn, [EXPR_B, SHARED] as const] : [[EXPR_B, SHARED] as const, ...conn];
  const parent: RecordedSecretValues = new Map();
  for (const [expression, plaintext] of order) {
    parent.set(plaintext, expression);
    recordResolvedPair(parent, expression, plaintext);
  }
  recordNestedStackParameterExpressions(
    parent,
    'AWS::CloudFormation::Stack',
    { Parameters: PARAMETERS },
    { Parameters: { [PARAM_A]: SPELLING, [PARAM_B]: EXPR_B } }
  );
  return parent;
}

function childTemplate(outputs: Record<string, unknown>): CloudFormationTemplate {
  return {
    Parameters: {
      [PARAM_A]: { Type: 'String' },
      [PARAM_B]: { Type: 'String' },
      [PUB]: { Type: 'String' },
    },
    // Declared, as CloudFormation requires of the condition an `Fn::If` names;
    // false, which is what the outputs pass here resolves it to.
    Conditions: { On: { 'Fn::Equals': ['a', 'b'] } },
    Resources: {},
    Outputs: Object.fromEntries(Object.entries(outputs).map(([key, value]) => [key, { Value: value }])),
  } as CloudFormationTemplate;
}

function childEngine(parent: RecordedSecretValues): DeployEngine {
  return new DeployEngine(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { dryRun: false, inheritedSecrets: parent } as never,
    'us-east-1'
  );
}

const resolver = new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false });

/**
 * The deploy's outputs pass as `doDeploy` runs it -- the withdrawal walk
 * before any resolution, then `resolveOutputs` and the persist redaction --
 * and the outputs the engine's own diff side binds, and the literal binding
 * `cdkd diff --recursive` renders from the parent row's persisted parameters.
 */
async function persistAndDesired(
  parent: RecordedSecretValues,
  template: CloudFormationTemplate
): Promise<{
  persisted: Record<string, unknown>;
  desired: Record<string, unknown>;
  literal: Record<string, unknown>;
}> {
  poisonRenderedSpellingsCollidingIn(template, PARAMETERS, parent);
  const engine = childEngine(parent);
  const resolved = await engine.resolveOutputs(template, {}, 'Parent~Child', template, PARAMETERS);
  // Twice, as the save's choke point re-redacts the pass's own redaction.
  const persisted = engine.redactOutputs(engine.redactOutputs(resolved));
  const resolveOutputsWith = async (parameters: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const [key, output] of Object.entries(template.Outputs ?? {})) {
      out[key] = await resolver.resolve((output as { Value: unknown }).Value, {
        template,
        resources: {},
        parameters,
        skipDynamicReferences: true,
      } as unknown as ResolverContext);
    }
    return out;
  };
  const desired = await resolveOutputsWith(engine.redactParametersForDiff(PARAMETERS));
  const literal = await resolveOutputsWith({
    [PARAM_A]: SPELLING,
    [PARAM_B]: EXPR_B,
    [PUB]: PUB_VALUE,
  });
  return { persisted, desired, literal };
}

describe("a nested child's Outputs reading BOTH parameters keep each spelling (#4913)", () => {
  // Every shape the persist walk answers per parameter: a bare `{Ref}`, a
  // re-read (`Fn::Select` / `Fn::Split`), an `Fn::Join` / `Fn::Sub` placeholder.
  const POSITIONED: Record<string, Record<string, unknown>> = {
    'bare ConnA, bare SecretB': { OA: { Ref: PARAM_A }, OB: { Ref: PARAM_B } },
    'Select ConnA, bare SecretB': { OA: SEL_A, OB: { Ref: PARAM_B } },
    'bare ConnA, Select SecretB': { OA: { Ref: PARAM_A }, OB: SEL_B },
    'Select ConnA, Select SecretB': { OA: SEL_A, OB: SEL_B },
    'Select over Split ConnA, bare SecretB': { OA: SPLIT_A, OB: { Ref: PARAM_B } },
    'Fn::Sub ConnA, bare SecretB': { OA: { 'Fn::Sub': `x-\${${PARAM_A}}` }, OB: { Ref: PARAM_B } },
    // The sibling through a placeholder: its part takes its parameter's
    // association, which the outputs bag holds too.
    'bare ConnA, Fn::Sub SecretB': { OA: { Ref: PARAM_A }, OB: { 'Fn::Sub': `x-\${${PARAM_B}}` } },
    'bare ConnA, Fn::Join SecretB': {
      OA: { Ref: PARAM_A },
      OB: { 'Fn::Join': ['', ['x-', { Ref: PARAM_B }]] },
    },
    'bare ConnA, one Fn::Sub over both': {
      OA: { Ref: PARAM_A },
      OB: { 'Fn::Sub': `\${${PARAM_A}}|\${${PARAM_B}}` },
    },
    'Fn::Join ConnA, Select SecretB': {
      OA: { 'Fn::Join': ['', ['x-', { Ref: PARAM_A }]] },
      OB: SEL_B,
    },
    // Issue #4919: an `Fn::Sub` under `Fn::Select`, and an `Fn::If` whose
    // leaf names its branch (`On` is false on both sides).
    'Sub-in-Select ConnA, bare SecretB': { OA: SUB_SEL_A, OB: { Ref: PARAM_B } },
    'bare ConnA, Sub-in-Select SecretB': { OA: { Ref: PARAM_A }, OB: SUB_SEL_B },
    'Fn::If over ConnA, bare SecretB': {
      OA: { 'Fn::If': ['On', 'z', { Ref: PARAM_A }] },
      OB: { Ref: PARAM_B },
    },
  };
  for (const reversed of [true, false]) {
    for (const literalLast of [true, false]) {
      for (const [shape, outputs] of Object.entries(POSITIONED)) {
        it(`${reversed ? 'reversed' : 'forward'} parent order, ${literalLast ? 'literal' : 'sibling'} read last, ${shape}`, async () => {
          const ordered = literalLast
            ? { OB: outputs['OB'], OA: outputs['OA'] }
            : { OA: outputs['OA'], OB: outputs['OB'] };
          const parent = parentRow(reversed);
          const { persisted, desired, literal } = await persistAndDesired(
            parent,
            childTemplate(ordered)
          );
          // Nothing withdrawn: the diff side binds the literal.
          expect(redactInheritedParameterValue(parent, PARAM_A, CONN)).toBe(SPELLING);
          expect(persisted).toEqual(desired);
          expect(persisted).toEqual(literal);
          // Each output its OWN parameter's token, whichever resolved last.
          expect(JSON.stringify(persisted['OA'])).toContain(EXPR_A);
          expect(JSON.stringify(persisted['OA'])).not.toContain(EXPR_B);
          expect(JSON.stringify(persisted['OB'])).toContain(EXPR_B);
          expect(JSON.stringify(persisted)).not.toContain(SHARED);
          expect(JSON.stringify(persisted)).not.toContain(USER);
        });
      }
    }
  }
});

describe('an output read the persist walk cannot position still withdraws (#4913)', () => {
  const SLOT: Record<string, Record<string, unknown>> = {
    'opaque Select ConnA, bare SecretB': { OA: OPAQUE_SEL_A, OB: { Ref: PARAM_B } },
    'bare ConnA, opaque Select SecretB': { OA: { Ref: PARAM_A }, OB: OPAQUE_SEL_B },
    // `TEMPLATE_SOURCED_RULES` walks no array positionally, so a read inside
    // a list-valued output is value-scanned from the slot.
    'ConnA in a list-valued output, bare SecretB': { OA: [{ Ref: PARAM_A }], OB: { Ref: PARAM_B } },
    // Two parts the template parse cannot key: only the resolver's spans
    // could position it, and they stay on the outputs pass's own bag.
    'bare ConnA, Fn::Sub of SecretB between two pseudo parameters': {
      OA: { Ref: PARAM_A },
      OB: { 'Fn::Sub': `\${AWS::Region}-\${AWS::URLSuffix}-\${${PARAM_B}}` },
    },
    // ...and a public parameter is one too: no association keys it.
    'bare ConnA, Fn::Sub of a pseudo parameter, a public parameter and SecretB': {
      OA: { Ref: PARAM_A },
      OB: { 'Fn::Sub': `\${AWS::Region}-\${${PUB}}-\${${PARAM_B}}` },
    },
    'bare ConnA, Fn::Join of a pseudo parameter, a public parameter and SecretB': {
      OA: { Ref: PARAM_A },
      OB: { 'Fn::Join': ['-', [{ Ref: 'AWS::Region' }, { Ref: PUB }, { Ref: PARAM_B }]] },
    },
    // An `Fn::If` is the walk's leaf, re-read only where every branch is.
    'Fn::If over opaque ConnA, bare SecretB': {
      OA: { 'Fn::If': ['On', OPAQUE_SEL_A, 'z'] },
      OB: { Ref: PARAM_B },
    },
  };
  for (const literalLast of [true, false]) {
    for (const [shape, outputs] of Object.entries(SLOT)) {
      // The reversed parent order, where the withdrawal restores agreement
      // (the forward order's slot residual is #2349's, unchanged).
      it(`${shape} (${literalLast ? 'literal' : 'sibling'} read last): withdraws the literal's spelling, and persists what the diff side binds`, async () => {
        const parent = parentRow(true);
        const ordered = literalLast
          ? { OB: outputs['OB'], OA: outputs['OA'] }
          : { OA: outputs['OA'], OB: outputs['OB'] };
        const template = {
          ...childTemplate(ordered),
          Conditions: { On: { 'Fn::Equals': ['a', 'a'] } },
        } as CloudFormationTemplate;
        const { persisted, desired } = await persistAndDesired(parent, template);
        expect(redactInheritedParameterValue(parent, PARAM_A, CONN)).toBe(
          `postgres://${USER_EXPR}:${EXPR_B}@host`
        );
        expect(persisted).toEqual(desired);
        expect(JSON.stringify(persisted)).not.toContain(SHARED);
      });
    }
  }

  it('counts an Export.Name read a slot read: the name resolution writes the slot', () => {
    const parent = parentRow(true);
    const template = {
      Parameters: { [PARAM_A]: { Type: 'String' }, [PARAM_B]: { Type: 'String' } },
      Resources: {},
      Outputs: {
        OA: { Value: { Ref: PARAM_A } },
        OB: { Value: 'v', Export: { Name: { 'Fn::Sub': `n-\${${PARAM_B}}` } } },
      },
    } as unknown as CloudFormationTemplate;
    poisonRenderedSpellingsCollidingIn(template, PARAMETERS, parent);
    expect(redactInheritedParameterValue(parent, PARAM_A, CONN)).toBe(
      `postgres://${USER_EXPR}:${EXPR_B}@host`
    );
  });

  it('keeps the spelling where the Outputs read only the literal', async () => {
    const parent = parentRow(true);
    const { persisted, literal } = await persistAndDesired(
      parent,
      childTemplate({ OA: { Ref: PARAM_A }, OA2: SEL_A })
    );
    expect(persisted).toEqual(literal);
    expect(persisted['OA']).toBe(SPELLING);
  });
});

describe('the no-change path keeps a previous generation\'s outputs (#4913)', () => {
  for (const reversed of [true, false]) {
    it(`re-redacting a persisted bag after the pass changes nothing (${reversed ? 'reversed' : 'forward'})`, async () => {
      const parent = parentRow(reversed);
      const template = childTemplate({ OA: { Ref: PARAM_A }, OB: SEL_B, OC: SPLIT_A });
      poisonRenderedSpellingsCollidingIn(template, PARAMETERS, parent);
      const engine = childEngine(parent);
      const resolved = await engine.resolveOutputs(template, {}, 'Parent~Child', template, PARAMETERS);
      const current = engine.redactOutputs(resolved);
      // This generation's bag, and an older one holding the survivor's
      // spelling (what a deploy before this fix persisted), are both kept
      // as they are: the walk rewrites no expression it did not resolve.
      expect(engine.redactOutputs(current)).toEqual(current);
      const older = {
        OA: `postgres://${USER_EXPR}:${EXPR_B}@host`,
        OB: EXPR_B,
        OC: `postgres://${USER_EXPR}:${EXPR_B}`,
      };
      expect(engine.redactOutputs(older)).toEqual(older);
      // ...and the older one differs from what the pass resolved, so the
      // no-change path's `outputsChanged` persists the fresh bag once.
      expect(current).not.toEqual(older);
      expect(current['OA']).toBe(SPELLING);
    });
  }
});

describe('cdkd scrub writes the outputs the deploy persists (#4913)', () => {
  const scrubLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
  for (const reversed of [true, false]) {
    for (const literalLast of [true, false]) {
      it(`${reversed ? 'reversed' : 'forward'} parent order, ${literalLast ? 'literal' : 'sibling'} read last`, async () => {
        const outputs = literalLast
          ? { OB: { Ref: PARAM_B }, OS: SEL_B, OJ: SUB_B, OA: { Ref: PARAM_A }, OR: SPLIT_A }
          : { OA: { Ref: PARAM_A }, OR: SPLIT_A, OB: { Ref: PARAM_B }, OS: SEL_B, OJ: SUB_B };
        const template = childTemplate(outputs);
        const scrubParent = parentRow(reversed);
        const state = {
          version: 9,
          region: 'us-east-1',
          stackName: 'Parent~Child',
          resources: {},
          // A record holding the plaintext, as scrub exists to repair.
          outputs: {
            OA: CONN,
            OR: `postgres://${USER}:${SHARED}`,
            OB: SHARED,
            OS: SHARED,
            OJ: `x-${SHARED}`,
          },
          lastModified: 0,
        } as unknown as StackState;
        const saveState = vi.fn().mockResolvedValue('etag-2');
        await scrubStack(
          { stackName: 'Parent~Child', template } as never,
          'us-east-1',
          {
            getState: vi.fn().mockResolvedValue({ state, etag: 'etag-1' }),
            saveState,
            purgeNoncurrentVersions: vi.fn().mockResolvedValue(undefined),
            listStacks: vi.fn().mockResolvedValue([]),
          } as never,
          {
            acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
            releaseLock: vi.fn().mockResolvedValue(undefined),
          } as never,
          {
            dryRun: false,
            logger: scrubLogger,
            nestedChild: {
              logicalId: 'Child',
              stackName: 'Parent~Child',
              input: { parameters: PARAMETERS, inheritedSecrets: scrubParent },
            },
          } as never
        );
        expect(redactInheritedParameterValue(scrubParent, PARAM_A, CONN)).toBe(SPELLING);
        const saved = (saveState.mock.calls.at(-1)![2] as StackState).outputs;
        const { persisted, literal } = await persistAndDesired(parentRow(reversed), template);
        expect(saved).toEqual(persisted);
        expect(saved).toEqual(literal);
        expect(saved['OA']).toBe(SPELLING);
        expect(saved['OB']).toBe(EXPR_B);
      });
    }
  }
});
