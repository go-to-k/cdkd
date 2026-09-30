import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { spawnSync } from 'node:child_process';

import {
  pasteableAwsProfileFlag,
  setPasteableAwsProfile,
  withPasteableAwsProfile,
} from '../../../src/utils/pasteable-aws-profile.js';
import {
  WITHHELD_AWS_COMMAND,
  pasteableAwsCommand,
  protectedReplacementAdvice,
  renderDisableCommand,
} from '../../../src/provisioning/replacement-protection-advice.js';
import {
  logGroupProtectionSite,
  rdsFamilyProtectionSite,
  userPoolProtectionSite,
} from '../../../src/provisioning/providers/deletion-protection-compensation.js';
import { preDeleteManualCommands } from '../../../src/cli/commands/export.js';
import {
  resetAwsClientDefaults,
  setAssumedRoleCredentials,
} from '../../../src/utils/aws-client-defaults.js';
import { buildProgram } from '../../../src/cli/program.js';
import { PASTE_PAYLOADS, spansThatRun, withPasteDir } from './paste-harness.js';

/**
 * go-to-k/cdkd#3959: every pasteable `aws ...` command carries the run's
 * EXPLICIT `--profile`, so a paste after `cdkd destroy --profile prod` does not
 * resolve the operator's default profile (another account).
 *
 * The profile is process state, so EVERY case starts and ends with it unset;
 * the assumed-role store is reset for the same reason.
 */
afterEach(() => {
  setPasteableAwsProfile(undefined);
  resetAwsClientDefaults();
});

/** Run `command` under bash with `aws` stubbed to print its argv, one per line. */
function argvUnderBash(command: string): string[] {
  const script = `aws() { printf '%s\\n' "$@"; }\n${command}\n`;
  const out = spawnSync('bash', ['--noprofile', '--norc', '-c', script], { encoding: 'utf8' });
  expect(out.status).toBe(0);
  return out.stdout.split('\n').slice(0, -1);
}

const rdsSite = (region: string | undefined) =>
  rdsFamilyProtectionSite({
    cliService: 'rds',
    serviceLabel: 'RDS',
    kind: 'cluster',
    physicalId: 'my-cluster',
    region,
    notFoundFault: 'DBClusterNotFoundFault',
    isNotFound: () => false,
  }).commands();

describe('pasteableAwsProfileFlag', () => {
  it('is EMPTY when the run named no profile, or an empty one', () => {
    expect(pasteableAwsProfileFlag()).toBe('');
    setPasteableAwsProfile('');
    expect(pasteableAwsProfileFlag()).toBe('');
  });

  it('names a plain profile bare', () => {
    setPasteableAwsProfile('prod');
    expect(pasteableAwsProfileFlag()).toBe('--profile prod');
    setPasteableAwsProfile('team.a_b@c:d/e+f');
    expect(pasteableAwsProfileFlag()).toBe('--profile team.a_b@c:d/e+f');
  });

  it('keeps a non-ASCII profile name, which is legitimate', () => {
    setPasteableAwsProfile('prod-\u00e9');
    expect(pasteableAwsProfileFlag()).toBe(`--profile 'prod-\u00e9'`);
  });

  it.each([
    ['a control character', 'prod\u001b[2J'],
    ['surrounding whitespace displaySafe trims', ' prod'],
    ['a leading dash', '--region'],
    ['a clause break a selection can start inside', 'a: b'],
    ['a backtick, which ends a markdown-backtick wrapper when pasted', 'x`touch OWNED`y'],
    ['whitespace', 'team a'],
    ['an apostrophe', "team'a"],
    ['a command separator', 'x;y'],
    ['a dollar sign (also a JS replacement pattern)', 'x$$y'],
    ['a replacement back-reference', 'a$1b'],
    ['a tilde', '~root'],
    ['a backslash', 'p\\q'],
  ])('prints the quoted hole, never the value, for %s', (_what, profile) => {
    setPasteableAwsProfile(profile);
    expect(pasteableAwsProfileFlag()).toBe(`--profile '<profile>'`);
  });

  it.each([...' \t\'"`$;&|<>()*?[]{}!#~\\^=%,'])(
    'holes a profile holding %j, which a pasted line could run or re-split',
    (c) => {
      setPasteableAwsProfile(`a${c}b`);
      expect(pasteableAwsProfileFlag()).toBe(`--profile '<profile>'`);
    }
  );

  it('prints the role-profile hole when the run also assumed a role', () => {
    setPasteableAwsProfile('prod');
    setAssumedRoleCredentials({
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'secret',
      sessionToken: 'token',
    });
    expect(pasteableAwsProfileFlag()).toBe(`--profile '<role-profile>'`);
  });

  it('adds nothing under an assumed role when the run named no profile', () => {
    setAssumedRoleCredentials({
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'secret',
      sessionToken: 'token',
    });
    expect(pasteableAwsProfileFlag()).toBe('');
  });
});

describe('withPasteableAwsProfile', () => {
  it('is the identity without a profile', () => {
    const text = 'aws ec2 describe-instances && aws ec2 associate-address';
    expect(withPasteableAwsProfile(text)).toBe(text);
  });

  it('inserts after EVERY aws command word, chained or piped', () => {
    setPasteableAwsProfile('prod');
    expect(
      withPasteableAwsProfile(
        "aws events list-targets-by-rule | jq -r '.Targets[].Id' | xargs aws events remove-targets; aws events delete-rule && aws ec2 x"
      )
    ).toBe(
      "aws --profile prod events list-targets-by-rule | jq -r '.Targets[].Id' | xargs aws --profile prod events remove-targets; aws --profile prod events delete-rule && aws --profile prod ec2 x"
    );
  });

  it('inserts after `(` and after a newline too', () => {
    setPasteableAwsProfile('prod');
    expect(withPasteableAwsProfile('(aws ec2 x)')).toBe('(aws --profile prod ec2 x)');
    expect(withPasteableAwsProfile('a\naws ec2 x')).toBe('a\naws --profile prod ec2 x');
  });

  it('handles a span that ends right after `aws ` (a spliced service fragment)', () => {
    setPasteableAwsProfile('prod');
    expect(withPasteableAwsProfile('aws ')).toBe('aws --profile prod ');
  });

  it('leaves text with no aws command word alone', () => {
    setPasteableAwsProfile('prod');
    for (const text of [' --region ', 'Name=', 'laws of', 'aws', 'aws-cdk:path x', 'aws Upper']) {
      expect(withPasteableAwsProfile(text)).toBe(text);
    }
  });
});

describe('the shared renderers carry the profile (go-to-k/cdkd#3959)', () => {
  it('pasteableAwsCommand: byte-identical without a profile', () => {
    const aws = pasteableAwsCommand();
    expect(aws`aws iam delete-role --role-name ${'r'}`.render()).toBe(
      'aws iam delete-role --role-name r'
    );
  });

  it('pasteableAwsCommand: after every aws word, values still one argument each', () => {
    setPasteableAwsProfile('prod-\u00e9');
    const aws = pasteableAwsCommand();
    const cmd = aws`aws ec2 describe-instances --instance-ids ${'i-1'} && aws ec2 associate-address --instance-id ${'i-1'}`.render();
    expect(cmd).toBe(
      `aws --profile 'prod-\u00e9' ec2 describe-instances --instance-ids i-1 && ` +
        `aws --profile 'prod-\u00e9' ec2 associate-address --instance-id i-1`
    );
    expect(argvUnderBash(cmd)).toEqual([
      '--profile',
      'prod-\u00e9',
      'ec2',
      'describe-instances',
      '--instance-ids',
      'i-1',
      '--profile',
      'prod-\u00e9',
      'ec2',
      'associate-address',
      '--instance-id',
      'i-1',
    ]);
  });

  it('pasteableAwsCommand: a withheld command stays withheld (no profile leaks into the notice)', () => {
    setPasteableAwsProfile('prod');
    const aws = pasteableAwsCommand();
    const rendered = aws`aws iam delete-role --role-name ${'bad\u001bname'}`.render();
    expect(rendered).toBe(WITHHELD_AWS_COMMAND);
  });

  it('renderDisableCommand / protectedReplacementAdvice: byte-identical without a profile', () => {
    const disable = {
      before: 'aws logs delete-log-group --log-group-name',
      identifier: 'my-group',
    } as const;
    expect(renderDisableCommand(disable)).toBe('aws logs delete-log-group --log-group-name my-group');
  });

  it('renderDisableCommand / protectedReplacementAdvice: carry the profile', () => {
    setPasteableAwsProfile('prod');
    expect(
      renderDisableCommand({
        before: 'aws elbv2 modify-load-balancer-attributes --load-balancer-arn',
        identifier: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/x/1',
        after: '--attributes Key=deletion_protection.enabled,Value=false',
      })
    ).toBe(
      'aws --profile prod elbv2 modify-load-balancer-attributes --load-balancer-arn ' +
        'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/x/1 ' +
        '--attributes Key=deletion_protection.enabled,Value=false'
    );
    const advice = protectedReplacementAdvice({
      evidence: "cdkd's recorded properties carry DeletionProtection: true",
      replaceFlags: 'cdkd deploy --replace',
      disable: {
        before: 'aws rds modify-db-cluster --db-cluster-identifier',
        identifier: 'c1',
        after: '--no-deletion-protection',
      },
    });
    expect(advice).toContain(
      '`aws --profile prod rds modify-db-cluster --db-cluster-identifier c1 --no-deletion-protection`'
    );
  });
});

describe('a hostile profile inside the backtick-wrapped advice runs nothing when pasted', () => {
  it.each([
    ...PASTE_PAYLOADS.map((p) => [p.label, p.value] as const),
    // Space-free, so only the non-whitespace part of the gate can stop it.
    ['space-free backtick', 'x`touch${IFS}OWNED`y'] as const,
    ['space-free substitution', 'x$(touch${IFS}OWNED)'] as const,
  ])(
    '%s',
    (_label, profile) => {
      setPasteableAwsProfile(profile);
      const advice = protectedReplacementAdvice({
        evidence: "cdkd's recorded properties carry DeletionProtection: true",
        replaceFlags: 'cdkd deploy --replace',
        disable: {
          before: 'aws rds modify-db-cluster --db-cluster-identifier',
          identifier: 'c1',
          after: '--no-deletion-protection',
        },
      });
      withPasteDir((dir) => {
        expect(spansThatRun(advice, dir)).toEqual([]);
      });
    },
    30_000
  );
});

describe('the --remove-protection compensation commands (the issue examples)', () => {
  it('are byte-identical without a profile', () => {
    expect(rdsSite('eu-west-1')).toEqual({
      check: 'aws rds describe-db-clusters --db-cluster-identifier my-cluster --region eu-west-1',
      restoreAfterNotFound:
        'aws rds modify-db-cluster --db-cluster-identifier my-cluster --region eu-west-1 --deletion-protection --apply-immediately',
      restoreLive:
        'aws rds modify-db-cluster --db-cluster-identifier my-cluster --region eu-west-1 --deletion-protection --apply-immediately',
    });
  });

  it('carry --profile on the RDS-family check and restore lines (service spliced as a fragment)', () => {
    setPasteableAwsProfile('prod');
    const cmds = rdsSite(undefined);
    expect(cmds.check).toBe(
      'aws --profile prod rds describe-db-clusters --db-cluster-identifier my-cluster'
    );
    expect(cmds.restoreLive).toBe(
      'aws --profile prod rds modify-db-cluster --db-cluster-identifier my-cluster --deletion-protection --apply-immediately'
    );
  });

  it('carry --profile on the log-group and user-pool lines', () => {
    setPasteableAwsProfile('prod');
    const logs = logGroupProtectionSite('/my/group', 'us-east-1').commands();
    expect(logs.check).toBe(
      'aws --profile prod logs describe-log-groups --log-group-identifiers /my/group --region us-east-1'
    );
    const pool = userPoolProtectionSite('us-east-1_abc', undefined).commands();
    expect(pool.restoreLive).toBe(
      'aws --profile prod cognito-idp update-user-pool --user-pool-id us-east-1_abc --deletion-protection ACTIVE'
    );
  });
});

describe('hand-built aws commands in cdkd export', () => {
  const entries = [
    { resourceType: 'AWS::ApiGatewayV2::Stage' },
    // An unreadable principal list names every kind: three iam lines.
    { resourceType: 'AWS::IAM::Policy' },
  ];

  it('preDeleteManualCommands is byte-identical without a profile', () => {
    expect(preDeleteManualCommands(entries).filter((l) => l.startsWith('aws '))).toEqual([
      "aws apigatewayv2 delete-stage --api-id '<ApiId>' --stage-name '<StageName>'",
      "aws iam delete-role-policy --role-name '<RoleName>' --policy-name '<PolicyName>'",
      "aws iam delete-user-policy --user-name '<UserName>' --policy-name '<PolicyName>'",
      "aws iam delete-group-policy --group-name '<GroupName>' --policy-name '<PolicyName>'",
    ]);
  });

  it('preDeleteManualCommands carries the profile', () => {
    setPasteableAwsProfile('prod');
    expect(preDeleteManualCommands(entries).filter((l) => l.startsWith('aws '))).toEqual([
      "aws --profile prod apigatewayv2 delete-stage --api-id '<ApiId>' --stage-name '<StageName>'",
      "aws --profile prod iam delete-role-policy --role-name '<RoleName>' --policy-name '<PolicyName>'",
      "aws --profile prod iam delete-user-policy --user-name '<UserName>' --policy-name '<PolicyName>'",
      "aws --profile prod iam delete-group-policy --group-name '<GroupName>' --policy-name '<PolicyName>'",
    ]);
  });
});

describe("the CLI's preAction hook records only an EXPLICIT --profile", () => {
  function runForceUnlock(argv: string[]): void {
    const program = buildProgram();
    const cmd = program.commands.find((c) => c.name() === 'force-unlock');
    if (!cmd) throw new Error('no force-unlock command');
    cmd.action(() => {});
    program.parse(['force-unlock', 'MyStack', ...argv], { from: 'user' });
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('records --profile', () => {
    vi.stubEnv('AWS_PROFILE', undefined);
    runForceUnlock(['--profile', 'prod']);
    expect(pasteableAwsProfileFlag()).toBe('--profile prod');
  });

  it('records nothing for an inherited AWS_PROFILE, and clears a stale value', () => {
    setPasteableAwsProfile('stale');
    vi.stubEnv('AWS_PROFILE', 'from-env');
    runForceUnlock([]);
    expect(pasteableAwsProfileFlag()).toBe('');
  });
});
