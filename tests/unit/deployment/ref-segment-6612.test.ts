import { describe, it, expect } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
  cfnRefValueFromPhysicalId,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import { SECRET_MASK } from '../../../src/deployment/secret-redaction.js';

/**
 * Issue #6612 — compound-id types whose CloudFormation `Ref` is one segment of
 * cdkd's `|`-joined physical id (or a reshaped one), found by
 * `scripts/gen-ref-segment-coverage.ts`. Each physical id is the shape Cloud
 * Control records (the schema `primaryIdentifier` values joined in order), and
 * each expected value is what CloudFormation's `Ref` returned on a live stack
 * or, for a pre-registry type, what its docs page states.
 */
const CASES: ReadonlyArray<readonly [type: string, physicalId: string, ref: string]> = [
  // Measured.
  ['AWS::GuardDuty::Filter', '9063d99f24924cdda338bbfe09b3279e|cdkdprobe6612filter', 'cdkdprobe6612filter'],
  ['AWS::ElasticBeanstalk::ConfigurationTemplate', 'my-app|my-app-EbTemplate-NY6CkAL7pbQh', 'my-app-EbTemplate-NY6CkAL7pbQh'],
  [
    'AWS::EC2::TransitGatewayRouteTablePropagation',
    'tgw-rtb-03cae82bcb4e0bf90|tgw-attach-063324fd3d0c43b14',
    'tgw-attach-063324fd3d0c43b14_tgw-rtb-03cae82bcb4e0bf90',
  ],
  [
    'AWS::ApplicationAutoScaling::ScalingPolicy',
    'arn:aws:autoscaling:us-east-1:123456789012:scalingPolicy:9c52e4e5-a0f8-4b33-b440-d1921ed5fd74:resource/dynamodb/table/T:policyName/p|dynamodb:table:ReadCapacityUnits',
    'arn:aws:autoscaling:us-east-1:123456789012:scalingPolicy:9c52e4e5-a0f8-4b33-b440-d1921ed5fd74:resource/dynamodb/table/T:policyName/p',
  ],
  // A policy name may contain `|`; the dimension may not.
  [
    'AWS::ApplicationAutoScaling::ScalingPolicy',
    'arn:aws:autoscaling:us-east-1:123456789012:scalingPolicy:x:resource/dynamodb/table/T:policyName/a|b|dynamodb:table:ReadCapacityUnits',
    'arn:aws:autoscaling:us-east-1:123456789012:scalingPolicy:x:resource/dynamodb/table/T:policyName/a|b',
  ],
  ['AWS::ElasticBeanstalk::ApplicationVersion', 'cdkd-probe-6612-ebv|cdkd-probe-6612-d-ebversion-bs6qxcpsxvgp', 'cdkd-probe-6612-d-ebversion-bs6qxcpsxvgp'],
  ['AWS::SES::ReceiptRule', 'cdkd-probe-6612-rule|cdkd-probe-6612-rs', 'cdkd-probe-6612-rule'],
  ['AWS::AutoScaling::LifecycleHook', 'my-asg|cdkd-probe-6612-hook', 'cdkd-probe-6612-hook'],
  // An ASG name may contain `|`; a hook name may not.
  ['AWS::AutoScaling::LifecycleHook', 'a|b|my-hook', 'my-hook'],
  ['AWS::ServiceDiscovery::Instance', 'srv-mzikbcsxh7rw2mxt|cdkd-probe-6612-inst', 'cdkd-probe-6612-inst'],
  ['AWS::AutoScaling::ScheduledAction', 'cdkd-p-Sched-AKCQ2M5LGOKV|my-asg', 'cdkd-p-Sched-AKCQ2M5LGOKV'],
  // Docs-verified, pre-registry types (not measured: a second account / an EMR
  // cluster); IPSet and ThreatIntelSet measured.
  ['AWS::GuardDuty::Master', '9063d99f24924cdda338bbfe09b3279e|111122223333', '111122223333'],
  ['AWS::GuardDuty::Member', '9063d99f24924cdda338bbfe09b3279e|444455556666', '444455556666'],
  ['AWS::GuardDuty::IPSet', '0eb2c1f8f1b14a0b8f2c0c1d2e3f4a5b|9063d99f24924cdda338bbfe09b3279e', '0eb2c1f8f1b14a0b8f2c0c1d2e3f4a5b'],
  ['AWS::GuardDuty::ThreatIntelSet', '1eb2c1f8f1b14a0b8f2c0c1d2e3f4a5b|9063d99f24924cdda338bbfe09b3279e', '1eb2c1f8f1b14a0b8f2c0c1d2e3f4a5b'],
  ['AWS::EMR::InstanceFleetConfig', 'j-2AXXXXXXGAPLF|if-1A2B3C4D5E6F', 'if-1A2B3C4D5E6F'],
  ['AWS::EMR::InstanceGroupConfig', 'ig-1A2B3C4D5E6F|j-2AXXXXXXGAPLF', 'ig-1A2B3C4D5E6F'],
  ['AWS::Glue::Connection', '123456789012|my-connection', 'my-connection'],
  // A connection name may contain `|`; the 12-digit catalog id cannot.
  ['AWS::Glue::Connection', '123456789012|a|b', 'a|b'],
];

describe('Ref of a compound-id type returns its CloudFormation value (issue #6612)', () => {
  it.each(CASES)('%s: %s -> %s', (type, physicalId, ref) => {
    expect(cfnRefValueFromPhysicalId(type, physicalId)).toBe(ref);
  });

  it.each(CASES)('%s through the resolver (Ref)', async (type, physicalId, ref) => {
    const resolver = new IntrinsicFunctionResolver();
    const context: ResolverContext = {
      template: { Resources: { R: { Type: type, Properties: {} } } },
      resources: { R: { physicalId, resourceType: type, properties: {}, attributes: {}, dependencies: [] } },
    };
    expect(await resolver.resolve({ Ref: 'R' }, context)).toBe(ref);
  });

  // The SDK route stores a bare id (no `|`), which must pass through untouched.
  it.each([
    ['AWS::EMR::InstanceFleetConfig', 'if-1A2B3C4D5E6F'],
    ['AWS::EMR::InstanceGroupConfig', 'ig-1A2B3C4D5E6F'],
    ['AWS::Glue::Connection', 'my-connection'],
    // A bare SDK name carrying `|` keeps it: only a catalog-id prefix is cut.
    ['AWS::Glue::Connection', 'a|b'],
  ])('%s keeps a pipe-free / SDK physical id %s as is', (type, physicalId) => {
    expect(cfnRefValueFromPhysicalId(type, physicalId)).toBe(physicalId);
  });

  it('anchors a ScheduledAction name containing `|` on the recorded AutoScalingGroupName', () => {
    const t = 'AWS::AutoScaling::ScheduledAction';
    const lookup = (group: string) => (keys: readonly string[]) =>
      keys.includes('AutoScalingGroupName') ? group : undefined;
    expect(cfnRefValueFromPhysicalId(t, 'a|b|my-asg', lookup('my-asg'))).toBe('a|b');
    expect(cfnRefValueFromPhysicalId(t, 'act|x|y', lookup('x|y'))).toBe('act');
    // No anchor (or one the id does not end with): before the first `|`.
    expect(cfnRefValueFromPhysicalId(t, 'act|x|y')).toBe('act');
    expect(cfnRefValueFromPhysicalId(t, 'act|x|y', lookup('other'))).toBe('act');
    expect(cfnRefValueFromPhysicalId(t, 'act')).toBe('act');
  });

  it('reads no state for a two-segment ScheduledAction or Elastic Beanstalk id (a masked anchor cannot refuse it)', () => {
    const lookup = () => {
      throw new Error('state must not be read for an unambiguous id');
    };
    expect(cfnRefValueFromPhysicalId('AWS::AutoScaling::ScheduledAction', 'act|asg', lookup)).toBe('act');
    expect(cfnRefValueFromPhysicalId('AWS::ElasticBeanstalk::ConfigurationTemplate', 'app|tpl', lookup)).toBe('tpl');
  });

  it('anchors an Elastic Beanstalk child name containing `|` on the recorded ApplicationName', () => {
    const lookup = (app: string) => (keys: readonly string[]) =>
      keys.includes('ApplicationName') ? app : undefined;
    for (const t of ['AWS::ElasticBeanstalk::ConfigurationTemplate', 'AWS::ElasticBeanstalk::ApplicationVersion']) {
      expect(cfnRefValueFromPhysicalId(t, 'my|app|v1', lookup('my|app'))).toBe('v1');
      expect(cfnRefValueFromPhysicalId(t, 'app|v|1', lookup('app'))).toBe('v|1');
      // No anchor: after the first `|`.
      expect(cfnRefValueFromPhysicalId(t, 'app|v|1')).toBe('v|1');
      expect(cfnRefValueFromPhysicalId(t, 'v1')).toBe('v1');
    }
  });

  it('serves a masked anchor as the mask for an ambiguous id, never a guess (as for a Glue table)', () => {
    const masked = (keys: readonly string[]) =>
      keys.includes('AutoScalingGroupName') || keys.includes('ApplicationName') ? SECRET_MASK : undefined;
    expect(cfnRefValueFromPhysicalId('AWS::AutoScaling::ScheduledAction', 'a|b|asg', masked)).toBe(SECRET_MASK);
    expect(cfnRefValueFromPhysicalId('AWS::ElasticBeanstalk::ApplicationVersion', 'app|v|1', masked)).toBe(SECRET_MASK);
    // A two-segment id reads nothing, so the mask never enters.
    expect(cfnRefValueFromPhysicalId('AWS::AutoScaling::ScheduledAction', 'act|asg', masked)).toBe('act');
  });

  it('leaves a propagation id that is not the Cloud Control shape alone', () => {
    const t = 'AWS::EC2::TransitGatewayRouteTablePropagation';
    expect(cfnRefValueFromPhysicalId(t, 'tgw-attach-0a_tgw-rtb-0b')).toBe('tgw-attach-0a_tgw-rtb-0b');
    expect(cfnRefValueFromPhysicalId(t, 'tgw-attach-0a|tgw-rtb-0b')).toBe('tgw-attach-0a|tgw-rtb-0b');
  });
});
