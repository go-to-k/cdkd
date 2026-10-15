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

  describe('AWS readback (drift --revert, go-to-k/cdkd#4921)', () => {
    // The read-back shape in miniature: both runtime features beside the one
    // that drifts.
    // Listed in a different order from the baseline: entries pair by Name.
    const LIVE_FEATURES = [
      { Name: 'RUNTIME_MONITORING', Status: 'ENABLED' },
      { Name: 'EKS_RUNTIME_MONITORING', Status: 'DISABLED' },
      { Name: 'RDS_LOGIN_EVENTS', Status: 'DISABLED' },
    ];
    const BASELINE_FEATURES = [
      { Name: 'RDS_LOGIN_EVENTS', Status: 'ENABLED' },
      { Name: 'EKS_RUNTIME_MONITORING', Status: 'DISABLED' },
      { Name: 'RUNTIME_MONITORING', Status: 'ENABLED' },
    ];
    const previous = { Enable: true, Features: LIVE_FEATURES, DataSources: DATA_SOURCES };

    it('removes both undrifted keys although the bag carries them', () => {
      expect(
        withGuardDutyDetectorReadBackOps(DETECTOR, [SCALAR], { ...previous }, { previous })
      ).toEqual([
        SCALAR,
        { op: 'remove', path: '/Features' },
        { op: 'remove', path: '/DataSources' },
      ]);
    });

    it('narrows a drifted Features op to the entries that differ, leaving the runtime pair out', () => {
      const patch: JsonPatchOp[] = [
        { op: 'replace', path: '/Features', value: BASELINE_FEATURES },
      ];
      expect(
        withGuardDutyDetectorReadBackOps(
          DETECTOR,
          patch,
          { ...previous, Features: BASELINE_FEATURES },
          { previous }
        )
      ).toEqual([
        { op: 'replace', path: '/Features', value: [{ Name: 'RDS_LOGIN_EVENTS', Status: 'ENABLED' }] },
        { op: 'remove', path: '/DataSources' },
      ]);
    });

    it('removes a drifted DataSources beside a drifted Features (a feature toggle drifts both)', () => {
      const patch: JsonPatchOp[] = [
        { op: 'replace', path: '/DataSources', value: { S3Logs: { Enable: true } } },
        { op: 'replace', path: '/Features', value: BASELINE_FEATURES },
      ];
      expect(
        withGuardDutyDetectorReadBackOps(
          DETECTOR,
          patch,
          { ...previous, Features: BASELINE_FEATURES },
          { previous }
        )
      ).toEqual([
        { op: 'remove', path: '/DataSources' },
        { op: 'replace', path: '/Features', value: [{ Name: 'RDS_LOGIN_EVENTS', Status: 'ENABLED' }] },
      ]);
    });

    it('keeps a drifted DataSources beside a remove /Features op', () => {
      const ds = { S3Logs: { Enable: true } };
      const patch: JsonPatchOp[] = [
        { op: 'replace', path: '/DataSources', value: ds },
        { op: 'remove', path: '/Features' },
      ];
      expect(
        withGuardDutyDetectorReadBackOps(DETECTOR, patch, { Enable: true, DataSources: ds }, { previous })
      ).toEqual([
        { op: 'replace', path: '/DataSources', value: ds },
        { op: 'remove', path: '/Features' },
      ]);
    });

    // go-to-k/cdkd#4935 M1: drift compares Features positionally, so these
    // are drift, yet no entry differs by Name and UpdateDetector cannot undo
    // them. Sending nothing would report a revert that changed nothing.
    it.each([
      ['reordered entries only', [...LIVE_FEATURES].reverse(), LIVE_FEATURES],
      [
        'an entry GuardDuty added that the baseline lacks',
        LIVE_FEATURES.slice(1),
        LIVE_FEATURES,
      ],
    ])('refuses a revert whose Features differ by %s', (_label, baseline, live) => {
      const patch: JsonPatchOp[] = [{ op: 'replace', path: '/Features', value: baseline }];
      expect(() =>
        withGuardDutyDetectorReadBackOps(
          DETECTOR,
          patch,
          { ...previous, Features: baseline },
          { previous: { ...previous, Features: live } }
        )
      ).toThrow(/cannot revert Features: .*only in the order of its entries or in entries GuardDuty added/);
    });

    it('sends a baseline entry the live list no longer has', () => {
      const gone = { Name: 'LAMBDA_NETWORK_LOGS', Status: 'ENABLED' };
      const baseline = [...LIVE_FEATURES, gone];
      const patch: JsonPatchOp[] = [{ op: 'replace', path: '/Features', value: baseline }];
      expect(
        withGuardDutyDetectorReadBackOps(
          DETECTOR,
          patch,
          { ...previous, Features: baseline },
          { previous }
        )
      ).toEqual([
        { op: 'replace', path: '/Features', value: [gone] },
        { op: 'remove', path: '/DataSources' },
      ]);
    });

    it('keeps an entry whose only difference is a nested AdditionalConfiguration status', () => {
      const withAddon = (status: string) => ({
        Name: 'RUNTIME_MONITORING',
        Status: 'ENABLED',
        AdditionalConfiguration: [{ Name: 'EKS_ADDON_MANAGEMENT', Status: status }],
      });
      const live = [withAddon('ENABLED'), LIVE_FEATURES[1]];
      const baseline = [withAddon('DISABLED'), LIVE_FEATURES[1]];
      const patch: JsonPatchOp[] = [{ op: 'replace', path: '/Features', value: baseline }];
      expect(
        withGuardDutyDetectorReadBackOps(
          DETECTOR,
          patch,
          { ...previous, Features: baseline },
          { previous: { ...previous, Features: live } }
        )
      ).toEqual([
        { op: 'replace', path: '/Features', value: [withAddon('DISABLED')] },
        { op: 'remove', path: '/DataSources' },
      ]);
    });

    it('sends no remove for an undrifted key the AWS-current bag lacks (RFC 6902 missing path)', () => {
      expect(
        withGuardDutyDetectorReadBackOps(
          DETECTOR,
          [SCALAR],
          { Enable: true, Features: LIVE_FEATURES },
          { previous: { Enable: true, Features: LIVE_FEATURES } }
        )
      ).toEqual([SCALAR, { op: 'remove', path: '/Features' }]);
    });

    it.each([
      ['an object with no Name', { Status: 'ENABLED' }],
      ['null', null],
      ['a non-string Name', { Name: 7, Status: 'ENABLED' }],
      ['a primitive', 'RDS_LOGIN_EVENTS'],
    ])('keeps a Features op as it was when an entry is %s', (_label, entry) => {
      // Beside an UNCHANGED named entry, so narrowing past the odd one would
      // drop it.
      const odd = [entry, LIVE_FEATURES[0]];
      const patch: JsonPatchOp[] = [{ op: 'replace', path: '/Features', value: odd }];
      expect(
        withGuardDutyDetectorReadBackOps(
          DETECTOR,
          patch,
          { ...previous, Features: odd },
          { previous }
        )
      ).toEqual([
        { op: 'replace', path: '/Features', value: odd },
        { op: 'remove', path: '/DataSources' },
      ]);
    });

    it('keeps a remove /Features op as it was (no list to narrow)', () => {
      const patch: JsonPatchOp[] = [{ op: 'remove', path: '/Features' }];
      expect(
        withGuardDutyDetectorReadBackOps(DETECTOR, patch, { Enable: true }, { previous })
      ).toEqual([
        { op: 'remove', path: '/Features' },
        { op: 'remove', path: '/DataSources' },
      ]);
    });

    it('keeps a Features op as it was when the AWS-current value is not a list', () => {
      const patch: JsonPatchOp[] = [{ op: 'replace', path: '/Features', value: BASELINE_FEATURES }];
      expect(
        withGuardDutyDetectorReadBackOps(
          DETECTOR,
          patch,
          { ...previous, Features: BASELINE_FEATURES },
          { previous: { ...previous, Features: 'not a list' } }
        )
      ).toEqual([
        { op: 'replace', path: '/Features', value: BASELINE_FEATURES },
        { op: 'remove', path: '/DataSources' },
      ]);
    });
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
