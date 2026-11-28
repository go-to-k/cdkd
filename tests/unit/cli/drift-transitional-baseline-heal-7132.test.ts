import { describe, it, expect } from 'vite-plus/test';
import { preFixBaselineUncomparedDriftKeys } from '../../../src/cli/commands/drift/baseline-keys.js';

/**
 * go-to-k/cdkd#7132: a deploy before #7132 read the observed baseline right
 * after `MonitorInstances` / `UnmonitorInstances`, the profile association,
 * `ModifyInstanceMetadataOptions` or `PutBackupPolicy`, while AWS still
 * answered the transitional value. A no-change deploy never re-reads, so
 * `cdkd drift` reported the stale baseline and `--revert` pushed it back.
 * The key is not compared while the live member is the declared one (what
 * CloudFormation compares); a live member that differs from the template, or
 * a member the template leaves out, stays compared. The live bags are spelled
 * as the providers' reads spell them.
 */

const EC2 = 'AWS::EC2::Instance';
const EFS = 'AWS::EFS::FileSystem';
const PROFILE_ARN = 'arn:aws:iam::123456789012:instance-profile/app-profile';
const OLD_PROFILE_ARN = 'arn:aws:iam::123456789012:instance-profile/old-profile';

const skipped = (
  type: string,
  observed: Record<string, unknown>,
  properties: Record<string, unknown>,
  aws: Record<string, unknown>
): string[] => preFixBaselineUncomparedDriftKeys(type, observed, properties, aws);

describe('EC2 Instance Monitoring (go-to-k/cdkd#7132)', () => {
  it.each([
    // baseline, template, live, expected
    [false, true, true, ['Monitoring']],
    [false, 'true', true, ['Monitoring']],
    [true, false, false, ['Monitoring']],
    [true, 'false', false, ['Monitoring']],
    // live differs from the template: an out-of-band toggle, still compared
    [true, true, false, []],
    [false, false, true, []],
    // template absent: never healed
    [false, 'absent', true, []],
    [true, 'absent', false, []],
  ] as const)('baseline %s, template %s, live %s -> %j', (recorded, declared, live, expected) => {
    const properties: Record<string, unknown> =
      declared === 'absent' ? { ImageId: 'ami-1' } : { ImageId: 'ami-1', Monitoring: declared };
    expect(
      skipped(EC2, { Monitoring: recorded }, properties, { Monitoring: live })
    ).toEqual(expected);
  });

  it('a live value that is not a boolean is no evidence', () => {
    expect(skipped(EC2, { Monitoring: false }, { Monitoring: true }, { Monitoring: 'true' })).toEqual(
      []
    );
    expect(skipped(EC2, { Monitoring: false }, { Monitoring: true }, {})).toEqual([]);
  });
});

describe('EC2 Instance IamInstanceProfile (go-to-k/cdkd#7132)', () => {
  it('skips a stale old-profile baseline while live is the declared profile (name or ARN)', () => {
    for (const declared of ['app-profile', PROFILE_ARN]) {
      expect(
        skipped(
          EC2,
          { IamInstanceProfile: OLD_PROFILE_ARN },
          { IamInstanceProfile: declared },
          { IamInstanceProfile: PROFILE_ARN }
        )
      ).toEqual(['IamInstanceProfile']);
    }
  });

  it('matches a declared name against the last segment of a path-qualified ARN', () => {
    expect(
      skipped(
        EC2,
        { IamInstanceProfile: OLD_PROFILE_ARN },
        { IamInstanceProfile: 'app-profile' },
        { IamInstanceProfile: 'arn:aws:iam::123456789012:instance-profile/team/app-profile' }
      )
    ).toEqual(['IamInstanceProfile']);
  });

  it('still reports a live profile other than the declared one', () => {
    expect(
      skipped(
        EC2,
        { IamInstanceProfile: PROFILE_ARN },
        { IamInstanceProfile: 'app-profile' },
        { IamInstanceProfile: OLD_PROFILE_ARN }
      )
    ).toEqual([]);
    // A name that is only a suffix of the live name is not the declared profile.
    expect(
      skipped(
        EC2,
        { IamInstanceProfile: OLD_PROFILE_ARN },
        { IamInstanceProfile: 'profile' },
        { IamInstanceProfile: PROFILE_ARN }
      )
    ).toEqual([]);
    // A path-qualified declared name, or a non-instance-profile ARN, is not matched loosely.
    expect(
      skipped(
        EC2,
        { IamInstanceProfile: OLD_PROFILE_ARN },
        { IamInstanceProfile: 'team/app-profile' },
        { IamInstanceProfile: 'arn:aws:iam::123456789012:instance-profile/team/app-profile' }
      )
    ).toEqual([]);
    expect(
      skipped(
        EC2,
        { IamInstanceProfile: OLD_PROFILE_ARN },
        { IamInstanceProfile: 'app-profile' },
        { IamInstanceProfile: 'arn:aws:iam::123456789012:role/app-profile' }
      )
    ).toEqual([]);
  });

  it('never heals an undeclared or empty profile', () => {
    expect(
      skipped(EC2, { IamInstanceProfile: OLD_PROFILE_ARN }, {}, { IamInstanceProfile: PROFILE_ARN })
    ).toEqual([]);
    expect(
      skipped(
        EC2,
        { IamInstanceProfile: OLD_PROFILE_ARN },
        { IamInstanceProfile: '' },
        { IamInstanceProfile: PROFILE_ARN }
      )
    ).toEqual([]);
  });
});

describe('EC2 Instance MetadataOptions (go-to-k/cdkd#7132)', () => {
  const live = {
    HttpTokens: 'required',
    HttpPutResponseHopLimit: 2,
    HttpEndpoint: 'enabled',
    HttpProtocolIpv6: 'disabled',
    InstanceMetadataTags: 'disabled',
  };
  const stale = { ...live, HttpTokens: 'optional', HttpPutResponseHopLimit: 1 };

  it('skips a baseline holding the pre-update values while live is the declared options', () => {
    expect(
      skipped(
        EC2,
        { MetadataOptions: stale },
        { MetadataOptions: { HttpTokens: 'required', HttpPutResponseHopLimit: '2' } },
        { MetadataOptions: live }
      )
    ).toEqual(['MetadataOptions']);
  });

  it('still reports a declared member that differs live', () => {
    expect(
      skipped(
        EC2,
        { MetadataOptions: stale },
        { MetadataOptions: { HttpTokens: 'required', HttpPutResponseHopLimit: 3 } },
        { MetadataOptions: live }
      )
    ).toEqual([]);
  });

  it('still reports an out-of-band change to a member the template leaves out', () => {
    expect(
      skipped(
        EC2,
        { MetadataOptions: stale },
        { MetadataOptions: { HttpTokens: 'required', HttpPutResponseHopLimit: 2 } },
        { MetadataOptions: { ...live, InstanceMetadataTags: 'enabled' } }
      )
    ).toEqual([]);
  });

  it('never heals undeclared or empty options, or a baseline without them', () => {
    expect(skipped(EC2, { MetadataOptions: stale }, {}, { MetadataOptions: live })).toEqual([]);
    expect(
      skipped(EC2, { MetadataOptions: stale }, { MetadataOptions: {} }, { MetadataOptions: live })
    ).toEqual([]);
    expect(
      skipped(EC2, {}, { MetadataOptions: { HttpTokens: 'required' } }, { MetadataOptions: live })
    ).toEqual([]);
  });
});

/** The EFS rule alone: `FileSystemPolicy` (also healed when absent on both sides) dropped. */
const skippedEfs = (
  observed: Record<string, unknown>,
  properties: Record<string, unknown>,
  aws: Record<string, unknown>
): string[] => skipped(EFS, observed, properties, aws).filter((key) => key !== 'FileSystemPolicy');

describe('EFS FileSystem BackupPolicy (go-to-k/cdkd#7132)', () => {
  it.each([
    ['ENABLING', 'ENABLED'],
    ['DISABLING', 'DISABLED'],
    ['DISABLED', 'ENABLED'],
  ])('skips a %s baseline while live is the declared %s', (recorded, declared) => {
    expect(
      skippedEfs(
        { BackupPolicy: { Status: recorded } },
        { BackupPolicy: { Status: declared } },
        { BackupPolicy: { Status: declared } }
      )
    ).toEqual(['BackupPolicy']);
  });

  it('still reports a live status other than the declared one', () => {
    expect(
      skippedEfs(
        { BackupPolicy: { Status: 'ENABLED' } },
        { BackupPolicy: { Status: 'ENABLED' } },
        { BackupPolicy: { Status: 'DISABLED' } }
      )
    ).toEqual([]);
    expect(
      skippedEfs(
        { BackupPolicy: { Status: 'ENABLING' } },
        { BackupPolicy: { Status: 'ENABLED' } },
        { BackupPolicy: { Status: 'DISABLING' } }
      )
    ).toEqual([]);
  });

  it('never heals an undeclared BackupPolicy', () => {
    expect(
      skippedEfs( { BackupPolicy: { Status: 'ENABLING' } }, {}, { BackupPolicy: { Status: 'ENABLED' } })
    ).toEqual([]);
  });

  it('keeps the FileSystemPolicy rule alongside it', () => {
    expect(
      skipped(
        EFS,
        { BackupPolicy: { Status: 'ENABLING' } },
        { BackupPolicy: { Status: 'ENABLED' } },
        { BackupPolicy: { Status: 'ENABLED' } }
      )
    ).toEqual(expect.arrayContaining(['BackupPolicy', 'FileSystemPolicy']));
  });
});
