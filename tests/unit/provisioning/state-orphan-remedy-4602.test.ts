import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * go-to-k/cdkd#4602: a provider delete-path skip names the whole-stack
 * `cdkd state orphan <stack>` only on a STACK DESTROY (`DeleteContext.stackDestroy`),
 * where the stack's other records are already gone; every other delete names
 * the single-record `--resource <logicalId>` form. One case per site and phase
 * for the sites whose context this issue threaded; the parent-qualified arms
 * are in `provider-delete-skip-outcome.test.ts`, the secret-rotation arms in
 * `secret-principal-delete-4150.test.ts`.
 */

const warnSpy = vi.hoisted(() => vi.fn());
const send = vi.hoisted(() => vi.fn());
const stubClient = vi.hoisted(
  () => () => ({ send, config: { region: () => Promise.resolve('us-east-1') } })
);

vi.mock('@aws-sdk/client-lambda', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@aws-sdk/client-lambda');
  return { ...actual, LambdaClient: vi.fn().mockImplementation(stubClient) };
});
vi.mock('@aws-sdk/client-iam', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@aws-sdk/client-iam');
  return { ...actual, IAMClient: vi.fn().mockImplementation(stubClient) };
});
vi.mock('@aws-sdk/client-ec2', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@aws-sdk/client-ec2');
  return { ...actual, EC2Client: vi.fn().mockImplementation(stubClient) };
});
vi.mock('@aws-sdk/client-cloudwatch', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@aws-sdk/client-cloudwatch');
  return { ...actual, CloudWatchClient: vi.fn().mockImplementation(stubClient) };
});

vi.mock('../../../src/utils/logger.js', () => {
  const child = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => child,
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import { stateOrphanRecordRemedy } from '../../../src/provisioning/state-orphan-remedy.js';
import { redactedDeleteAddressSkip } from '../../../src/provisioning/redacted-delete-address.js';
import {
  compositeIdFormatMessage,
  type CompositeIdFormat,
} from '../../../src/provisioning/composite-id.js';
import { LambdaPermissionProvider } from '../../../src/provisioning/providers/lambda-permission-provider.js';
import { IAMPolicyProvider } from '../../../src/provisioning/providers/iam-policy-provider.js';
import { IAMUserGroupProvider } from '../../../src/provisioning/providers/iam-user-group-provider.js';
import { CloudWatchAnomalyDetectorProvider } from '../../../src/provisioning/providers/cloudwatch-anomaly-detector-provider.js';
import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';
import type { DeleteContext } from '../../../src/provisioning/region-check.js';

const DESTROY: DeleteContext = { expectedRegion: 'us-east-1', stackDestroy: true };
const DEPLOY: DeleteContext = { expectedRegion: 'us-east-1' };

/** The whole-stack remedy a stack destroy names. */
const wholeStack = (id: string): string =>
  "'cdkd state orphan <stack> --stack-region <region>', which drops every record the stack " +
  `still has in that region, not just this one (add '--resource ${id}' to drop only this one)`;
/** The single-record remedy every other delete names. */
const single = (id: string): string =>
  `'cdkd state orphan <stack> --stack-region <region> --resource ${id}', which drops only this record`;
const BARE = "'cdkd state orphan <stack> --stack-region <region>',";

const warnText = (): string => warnSpy.mock.calls.map((c) => String(c[0])).join('\n');

beforeEach(() => {
  warnSpy.mockReset();
  send.mockReset();
  send.mockResolvedValue({});
});

describe('stateOrphanRecordRemedy', () => {
  it('names the whole-stack form only on a stack destroy, with the --resource alternative', () => {
    expect(stateOrphanRecordRemedy(DESTROY, 'MyRes')).toBe(wholeStack('MyRes'));
  });

  it.each([
    ['a deploy-side context', DEPLOY],
    ['no context at all', undefined],
    ['stackDestroy: false', { stackDestroy: false }],
  ])('names the single-record form for %s, and warns off the bare form', (_what, context) => {
    const text = stateOrphanRecordRemedy(context, 'MyRes');
    expect(text).toContain(single('MyRes'));
    expect(text).toContain('never run it without --resource on a stack that is still deployed');
    // One sentence: several callers place it inside a parenthesis.
    expect(text).not.toMatch(/\.\s/);
    expect(text).not.toContain(BARE);
  });

  it('keeps a placeholder for a logical id that is not a plain identifier', () => {
    expect(stateOrphanRecordRemedy(DEPLOY, '-rf $(x)')).toContain('--resource <logicalId>');
    expect(stateOrphanRecordRemedy(DEPLOY, '-rf $(x)')).not.toContain('$(x)');
    expect(stateOrphanRecordRemedy(DESTROY, 'a b')).toContain("add '--resource <logicalId>'");
  });
});

describe('redactedDeleteAddressSkip', () => {
  it('names the drop for the phase its context carries', () => {
    redactedDeleteAddressSkip({ warn: warnSpy }, 'MyStage', 'Stage', ['RestApiId'], DESTROY);
    expect(warnText()).toContain(`then drop the record with ${wholeStack('MyStage')}`);
    warnSpy.mockReset();
    redactedDeleteAddressSkip({ warn: warnSpy }, 'MyStage', 'Stage', ['RestApiId'], DEPLOY);
    expect(warnText()).toContain(`then drop the record with ${single('MyStage')}`);
    expect(warnText()).not.toContain(BARE);
  });
});

describe('compositeIdFormatMessage', () => {
  const FORMAT: CompositeIdFormat = {
    label: 'Glue Table',
    segments: ['databaseName', 'tableName'],
  } as unknown as CompositeIdFormat;

  it('names the drop for the phase its context carries', () => {
    expect(
      compositeIdFormatMessage(FORMAT, 'MyTable', 'oops', { skipping: true, context: DESTROY })
    ).toContain(`drop the record with ${wholeStack('MyTable')}`);
    const deploy = compositeIdFormatMessage(FORMAT, 'MyTable', 'oops', {
      skipping: true,
      context: DEPLOY,
    });
    expect(deploy).toContain(`drop the record with ${single('MyTable')}`);
    expect(deploy).not.toContain(BARE);
  });
});

describe('the providers thread their DeleteContext into the shared skips', () => {
  it.each([
    ['a stack destroy', DESTROY, wholeStack],
    ['a deploy', DEPLOY, single],
  ])('AWS::Lambda::Permission redacted FunctionName on %s', async (_what, context, expected) => {
    await new LambdaPermissionProvider().delete(
      'MyPerm',
      'AllowInvoke',
      'AWS::Lambda::Permission',
      { FunctionName: '***' },
      context
    );
    expect(send).not.toHaveBeenCalled();
    expect(warnText()).toContain(expected('MyPerm'));
  });

  it.each([
    ['a stack destroy', DESTROY, wholeStack],
    ['a deploy', DEPLOY, single],
  ])('AWS::IAM::Policy redacted PolicyName on %s', async (_what, context, expected) => {
    // `:r`: the physicalId names no policy, so the redacted fallback is all there is.
    await new IAMPolicyProvider().delete(
      'MyPolicy',
      ':r',
      'AWS::IAM::Policy',
      { PolicyName: '***', Roles: ['r'] },
      context
    );
    expect(send).not.toHaveBeenCalled();
    expect(warnText()).toContain(expected('MyPolicy'));
  });

  it.each([
    ['a stack destroy', DESTROY, wholeStack],
    ['a deploy', DEPLOY, single],
  ])('AWS::IAM::Policy secret-derived principal list on %s', async (_what, context, expected) => {
    await new IAMPolicyProvider().delete(
      'MyPolicy',
      'MyPolicy',
      'AWS::IAM::Policy',
      { PolicyName: 'MyPolicy', Roles: ['***'] },
      context
    );
    expect(send).not.toHaveBeenCalled();
    expect(warnText()).toContain(`then drop this record with ${expected('MyPolicy')}`);
  });

  it.each([
    ['a stack destroy', DESTROY, wholeStack],
    ['a deploy', DEPLOY, single],
  ])('AWS::IAM::UserToGroupAddition redacted GroupName on %s', async (_what, context, expected) => {
    await new IAMUserGroupProvider().delete(
      'MyAddition',
      'MyAddition',
      'AWS::IAM::UserToGroupAddition',
      { GroupName: '***', Users: ['u'] },
      context
    );
    expect(send).not.toHaveBeenCalled();
    expect(warnText()).toContain(expected('MyAddition'));
  });

  it.each([
    ['a stack destroy', DESTROY, wholeStack],
    ['a deploy', DEPLOY, single],
  ])('AWS::CloudWatch::AnomalyDetector with no properties on %s', async (_what, context, expected) => {
    const error = await new CloudWatchAnomalyDetectorProvider()
      .delete('Detector', 'pid', 'AWS::CloudWatch::AnomalyDetector', undefined, context)
      .then(
        () => undefined,
        (e: unknown) => e as Error
      );
    expect(error?.message).toContain(`drop the record with ${expected('Detector')}`);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ['a stack destroy', DESTROY, wholeStack],
    ['a deploy', DEPLOY, single],
  ])('AWS::CloudWatch::AnomalyDetector redacted descriptor on %s', async (_what, context, expected) => {
    await new CloudWatchAnomalyDetectorProvider().delete(
      'Detector',
      'pid',
      'AWS::CloudWatch::AnomalyDetector',
      { Namespace: '***', MetricName: 'Errors', Stat: 'Sum' },
      context
    );
    expect(send).not.toHaveBeenCalled();
    expect(warnText()).toContain(expected('Detector'));
  });

  it.each([
    ['a stack destroy', DESTROY, wholeStack],
    ['a deploy', DEPLOY, single],
  ])('AWS::EC2::NetworkAclEntry malformed composite id on %s', async (_what, context, expected) => {
    await new EC2Provider().delete(
      'MyEntry',
      'acl-123',
      'AWS::EC2::NetworkAclEntry',
      undefined,
      context
    );
    expect(send).not.toHaveBeenCalled();
    expect(warnText()).toContain(`drop the record with ${expected('MyEntry')}`);
  });

  const INGRESS = {
    GroupId: 'sg-1',
    IpProtocol: 'tcp',
    FromPort: 80,
    ToPort: 80,
    CidrIp: '***',
  };

  it.each([
    ['a stack destroy', DESTROY, wholeStack],
    ['a deploy', DEPLOY, single],
  ])('AWS::EC2::SecurityGroupIngress redacted permission on %s', async (_what, context, expected) => {
    await new EC2Provider().delete(
      'MyIngress',
      'sg-1|tcp|80|80',
      'AWS::EC2::SecurityGroupIngress',
      INGRESS,
      context
    );
    expect(send).not.toHaveBeenCalled();
    expect(warnText()).toContain(expected('MyIngress'));
  });
});

describe('an UPDATE whose revoke was skipped (the stack is deployed)', () => {
  it('names the single-record drop, never the whole-stack form', async () => {
    const error = await new EC2Provider()
      .update(
        'MyIngress',
        'sg-1|tcp|80|80',
        'AWS::EC2::SecurityGroupIngress',
        { ...INGRESS_NEW },
        { ...INGRESS_OLD }
      )
      .then(
        () => undefined,
        (e: unknown) => e as Error
      );
    expect(error?.message).toContain('Cannot update SecurityGroupIngress MyIngress');
    expect(error?.message).toContain(`then drop its record with ${single('MyIngress')}`);
    expect(error?.message).not.toContain(BARE);
    expect(error?.message).not.toContain("'cdkd state orphan <stack>' —");
  });
});

const INGRESS_OLD = { GroupId: 'sg-1', IpProtocol: 'tcp', FromPort: 80, ToPort: 80, CidrIp: '***' };
const INGRESS_NEW = { ...INGRESS_OLD, CidrIp: '10.0.0.0/8' };
