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
  const resolve = async (value: unknown): Promise<unknown> => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const keys = Object.keys(value as Record<string, unknown>);
      // `Fn::Join` FOLDS to a string, which is what makes the dominant CDK
      // secret shape (`{'Fn::Join': ['', ['{{resolve:secretsmanager:', {Ref},
      // ':SecretString:pw::}}']]}`) arrive here as a resolved value rather than
      // as a surviving intrinsic. Without this arm a fixture built on that shape
      // is reported unresolved and can never exercise the secret signals.
      if (keys.length === 1 && keys[0] === 'Fn::Join') {
        const [sep, parts] = (value as { 'Fn::Join': [string, unknown[]] })['Fn::Join'];
        const resolvedParts = [];
        for (const part of parts) resolvedParts.push(String(await resolve(part)));
        return resolvedParts.join(sep);
      }
      if (keys.length === 1 && keys[0] === 'Ref') {
        const id = (value as { Ref: string }).Ref;
        if (!(id in table)) throw new Error(`Resource not found in state: ${id}`);
        return table[id];
      }
      if (keys.length === 1 && keys[0] === 'Fn::GetAtt') {
        const [id, attr] = (value as { 'Fn::GetAtt': [string, string] })['Fn::GetAtt'];
        const key = `${id}.${attr}`;
        if (!(key in table)) throw new Error(`Resource not found in state: ${id}`);
        return table[key];
      }
    }
    return value;
  };
  return resolve;
}

/** The lenient shape the `IntrinsicResolveFn` TYPE also permits (returns the input). */
function lenientResolver(value: unknown): Promise<unknown> {
  return Promise.resolve(value);
}

const ARN = 'arn:aws:s3:::bucket';
const RESOLVER = resolverFor({
  'Bucket.Arn': ARN,
  // An attribute whose VALUE is an expression string: the shape an intrinsic
  // `Export.Name` takes after this resolver's `skipDynamicReferences` pass.
  'Bucket.SecretishName': 'pre-{{resolve:secretsmanager:db:SecretString:pw}}',
  // A `Ref` target, for the `Fn::Join`-wrapped secret shape.
  Sec: 'arn:aws:secretsmanager:us-east-1:1234:secret:db',
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
  it('SKIPS an export alias whose name is another published output (issue #1919)', async () => {
    // The deploy engine refuses this alias and keeps the colliding output's own
    // value. Previewing it here made the two bags disagree permanently: the diff
    // reported an ADD/MODIFY on every run, `cdkd diff --fail` never went green,
    // and the user was told an export is published that deploy declines to
    // publish. Declared owner-first, the order that makes the alias win in an
    // unguarded pass.
    const template: CloudFormationTemplate = {
      Resources: { Bucket: { Type: 'AWS::S3::Bucket', Properties: {} } },
      Outputs: {
        PublicAlpha: { Value: 'alpha-public' },
        Exporter: { Value: { 'Fn::GetAtt': ['Bucket', 'Arn'] }, Export: { Name: 'PublicAlpha' } },
      },
    };

    const r = await resolveTemplateOutputs(template, RESOLVER);

    expect(r.outputs).toEqual({ PublicAlpha: 'alpha-public', Exporter: ARN });
    expect([...r.exportNames]).toEqual([]);
    // NOT a resolution failure: the bag matches what deploy writes, so there is
    // nothing to withhold.
    expect(r.resolutionFailed).toBe(false);
  });

  it('PARITY row 1 — an INTRINSIC name still carrying a secret spelling is skipped', async () => {
    // Deploy substitutes plaintext into an intrinsic name and then REFUSES it,
    // because the name would become a state KEY and redaction walks values only.
    // This resolver runs with `skipDynamicReferences`, so the same name arrives
    // here still spelled as its expression — which is the signal.
    const template: CloudFormationTemplate = {
      Resources: { Bucket: { Type: 'AWS::S3::Bucket', Properties: {} } },
      Outputs: {
        Exporter: {
          Value: { 'Fn::GetAtt': ['Bucket', 'Arn'] },
          Export: { Name: { 'Fn::GetAtt': ['Bucket', 'SecretishName'] } as never },
        },
      },
    };

    const r = await resolveTemplateOutputs(template, RESOLVER);

    expect(r.outputs).toEqual({ Exporter: ARN });
    expect([...r.exportNames]).toEqual([]);
  });

  it('PARITY row 2 — a LITERAL name spelled as an expression is PUBLISHED, as deploy publishes it', async () => {
    // The regression the previous round shipped: refusing by SPELLING refused
    // this too, while the deploy engine short-circuits a STRING `Export.Name`
    // past the resolver entirely — it substitutes nothing, uses the string
    // verbatim as the key, and publishes. Refusing here made the preview report
    // a phantom REMOVE on every run and kept `cdkd diff --fail` red, which is
    // the inverse of the bug the refusal was added for.
    const literalName = '{{resolve:secretsmanager:db:SecretString:pw}}';
    const template: CloudFormationTemplate = {
      Resources: { Bucket: { Type: 'AWS::S3::Bucket', Properties: {} } },
      Outputs: {
        Exporter: { Value: { 'Fn::GetAtt': ['Bucket', 'Arn'] }, Export: { Name: literalName } },
      },
    };

    const r = await resolveTemplateOutputs(template, RESOLVER);

    expect(r.outputs).toEqual({ Exporter: ARN, [literalName]: ARN });
    expect([...r.exportNames]).toEqual([literalName]);
  });

  it('PARITY row 3 — a LITERAL name in a secret-bearing stack SUPPRESSES rather than guesses', async () => {
    // Deploy refuses a literal name that CONTAINS a resolved plaintext
    // (`prod-<secret>-endpoint`), and this preview never resolves one, so it
    // cannot evaluate that predicate. Publishing would risk a phantom ADD whose
    // row PRINTS the plaintext-bearing key into CI logs, so the delta is
    // suppressed instead — this module's existing answer to "cannot reproduce
    // what deploy will do".
    //
    // The secret-bearing output uses the INTRINSIC shape on purpose: an
    // `Fn::Join` around a `Ref` to the secret's ARN is what
    // `secret.secretValueFromJson(...)` renders, and a shallow string scan of
    // `output.Value` reports no secret for it — which is the DOMINANT CDK shape
    // and disarmed this whole branch.
    const template: CloudFormationTemplate = {
      Resources: { Bucket: { Type: 'AWS::S3::Bucket', Properties: {} } },
      Outputs: {
        DbSecret: {
          Value: {
            'Fn::Join': [
              '',
              ['{{resolve:secretsmanager:', { Ref: 'Sec' }, ':SecretString:password::}}'],
            ],
          },
        },
        Exporter: {
          Value: { 'Fn::GetAtt': ['Bucket', 'Arn'] },
          Export: { Name: 'MyStack:BucketArn' },
        },
      },
    };

    const r = await resolveTemplateOutputs(template, RESOLVER);

    expect([...r.exportNames]).toEqual([]);
    expect(Object.hasOwn(r.outputs, 'MyStack:BucketArn')).toBe(false);
    expect(r.resolutionFailed).toBe(true);
    // The value keys still resolved — the suppression is a reporting decision,
    // not a resolution failure.
    expect(r.outputs['Exporter']).toBe(ARN);
  });

  it('PARITY row 3 — the suppression RECORDS the alias key, so the warning cannot misreport', async () => {
    // The suppression drops a key that may well be PRESENT in state. Without
    // recording it, `diff-recursive`'s `wouldHaveChanged` filter reads it as a
    // REMOVE and the stack warns "one or more could not be resolved ... usually
    // an output referencing a resource this deploy has yet to create" — the
    // wrong cause, on every run, forever.
    const template: CloudFormationTemplate = {
      Resources: { Bucket: { Type: 'AWS::S3::Bucket', Properties: {} } },
      Outputs: {
        DbSecret: {
          Value: {
            'Fn::Join': [
              '',
              ['{{resolve:secretsmanager:', { Ref: 'Sec' }, ':SecretString:password::}}'],
            ],
          },
        },
        Exporter: {
          Value: { 'Fn::GetAtt': ['Bucket', 'Arn'] },
          Export: { Name: 'MyStack:BucketArn' },
        },
      },
    };

    const r = await resolveTemplateOutputs(template, RESOLVER);

    expect(r.failedKeys.has('MyStack:BucketArn')).toBe(true);
    // The filter the warning is computed through must therefore drop the row a
    // stored copy of that key would otherwise produce.
    const wouldHaveChanged = computeOutputsDiff(
      { 'MyStack:BucketArn': 'arn:aws:s3:::previously-published' },
      r.outputs,
      r.exportNames,
      r.secretSourceKeys
    ).filter((change) => !r.failedKeys.has(change.name));
    expect(wouldHaveChanged.map((c) => c.name)).not.toContain('MyStack:BucketArn');
  });

  it('PARITY row 3 — the same literal name publishes when the stack resolves NO secret', async () => {
    // The other half, so the rule cannot silently widen to every stack.
    const r = await resolveTemplateOutputs(templateWithExport(), RESOLVER);
    expect([...r.exportNames]).toEqual(['StackA:BucketArn']);
    expect(r.resolutionFailed).toBe(false);
  });

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

  it('withholds a legacy plaintext when the DESIRED side is an intrinsic-wrapped secret', () => {
    // The same shallow-scan gap on the WITHHOLDING signal (issue #1921's half):
    // the desired value is the dominant CDK shape — an `Fn::Join` around a `Ref`
    // to the secret's ARN — so a string-only test reported "not a secret" and
    // the stored PLAINTEXT was printed as the row's `old:` value, into CI logs.
    const desired = {
      DbPassword: {
        'Fn::Join': ['', ['{{resolve:secretsmanager:', { Ref: 'Sec' }, ':SecretString:pw::}}']],
      },
    };
    const changes = computeOutputsDiff({ DbPassword: 'hunter2-plaintext' }, desired, new Set());
    expect(changes[0]!.oldValueRedacted).toBe(true);
    expect(changes[0]).not.toHaveProperty('oldValue');
    expect(JSON.stringify(changes)).not.toContain('hunter2');
  });

  it('a PARTIALLY-redacted stored list still counts as legacy (veto stays at LEAF granularity)', () => {
    // The veto must be harder to earn than the suspicion. Widening it to a deep
    // walk — as the positive arms legitimately are — makes a CONTAINER holding
    // any expression leaf vote "already redacted", so this bag, the partial
    // residue `cdkd scrub` itself admits it can leave, is read as post-GHSA and
    // its plaintext leaf prints in the rendered row.
    const current = {
      Endpoints: ['{{resolve:secretsmanager:A:SecretString:pw}}', 'prod-hunter2-plaintext'],
    };
    const desired = { Endpoints: ['{{resolve:secretsmanager:A:SecretString:pw}}', 'prod-new'] };

    const changes = computeOutputsDiff(current, desired, new Set());

    expect(changes[0]!.oldValueRedacted).toBe(true);
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

  it('deploy still writes the Export.Name alias as a second bag key, and GUARDS it', () => {
    // This fence went VACUOUS once (issue #1919 review) and the way it did is
    // the lesson: it grepped for the literal alias write, the deploy engine
    // moved that write inside a guard's `else` arm, and the literal survived —
    // so the fence stayed green through the exact drift it exists to catch,
    // while this module kept previewing an alias the deploy had started
    // refusing (a phantom diff on every run, forever).
    //
    // A literal that can survive inside a branch cannot fence a branch. So both
    // halves are pinned instead: the write still exists, AND both writers of
    // this key space consult the same shared rule. Removing the guard from
    // either side reds this.
    expect(source).toContain('outputs[exportName] = value;');
    expect(source).toContain('isExportAliasCollision(exportName, outputKey, publishedOutputNames)');
    const twin = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../src/analyzer/outputs-diff.ts'),
      'utf8'
    );
    expect(twin).toContain('isExportAliasCollision(exportName, outputKey, publishedOutputNames)');
  });

  it('both writers still guard the SECRET-bearing export name', () => {
    // The collision guard was fenced first and the SECRET guard was not — and
    // the secret guard is the one rule that actually diverged (the two sides
    // disagreed in BOTH directions on a literal name for a full round). Each
    // side keeps its own predicate here, because they answer the same question
    // from different information: deploy resolves the name and asks what was
    // substituted; the diff never substitutes and asks how the name is SPELLED,
    // gated on the name being intrinsic. Losing either arm reds this.
    const twin = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../src/analyzer/outputs-diff.ts'),
      'utf8'
    );
    expect(source).toContain('exportNameSecretExposure(');
    expect(source).toContain('secretBearingExportNameWarning(outputKey, exportName, exposure)');
    expect(twin).toContain('declaredExportIsIntrinsic && isSecretDynamicReference(exportName)');
    // ...and the LITERAL arm, which is what keeps the diff from publishing an
    // alias deploy refuses without being able to see the secret.
    expect(twin).toContain('!declaredExportIsIntrinsic && secretSourceKeys.size > 0');
    // That arm no longer suppresses unconditionally: it reads the verdict a
    // previous deploy recorded (issue #1942). Pinned because losing this line
    // silently restores the suppression — a green section that simply stops
    // reporting export changes, which is the #875 bug wearing the fix's shape.
    expect(twin).toContain('Object.hasOwn(storedOutputs, exportName)');
  });

  it('deploy still skips a condition-false output', () => {
    // The predicate MOVED (issue #1919): the deploy engine now shares it with
    // `cdkd scrub` through `outputs-export-alias.ts`, because the outputs bag
    // has two key writers that must agree about which outputs are published.
    // Behavior is unchanged — `outputs-diff.ts:283` still spells it inline, and
    // this fence still watches exactly that parity — so the fence follows the
    // predicate rather than being relaxed. BOTH halves are asserted: the rule
    // itself, and that the deploy engine still calls it. Either one moving on
    // its own is drift, and the single grep this replaces could only see the
    // first.
    const rules = readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../../src/deployment/outputs-export-alias.ts'
      ),
      'utf8'
    );
    expect(rules).toMatch(
      /output\.Condition !== undefined && conditions\?\.\[output\.Condition\] === false/
    );
    expect(source).toContain('isOutputSuppressedByCondition(output, conditions)');
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

/**
 * Deciding a LITERAL `Export.Name` from the STORED bag (issue #1942).
 *
 * Deploy refuses a literal name that CONTAINS a resolved secret plaintext; the
 * preview never resolves a plaintext, so it cannot evaluate that predicate. It
 * used to suppress the whole Outputs section for such a stack, which is the
 * #875 case going unreported. It now reads the verdict a previous deploy
 * already recorded: state holding the alias KEY proves that deploy published
 * it, over the same literal name.
 *
 * Every fixture below builds its secret on the `Fn::Join`-around-a-`Ref` shape
 * `secret.secretValueFromJson(...)` renders. A plain-string secret cannot
 * discriminate this class — `containsSecretDynamicReference` is what arms the
 * whole branch, and a shallow scan of a plain string passes for the wrong
 * reason.
 */
describe('literal Export.Name decided from the stored bag (issue #1942)', () => {
  /** A stack that resolves a secret AND publishes a literal export alias. */
  function secretStackWithLiteralAlias(): CloudFormationTemplate {
    return {
      Resources: { Bucket: { Type: 'AWS::S3::Bucket', Properties: {} } },
      Outputs: {
        DbSecret: {
          Value: {
            'Fn::Join': [
              '',
              ['{{resolve:secretsmanager:', { Ref: 'Sec' }, ':SecretString:password::}}'],
            ],
          },
        },
        Exporter: {
          Value: { 'Fn::GetAtt': ['Bucket', 'Arn'] },
          Export: { Name: 'MyStack:BucketArn' },
        },
      },
    };
  }

  it('PUBLISHES the alias when state holds that key — the previous deploy already decided', async () => {
    const r = await resolveTemplateOutputs(secretStackWithLiteralAlias(), RESOLVER, undefined, {
      'MyStack:BucketArn': ARN,
      Exporter: ARN,
    });

    expect(r.outputs['MyStack:BucketArn']).toBe(ARN);
    expect([...r.exportNames]).toEqual(['MyStack:BucketArn']);
    // No suppression: the section is reportable again, which is the whole point.
    expect(r.resolutionFailed).toBe(false);
    expect(r.failedKeys.has('MyStack:BucketArn')).toBe(false);
  });

  it('publishes on a DIFFERENT stored value too, so a real export change is SHOWN (#875)', async () => {
    // The row that motivated the issue. The refusal deploy makes is about the
    // NAME — an unchanged template literal — so the stored VALUE is not part of
    // the evidence; requiring equality would suppress exactly the row someone
    // needed to see.
    const stored = { 'MyStack:BucketArn': 'arn:aws:s3:::previously-published', Exporter: ARN };
    const r = await resolveTemplateOutputs(secretStackWithLiteralAlias(), RESOLVER, undefined, stored);

    expect(r.resolutionFailed).toBe(false);
    const changes = computeOutputsDiff(stored, r.outputs, r.exportNames, r.secretSourceKeys, {
      declaredKeys: r.declaredKeys,
      templateHasSecretReference: r.templateHasSecretReference,
    });
    const aliasRow = changes.find((c) => c.name === 'MyStack:BucketArn');
    expect(aliasRow?.changeType).toBe('MODIFY');
    expect(aliasRow?.isExport).toBe(true);
    expect(aliasRow?.newValue).toBe(ARN);
    // The stored side is an ordinary ARN in a record whose secret output is
    // already stored as its expression, so nothing is withheld here.
    expect(aliasRow?.oldValueRedacted).toBeUndefined();
  });

  it('SUPPRESSES when the stored bag lacks the key — absence records no verdict', async () => {
    // A first deploy of this alias. State has other keys, so this is the
    // "bag present, key absent" row rather than the no-state one below.
    const r = await resolveTemplateOutputs(secretStackWithLiteralAlias(), RESOLVER, undefined, {
      Exporter: ARN,
    });

    expect(Object.hasOwn(r.outputs, 'MyStack:BucketArn')).toBe(false);
    expect([...r.exportNames]).toEqual([]);
    expect(r.resolutionFailed).toBe(true);
    // Still recorded, so the downstream warning cannot blame the wrong cause.
    expect(r.failedKeys.has('MyStack:BucketArn')).toBe(true);
  });

  it('SUPPRESSES with no stored bag at all — a never-deployed stack, or a caller with none', async () => {
    // Both spellings, because they arrive by different routes: an EMPTY bag is
    // a state record with no outputs yet, while ABSENT is the pre-#1942 caller
    // shape (`resolveTemplateOutputs` still has three required parameters).
    const empty = await resolveTemplateOutputs(
      secretStackWithLiteralAlias(),
      RESOLVER,
      undefined,
      {}
    );
    expect(empty.resolutionFailed).toBe(true);
    expect(empty.failedKeys.has('MyStack:BucketArn')).toBe(true);

    const absent = await resolveTemplateOutputs(secretStackWithLiteralAlias(), RESOLVER);
    expect(absent.resolutionFailed).toBe(true);
    expect(absent.failedKeys.has('MyStack:BucketArn')).toBe(true);
  });

  it('does NOT widen to an INTRINSIC name carrying a secret spelling, even when state holds the key', async () => {
    // The refusal order is secret-first, so the stored-bag arm is never reached
    // for an intrinsic name — deploy WILL substitute a plaintext into that key
    // and refuse, whatever state happens to hold.
    const template: CloudFormationTemplate = {
      Resources: { Bucket: { Type: 'AWS::S3::Bucket', Properties: {} } },
      Outputs: {
        Exporter: {
          Value: { 'Fn::GetAtt': ['Bucket', 'Arn'] },
          Export: { Name: { 'Fn::GetAtt': ['Bucket', 'SecretishName'] } as never },
        },
      },
    };

    const r = await resolveTemplateOutputs(template, RESOLVER, undefined, {
      'pre-{{resolve:secretsmanager:db:SecretString:pw}}': ARN,
    });

    expect([...r.exportNames]).toEqual([]);
    expect(Object.hasOwn(r.outputs, 'pre-{{resolve:secretsmanager:db:SecretString:pw}}')).toBe(
      false
    );
  });

  it('does NOT widen to a COLLIDING alias, even when state holds the key', async () => {
    // Deploy skips a colliding alias and keeps the output's own value, so
    // publishing it would be a permanent phantom regardless of what state has.
    const template: CloudFormationTemplate = {
      Resources: { Bucket: { Type: 'AWS::S3::Bucket', Properties: {} } },
      Outputs: {
        DbSecret: {
          Value: {
            'Fn::Join': [
              '',
              ['{{resolve:secretsmanager:', { Ref: 'Sec' }, ':SecretString:password::}}'],
            ],
          },
        },
        Other: { Value: { 'Fn::GetAtt': ['Bucket', 'Arn'] } },
        Exporter: {
          Value: { 'Fn::GetAtt': ['Bucket', 'Arn'] },
          Export: { Name: 'Other' },
        },
      },
    };

    const r = await resolveTemplateOutputs(template, RESOLVER, undefined, { Other: ARN });
    expect([...r.exportNames]).toEqual([]);
  });
});

/**
 * A stored key today's template cannot ACCOUNT FOR (issue #1948).
 *
 * `secretSourceKeys` is built from DECLARATIONS, so an output DELETED from the
 * template contributes nothing to it — a record whose only secret-bearing
 * output has since been removed was judged not-legacy and printed its stored
 * pre-GHSA plaintext as the `old:` side of a REMOVE row, into the terminal and
 * into CI logs.
 *
 * The replacement is a REFUSAL, not a detection (a stored plaintext is
 * indistinguishable from an ordinary string), gated so it stays off the common
 * benign case of deleting an ordinary output.
 */
describe('unaccountable stored key withholding (issue #1948)', () => {
  const PLAINTEXT = 'hunter2';
  const SECRET_EXPR = '{{resolve:secretsmanager:prod/db:SecretString:password}}';

  it('WITHHOLDS the REMOVE value of a secret output deleted from the template', () => {
    // The motivating case: the ONLY secret-bearing output was deleted, so
    // `secretSourceKeys` is empty and the record reads as post-GHSA.
    const changes = computeOutputsDiff(
      { DbPassword: PLAINTEXT, ApiUrl: 'https://old.example.com' },
      { ApiUrl: 'https://new.example.com' },
      new Set(),
      new Set(),
      { declaredKeys: new Set(['ApiUrl']), templateHasSecretReference: true }
    );

    const removed = changes.find((c) => c.name === 'DbPassword');
    expect(removed?.changeType).toBe('REMOVE');
    expect(removed?.oldValueRedacted).toBe(true);
    expect(removed?.oldValue).toBeUndefined();
  });

  it('withholds PER KEY, not record-wide — the accountable rows keep their values', () => {
    // The asymmetry with the legacy-record arms above, and it follows from what
    // each concludes: those claim the whole bag is unredacted, this one claims
    // only that ONE key is undecidable.
    const changes = computeOutputsDiff(
      { DbPassword: PLAINTEXT, ApiUrl: 'https://old.example.com' },
      { ApiUrl: 'https://new.example.com' },
      new Set(),
      new Set(),
      { declaredKeys: new Set(['ApiUrl']), templateHasSecretReference: true }
    );

    const modified = changes.find((c) => c.name === 'ApiUrl');
    expect(modified?.changeType).toBe('MODIFY');
    expect(modified?.oldValue).toBe('https://old.example.com');
    expect(modified?.oldValueRedacted).toBeUndefined();
  });

  it('does NOTHING when the template proves no secret reference anywhere', () => {
    // Deleting an output is a normal refactor, so without this gate every
    // ordinary stack would lose its REMOVE values.
    const changes = computeOutputsDiff(
      { Removed: 'arn:aws:s3:::gone', ApiUrl: 'https://old.example.com' },
      { ApiUrl: 'https://old.example.com' },
      new Set(),
      new Set(),
      { declaredKeys: new Set(['ApiUrl']), templateHasSecretReference: false }
    );

    const removed = changes.find((c) => c.name === 'Removed');
    expect(removed?.oldValue).toBe('arn:aws:s3:::gone');
    expect(removed?.oldValueRedacted).toBeUndefined();
  });

  it('is EXONERATED when any stored value is a secret expression (the last write redacted)', () => {
    // `resolveOutputs` rewrites the whole bag on every deploy, so one redacted
    // key proves the bag as a whole is post-GHSA — including the deleted key's
    // value, which is therefore an ordinary string.
    const changes = computeOutputsDiff(
      { Removed: 'arn:aws:s3:::gone', DbPassword: SECRET_EXPR },
      { DbPassword: SECRET_EXPR },
      new Set(),
      new Set(),
      { declaredKeys: new Set(['DbPassword']), templateHasSecretReference: true }
    );

    const removed = changes.find((c) => c.name === 'Removed');
    expect(removed?.oldValue).toBe('arn:aws:s3:::gone');
    expect(removed?.oldValueRedacted).toBeUndefined();
  });

  it('leaves a DECLARED-but-condition-skipped key alone — the template accounts for it', () => {
    // Such a key is absent from `desired` but present in `declaredKeys`, which
    // is exactly the distinction the set exists to draw. (If it were also
    // secret-bearing, `secretSourceKeys` covers it record-wide.)
    const changes = computeOutputsDiff(
      { MaybeOut: 'arn:aws:s3:::conditional' },
      {},
      new Set(),
      new Set(),
      { declaredKeys: new Set(['MaybeOut']), templateHasSecretReference: true }
    );

    expect(changes[0]?.changeType).toBe('REMOVE');
    expect(changes[0]?.oldValue).toBe('arn:aws:s3:::conditional');
    expect(changes[0]?.oldValueRedacted).toBeUndefined();
  });

  it('withholds nothing when the caller passes no scan at all (default arg)', () => {
    // `computeOutputsDiff` keeps working for callers that never supply the new
    // information — the arm is opt-in on the data, not on a flag.
    const changes = computeOutputsDiff({ Removed: PLAINTEXT }, {}, new Set());
    expect(changes[0]?.oldValue).toBe(PLAINTEXT);
    expect(changes[0]?.oldValueRedacted).toBeUndefined();
  });

  it('an ADD is never withheld — it has no stored side to withhold', () => {
    const changes = computeOutputsDiff({}, { Fresh: 'v' }, new Set(), new Set(), {
      declaredKeys: new Set(),
      templateHasSecretReference: true,
    });
    expect(changes[0]?.changeType).toBe('ADD');
    expect(changes[0]?.newValue).toBe('v');
    expect(changes[0]?.oldValueRedacted).toBeUndefined();
  });
});

describe('declaredKeys + templateHasSecretReference (issue #1948 inputs)', () => {
  it('declares every output name AND every literal Export.Name, condition-skipped included', async () => {
    const template: CloudFormationTemplate = {
      Resources: { Bucket: { Type: 'AWS::S3::Bucket', Properties: {} } },
      Conditions: {},
      Outputs: {
        Skipped: { Value: 'x', Condition: 'Never', Export: { Name: 'Skipped:Alias' } },
        Exporter: {
          Value: { 'Fn::GetAtt': ['Bucket', 'Arn'] },
          Export: { Name: 'MyStack:BucketArn' },
        },
      },
    };

    const r = await resolveTemplateOutputs(template, RESOLVER, { Never: false });

    // A condition-skipped output never reaches the resolve loop, so only pass 1
    // can record it — and its stored key is exactly the shape that would
    // otherwise be judged unaccountable.
    expect([...r.declaredKeys].sort()).toEqual(
      ['Exporter', 'MyStack:BucketArn', 'Skipped', 'Skipped:Alias'].sort()
    );
  });

  it('sees a secret reference in RESOURCES, not just in Outputs', async () => {
    // The #1948 case is precisely one where `Outputs` no longer mentions the
    // secret, so an Outputs-only walk would answer false for every case the
    // gate exists to catch.
    const template: CloudFormationTemplate = {
      Resources: {
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Environment: {
              Variables: { PW: '{{resolve:secretsmanager:prod/db:SecretString:password}}' },
            },
          },
        },
      },
      Outputs: { ApiUrl: { Value: 'https://example.com' } },
    };

    const r = await resolveTemplateOutputs(template, RESOLVER);
    expect(r.templateHasSecretReference).toBe(true);
    // ...and the Outputs-only signal is genuinely empty, which is what makes
    // this fixture the #1948 shape rather than a case the old signals covered.
    expect(r.secretSourceKeys.size).toBe(0);
  });

  it('answers false for a stack with no secret reference anywhere', async () => {
    const r = await resolveTemplateOutputs(templateWithExport(), RESOLVER);
    expect(r.templateHasSecretReference).toBe(false);
  });
});
