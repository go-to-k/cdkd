/**
 * WIRING for issue #2740: `computeStackDiff` hands `StackState.skippedOutputs`
 * to `resolveTemplateOutputs`. The analyzer suite proves the reader; this
 * proves the argument is THREADED, through the REAL `IntrinsicFunctionResolver`
 * under the diff's `skipDynamicReferences` context — so the secret reference
 * below assembles into its own token exactly as it does in `cdkd diff`, and a
 * missing fifth argument reads as the phantom `ADD` the issue reports.
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

import { getLogger } from '../../../src/utils/logger.js';
import { computeStackDiff } from '../../../src/cli/commands/diff-recursive.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { skippedOutputDigest } from '../../../src/analyzer/skipped-outputs.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';

const SECRET_REF = '{{resolve:secretsmanager:cdkd/db:SecretString:missing}}';

function template(): CloudFormationTemplate {
  return {
    // A two-argument `Fn::Sub` inside a condition, and a `Ref` to a parameter:
    // the shapes `computeStackDiff`'s parameter binding and condition
    // evaluation walk before the outputs pass. The record below is computed
    // over the PRISTINE template, as the deploy does, and the no-mutation case
    // asserts this object comes back untouched.
    Parameters: { Env: { Type: 'String', Default: 'dev' } },
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

/**
 * The same stack with the skipped output REFERENCING resource `A`.
 *
 * A `Ref`-shaped reference, not an `Fn::GetAtt`: the un-bind arm is the one
 * that RESOLVES, and resolving an attribute this state does not hold sends the
 * real resolver to the SDK for it — which the repo's AWS fence refuses on a
 * machine with credentials, and which on a credential-less CI runner fails
 * in-process and SATISFIES a "could not be resolved" assertion for the wrong
 * reason. A `Ref` to a resource that IS in state resolves from `physicalId`
 * alone, so both arms stay local and the discriminator is the rendered row.
 */
function refTemplate(resourceValue = 'x'): CloudFormationTemplate {
  const t = template();
  t.Resources['A']!.Properties = { Value: resourceValue };
  t.Outputs!['NeverResolved'] = { Value: { 'Fn::Sub': 'endpoint-${A}' } };
  return t;
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

const backend = {
  getState: async () => null,
} as unknown as S3StateBackend;

async function diff(s: StackState, tpl: CloudFormationTemplate) {
  return computeStackDiff(s, tpl, 'us-east-1', 'S', backend, new DiffCalculator());
}

describe('computeStackDiff threads skippedOutputs (issue #2740)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('CONTROL: with no record, the never-resolved secret output previews as an ADD', async () => {
    const { changes, outputChanges } = await diff(state(), template());
    expect([...changes.values()].every((c) => c.changeType === 'NO_CHANGE')).toBe(true);
    expect(outputChanges).toEqual([
      { name: 'NeverResolved', changeType: 'ADD', newValue: SECRET_REF, isExport: false },
    ]);
  });

  it('with the record the last deploy wrote, the unchanged stack reports NO outputs delta and no warning', async () => {
    const record = { NeverResolved: skippedOutputDigest(template(), 'NeverResolved') };
    const { outputChanges } = await diff(state(record), template());
    expect(outputChanges).toEqual([]);
    // The key is previewed as absent, not as a failed section — no warning.
    expect(getLogger().warn).not.toHaveBeenCalled();
  });

  it('leaves the template it was handed byte-identical, so no resolution can reach the digest', async () => {
    // The snapshot contract from the other direction (issue #2740). It used to
    // be pinned by asserting that condition evaluation REWROTE the template in
    // place — the behaviour go-to-k/cdkd#2764 removed from `resolveSub`. The
    // invariant never depended on that write: it is that the digest sees
    // template text as handed in. Pinning the no-mutation contract keeps a
    // future in-place optimisation anywhere in this flow from moving the
    // digest silently — it reds HERE, and whoever reintroduces one has to
    // re-establish that the snapshot still precedes it.
    const handedIn = template();
    const pristine = structuredClone(handedIn);
    await diff(state(), handedIn);
    expect(handedIn).toEqual(pristine);
  });

  // The `Resources` exclusion's blind spot (review round 1) and its fix. The
  // two arms differ ONLY in whether the referenced resource changes — the
  // digest is byte-identical between them, since `Resources` is not digested —
  // so the row is attributable to the change map and to nothing else.
  it('does NOT bind a record whose output references a resource this deploy will CHANGE', async () => {
    const record = { NeverResolved: skippedOutputDigest(refTemplate(), 'NeverResolved') };
    const { changes, outputChanges } = await diff(state(record), refTemplate('CHANGED'));
    expect([...changes.values()].some((c) => c.changeType === 'UPDATE')).toBe(true);
    // Un-bound, so the output is previewed like any other. The VALUE is
    // asserted, not just the row: `endpoint-pid` is the state record's
    // `physicalId` substituted into the `Fn::Sub`, which is the claim this
    // fixture's doc-comment makes about staying local — no attribute, no
    // client, no credentials. A shape that reached AWS could not produce it.
    expect(outputChanges.map((c) => [c.name, c.changeType, c.newValue])).toEqual([
      ['NeverResolved', 'ADD', 'endpoint-pid'],
    ]);
  });

  it('...and still BINDS when that resource is unchanged, so no row appears', async () => {
    // The negative control: same output, same reference, same digest, no
    // resource change. The record must still hold, or the un-bind rule would
    // have re-opened the phantom on every diff.
    const record = { NeverResolved: skippedOutputDigest(refTemplate(), 'NeverResolved') };
    const { changes, outputChanges } = await diff(state(record), refTemplate());
    expect([...changes.values()].every((c) => c.changeType === 'NO_CHANGE')).toBe(true);
    expect(outputChanges).toEqual([]);
    expect(getLogger().warn).not.toHaveBeenCalled();
  });

  it('a genuinely changed sibling still renders beside the suppressed key (the section is not suppressed)', async () => {
    const record = { NeverResolved: skippedOutputDigest(template(), 'NeverResolved') };
    const s = state(record);
    s.outputs = { Fine: 'fine-before' };
    const { outputChanges } = await diff(s, template());
    expect(outputChanges.map((c) => [c.name, c.changeType])).toEqual([['Fine', 'MODIFY']]);
  });

  it('a record whose digest no longer matches today\x27s template is the ordinary ADD again', async () => {
    const stale = { NeverResolved: 'not-the-digest-of-this-template' };
    const { outputChanges } = await diff(state(stale), template());
    expect(outputChanges.map((c) => [c.name, c.changeType])).toEqual([['NeverResolved', 'ADD']]);
  });
});
