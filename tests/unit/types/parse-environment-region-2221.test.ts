/**
 * The region of a Cloud Assembly `environment` is read exactly as the AWS CDK
 * CLI reads it (issue go-to-k/cdkd#2221): `@aws-cdk/cloud-assembly-api`'s
 * `EnvironmentUtils.parse` takes the longest `[a-z0-9-]+` run after
 * `aws://<account>/` and ignores the rest, and throws
 * `Unable to parse environment specification` where there is none
 * (`aws://<acct>/US-EAST-1`).
 *
 * Both polarities matter, and the parity table checks them against the REAL
 * parser (`aws-cdk-lib/cx-api`, a devDependency) and against a verbatim copy of
 * its pattern: everything CDK accepts is accepted with CDK's region, and
 * everything CDK refuses is refused. The refusal also fires through the real
 * `AssemblyReader`, naming the stack.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EnvironmentUtils } from 'aws-cdk-lib/cx-api';

vi.mock('../../../src/utils/logger.js', () => {
  const quiet = () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: quiet,
  });
  return { getLogger: quiet };
});

import { parseEnvironment, type AssemblyManifest } from '../../../src/types/assembly.js';
import { AssemblyReader } from '../../../src/synthesis/assembly-reader.js';
import { SynthesisError } from '../../../src/utils/error-handler.js';

const ACCOUNT = '123456789012';

/**
 * `AWS_ENV_REGEX` from `@aws-cdk/cloud-assembly-api/lib/environment.js`,
 * copied character for character.
 */
const CDK_AWS_ENV_REGEX = new RegExp(String.raw`aws\:\/\/([a-z0-9A-Z\-\@\.\_]+)\/([a-z\-0-9]+)`);

/** Every partition's region shape, plus regions with two-digit / multi-part names. */
const CANONICAL_REGIONS = [
  'us-east-1',
  'ap-southeast-5',
  'eu-central-2',
  'il-central-1',
  'cn-north-1',
  'cn-northwest-1',
  'us-gov-west-1',
  'us-iso-east-1',
  'us-isob-east-1',
  'eu-isoe-west-1',
  'us-isof-south-1',
  'eusc-de-east-1',
  'unknown-region',
];

/** Spellings CDK reads by TRUNCATION: accepted, with the region it keeps. */
const TRUNCATED: Array<[string, string]> = [
  ['us-east-1 ', 'us-east-1'],
  ['us-east-1/extra', 'us-east-1'],
  ['us-east-1\nus-west-2', 'us-east-1'],
  ['us-east-1\n', 'us-east-1'],
  ['us-east-1‮', 'us-east-1'],
  ['us-EAST-1', 'us-'],
  ['us_east_1', 'us'],
];

/** Spellings CDK REFUSES: nothing after the `/` starts a region. */
const REFUSED = ['US-EAST-1', 'Us-East-1', ' us-east-1', '\nus-east-1', '_us-east-1', '‮us'];

function cdkVerdict(env: string): string | undefined {
  try {
    return EnvironmentUtils.parse(env).region;
  } catch {
    return undefined;
  }
}

function cdkdVerdict(env: string): string | undefined {
  try {
    return parseEnvironment(env).region;
  } catch (error) {
    expect(error).toBeInstanceOf(SynthesisError);
    return undefined;
  }
}

function refusal(env: string, stackName?: string): string {
  try {
    parseEnvironment(env, stackName);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error(`expected ${JSON.stringify(env)} to be refused`);
}

describe('parseEnvironment region parity with the AWS CDK CLI (issue #2221)', () => {
  const table: Array<[string, string | undefined]> = [
    ...CANONICAL_REGIONS.map((r): [string, string] => [`aws://${ACCOUNT}/${r}`, r]),
    ...TRUNCATED.map(([r, kept]): [string, string] => [`aws://${ACCOUNT}/${r}`, kept]),
    ...REFUSED.map((r): [string, undefined] => [`aws://${ACCOUNT}/${r}`, undefined]),
    // Unanchored: CDK finds a LATER `aws://` when the first one names no region.
    [`aws://${ACCOUNT}/Xaws://${ACCOUNT}/eu-west-1`, 'eu-west-1'],
    ['aws://unknown-account/unknown-region', 'unknown-region'],
  ];

  it('the copied pattern is the one the real parser runs', () => {
    for (const [env] of table) {
      expect(CDK_AWS_ENV_REGEX.exec(env)?.[2], JSON.stringify(env)).toBe(cdkVerdict(env));
    }
  });

  it.each(table)('%j: cdkd and EnvironmentUtils.parse agree (%j)', (env, expected) => {
    expect(cdkVerdict(env)).toBe(expected);
    expect(cdkdVerdict(env)).toBe(expected);
  });

  it('floors: the table holds accepted, truncated and refused rows', () => {
    expect(table.filter(([, r]) => r === undefined).length).toBeGreaterThanOrEqual(6);
    expect(TRUNCATED.length).toBeGreaterThanOrEqual(7);
    expect(table.length).toBeGreaterThanOrEqual(28);
  });
});

describe('parseEnvironment outside the region (unchanged by issue #2221)', () => {
  it('keeps the account and the unknown-account sentinel as before', () => {
    expect(parseEnvironment('aws://unknown-account/eu-west-1')).toEqual({
      account: 'unknown-account',
      region: 'eu-west-1',
    });
    expect(parseEnvironment('aws://my-alias@x.y_z/us-east-1')).toEqual({
      account: 'my-alias@x.y_z',
      region: 'us-east-1',
    });
  });

  it('takes BOTH halves from a later aws:// when CDK matches there', () => {
    const env = 'aws://111111111111/Xaws://222222222222/eu-west-1';
    expect(EnvironmentUtils.parse(env)).toMatchObject({
      account: '222222222222',
      region: 'eu-west-1',
    });
    expect(parseEnvironment(env)).toEqual({ account: '222222222222', region: 'eu-west-1' });
  });

  it('keeps accepting an account CDK refuses, reading its region by the same prefix rule', () => {
    // CDK's account class has no `:`, so `EnvironmentUtils.parse` throws here;
    // cdkd's account side was always wider and stays so.
    expect(cdkVerdict(`aws://acct:x/us-east-1/extra`)).toBeUndefined();
    expect(parseEnvironment('aws://acct:x/us-east-1/extra')).toEqual({
      account: 'acct:x',
      region: 'us-east-1',
    });
  });

  it('keeps answering the sentinels for a string that is not aws://account/region', () => {
    expect(parseEnvironment('not-an-env')).toEqual({
      account: 'unknown-account',
      region: 'unknown-region',
    });
  });
});

describe('the refusal message (issue #2221)', () => {
  it('names the stack and region, the AWS CDK CLI parity, the fix and the state consequence', () => {
    const message = refusal(`aws://${ACCOUNT}/US-EAST-1`, 'MyStack');
    expect(message).toContain('Stack MyStack in the cloud assembly declares region US-EAST-1,');
    expect(message).toContain(
      'The AWS CDK CLI refuses this assembly too ("Unable to parse environment specification").'
    );
    expect(message).toContain('Re-synthesize with the region spelled us-east-1.');
    expect(message).toContain('a deploy using the canonical spelling will not find that state');
    expect(message).toContain(
      "'cdkd state show' and 'cdkd state orphan' still reach that record when " +
        "'--stack-region' is given the exact raw spelling"
    );
  });

  it.each([
    ['US-EAST-1', true],
    ['Us-East-1', true],
    [' us-east-1', false],
    ['\nus-east-1', false],
    ['_us-east-1', false],
  ])('prints the raw-key state paragraph for %j only for a case-only spelling', (region, shown) => {
    const message = refusal(`aws://${ACCOUNT}/${region}`);
    expect(message).toContain('which is not a canonical AWS region spelling');
    expect(message.includes('If an earlier cdkd version deployed this stack')).toBe(shown);
    expect(message.includes("'cdkd state show' and 'cdkd state orphan'")).toBe(shown);
  });

  it('suggests the lowercase spelling only when lowercasing makes it canonical', () => {
    expect(refusal(`aws://${ACCOUNT}/Cn-North-1`)).toContain(
      'Re-synthesize with the region spelled cn-north-1.'
    );
    expect(refusal(`aws://${ACCOUNT}/_us-east-1`)).toContain(
      "Re-synthesize with a canonical region, e.g. env: { region: 'us-east-1' }."
    );
  });

  it('renders an untrusted region through displayIdent: no raw newline or bidi control', () => {
    const message = refusal(`aws://${ACCOUNT}/\nFAKE LINE‮`, 'MyStack');
    const firstLine = message.split('\n')[0]!;
    expect(firstLine).toContain('declares region "FAKE LINE",');
    expect(message).not.toContain('‮');
    expect(message).not.toMatch(/^FAKE LINE/m);
  });
});

describe('AssemblyReader reads the environment region as the AWS CDK CLI does (issue #2221)', () => {
  let root: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'cdkd-2221-')));
    writeFileSync(join(root, 'Good.template.json'), JSON.stringify({ Resources: {} }));
    writeFileSync(join(root, 'Other.template.json'), JSON.stringify({ Resources: {} }));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function manifestWith(otherRegion: string): AssemblyManifest {
    return {
      version: '54.0.0',
      artifacts: {
        Good: {
          type: 'aws:cloudformation:stack',
          environment: `aws://${ACCOUNT}/us-east-1`,
          properties: { stackName: 'Good', templateFile: 'Good.template.json' },
        },
        Other: {
          type: 'aws:cloudformation:stack',
          environment: `aws://${ACCOUNT}/${otherRegion}`,
          properties: { stackName: 'Other', templateFile: 'Other.template.json' },
        },
      },
    } as AssemblyManifest;
  }

  it('reads a canonical region, and a truncated one as CDK keeps it', () => {
    expect(
      new AssemblyReader()
        .getAllStacks(root, manifestWith('cn-north-1'))
        .map((s) => [s.stackName, s.region])
    ).toEqual([
      ['Good', 'us-east-1'],
      ['Other', 'cn-north-1'],
    ]);
    // A line terminator used to fall through to "no region" (the command's
    // fallback); it now yields the region CDK reads.
    expect(
      new AssemblyReader()
        .getAllStacks(root, manifestWith('eu-west-1\nus-west-2'))
        .map((s) => [s.stackName, s.region])
    ).toEqual([
      ['Good', 'us-east-1'],
      ['Other', 'eu-west-1'],
    ]);
  });

  it('refuses the WHOLE assembly, naming the offending stack', () => {
    expect(() => new AssemblyReader().getAllStacks(root, manifestWith('US-EAST-1'))).toThrow(
      /^Stack Other in the cloud assembly declares region US-EAST-1,/
    );
  });
});
