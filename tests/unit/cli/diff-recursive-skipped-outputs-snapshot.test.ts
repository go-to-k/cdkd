/**
 * The diff side of issue #2740's snapshot ORDERING, pinned by INJECTING a
 * mutation.
 *
 * `computeStackDiff` deep-copies the template before its parameter binding and
 * condition evaluation, so that no resolution can be visible to the
 * skipped-output digests. Its sibling suite
 * (`diff-recursive-skipped-outputs.test.ts`) drives the REAL resolver and pins
 * the no-mutation contract from the other direction, which is the right test
 * for what the code does today — but it cannot pin the ORDERING, because since
 * go-to-k/cdkd#2764 nothing in that flow rewrites the template, so deleting the
 * copy survives it.
 *
 * This suite supplies the missing half: the resolver is mocked to rewrite
 * `context.template.Conditions` in place while evaluating conditions — the
 * shape `resolveSub` used to produce — and the record is computed over a
 * freshly-parsed template. If the snapshot were taken after that step (or were
 * the live object rather than a copy), the digests would disagree and the
 * record would stop binding. That is the same mechanism the engine suite uses
 * for its own half, so the invariant is pinned on BOTH sides regardless of what
 * any real resolver happens to do.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

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

/** Toggled per case: whether the mocked `evaluateConditions` rewrites its input. */
const conditionsEvaluationMutates = vi.hoisted(() => ({ value: true }));

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/deployment/intrinsic-function-resolver.js')>();
  return {
    ...actual,
    IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
      // Pass-through: every fixture value below is a literal or a token this
      // resolver is expected to leave alone, which is what the diff's
      // `skipDynamicReferences` context does for a secret reference.
      resolve: vi.fn().mockImplementation((value: unknown) => Promise.resolve(value)),
      resolveBestEffort: vi.fn().mockImplementation((value: unknown) => Promise.resolve(value)),
      resolveParameters: vi.fn().mockReturnValue({}),
      evaluateConditions: vi
        .fn()
        .mockImplementation((context: { template?: { Conditions?: Record<string, unknown> } }) => {
          if (conditionsEvaluationMutates.value && context.template?.Conditions) {
            for (const name of Object.keys(context.template.Conditions)) {
              context.template.Conditions[name] = '<rewritten in place by evaluateConditions>';
            }
          }
          return Promise.resolve({});
        }),
      getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
      resetPhysicalIdFallbackCount: vi.fn(),
    })),
  };
});

import { computeStackDiff } from '../../../src/cli/commands/diff-recursive.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { skippedOutputDigest } from '../../../src/analyzer/skipped-outputs.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';

const SECRET_REF = '{{resolve:secretsmanager:cdkd/db:SecretString:missing}}';

function template(): CloudFormationTemplate {
  return {
    Parameters: { Env: { Type: 'String', Default: 'dev' } },
    // The section the mocked evaluation rewrites. It is digested (everything
    // but `Resources` and `Outputs` is), so a post-evaluation snapshot would
    // produce a digest a freshly-parsed template can never reproduce.
    Conditions: {
      IsDev: { 'Fn::Equals': [{ 'Fn::Sub': ['${E}', { E: { Ref: 'Env' } }] }, 'dev'] },
    },
    Resources: { A: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'x' } } },
    Outputs: {
      NeverResolved: { Value: SECRET_REF },
      Fine: { Value: 'fine' },
    },
  };
}

function state(skippedOutputs?: Record<string, string>): StackState {
  return {
    stackName: 'S',
    region: 'us-east-1',
    version: 9,
    resources: {
      A: {
        physicalId: 'pid',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Value: 'x' },
        attributes: {},
        dependencies: [],
      },
    },
    outputs: { Fine: 'fine' },
    exportNames: [],
    ...(skippedOutputs && { skippedOutputs }),
    lastModified: 0,
  };
}

const backend = { getState: async () => null } as unknown as S3StateBackend;

const diff = async (s: StackState, tpl: CloudFormationTemplate) =>
  computeStackDiff(s, tpl, 'us-east-1', 'S', backend, new DiffCalculator());

beforeEach(() => {
  vi.clearAllMocks();
  conditionsEvaluationMutates.value = true;
});

describe('computeStackDiff digests the template BEFORE it is resolved (issue #2740)', () => {
  it('binds a record computed over a fresh parse even though condition evaluation rewrote the template', async () => {
    const record = { NeverResolved: skippedOutputDigest(template(), 'NeverResolved') };
    const handedIn = template();
    const { outputChanges } = await diff(state(record), handedIn);

    // PREMISE: the rewrite really happened on the object the caller passed in,
    // so a snapshot taken after it — or no snapshot at all — would digest
    // `<rewritten in place by evaluateConditions>` and stop binding.
    expect(handedIn.Conditions).toEqual({ IsDev: '<rewritten in place by evaluateConditions>' });
    // The record still binds: no phantom row for the key it names.
    expect(outputChanges).toEqual([]);
  });

  it('CONTROL: with the rewrite disabled the same record binds too, so the case above is about ORDER', async () => {
    // Without this, a failure of the case above could equally mean "the record
    // never binds under this mock" rather than "the snapshot moved".
    conditionsEvaluationMutates.value = false;
    const record = { NeverResolved: skippedOutputDigest(template(), 'NeverResolved') };
    const handedIn = template();
    const { outputChanges } = await diff(state(record), handedIn);
    expect(handedIn.Conditions).toEqual(template().Conditions);
    expect(outputChanges).toEqual([]);
  });

  it('CONTROL: a record digested over the REWRITTEN template does not bind', async () => {
    // The other direction, and what a post-resolution snapshot would compute:
    // digest the mutated shape and the key previews as an ordinary ADD again.
    const rewritten = template();
    rewritten.Conditions = { IsDev: '<rewritten in place by evaluateConditions>' };
    const record = { NeverResolved: skippedOutputDigest(rewritten, 'NeverResolved') };
    const { outputChanges } = await diff(state(record), template());
    expect(outputChanges.map((c) => [c.name, c.changeType])).toEqual([['NeverResolved', 'ADD']]);
  });
});
