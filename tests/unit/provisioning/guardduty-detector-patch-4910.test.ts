import { describe, it, expect } from 'vite-plus/test';
import { withGuardDutyDetectorReadBackOps } from '../../../src/provisioning/guardduty-detector-patch.js';
import type { JsonPatchOp } from '../../../src/provisioning/json-patch-generator.js';

const DETECTOR = 'AWS::GuardDuty::Detector';
const FEATURES = [{ Name: 'RDS_LOGIN_EVENTS', Status: 'ENABLED' }];
const DATA_SOURCES = { S3Logs: { Enable: false } };
const SCALAR: JsonPatchOp = { op: 'add', path: '/FindingPublishingFrequency', value: 'ONE_HOUR' };

describe('withGuardDutyDetectorReadBackOps (go-to-k/cdkd#4910)', () => {
  it('Features shape: adds the desired Features and removes DataSources', () => {
    expect(
      withGuardDutyDetectorReadBackOps(DETECTOR, [SCALAR], { Enable: true, Features: FEATURES })
    ).toEqual([
      SCALAR,
      { op: 'add', path: '/Features', value: FEATURES },
      { op: 'remove', path: '/DataSources' },
    ]);
  });

  it('DataSources shape: removes Features and adds the desired DataSources', () => {
    expect(
      withGuardDutyDetectorReadBackOps(DETECTOR, [SCALAR], {
        Enable: true,
        DataSources: DATA_SOURCES,
      })
    ).toEqual([
      SCALAR,
      { op: 'remove', path: '/Features' },
      { op: 'add', path: '/DataSources', value: DATA_SOURCES },
    ]);
  });

  it('neither declared: removes both', () => {
    expect(withGuardDutyDetectorReadBackOps(DETECTOR, [SCALAR], { Enable: true })).toEqual([
      SCALAR,
      { op: 'remove', path: '/Features' },
      { op: 'remove', path: '/DataSources' },
    ]);
  });

  it('both declared: adds both, as a CloudFormation update would send them', () => {
    expect(
      withGuardDutyDetectorReadBackOps(DETECTOR, [SCALAR], {
        Enable: true,
        Features: FEATURES,
        DataSources: DATA_SOURCES,
      })
    ).toEqual([
      SCALAR,
      { op: 'add', path: '/Features', value: FEATURES },
      { op: 'add', path: '/DataSources', value: DATA_SOURCES },
    ]);
  });

  it('keeps an existing /Features op and only fixes DataSources', () => {
    const next = [...FEATURES, { Name: 'EKS_AUDIT_LOGS', Status: 'DISABLED' }];
    const patch: JsonPatchOp[] = [{ op: 'replace', path: '/Features', value: next }];
    expect(
      withGuardDutyDetectorReadBackOps(DETECTOR, patch, { Enable: true, Features: next })
    ).toEqual([
      { op: 'replace', path: '/Features', value: next },
      { op: 'remove', path: '/DataSources' },
    ]);
  });

  it('keeps an existing /DataSources op and only fixes Features', () => {
    const patch: JsonPatchOp[] = [{ op: 'replace', path: '/DataSources', value: DATA_SOURCES }];
    expect(
      withGuardDutyDetectorReadBackOps(DETECTOR, patch, {
        Enable: true,
        DataSources: DATA_SOURCES,
      })
    ).toEqual([
      { op: 'replace', path: '/DataSources', value: DATA_SOURCES },
      { op: 'remove', path: '/Features' },
    ]);
  });

  it('returns the same array when the patch already has ops on both keys', () => {
    const patch: JsonPatchOp[] = [
      { op: 'remove', path: '/DataSources' },
      { op: 'replace', path: '/Features', value: FEATURES },
    ];
    expect(
      withGuardDutyDetectorReadBackOps(DETECTOR, patch, { Enable: true, Features: FEATURES })
    ).toBe(patch);
  });

  it('leaves an empty patch empty', () => {
    const patch: JsonPatchOp[] = [];
    expect(
      withGuardDutyDetectorReadBackOps(DETECTOR, patch, { Enable: true, Features: FEATURES })
    ).toBe(patch);
  });

  it('leaves another type unchanged even with the same property names', () => {
    const patch: JsonPatchOp[] = [SCALAR];
    expect(
      withGuardDutyDetectorReadBackOps('AWS::GuardDuty::Filter', patch, {
        Features: FEATURES,
      })
    ).toBe(patch);
  });
});
