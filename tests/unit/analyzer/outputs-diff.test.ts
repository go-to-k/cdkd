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

/**
 * Resolver stand-in modelled on the REAL one `computeStackDiff` passes.
 *
 * That is `IntrinsicFunctionResolver.resolve(..., {bestEffort: true})` directly,
 * NOT `DiffCalculator.resolveBestEffort`'s returns-the-original-value wrapper —
 * so an unresolvable `Fn::GetAtt` THROWS here, as it does in production. A more
 * forgiving mock would agree with a wrong assumption about the contract this
 * module actually faces.
 *
 * `undefined` entries in the table model the constructible-but-unknown
 * attributes (`StreamArn`, `PolicyId`, `VpcId`) that resolve WITHOUT throwing.
 */
function resolverFor(table: Record<string, unknown>) {
  return async (value: unknown): Promise<unknown> => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const keys = Object.keys(value as Record<string, unknown>);
      if (keys.length === 1 && keys[0] === 'Fn::GetAtt') {
        const [id, attr] = (value as { 'Fn::GetAtt': [string, string] })['Fn::GetAtt'];
        const key = `${id}.${attr}`;
        if (!(key in table)) throw new Error(`Resource not found in state: ${id}`);
        return table[key];
      }
    }
    return value;
  };
}

/** The lenient shape the `IntrinsicResolveFn` TYPE also permits (returns the input). */
function lenientResolver(value: unknown): Promise<unknown> {
  return Promise.resolve(value);
}

const ARN = 'arn:aws:s3:::bucket';
const RESOLVER = resolverFor({
  'Bucket.Arn': ARN,
  // Constructible-but-unknown attribute: resolves to undefined, does NOT throw.
  'Role.RoleId': undefined,
});

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
    // Uses the LENIENT resolver shape on purpose: this is the arm that catches a
    // surviving intrinsic nested inside a structure an outer intrinsic already
    // built, which a shallow "is this value itself an intrinsic?" check misses.
    const template: CloudFormationTemplate = {
      Resources: {},
      Outputs: {
        Joined: { Value: ['literal', { 'Fn::GetAtt': ['NotYetCreated', 'Arn'] }] },
      },
    };
    const r = await resolveTemplateOutputs(template, lenientResolver);
    expect(r.resolutionFailed).toBe(true);
    expect(r.outputs).toEqual({});
  });

  it('flags an attribute that resolves to undefined WITHOUT throwing', async () => {
    // The deploy engine keys its refusal on exactly this (`v === undefined`).
    // `IntrinsicFunctionResolver.resolve` returns undefined rather than throwing
    // for a constructible-but-unknown attribute (StreamArn / PolicyId / VpcId).
    // JSON.stringify drops an undefined-valued key, so state can NEVER hold one
    // -- without this arm the output is a permanent phantom ADD printing
    // `new: undefined` and `--fail` exits 1 forever on a clean stack.
    const template: CloudFormationTemplate = {
      Resources: {},
      Outputs: { RoleId: { Value: { 'Fn::GetAtt': ['Role', 'RoleId'] } } },
    };
    const r = await resolveTemplateOutputs(template, RESOLVER);
    expect(r.resolutionFailed).toBe(true);
    expect(r.outputs).toEqual({});
  });

  it('flags a symbol result (a top-level Ref: AWS::NoValue)', async () => {
    // resolveValue strips the AWS::NoValue sentinel only INSIDE arrays/objects;
    // a top-level Fn::If selecting it returns the bare symbol, which is likewise
    // not persistable and would be a permanent phantom.
    const template: CloudFormationTemplate = {
      Resources: {},
      Outputs: { Maybe: { Value: { 'Fn::If': ['C', 'x', { Ref: 'AWS::NoValue' }] } } },
    };
    const r = await resolveTemplateOutputs(template, async () => Symbol('AWS::NoValue'));
    expect(r.resolutionFailed).toBe(true);
    expect(r.outputs).toEqual({});
  });

  it('does NOT flag a literal ${...} in a value whose source used no Fn::Sub', async () => {
    // The over-match this scoping removes: an IAM policy body with
    // `${aws:username}`, a UserData shell `${VAR}`, or any literal a user wrote
    // would otherwise set resolutionFailed and suppress the WHOLE Outputs
    // section for that stack, on every run, forever.
    const template: CloudFormationTemplate = {
      Resources: {},
      Outputs: { Policy: { Value: 'arn:aws:iam::${aws:username}:role/x' } },
    };
    const r = await resolveTemplateOutputs(template, lenientResolver);
    expect(r.resolutionFailed).toBe(false);
    expect(r.outputs).toEqual({ Policy: 'arn:aws:iam::${aws:username}:role/x' });
  });

  it('finds an Fn::Sub NESTED inside an Fn::Join and still flags its laundered placeholder', async () => {
    const template: CloudFormationTemplate = {
      Resources: {},
      Outputs: {
        Joined: { Value: { 'Fn::Join': ['', [{ 'Fn::Sub': 'arn:${Pending}' }, '-x']] } },
      },
    };
    const r = await resolveTemplateOutputs(template, async () => 'arn:${Pending}-x');
    expect(r.resolutionFailed).toBe(true);
  });

  it('flags a half-substituted Fn::Sub placeholder string', async () => {
    // resolveSub catches a genuine Ref/GetAtt miss, WARNS, and keeps the literal
    // `${Foo}` in the output STRING -- no throw, no intrinsic object -- so this
    // launders straight past an object-only check and diffs as a phantom whose
    // printed value is "arn:...${NewBucket}".
    const template: CloudFormationTemplate = {
      Resources: {},
      Outputs: { Subbed: { Value: { 'Fn::Sub': 'arn:${NewBucket}' } } },
    };
    const r = await resolveTemplateOutputs(template, async () => 'arn:${NewBucket}');
    expect(r.resolutionFailed).toBe(true);
    expect(r.outputs).toEqual({});
  });

  it('a fully-substituted Fn::Sub result is NOT flagged', async () => {
    const template: CloudFormationTemplate = {
      Resources: {},
      Outputs: { Subbed: { Value: { 'Fn::Sub': 'arn:${Bucket}' } } },
    };
    const r = await resolveTemplateOutputs(template, async () => 'arn:real-bucket');
    expect(r.resolutionFailed).toBe(false);
    expect(r.outputs).toEqual({ Subbed: 'arn:real-bucket' });
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

describe('computeOutputsDiff — legacy secret plaintext on the stored side', () => {
  const EXPR = '{{resolve:secretsmanager:prod/db:SecretString:password}}';

  it('WITHHOLDS a stored plaintext when the desired side is still a secret expression', () => {
    // `cdkd diff` resolves with skipDynamicReferences, so the desired side stays
    // the expression. A state record written before the GHSA redaction landed
    // holds the RESOLVED PLAINTEXT instead (what `cdkd scrub` repairs). This is
    // the first code path that DISPLAYS a stored output value, and diff is run
    // in CI -- printing it would put the secret in build logs.
    const changes = computeOutputsDiff({ DbPassword: 'hunter2' }, { DbPassword: EXPR }, new Set());
    expect(changes).toHaveLength(1);
    expect(changes[0]!.changeType).toBe('MODIFY');
    expect(changes[0]!.oldValueRedacted).toBe(true);
    // The value must be ABSENT, not merely flagged.
    expect(changes[0]).not.toHaveProperty('oldValue');
    expect(JSON.stringify(changes)).not.toContain('hunter2');
  });

  it('does NOT withhold when both sides are expressions (already-redacted state)', () => {
    const other = '{{resolve:secretsmanager:prod/db:SecretString:username}}';
    const changes = computeOutputsDiff({ DbPassword: other }, { DbPassword: EXPR }, new Set());
    expect(changes[0]!.oldValueRedacted).toBeUndefined();
    expect(changes[0]!.oldValue).toBe(other);
  });

  it('does NOT withhold an ordinary non-secret change', () => {
    const changes = computeOutputsDiff({ Out: 'old' }, { Out: 'new' }, new Set());
    expect(changes[0]!.oldValueRedacted).toBeUndefined();
    expect(changes[0]!.oldValue).toBe('old');
  });
});

describe('Export.Name scoping + alias failure keys (issue #1921 review round 3)', () => {
  it('scopes the ${...} test to Export.Name OWN source, not the value\'s', async () => {
    // The bug: `sourceUsedSub` came from `output.Value`. An export name that IS
    // an Fn::Sub, on an output whose Value is not, would have its laundered
    // `${...}` accepted -- publishing a WRONG alias key, which is worse than a
    // phantom because a consumer's Fn::ImportValue reads that string.
    const template: CloudFormationTemplate = {
      Resources: {},
      Outputs: {
        Out: {
          Value: 'plain-literal',
          Export: { Name: { 'Fn::Sub': 'stack-${Pending}' } as unknown as string },
        },
      },
    };
    const r = await resolveTemplateOutputs(template, async (v) =>
      typeof v === 'string' ? v : 'stack-${Pending}'
    );
    expect(r.resolutionFailed).toBe(true);
    expect([...r.exportNames]).toEqual([]);
  });

  it('does NOT suppress an export name containing a literal ${...} with no Fn::Sub source', async () => {
    const template: CloudFormationTemplate = {
      Resources: {},
      Outputs: { Out: { Value: 'v', Export: { Name: 'literal-${not-a-sub}' } } },
    };
    const r = await resolveTemplateOutputs(template, lenientResolver);
    expect(r.resolutionFailed).toBe(false);
    expect([...r.exportNames]).toEqual(['literal-${not-a-sub}']);
  });

  it('records the literal Export.Name alias as a failed key when the VALUE fails', async () => {
    // Both keys are dropped from the bag, so both must be excluded from the
    // suppression-warning computation or the alias reads as a phantom REMOVE.
    const template: CloudFormationTemplate = {
      Resources: {},
      Outputs: {
        Pending: {
          Value: { 'Fn::GetAtt': ['NotYetCreated', 'Arn'] },
          Export: { Name: 'S:Pending' },
        },
      },
    };
    const r = await resolveTemplateOutputs(template, RESOLVER);
    expect([...r.failedKeys].sort()).toEqual(['Pending', 'S:Pending']);
  });
});

describe('secretSourceKeys + record-level withholding (issue #1921 review round 2)', () => {
  const EXPR = '{{resolve:secretsmanager:prod/db:SecretString:password}}';

  it('records a secret-sourced key even when its output is condition-SKIPPED', async () => {
    // The reachable leak this closes: a condition-false secret output is never
    // resolved, so it has NO desired side -- it lands in the REMOVE loop and
    // would print `old: "hunter2"` in full. The TEMPLATE still proves it secret.
    const template: CloudFormationTemplate = {
      Resources: {},
      Outputs: {
        DbPassword: { Value: EXPR, Condition: 'IsProd', Export: { Name: 'S:DbPassword' } },
      },
    };
    const r = await resolveTemplateOutputs(template, RESOLVER, { IsProd: false });
    expect(r.outputs).toEqual({});
    expect([...r.secretSourceKeys].sort()).toEqual(['DbPassword', 'S:DbPassword']);
  });

  it('WITHHOLDS a condition-skipped secret output on the REMOVE row', () => {
    const changes = computeOutputsDiff(
      { DbPassword: 'hunter2' },
      {},
      new Set(),
      new Set(['DbPassword'])
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]!.changeType).toBe('REMOVE');
    expect(changes[0]!.oldValueRedacted).toBe(true);
    expect(changes[0]).not.toHaveProperty('oldValue');
    expect(JSON.stringify(changes)).not.toContain('hunter2');
  });

  it('withholds RECORD-wide: one legacy key makes every other stored value suspect', () => {
    // A record with any pre-GHSA key was written by a pre-GHSA binary, so every
    // value in it is unredacted -- including a renamed export's REMOVE row.
    const changes = computeOutputsDiff(
      { DbPassword: 'hunter2', 'S:OldExport': 'also-secret', Plain: 'a' },
      { DbPassword: EXPR, Plain: 'b' },
      new Set(),
      new Set()
    );
    for (const change of changes) {
      expect(change.oldValueRedacted).toBe(true);
      expect(change).not.toHaveProperty('oldValue');
    }
    expect(JSON.stringify(changes)).not.toContain('hunter2');
    expect(JSON.stringify(changes)).not.toContain('also-secret');
  });

  it('leaves an ADD alone — it has no stored side to withhold', () => {
    const changes = computeOutputsDiff({ DbPassword: 'hunter2' }, { DbPassword: EXPR, New: 'n' }, new Set(), new Set());
    const added = changes.find((c) => c.name === 'New')!;
    expect(added.changeType).toBe('ADD');
    expect(added.oldValueRedacted).toBeUndefined();
    expect(added.newValue).toBe('n');
  });

  it('does NOT treat a PUBLIC {{resolve:ssm:...}} output as a legacy record', () => {
    // Per issue #1901 an ssm reference is classified by the parameter's TYPE: a
    // String / StringList parameter is public and legitimately persisted
    // RESOLVED, while the diff (skipDynamicReferences) holds the expression. A
    // signal keyed on "any {{resolve:" would fire on that ordinary record --
    // and since the verdict is record-WIDE, it would withhold every previous
    // value in the stack and advise `cdkd scrub`, which would find nothing.
    const changes = computeOutputsDiff(
      { PublicParam: 'us-east-1a', Other: 'old' },
      { PublicParam: '{{resolve:ssm:/my/public/param}}', Other: 'new' },
      new Set(),
      new Set()
    );
    for (const change of changes) {
      expect(change.oldValueRedacted).toBeUndefined();
    }
    expect(changes.find((c) => c.name === 'Other')!.oldValue).toBe('old');
  });

  it('DOES treat an ssm-secure reference as secret-bearing', () => {
    const changes = computeOutputsDiff(
      { Secret: 'plaintext' },
      { Secret: '{{resolve:ssm-secure:/my/secret}}' },
      new Set(),
      new Set()
    );
    expect(changes[0]!.oldValueRedacted).toBe(true);
    expect(JSON.stringify(changes)).not.toContain('plaintext');
  });

  it('a fully post-GHSA record withholds NOTHING', () => {
    const changes = computeOutputsDiff({ Plain: 'a' }, { Plain: 'b' }, new Set(), new Set());
    expect(changes[0]!.oldValueRedacted).toBeUndefined();
    expect(changes[0]!.oldValue).toBe('a');
  });
});

describe('failedKeys (issue #1921 review round 2)', () => {
  it('names the keys that were DROPPED, so a caller can tell them from real REMOVEs', async () => {
    // The deploy side keeps an unresolved key with value `undefined`; this
    // resolver drops it, so without failedKeys every failure reads as a REMOVE
    // and the suppression warning fires on the ordinary pending-resource case.
    const template: CloudFormationTemplate = {
      Resources: {},
      Outputs: {
        Pending: { Value: { 'Fn::GetAtt': ['NotYetCreated', 'Arn'] } },
        Fine: { Value: 'ok' },
      },
    };
    const r = await resolveTemplateOutputs(template, RESOLVER);
    expect(r.resolutionFailed).toBe(true);
    expect([...r.failedKeys]).toEqual(['Pending']);
    expect(r.outputs).toEqual({ Fine: 'ok' });
  });

  it('a condition-skipped output is NOT a failed key (CFn really does not create it)', async () => {
    const template: CloudFormationTemplate = {
      Resources: {},
      Outputs: { Gone: { Value: 'x', Condition: 'IsDev' } },
    };
    const r = await resolveTemplateOutputs(template, RESOLVER, { IsDev: false });
    expect(r.resolutionFailed).toBe(false);
    expect([...r.failedKeys]).toEqual([]);
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

  it('deploy still DEFINES its failure signal as an undefined bag value', () => {
    // Watch the DEFINITION, not the consumption. An earlier version of this
    // fence pinned `!resolutionFailed && !outputMapsEqual(` -- the line that
    // USES the flag -- which stayed green while the diff twin disagreed with
    // deploy about what "failed" MEANS (it checked only for surviving
    // intrinsics and missed `undefined`, deploy's actual signal). The mirrored
    // behavior lives in `isUnresolvedValue`, whose first arm is this predicate.
    expect(source).toMatch(/some\(\(v\) => v === undefined\)/);
  });

  it('deploy still declines to persist when that signal is set', () => {
    expect(source).toMatch(/!resolutionFailed && !outputMapsEqual\(/);
  });
});
