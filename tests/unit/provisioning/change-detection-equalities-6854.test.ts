/**
 * go-to-k/cdkd#6854 (lane B): the boundary of each provider change-detection
 * equality the #6859 review found uncovered, a positive and a NEGATIVE pair
 * each. The AWS evidence per rule is in
 * `docs/design/6854-b-db-compute-normalization-rules.md` ("Change detection").
 */
import { describe, it, expect, vi } from 'vite-plus/test';

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ lambdaCore: { send: vi.fn() }, lambda: { send: vi.fn() } }),
}));

import { sameKmsKey } from '../../../src/provisioning/providers/docdb/shared.js';
import { sameCreateOnlySent } from '../../../src/provisioning/providers/ec2/common.js';
import {
  instanceProfileKey,
  sameInstanceCreateOnlySent,
  sameStringSet,
} from '../../../src/provisioning/providers/ec2/instance-support.js';
import { changedCreateTimeKeys } from '../../../src/provisioning/providers/rds/instance-restore.js';
import { sameDbIdentifier } from '../../../src/provisioning/providers/rds/express-writer.js';
import { sameWeights } from '../../../src/provisioning/providers/lambda-web-function-endpoint-provider.js';

describe('DocumentDB KMS key (docdb/shared.ts sameKmsKey)', () => {
  const id = '1234abcd-12ab-34cd-56ef-1234567890ab';
  it('equates a key ARN with its bare id, and an alias ARN with its alias name', () => {
    expect(sameKmsKey(`arn:aws:kms:us-east-1:111111111111:key/${id}`, id)).toBe(true);
    expect(sameKmsKey('arn:aws:kms:us-east-1:111111111111:alias/app', 'alias/app')).toBe(true);
  });
  it('keeps another key, an alias against a key id, and an absent side apart', () => {
    expect(sameKmsKey(id, '5678abcd-12ab-34cd-56ef-1234567890ab')).toBe(false);
    expect(sameKmsKey('alias/app', id)).toBe(false);
    expect(sameKmsKey('alias/app', 'alias/other')).toBe(false);
    expect(sameKmsKey(id, undefined)).toBe(false);
  });
});

describe('EC2 create-only inputs (ec2/common.ts sameCreateOnlySent, instance-support.ts)', () => {
  it('equates the CloudFormation string spellings the create sends as one value', () => {
    expect(sameCreateOnlySent('Ipv4NetmaskLength', '28', 28)).toBe(true);
    expect(sameCreateOnlySent('CpuOptions', { CoreCount: '2' }, { CoreCount: 2 })).toBe(true);
    expect(sameCreateOnlySent('HibernationOptions', { Configured: 'true' }, { Configured: true })).toBe(true);
    expect(sameCreateOnlySent('LaunchTemplate', { LaunchTemplateId: 'lt-1', Version: 3 }, { LaunchTemplateId: 'lt-1', Version: '3' })).toBe(true);
    expect(sameInstanceCreateOnlySent('EnclaveOptions', { Enabled: 'true' }, { Enabled: true })).toBe(true);
  });
  it('keeps another value, a non-coercible spelling and another key apart', () => {
    expect(sameCreateOnlySent('Ipv4NetmaskLength', '27', 28)).toBe(false);
    expect(sameCreateOnlySent('CpuOptions', { CoreCount: '2' }, { CoreCount: 4 })).toBe(false);
    expect(sameCreateOnlySent('HibernationOptions', { Configured: 'yes' }, { Configured: true })).toBe(false);
    expect(sameCreateOnlySent('LaunchTemplate', { LaunchTemplateId: 'lt-1', Version: 3 }, { LaunchTemplateId: 'lt-1', Version: '$Latest' })).toBe(false);
    expect(sameCreateOnlySent('VpcId', 'vpc-1', 'VPC-1')).toBe(false);
    expect(sameInstanceCreateOnlySent('EnclaveOptions', { Enabled: 'false' }, { Enabled: true })).toBe(false);
  });
});

describe('EC2 instance security groups (instance-support.ts sameStringSet)', () => {
  it('equates another order and a repeated id', () => {
    expect(sameStringSet(['sg-1', 'sg-2'], ['sg-2', 'sg-1'])).toBe(true);
    expect(sameStringSet(['sg-1', 'sg-1'], ['sg-1'])).toBe(true);
  });
  it('keeps another member, a missing member and a non-list apart', () => {
    expect(sameStringSet(['sg-1', 'sg-2'], ['sg-1', 'sg-3'])).toBe(false);
    expect(sameStringSet(['sg-1', 'sg-2'], ['sg-1'])).toBe(false);
    expect(sameStringSet(['sg-1'], 'sg-1')).toBe(false);
  });
});

describe('EC2 instance profile (instance-support.ts instanceProfileKey)', () => {
  it('equates a name with its ARN (with or without a path)', () => {
    expect(instanceProfileKey('arn:aws:iam::111111111111:instance-profile/app')).toBe(instanceProfileKey('app'));
    expect(instanceProfileKey('arn:aws:iam::111111111111:instance-profile/team/app')).toBe('app');
  });
  it('keeps another profile apart', () => {
    expect(instanceProfileKey('arn:aws:iam::111111111111:instance-profile/app')).not.toBe(instanceProfileKey('App'));
    expect(instanceProfileKey('other')).not.toBe(instanceProfileKey('app'));
  });
});

describe('RDS restore inputs (rds/instance-restore.ts sameCreateTimeValue)', () => {
  const changed = (key: string, desired: unknown, recorded: unknown): string[] =>
    changedCreateTimeKeys([key], { [key]: desired }, { [key]: recorded });
  it('equates only a boolean spelling of UseLatestRestorableTime', () => {
    expect(changed('UseLatestRestorableTime', 'true', true)).toEqual([]);
    expect(changed('DBSnapshotIdentifier', 'snap-1', 'snap-1')).toEqual([]);
  });
  it('keeps another value and an identifier in another case apart', () => {
    expect(changed('DBSnapshotIdentifier', 'snap-2', 'snap-1')).toEqual(['DBSnapshotIdentifier']);
    expect(changed('DBSnapshotIdentifier', 'Snap-1', 'snap-1')).toEqual(['DBSnapshotIdentifier']);
    expect(changed('UseLatestRestorableTime', true, false)).toEqual(['UseLatestRestorableTime']);
  });
});

describe('RDS express writer identifier (rds/express-writer.ts sameDbIdentifier)', () => {
  it('equates an identifier in another case (RDS stores it lower-cased)', () => {
    expect(sameDbIdentifier('mycluster', 'MyCluster')).toBe(true);
  });
  it('keeps another identifier and an absent one apart', () => {
    expect(sameDbIdentifier('mycluster-2', 'MyCluster')).toBe(false);
    expect(sameDbIdentifier(undefined, 'MyCluster')).toBe(false);
  });
});

describe('Lambda web function endpoint weights (sameWeights)', () => {
  const w = (revisionId: string, weight: number) => ({ revisionId, weight });
  it('equates another order', () => {
    expect(sameWeights([w('r1', 90), w('r2', 10)], [w('r2', 10), w('r1', 90)])).toBe(true);
  });
  it('keeps another weight, another revision, a missing entry and an absent live list apart', () => {
    expect(sameWeights([w('r1', 90), w('r2', 10)], [w('r1', 80), w('r2', 20)])).toBe(false);
    expect(sameWeights([w('r1', 100)], [w('r3', 100)])).toBe(false);
    expect(sameWeights([w('r1', 90), w('r2', 10)], [w('r1', 90)])).toBe(false);
    expect(sameWeights([w('r1', 100)], undefined)).toBe(false);
    // A repeated entry is not a different one's stand-in.
    expect(sameWeights([w('r1', 50), w('r2', 50)], [w('r1', 50), w('r1', 50)])).toBe(false);
  });
});
