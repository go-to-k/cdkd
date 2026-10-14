import { describe, it, expect } from 'vite-plus/test';
import { withGuardDutyDetectorReadBackOps } from '../../../src/provisioning/guardduty-detector-patch.js';
import type { JsonPatchOp } from '../../../src/provisioning/json-patch-generator.js';

const DETECTOR = 'AWS::GuardDuty::Detector';
const FEATURES = [{ Name: 'RDS_LOGIN_EVENTS', Status: 'ENABLED' }];

describe('withGuardDutyDetectorReadBackOps (go-to-k/cdkd#4910)', () => {
  it('adds the desired Features and removes DataSources on a scalar-only patch', () => {
    const patch: JsonPatchOp[] = [
      { op: 'add', path: '/FindingPublishingFrequency', value: 'ONE_HOUR' },
    ];
    expect(
      withGuardDutyDetectorReadBackOps(DETECTOR, patch, {
        Enable: true,
        Features: FEATURES,
        FindingPublishingFrequency: 'ONE_HOUR',
      })
    ).toEqual([
      { op: 'add', path: '/FindingPublishingFrequency', value: 'ONE_HOUR' },
      { op: 'add', path: '/Features', value: FEATURES },
      { op: 'remove', path: '/DataSources' },
    ]);
  });

  it('keeps an existing /Features op and only removes DataSources', () => {
    const next = [...FEATURES, { Name: 'EKS_AUDIT_LOGS', Status: 'DISABLED' }];
    const patch: JsonPatchOp[] = [{ op: 'replace', path: '/Features', value: next }];
    expect(
      withGuardDutyDetectorReadBackOps(DETECTOR, patch, { Enable: true, Features: next })
    ).toEqual([
      { op: 'replace', path: '/Features', value: next },
      { op: 'remove', path: '/DataSources' },
    ]);
  });

  it('adds no /DataSources op when the patch already has one', () => {
    const patch: JsonPatchOp[] = [
      { op: 'remove', path: '/DataSources' },
      { op: 'replace', path: '/Features', value: FEATURES },
    ];
    expect(
      withGuardDutyDetectorReadBackOps(DETECTOR, patch, { Enable: true, Features: FEATURES })
    ).toBe(patch);
  });

  it('leaves the legacy shape (DataSources declared) unchanged', () => {
    const patch: JsonPatchOp[] = [{ op: 'replace', path: '/Enable', value: false }];
    const desired = {
      Enable: false,
      Features: FEATURES,
      DataSources: { S3Logs: { Enable: true } },
    };
    expect(withGuardDutyDetectorReadBackOps(DETECTOR, patch, desired)).toBe(patch);
  });

  it('leaves a detector that declares no Features list unchanged', () => {
    const patch: JsonPatchOp[] = [{ op: 'replace', path: '/Enable', value: false }];
    expect(withGuardDutyDetectorReadBackOps(DETECTOR, patch, { Enable: false })).toBe(patch);
    expect(
      withGuardDutyDetectorReadBackOps(DETECTOR, patch, { Enable: false, Features: {} })
    ).toBe(patch);
  });

  it('leaves an empty patch empty', () => {
    const patch: JsonPatchOp[] = [];
    expect(
      withGuardDutyDetectorReadBackOps(DETECTOR, patch, { Enable: true, Features: FEATURES })
    ).toBe(patch);
  });

  it('leaves another type unchanged even with the same property names', () => {
    const patch: JsonPatchOp[] = [{ op: 'replace', path: '/Enable', value: false }];
    expect(
      withGuardDutyDetectorReadBackOps('AWS::GuardDuty::Filter', patch, {
        Enable: false,
        Features: FEATURES,
      })
    ).toBe(patch);
  });
});
