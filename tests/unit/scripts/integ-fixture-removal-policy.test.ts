import { describe, it, expect } from 'vite-plus/test';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  scanFixtureSource,
  STATEFUL_CONSTRUCTS,
  type ScanStats,
} from '../../../scripts/check-fixture-removal-policy.js';

/**
 * Regression guard for issue #1326: stateful CDK L2 constructs in integ
 * fixtures must carry an EXPLICIT removalPolicy. The L2 default is RETAIN,
 * which both CloudFormation and cdkd honor, so an omitted policy leaks the
 * resource on every deploy/destroy cycle while the destroy still reports
 * success. Originating incident: the sqs-cloudwatch fixture's Kinesis Stream
 * leaked 14 billed PROVISIONED streams across a month of benchmark runs
 * (fixed in PR #1327); this lint then immediately found a second live case
 * (log-pipeline's Stream, fixed in the PR that added this file).
 *
 * See `scripts/check-fixture-removal-policy.ts` for the classifier and the
 * compliance escapes (explicit prop / applyRemovalPolicy / allow-comment).
 */

const INTEG_ROOT = join(import.meta.dirname, '../../../tests/integration');

function scanTree() {
  const perFile: { fixture: string; file: string; stats: ScanStats }[] = [];
  for (const dir of readdirSync(INTEG_ROOT, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const sub of ['lib', 'bin']) {
      const p = join(INTEG_ROOT, dir.name, sub);
      if (!existsSync(p)) continue;
      for (const f of readdirSync(p).filter((f) => f.endsWith('.ts'))) {
        perFile.push({
          fixture: dir.name,
          file: `${dir.name}/${sub}/${f}`,
          stats: scanFixtureSource(f, readFileSync(join(p, f), 'utf8')),
        });
      }
    }
  }
  return perFile;
}

describe('scanFixtureSource', () => {
  const HEADER = `import * as cdk from 'aws-cdk-lib';\nimport * as kinesis from 'aws-cdk-lib/aws-kinesis';\n`;

  it('flags a namespace-import construct with no props argument', () => {
    const { hits } = scanFixtureSource('t.ts', `${HEADER}new kinesis.Stream(this, 'S');\n`);
    expect(hits).toEqual([
      { construct: 'aws-kinesis.Stream', line: 3, compliant: false, via: null },
    ]);
  });

  it('flags props that lack removalPolicy even when other keys exist', () => {
    const src = `${HEADER}new kinesis.Stream(this, 'S', { shardCount: 1 });\n`;
    expect(scanFixtureSource('t.ts', src).hits[0].compliant).toBe(false);
  });

  it('accepts an explicit removalPolicy prop (any value, RETAIN included)', () => {
    for (const v of ['cdk.RemovalPolicy.DESTROY', 'cdk.RemovalPolicy.RETAIN']) {
      const src = `${HEADER}new kinesis.Stream(this, 'S', { removalPolicy: ${v} });\n`;
      expect(scanFixtureSource('t.ts', src).hits[0]).toMatchObject({
        compliant: true,
        via: 'removalPolicy-prop',
      });
    }
  });

  it('resolves a named import, including a rename', () => {
    const src = `import { Stream as KStream } from 'aws-cdk-lib/aws-kinesis';\nnew KStream(this, 'S', { removalPolicy: x });\n`;
    const stats = scanFixtureSource('t.ts', src);
    expect(stats.hits[0]).toMatchObject({ construct: 'aws-kinesis.Stream', compliant: true });
    expect(stats.viaNamed).toBe(1);
  });

  it('resolves barrel access in both spellings', () => {
    // `cdk.aws_s3.Bucket` and `import { aws_s3 as s3l }` are rare but legal;
    // the parameters fixture already uses the chain form for an L1.
    const src =
      `import * as cdk from 'aws-cdk-lib';\nimport { aws_s3 as s3l } from 'aws-cdk-lib';\n` +
      `new cdk.aws_s3.Bucket(this, 'A');\nnew s3l.Bucket(this, 'B');\n`;
    const stats = scanFixtureSource('t.ts', src);
    expect(stats.hits.map((h) => h.construct)).toEqual(['aws-s3.Bucket', 'aws-s3.Bucket']);
    expect(stats.viaBarrel).toBe(2);
    expect(stats.hits.every((h) => !h.compliant)).toBe(true);
  });

  it('resolves a props argument passed as a same-file variable', () => {
    // The dynamodb-globaltable fixture passes `tableProps`; the first cut of
    // this classifier false-positived on exactly this shape.
    const src = `${HEADER}const p = { shardCount: 1, removalPolicy: cdk.RemovalPolicy.DESTROY };\nnew kinesis.Stream(this, 'S', p);\n`;
    const stats = scanFixtureSource('t.ts', src);
    expect(stats.hits[0]).toMatchObject({ compliant: true, via: 'removalPolicy-prop' });
    expect(stats.propsViaVariable).toBe(1);
  });

  it('still flags a props variable that lacks removalPolicy', () => {
    const src = `${HEADER}const p = { shardCount: 1 };\nnew kinesis.Stream(this, 'S', p);\n`;
    expect(scanFixtureSource('t.ts', src).hits[0].compliant).toBe(false);
  });

  it('does not credit a spread for an explicit removalPolicy', () => {
    // `{ ...base }` may or may not carry the policy -- treat as absent so the
    // author is forced to restate it visibly (or use the allow-comment).
    const src = `${HEADER}const base = { removalPolicy: cdk.RemovalPolicy.DESTROY };\nnew kinesis.Stream(this, 'S', { ...base });\n`;
    expect(scanFixtureSource('t.ts', src).hits[0].compliant).toBe(false);
  });

  it('accepts applyRemovalPolicy on a const target', () => {
    const src = `${HEADER}const s = new kinesis.Stream(this, 'S');\ns.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);\n`;
    expect(scanFixtureSource('t.ts', src).hits[0]).toMatchObject({
      compliant: true,
      via: 'applyRemovalPolicy',
    });
  });

  it('accepts applyRemovalPolicy on a member target (this.x)', () => {
    const src = `${HEADER}this.stream = new kinesis.Stream(this, 'S');\nthis.stream.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);\n`;
    expect(scanFixtureSource('t.ts', src).hits[0].compliant).toBe(true);
  });

  it('does not credit a commented-out or string-embedded applyRemovalPolicy', () => {
    // The first cut resolved this with a raw-source regex, so commenting the
    // call out during a refactor kept the lint green while the leak returned.
    const commented = `${HEADER}const s = new kinesis.Stream(this, 'S');\n// s.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);\n`;
    expect(scanFixtureSource('t.ts', commented).hits[0].compliant).toBe(false);
    const inString = `${HEADER}const s = new kinesis.Stream(this, 'S');\nconst note = 's.applyRemovalPolicy(x)';\n`;
    expect(scanFixtureSource('t.ts', inString).hits[0].compliant).toBe(false);
  });

  it('does not let one variable name substring-match another', () => {
    // `s.applyRemovalPolicy` must not satisfy `logs` (suffix) or `sx` (prefix).
    const src = `${HEADER}const logs = new kinesis.Stream(this, 'A');\nconst s = new kinesis.Stream(this, 'B');\ns.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);\n`;
    const [a, b] = scanFixtureSource('t.ts', src).hits;
    expect(a.compliant).toBe(false);
    expect(b.compliant).toBe(true);
  });

  it('accepts an allow-default-removal-policy comment with rationale', () => {
    const src = `${HEADER}// allow-default-removal-policy: exercises the RETAIN default on purpose\nnew kinesis.Stream(this, 'S');\n`;
    expect(scanFixtureSource('t.ts', src).hits[0]).toMatchObject({
      compliant: true,
      via: 'allow-comment',
    });
  });

  it('accepts a trailing allow-comment on the closing line of a multi-line call', () => {
    const src = `${HEADER}new kinesis.Stream(this, 'S', {\n  shardCount: 1,\n}); // allow-default-removal-policy: exercises the default\n`;
    expect(scanFixtureSource('t.ts', src).hits[0]).toMatchObject({ via: 'allow-comment' });
  });

  it('rejects an allow-comment with no rationale', () => {
    const src = `${HEADER}// allow-default-removal-policy:\nnew kinesis.Stream(this, 'S');\n`;
    expect(scanFixtureSource('t.ts', src).hits[0].compliant).toBe(false);
  });

  it('scopes allow-comments to a class-property initializer, not the class', () => {
    // A comment above the CLASS must not credit every initializer inside it.
    const aboveClass = `${HEADER}// allow-default-removal-policy: nope\nclass X { s = new kinesis.Stream(this, 'S'); }\n`;
    expect(scanFixtureSource('t.ts', aboveClass).hits[0].compliant).toBe(false);
    const aboveProp = `${HEADER}class X {\n  // allow-default-removal-policy: exercises the default\n  s = new kinesis.Stream(this, 'S');\n}\n`;
    expect(scanFixtureSource('t.ts', aboveProp).hits[0]).toMatchObject({ via: 'allow-comment' });
  });

  it('recognizes the ECR / Cognito / Backup registry additions', () => {
    const src =
      `import * as ecr from 'aws-cdk-lib/aws-ecr';\nimport * as cognito from 'aws-cdk-lib/aws-cognito';\nimport * as backup from 'aws-cdk-lib/aws-backup';\n` +
      `new ecr.Repository(this, 'R');\nnew cognito.UserPool(this, 'P');\nnew backup.BackupVault(this, 'V');\n`;
    const { hits } = scanFixtureSource('t.ts', src);
    expect(hits.map((h) => h.construct)).toEqual([
      'aws-ecr.Repository',
      'aws-cognito.UserPool',
      'aws-backup.BackupVault',
    ]);
    expect(hits.every((h) => !h.compliant)).toBe(true);
  });

  it('ignores non-stateful constructs and L1 Cfn classes', () => {
    const src =
      `import * as sqs from 'aws-cdk-lib/aws-sqs';\nimport * as kinesis from 'aws-cdk-lib/aws-kinesis';\n` +
      `new sqs.Queue(this, 'Q');\nnew kinesis.CfnStream(this, 'S');\n`;
    expect(scanFixtureSource('t.ts', src).hits).toEqual([]);
  });

  it('ignores a same-name class from an unrelated module', () => {
    const src = `import { Stream } from 'node:stream';\nnew Stream();\n`;
    expect(scanFixtureSource('t.ts', src).hits).toEqual([]);
  });
});

describe('integ fixture stateful-L2 removalPolicy sweep (issue #1326)', () => {
  const perFile = scanTree();
  const allHits = perFile.flatMap((f) => f.stats.hits.map((h) => ({ ...h, file: f.file })));

  it('finds the fixture tree', () => {
    expect(perFile.length).toBeGreaterThan(400);
  });

  // Coverage floors: "0 violations" and "parsed nothing" are the same green.
  // Floors are per input SHAPE the parser claims to handle (see
  // .claude/rules/testing.md "A checker must prove it sees its input").
  // Baseline 2026-07-31: 120 hits -- namespace 117 / named 3 / props-variable 1.
  it('sees each constructor-reference shape the tree actually uses', () => {
    const total = (k: 'viaNamespace' | 'viaNamed' | 'propsViaVariable') =>
      perFile.reduce((n, f) => n + f.stats[k], 0);
    expect(total('viaNamespace')).toBeGreaterThanOrEqual(90);
    expect(total('viaNamed')).toBeGreaterThanOrEqual(2);
    expect(total('propsViaVariable')).toBeGreaterThanOrEqual(1);
    // No barrel-form stateful L2 exists in the tree today; the shape is
    // covered by the synthetic tests above. If one appears, raise a floor.
  });

  it('sees every construct kind the tree actually uses', () => {
    const byConstruct = new Map<string, number>();
    for (const h of allHits) byConstruct.set(h.construct, (byConstruct.get(h.construct) ?? 0) + 1);
    // Baseline counts 2026-07-31, floored with slack for fixture churn.
    const floors: Record<string, number> = {
      'aws-s3.Bucket': 35,
      'aws-dynamodb.Table': 20,
      'aws-logs.LogGroup': 12,
      'aws-kinesis.Stream': 5,
      'aws-kms.Key': 5,
      'aws-cognito.UserPool': 4,
      'aws-ecr.Repository': 2,
      'aws-efs.FileSystem': 2,
      'aws-dynamodb.TableV2': 1,
      'aws-opensearchservice.Domain': 1,
      'aws-rds.DatabaseInstance': 1,
      'aws-rds.DatabaseCluster': 1,
      // aws-backup.BackupVault: registered but unused in the tree today --
      // covered by the synthetic test above; add a floor when a fixture lands.
    };
    for (const [construct, floor] of Object.entries(floors)) {
      expect(byConstruct.get(construct) ?? 0, construct).toBeGreaterThanOrEqual(floor);
    }
    // Every floored kind must be declared, and vice versa nothing outside the
    // registry can appear (hit constructs come FROM the registry by design).
    for (const construct of Object.keys(floors)) {
      const [module, name] = construct.split('.');
      expect(STATEFUL_CONSTRUCTS[module]).toContain(name);
    }
  });

  it('every stateful L2 instantiation carries an explicit removal policy', () => {
    const violations = allHits
      .filter((h) => !h.compliant)
      .map((h) => `${h.file}:${h.line} ${h.construct}`);
    expect(violations, 'add removalPolicy (or applyRemovalPolicy / allow-comment)').toEqual([]);
  });

  it('keeps allow-comments rare and intentional', () => {
    // The escape hatch is for fixtures that TEST the default. If this grows,
    // someone is using it to silence the lint -- review each addition.
    const allowed = allHits.filter((h) => h.via === 'allow-comment');
    expect(allowed.length).toBeLessThanOrEqual(2);
  });
});
