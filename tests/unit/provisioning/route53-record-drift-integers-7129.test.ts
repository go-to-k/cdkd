/**
 * go-to-k/cdkd#7129: CDK synthesizes a Route 53 record's `TTL` as a string
 * (`"300"`) and the readback answers the number AWS holds. On a baseline taken
 * from the recorded `properties` (no `observedProperties`) drift reported
 * `TTL: 300 -> 300`. `canonicalizeDriftProperties` folds a record's integer
 * members to numbers on both sides, for `RecordSet` and each member of a
 * `RecordSetGroup`.
 */
import { describe, it, expect } from 'vite-plus/test';
import { Route53Provider } from '../../../src/provisioning/providers/route53-provider.js';
import { calculateResourceDrift } from '../../../src/analyzer/drift-calculator.js';

const RECORD = 'AWS::Route53::RecordSet';
const GROUP = 'AWS::Route53::RecordSetGroup';
const provider = new Route53Provider();
const canon = (type: string, bag: Record<string, unknown>) =>
  provider.canonicalizeDriftProperties(type, bag);

/** Drift between a recorded bag and a readback, both canonicalized as `cdkd drift` does. */
const drift = (type: string, recorded: Record<string, unknown>, live: Record<string, unknown>) =>
  calculateResourceDrift(canon(type, recorded), canon(type, live), { resourceType: type });

const CDK_RECORD = {
  HostedZoneId: 'Z1',
  Name: 'www.example.internal.',
  Type: 'CNAME',
  TTL: '300',
  ResourceRecords: ['example.com'],
};
const LIVE_RECORD = { ...CDK_RECORD, TTL: 300 };

describe('Route 53 record integer members compare as numbers (go-to-k/cdkd#7129)', () => {
  it('a RecordSet recorded with TTL "300" matches a readback of 300', () => {
    expect(drift(RECORD, CDK_RECORD, LIVE_RECORD)).toEqual([]);
  });

  it('a real TTL change still drifts', () => {
    const changes = drift(RECORD, CDK_RECORD, { ...LIVE_RECORD, TTL: 60 });
    expect(changes.map((c) => [c.path, c.stateValue, c.awsValue])).toEqual([
      ['TTL', 300, 60],
    ]);
  });

  it('folds Weight and GeoProximityLocation.Bias the same way', () => {
    const recorded = {
      ...CDK_RECORD,
      SetIdentifier: 'a',
      Weight: '90',
      GeoProximityLocation: { AWSRegion: 'us-east-1', Bias: '-5' },
    };
    const live = {
      ...LIVE_RECORD,
      SetIdentifier: 'a',
      Weight: 90,
      GeoProximityLocation: { AWSRegion: 'us-east-1', Bias: -5 },
    };
    expect(drift(RECORD, recorded, live)).toEqual([]);
    expect(canon(RECORD, recorded)).toEqual(live);
  });

  it('folds each RecordSetGroup member', () => {
    const recorded = { HostedZoneId: 'Z1', RecordSets: [CDK_RECORD, { ...CDK_RECORD, Name: 'b.' }] };
    const live = { HostedZoneId: 'Z1', RecordSets: [LIVE_RECORD, { ...LIVE_RECORD, Name: 'b.' }] };
    expect(drift(GROUP, recorded, live)).toEqual([]);
  });

  it('leaves anything that is not a decimal integer string alone, and returns the input by identity', () => {
    for (const ttl of ['***', '3e2', ' 300', '300.0', '', { Ref: 'Ttl' }]) {
      const bag = { ...CDK_RECORD, TTL: ttl };
      expect(canon(RECORD, bag)).toBe(bag);
    }
    expect(canon(RECORD, LIVE_RECORD)).toBe(LIVE_RECORD);
    const group = { RecordSets: [LIVE_RECORD] };
    expect(canon(GROUP, group)).toBe(group);
    const zone = { Name: 'example.internal.', TTL: '300' };
    expect(canon('AWS::Route53::HostedZone', zone)).toBe(zone);
  });

  it('does not mutate the bag it folds', () => {
    const bag = { ...CDK_RECORD, GeoProximityLocation: { Bias: '3' } };
    canon(RECORD, bag);
    expect(bag.TTL).toBe('300');
    expect(bag.GeoProximityLocation.Bias).toBe('3');
  });
});
