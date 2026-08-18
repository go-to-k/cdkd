/**
 * Unit tests for the diff-side Outputs resolution / comparison (issue #1921).
 *
 * `cdkd deploy` learned to persist an Outputs-only change in #875; `cdkd diff`
 * never did, so a stack whose `Outputs` section changed while its `Resources`
 * stayed byte-identical previewed as "No changes detected" and `--fail` exited
 * 0 — while the apply wrote new outputs and republished the exports index.
 *
 * The fix deliberately does NOT share code with `DeployEngine.resolveOutputs`
 * (that file is in the `integ-broad` / `integ-destroy` gate scopes and was held
 * by a parallel lane). The last describe block is the anti-drift fence that
 * trade requires: it watches the three deploy-side semantics this module
 * mirrors, so an edit to either side that breaks parity fails here rather than
 * silently reintroducing a preview/apply divergence.
 */

import { describe, it, expect, vi } from 'vite-plus/test';

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

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import {
  computeOutputsDiff,
  resolveTemplateOutputs,
  type OutputChange,
} from '../../../src/analyzer/outputs-diff.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

/** Resolver stand-in: substitutes `Fn::GetAtt` from a table, else echoes back. */
function resolverFor(table: Record<string, unknown>) {
  return async (value: unknown): Promise<unknown> => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const keys = Object.keys(value as Record<string, unknown>);
      if (keys.length === 1 && keys[0] === 'Fn::GetAtt') {
        const [id, attr] = (value as { 'Fn::GetAtt': [string, string] })['Fn::GetAtt'];
        const key = `${id}.${attr}`;
        // Unknown reference -> best-effort resolvers return the ORIGINAL value.
        return key in table ? table[key] : value;
      }
    }
    return value;
  };
}

const ARN = 'arn:aws:s3:::bucket';
const RESOLVER = resolverFor({ 'Bucket.Arn': ARN });

function templateWithExport(): CloudFormationTemplate {
  return {
    Resources: { Bucket: { Type: 'AWS::S3::Bucket', Properties: {} } },
    Outputs: {
      BucketArn: {
        Value: { 'Fn::GetAtt': ['Bucket', 'Arn'] },
        Export: { Name: 'StackA:BucketArn' },
      },
    },
  };
}

describe('resolveTemplateOutputs', () => {
  it('builds the same bag shape the deploy engine persists — value key AND Export.Name alias', async () => {
    const r = await resolveTemplateOutputs(templateWithExport(), RESOLVER);
    // Both keys, same value: `Fn::ImportValue` resolves by EXPORT name, so a
    // bag missing the alias would leave a consumer unable to import.
    expect(r.outputs).toEqual({ BucketArn: ARN, 'StackA:BucketArn': ARN });
    expect([...r.exportNames]).toEqual(['StackA:BucketArn']);
    expect(r.resolutionFailed).toBe(false);
  });

  it('returns an empty bag for a template with no Outputs section', async () => {
    const r = await resolveTemplateOutputs({ Resources: {} }, RESOLVER);
    expect(r.outputs).toEqual({});
    expect(r.resolutionFailed).toBe(false);
  });

  it('skips a condition-false output instead of resolving it (CFn never creates it)', async () => {
    const template: CloudFormationTemplate = {
      Resources: {},
      Outputs: {
        Kept: { Value: 'kept', Condition: 'IsProd' },
        Dropped: { Value: 'dropped', Condition: 'IsDev' },
      },
    };
    const r = await resolveTemplateOutputs(template, RESOLVER, { IsProd: true, IsDev: false });
    expect(r.outputs).toEqual({ Kept: 'kept' });
    // A skipped output is NOT a resolution failure — it is a value CFn would
    // not publish, so the diff must still report the rest of the delta.
    expect(r.resolutionFailed).toBe(false);
  });

  it('keeps an output whose condition name is unknown (matches filterResourcesByCondition)', async () => {
    const template: CloudFormationTemplate = {
      Resources: {},
      Outputs: { Kept: { Value: 'kept', Condition: 'NeverEvaluated' } },
    };
    const r = await resolveTemplateOutputs(template, RESOLVER, {});
    expect(r.outputs).toEqual({ Kept: 'kept' });
  });

  it('flags an unresolvable output rather than storing the raw intrinsic', async () => {
    const template: CloudFormationTemplate = {
      Resources: {},
      Outputs: { Pending: { Value: { 'Fn::GetAtt': ['NotYetCreated', 'Arn'] } } },
    };
    const r = await resolveTemplateOutputs(template, RESOLVER);
    expect(r.resolutionFailed).toBe(true);
    expect(r.outputs).toEqual({});
  });

  it('flags an intrinsic buried inside a resolved container (deep, not shallow)', async () => {
    // The regression this pins: a shallow "is this value itself an intrinsic?"
    // check passes a half-substituted Fn::Join through as if resolved, and the
    // partially-built value then diffs against state as a phantom change.
    const template: CloudFormationTemplate = {
      Resources: {},
      Outputs: {
        Joined: { Value: ['literal', { 'Fn::GetAtt': ['NotYetCreated', 'Arn'] }] },
      },
    };
    const r = await resolveTemplateOutputs(template, RESOLVER);
    expect(r.resolutionFailed).toBe(true);
    expect(r.outputs).toEqual({});
  });

  it('flags an Export.Name that stays intrinsic — the alias key deploy will write is unknown', async () => {
    // `TemplateOutput.Export.Name` is typed `string`, but CloudFormation accepts
    // an intrinsic there and the deploy engine has always branched on
    // `typeof … === 'string'` for exactly that reason. The cast reproduces the
    // real template shape the narrower type cannot express.
    const template: CloudFormationTemplate = {
      Resources: {},
      Outputs: {
        Out: {
          Value: 'v',
          Export: { Name: { 'Fn::GetAtt': ['NotYetCreated', 'Name'] } as unknown as string },
        },
      },
    };
    const r = await resolveTemplateOutputs(template, RESOLVER);
    expect(r.resolutionFailed).toBe(true);
  });

  it('resolves an intrinsic Export.Name and stores the alias under the resolved string', async () => {
    const template: CloudFormationTemplate = {
      Resources: {},
      Outputs: {
        Out: {
          Value: 'v',
          Export: { Name: { 'Fn::GetAtt': ['Bucket', 'Arn'] } as unknown as string },
        },
      },
    };
    const r = await resolveTemplateOutputs(template, RESOLVER);
    expect(r.resolutionFailed).toBe(false);
    expect(r.outputs).toEqual({ Out: 'v', [ARN]: 'v' });
  });

  it('never throws when the resolver throws — a diff must not harden into an error', async () => {
    const throwing = async () => {
      throw new Error('boom');
    };
    const r = await resolveTemplateOutputs(templateWithExport(), throwing);
    expect(r.resolutionFailed).toBe(true);
    expect(r.outputs).toEqual({});
  });

  it('does not mutate the template (the resource diff shares it)', async () => {
    const template = templateWithExport();
    const before = JSON.stringify(template);
    await resolveTemplateOutputs(template, RESOLVER);
    expect(JSON.stringify(template)).toBe(before);
  });
});

describe('computeOutputsDiff', () => {
  const names = (changes: OutputChange[]) => changes.map((c) => `${c.changeType}:${c.name}`);

  it('reports an added export — the motivating #875 shape', () => {
    const changes = computeOutputsDiff({}, { BucketArn: ARN, 'StackA:BucketArn': ARN }, new Set(['StackA:BucketArn']));
    expect(names(changes)).toEqual(['ADD:BucketArn', 'ADD:StackA:BucketArn']);
    expect(changes[1]).toEqual({
      name: 'StackA:BucketArn',
      changeType: 'ADD',
      newValue: ARN,
      isExport: true,
    });
    // The non-export row carries no export marker.
    expect(changes[0]!.isExport).toBe(false);
  });

  it('reports a changed value', () => {
    const changes = computeOutputsDiff({ Out: 'old' }, { Out: 'new' }, new Set());
    expect(changes).toEqual([
      { name: 'Out', changeType: 'MODIFY', oldValue: 'old', newValue: 'new', isExport: false },
    ]);
  });

  it('reports a removed export — the reverse case that can break a consumer', () => {
    const changes = computeOutputsDiff({ 'StackA:BucketArn': ARN }, {}, new Set());
    expect(changes).toEqual([
      { name: 'StackA:BucketArn', changeType: 'REMOVE', oldValue: ARN, isExport: false },
    ]);
  });

  it('reports NOTHING for an unchanged Outputs section', () => {
    const bag = { Out: 'v', 'StackA:Out': 'v' };
    expect(computeOutputsDiff({ ...bag }, { ...bag }, new Set(['StackA:Out']))).toEqual([]);
  });

  it('compares structurally, so key order and nesting do not fabricate a change', () => {
    const current = { Out: { b: [1, 2], a: 'x' } };
    const desired = { Out: { a: 'x', b: [1, 2] } };
    expect(computeOutputsDiff(current, desired, new Set())).toEqual([]);
  });

  it('treats a reordered array as a real change (order is meaningful in an output)', () => {
    expect(computeOutputsDiff({ Out: [1, 2] }, { Out: [2, 1] }, new Set())).toHaveLength(1);
  });

  it('tolerates an absent state outputs bag (pre-v2 / never-deployed record)', () => {
    expect(names(computeOutputsDiff(undefined, { Out: 'v' }, new Set()))).toEqual(['ADD:Out']);
  });

  it('distinguishes an explicit null value from an absent key', () => {
    // `hasOwnProperty`, not a truthiness check: a persisted `null` that the
    // template still declares is unchanged, not a re-ADD.
    expect(computeOutputsDiff({ Out: null }, { Out: null }, new Set())).toEqual([]);
  });
});

describe('anti-drift fence vs DeployEngine.resolveOutputs (issue #1921)', () => {
  // This module is a deliberate SECOND implementation of the deploy engine's
  // outputs resolution — see the file header for why sharing was rejected. The
  // cost of that trade is drift, so these assertions watch the three deploy-side
  // behaviors the diff twin mirrors. If one fails, the deploy side moved: port
  // the change into `src/analyzer/outputs-diff.ts` (and its tests above) rather
  // than relaxing the assertion.
  const source = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../src/deployment/deploy-engine.ts'),
    'utf8'
  );

  it('deploy still writes the Export.Name alias as a second bag key', () => {
    expect(source).toContain('outputs[exportName] = value;');
  });

  it('deploy still skips a condition-false output', () => {
    expect(source).toMatch(/output\.Condition !== undefined && conditions\?\.\[output\.Condition\] === false/);
  });

  it('deploy still declines to persist a partially-resolved outputs bag', () => {
    // The predicate the diff mirrors by returning no delta when
    // `resolutionFailed` — see computeStackDiffWithOutputs.
    expect(source).toMatch(/!resolutionFailed && !outputMapsEqual\(/);
  });
});
