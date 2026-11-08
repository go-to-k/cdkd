import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vite-plus/test';
import {
  findActionableSdkUnwired,
  getPropertyCoverage,
} from '../../../src/provisioning/property-coverage.js';

// go-to-k/cdkd#6044: the remove-protection-compensation integ fixture puts its
// `CcInstance` (AWS::EC2::Instance) on the Cloud Control route by declaring a
// property the SDK provider leaves unwired, and its verify.sh fails the run
// when the instance lands anywhere else. #5630 wired the property it used to
// carry (`InstanceInitiatedShutdownBehavior`), and the precondition failure
// was found only by a live integ run. This pins the replacement, so the next
// routing change for it reds here instead.

const INSTANCE = 'AWS::EC2::Instance';
const FORCING_PROPERTY = 'ElasticGpuSpecifications';
const FIXTURE = new URL(
  '../../integration/remove-protection-compensation/lib/remove-protection-compensation-stack.ts',
  import.meta.url
);

/** The fixture's instance property bags as synthesized (`imageId` is an SSM parameter there). */
const sdkInstance = (): Record<string, unknown> => ({
  ImageId: 'ami-0123456789abcdef0',
  InstanceType: 't3.nano',
  SubnetId: 'subnet-0123456789abcdef0',
  DisableApiTermination: true,
  Tags: [{ Key: 'cdkd-integ', Value: 'rp-compensation' }],
});
const ccInstance = (): Record<string, unknown> => ({
  ...sdkInstance(),
  [FORCING_PROPERTY]: [],
});

/** The source text of one `new ec2.CfnInstance(this, '<id>', { ... })` call. */
function instanceBlock(source: string, logicalId: string): string {
  const start = source.indexOf(`new ec2.CfnInstance(this, '${logicalId}', {`);
  expect(start, `fixture declares ${logicalId}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('});', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('remove-protection-compensation CcInstance routes via Cloud Control (go-to-k/cdkd#6044)', () => {
  it(`${FORCING_PROPERTY} is SDK-unwired, not handled, for ${INSTANCE}`, () => {
    const coverage = getPropertyCoverage(INSTANCE);
    expect(coverage).toBeDefined();
    expect(coverage?.handled.has(FORCING_PROPERTY)).toBe(false);
    expect(coverage?.sdkUnwired.has(FORCING_PROPERTY)).toBe(true);
  });

  it('an empty list still drives the Cloud Control route (the rule keys on presence)', () => {
    expect(findActionableSdkUnwired(INSTANCE, ccInstance(), new Set()).map((d) => d.property)).toEqual(
      [FORCING_PROPERTY]
    );
  });

  it('the SdkInstance bag drives no Cloud Control route', () => {
    expect(findActionableSdkUnwired(INSTANCE, sdkInstance(), new Set())).toEqual([]);
  });

  it('the fixture declares the forcing property on CcInstance only', () => {
    const source = readFileSync(FIXTURE, 'utf8');
    expect(instanceBlock(source, 'CcInstance')).toContain('elasticGpuSpecifications: [],');
    expect(instanceBlock(source, 'SdkInstance')).not.toContain('elasticGpuSpecifications');
  });
});
