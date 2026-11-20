import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Executable checks for `tests/integration/revert-identity.sh`, the helper
 * every `drift --revert` fixture uses to prove the revert kept the identity of
 * each resource it touched (go-to-k/cdkd#6639).
 *
 * The helper is sourced under the system bash (3.2 on macOS) with a fake
 * `cdkd` (`$CLI`, printing a `state show --json` document from a file) and a
 * fake `aws` on PATH (printing a value from a file and recording its argv), so
 * a case can change the state record or the AWS-side identity between the
 * two snapshots the way a replacement would.
 */

const HELPER = join(import.meta.dirname, '../../../tests/integration/revert-identity.sh');
const BASH = '/bin/bash';
const SPAWN_TIMEOUT_MS = 60_000;

let sandbox: string;
let statePath: string;
let awsValuePath: string;
let awsLog: string;
let cdkdLog: string;

function writeState(resources: Record<string, { resourceType: string; physicalId: string }>): void {
  writeFileSync(statePath, JSON.stringify({ state: { resources } }));
}

function setAwsValue(value: string): void {
  writeFileSync(awsValuePath, value);
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'cdkd-revert-identity-'));
  const bin = join(sandbox, 'bin');
  mkdirSync(bin);
  statePath = join(sandbox, 'state.json');
  awsValuePath = join(sandbox, 'aws-value');
  awsLog = join(sandbox, 'aws.log');
  cdkdLog = join(sandbox, 'cdkd.log');
  writeFileSync(
    join(bin, 'aws'),
    [
      '#!/bin/sh',
      `echo "$@" >> "${awsLog}"`,
      `if [ -f "${awsValuePath}.rc" ]; then cat "${awsValuePath}.rc" >&2; exit 254; fi`,
      `cat "${awsValuePath}"`,
      '',
    ].join('\n')
  );
  chmodSync(join(bin, 'aws'), 0o755);
  writeFileSync(
    join(bin, 'fake-cdkd'),
    [
      '#!/bin/sh',
      `echo "$@" >> "${cdkdLog}"`,
      `if [ ! -f "${statePath}" ]; then echo "no state" >&2; exit 1; fi`,
      `cat "${statePath}"`,
      '',
    ].join('\n')
  );
  chmodSync(join(bin, 'fake-cdkd'), 0o755);
  writeState({
    Role1: { resourceType: 'AWS::IAM::Role', physicalId: 'Stack-Role1' },
    Sub1: {
      resourceType: 'AWS::SNS::Subscription',
      physicalId: 'arn:aws:sns:us-east-1:111111111111:t:0f0e-uuid',
    },
  });
  setAwsValue('AROAEXAMPLEUNIQUE1\n');
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

interface Run {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(snippet: string, extraEnv: Record<string, string> = {}): Run {
  const script = ['set -euo pipefail', `. "${HELPER}"`, snippet, ''].join('\n');
  const r = spawnSync(BASH, ['-c', script], {
    cwd: sandbox,
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
    env: {
      PATH: `${join(sandbox, 'bin')}:/usr/bin:/bin:${process.env.PATH ?? ''}`,
      HOME: sandbox,
      TMPDIR: sandbox,
      LC_ALL: 'C',
      BASH_ENV: '',
      ENV: '',
      CLI: join(sandbox, 'bin', 'fake-cdkd'),
      STATE_BUCKET: 'state-bucket',
      REGION: 'us-east-1',
      ...extraEnv,
    },
  });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

const before = (): string => join(sandbox, 'before');
const after = (): string => join(sandbox, 'after');

describe('revert_identity_snapshot + revert_identity_assert_unchanged', () => {
  it('passes when nothing changed, and records one row per logical id', () => {
    const r = run(
      [
        `revert_identity_snapshot "${before()}" Stack Role1 Sub1`,
        `revert_identity_snapshot "${after()}" Stack Role1 Sub1`,
        `revert_identity_assert_unchanged "${before()}" "${after()}" 2`,
      ].join('\n'),
      {}
    );
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('kept the identity of all 2 resource(s)');
    const rows = readFileSync(before(), 'utf8').trimEnd().split('\n');
    expect(rows).toEqual([
      'Role1\tAWS::IAM::Role\tStack-Role1\tunique:AROAEXAMPLEUNIQUE1',
      'Sub1\tAWS::SNS::Subscription\tarn:aws:sns:us-east-1:111111111111:t:0f0e-uuid\tgen-id:AROAEXAMPLEUNIQUE1',
    ]);
  });

  it('passes the region to state show (--stack-region) and to the AWS probe', () => {
    const r = run(`revert_identity_snapshot "${before()}" Stack Sub1`, {
      REVERT_IDENTITY_REGION: 'us-west-2',
    });
    expect(r.status).toBe(0);
    expect(readFileSync(cdkdLog, 'utf8')).toContain(
      'state show Stack --state-bucket state-bucket --stack-region us-west-2 --json'
    );
    expect(readFileSync(awsLog, 'utf8')).toContain('--region us-west-2');
  });

  it('FAILS when the AWS-side identity changed under the same physical id (a name-keyed replacement)', () => {
    const r = run(
      [
        `revert_identity_snapshot "${before()}" Stack Role1`,
        `printf 'AROANEWROLEAFTERREPLACE\\n' > "${awsValuePath}"`,
        `revert_identity_snapshot "${after()}" Stack Role1`,
        `revert_identity_assert_unchanged "${before()}" "${after()}" 1`,
      ].join('\n')
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('REPLACED or re-created a resource');
    expect(r.stderr).toContain('AROANEWROLEAFTERREPLACE');
  });

  it('FAILS when the state physical id changed', () => {
    const r = run(
      [
        `revert_identity_snapshot "${before()}" Stack Role1`,
        `printf '%s' '{"state":{"resources":{"Role1":{"resourceType":"AWS::IAM::Role","physicalId":"Stack-Role1-new"}}}}' > "${statePath}"`,
        `revert_identity_snapshot "${after()}" Stack Role1`,
        `revert_identity_assert_unchanged "${before()}" "${after()}" 1`,
      ].join('\n')
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('REPLACED or re-created a resource');
  });

  it.each([
    ['empty', ''],
    ['None', 'None\n'],
  ])('FAILS when the AWS probe reads %s', (_label, value) => {
    setAwsValue(value);
    const r = run(`revert_identity_snapshot "${before()}" Stack Role1 || exit 1; echo unreachable`);
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain('unreachable');
    expect(r.stderr).toContain('probe of');
  });

  it('FAILS when the AWS probe itself fails', () => {
    writeFileSync(`${awsValuePath}.rc`, 'An error occurred (NoSuchEntity)');
    const r = run(`revert_identity_snapshot "${before()}" Stack Role1 || exit 1; echo unreachable`);
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain('unreachable');
  });

  it('FAILS when state show fails, even called from an `||` context (errexit off)', () => {
    rmSync(statePath);
    const r = run(`revert_identity_snapshot "${before()}" Stack Role1 || exit 7; echo unreachable`);
    expect(r.status).toBe(7);
    expect(r.stderr).toContain("'state show Stack' failed");
  });

  it('FAILS when a logical id is missing from state', () => {
    const r = run(`revert_identity_snapshot "${before()}" Stack Role1 Missing1 || exit 1`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Missing1 has no state record');
  });

  it('FAILS for a type with no probe, at the snapshot AND at the assert', () => {
    writeState({ Thing: { resourceType: 'AWS::Fake::Thing', physicalId: 'thing-1' } });
    const snap = run(`revert_identity_snapshot "${before()}" Stack Thing || exit 1`);
    expect(snap.status).toBe(1);
    expect(snap.stderr).toContain('no AWS identity probe for AWS::Fake::Thing');
    // The row it leaves behind must not pass the comparison either, even
    // against an identical copy.
    const cmp = run(
      [
        `cp "${before()}" "${after()}"`,
        `revert_identity_assert_unchanged "${before()}" "${after()}" 1`,
      ].join('\n')
    );
    expect(existsSync(before())).toBe(true);
    expect(cmp.status).toBe(1);
    expect(cmp.stderr).toContain('empty or unprobed row');
  });

  it('FAILS on an empty field in a snapshot row', () => {
    const row = 'Role1\tAWS::IAM::Role\t\tunique:x\n';
    writeFileSync(before(), row);
    writeFileSync(after(), row);
    const r = run(`revert_identity_assert_unchanged "${before()}" "${after()}" 1`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('empty or unprobed row');
  });

  it('FAILS on a row-count mismatch, either side', () => {
    const r = run(
      [
        `revert_identity_snapshot "${before()}" Stack Role1 Sub1`,
        `revert_identity_snapshot "${after()}" Stack Role1 Sub1`,
        `revert_identity_assert_unchanged "${before()}" "${after()}" 3`,
      ].join('\n')
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('holds 2 row(s), want 3');
    const r2 = run(
      [
        `revert_identity_snapshot "${before()}" Stack Role1 Sub1`,
        `revert_identity_snapshot "${after()}" Stack Role1`,
        `revert_identity_assert_unchanged "${before()}" "${after()}" 2`,
      ].join('\n')
    );
    expect(r2.status).toBe(1);
    expect(r2.stderr).toContain('holds 1 row(s), want 2');
  });

  it.each(['0', '', 'two'])('FAILS on an expected count of %j (vacuity guard)', (want) => {
    writeFileSync(before(), '');
    writeFileSync(after(), '');
    const r = run(`revert_identity_assert_unchanged "${before()}" "${after()}" "${want}"`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('must be a positive integer');
  });

  it('FAILS when a snapshot file is missing', () => {
    const r = run(`revert_identity_assert_unchanged "${before()}" "${after()}" 1`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('is missing');
  });

  it("passes a type's extra read value (the owning API id) from the state record to its probe", () => {
    writeFileSync(
      statePath,
      JSON.stringify({
        state: {
          resources: {
            Stage1: {
              resourceType: 'AWS::ApiGatewayV2::Stage',
              physicalId: '$default',
              properties: { ApiId: 'abc123' },
            },
            Rule1: {
              resourceType: 'AWS::EC2::SecurityGroupIngress',
              physicalId: 'sg-1|tcp|443|443',
              attributes: { Id: 'sgr-0123' },
            },
          },
        },
      })
    );
    setAwsValue('2026-11-20T00:00:00Z\n');
    const r = run(`revert_identity_snapshot "${before()}" Stack Stage1 Rule1`);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const calls = readFileSync(awsLog, 'utf8');
    expect(calls).toContain('apigatewayv2 get-stage --region us-east-1 --api-id abc123 --stage-name $default');
    expect(calls).toContain('--security-group-rule-ids sgr-0123');
  });

  it('FAILS when a type needing an extra read value has none recorded', () => {
    writeState({ Stage1: { resourceType: 'AWS::ApiGatewayV2::Stage', physicalId: 'prod' } });
    const r = run(`revert_identity_snapshot "${before()}" Stack Stage1 || exit 1`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no ApiId');
  });

  it('reads a Lambda permission by its Sid, and FAILS once the statement is gone', () => {
    writeFileSync(
      statePath,
      JSON.stringify({
        state: {
          resources: {
            Perm1: {
              resourceType: 'AWS::Lambda::Permission',
              physicalId: 'arn:aws:lambda:us-east-1:1:function:fn|sid-1',
              properties: { FunctionName: 'fn' },
            },
          },
        },
      })
    );
    setAwsValue(JSON.stringify({ Statement: [{ Sid: 'other' }, { Sid: 'sid-1' }] }));
    const ok = run(`revert_identity_snapshot "${before()}" Stack Perm1`);
    expect(ok.status).toBe(0);
    expect(readFileSync(before(), 'utf8')).toContain('\tno-id:sid-1\n');
    setAwsValue(JSON.stringify({ Statement: [{ Sid: 'other' }] }));
    const gone = run(`revert_identity_snapshot "${after()}" Stack Perm1 || exit 1`);
    expect(gone.status).toBe(1);
    expect(gone.stderr).toContain('probe of');
  });

  it('FAILS a snapshot with no logical ids', () => {
    const r = run(`revert_identity_snapshot "${before()}" Stack || exit 1`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('needs <out-file> <stack> <logicalId>');
  });
});

describe('revert_output_assert_no_replacement', () => {
  const log = (): string => join(sandbox, 'revert.log');
  const check = (body: string, opt = ''): Run => {
    writeFileSync(log(), body);
    return run(`revert_output_assert_no_replacement "${log()}" ${opt}`);
  };

  it('passes an ordinary revert output', () => {
    const r = check('  ✓ Stack/Queue1 (AWS::SQS::Queue): reverted\n\nRevert summary: 1 reverted.\n');
    expect(r.status).toBe(0);
  });

  it.each([
    'Replacing Stack/Topic1 (AWS::SNS::Subscription)',
    '\u001b[33m  Re-creating the subscription\u001b[0m',
    'recreated Stack/Role1',
    'the subscription was replaced',
  ])('FAILS on replacement wording: %j', (line) => {
    const r = check(`ok\n${line}\n`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('reports a replacement or re-create');
  });

  it("ignores aws-cdk-lib's own synth WARNING lines", () => {
    const r = check(
      '[WARNING] aws-cdk-lib.aws_x.Foo#bar is deprecated. replaced by baz\n  ✓ reverted\n'
    );
    expect(r.status).toBe(0);
  });

  it("FAILS cdkd's refusal wording when no refusal is expected", () => {
    const r = check(
      '  ✗ Stack/Sub1 (AWS::SNS::Subscription): Endpoint changed, so reverting it would replace it, and a drift revert never replaces a resource. Nothing was changed; re-deploy with cdkd deploy --replace to replace it\n'
    );
    expect(r.status).toBe(1);
  });

  it.each([
    'a drift revert never replaces a resource. Nothing was changed; re-deploy with cdkd deploy --replace to replace it',
    '1 resource(s) cannot be reverted in place — re-deploy the stack with cdkd deploy --replace, or destroy + redeploy',
    'AWS::Lambda::Permission (Perm1) cannot be updated in place: use cdkd deploy with --replace, or change the resource definition',
  ])('expect-refusal allows refusal wording: %j', (line) => {
    const r = check(`${line}\n`, 'expect-refusal');
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('expect-refusal still FAILS a replacement line beside the refusal', () => {
    const r = check(
      'a drift revert never replaces a resource\nReplacing Stack/Other1\n',
      'expect-refusal'
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Replacing Stack/Other1');
  });

  it('expect-refusal FAILS when the refusal wording is absent (drifted wording)', () => {
    const r = check('  ✗ Stack/Sub1: refused\n', 'expect-refusal');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('carries none of cdkd');
  });

  it.each(['', 'expect-refusal'])(
    'FAILS the provider-REPLACED backstop line in mode %j',
    (opt) => {
      const r = check(
        '  ✗ Stack/Sub1 (AWS::SNS::Subscription): the provider REPLACED the resource or changed its identity instead of reverting it in place (x)\na drift revert never replaces a resource\n',
        opt
      );
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('backstop');
    }
  );

  it('FAILS on a missing or empty log', () => {
    expect(run(`revert_output_assert_no_replacement "${join(sandbox, 'nope')}"`).status).toBe(1);
    expect(check('').status).toBe(1);
  });

  it('FAILS on an unknown option', () => {
    const r = check('ok\n', 'expect-refusals');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('unknown option');
  });
});
