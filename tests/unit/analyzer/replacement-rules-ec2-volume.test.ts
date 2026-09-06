import { describe, it, expect } from 'vite-plus/test';
import { ReplacementRulesRegistry } from '../../../src/analyzer/replacement-rules.js';
import {
  STATEFUL_TYPES,
  isStatefulRecreateTargetForReplace,
} from '../../../src/provisioning/stateful-types.js';

/**
 * Regression coverage for issue #1356.
 *
 * The CFn registry schema for `AWS::EC2::Volume` declares NO
 * `createOnlyProperties` (live-verified 2026-08-03: `describe-type` returns
 * `createOnlyProperties: null`), so the `create-only-properties.ts` schema
 * fallback classified nothing and an immutable-property change was attempted
 * as an in-place UPDATE. AWS rejected the deploy ("Volume properties other
 * than AutoEnableIO, type, size, and IOPS cannot be updated") where
 * CloudFormation REPLACES the volume.
 *
 * The hand-authored registry rule is what closes the gap — and because a
 * volume replacement destroys the filesystem, the type also joins
 * `STATEFUL_TYPES` so the deploy engine's property-driven replacement guard
 * demands `--force-stateful-recreation`.
 */
const VOLUME = 'AWS::EC2::Volume';

describe('ReplacementRulesRegistry — AWS::EC2::Volume immutable properties (#1356)', () => {
  const registry = new ReplacementRulesRegistry();

  it.each([
    ['AvailabilityZone', 'us-east-1a', 'us-east-1b'],
    ['AvailabilityZoneId', 'use1-az1', 'use1-az2'],
    ['Encrypted', false, true],
    ['KmsKeyId', 'key-a', 'key-b'],
    ['OutpostArn', 'arn:aws:outposts:::outpost/op-a', 'arn:aws:outposts:::outpost/op-b'],
    ['SnapshotId', 'snap-aaa', 'snap-bbb'],
  ])('requires replacement when %s changes', (prop, oldValue, newValue) => {
    expect(registry.requiresReplacement(VOLUME, prop as string, oldValue, newValue)).toBe(true);
  });

  it.each([
    ['AutoEnableIO', false, true],
    ['Iops', 3000, 4000],
    ['Size', 1, 2],
    ['Throughput', 125, 250],
    ['VolumeType', 'gp2', 'gp3'],
    ['Tags', [], [{ Key: 'a', Value: 'b' }]],
  ])('does NOT require replacement when %s changes (in-place ModifyVolume)', (prop, a, b) => {
    expect(registry.requiresReplacement(VOLUME, prop as string, a, b)).toBe(false);
  });

  it('classifies both the immutable and the mutable set explicitly', () => {
    // `isClassified` gates the CFn-schema fallback in DiffCalculator. Pinning
    // it here is what guarantees the (empty) schema fallback can never
    // override the deliberate in-place classification above.
    for (const prop of [
      'AvailabilityZone',
      'AvailabilityZoneId',
      'Encrypted',
      'KmsKeyId',
      'OutpostArn',
      'SnapshotId',
      'AutoEnableIO',
      'Iops',
      'Size',
      'Throughput',
      'VolumeType',
      'Tags',
    ]) {
      expect(registry.isClassified(VOLUME, prop)).toBe(true);
    }
  });

  it('leaves the uncertain properties unclassified so the schema fallback still applies', () => {
    // Deliberately NOT guessed at — a wrong "replacement" classification here
    // would DELETE a data-bearing volume. Leaving them unclassified keeps
    // today's graceful degradation and lets the DescribeType fallback pick
    // them up if AWS ever populates `createOnlyProperties`.
    for (const prop of ['MultiAttachEnabled', 'SourceVolumeId', 'VolumeInitializationRate']) {
      expect(registry.isClassified(VOLUME, prop)).toBe(false);
    }
  });
});

describe('AWS::EC2::Volume stateful guard (#1356)', () => {
  it('is a stateful type — a replacement loses the volume data', () => {
    expect(STATEFUL_TYPES.has(VOLUME)).toBe(true);
  });

  it('requires --force-stateful-recreation on the mid-deploy replacement path', () => {
    expect(isStatefulRecreateTargetForReplace(VOLUME, { Size: 1 }, undefined)).toBe('always');
  });
});
