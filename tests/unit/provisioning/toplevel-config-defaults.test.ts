import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * Issue #1513: the TOP-LEVEL `(properties['X'] as string) ?? 'default'` reads
 * left out of #1493.
 *
 * The container is the provider's own property bag, so the malformed-CONTAINER
 * rule cannot fire — what bites here is a present-but-unusable VALUE (`null`,
 * an object from a mis-nested template, an unresolved intrinsic), which `??`
 * silently replaces with a default the template never asked for. The headline
 * case is `AWS::ApiGateway::Method AuthorizationType`, whose default is NO
 * AUTHORIZATION.
 *
 * Three per-site decisions are pinned here, because the issue's whole point is
 * that this is not a blanket sweep:
 *
 * - CREATE refuses (the value is always template-borne there);
 * - UPDATE warns and defaults instead (a rollback replays `update()` with a
 *   historical cdkd STATE record as the desired bag — refusing would leave the
 *   resource un-rollbackable with no template-side remedy);
 * - a numeric value is COERCED at the sites where an unquoted YAML scalar is a
 *   legitimate template shape (`IpProtocol: -1`, `Qualifier: 1`) and REFUSED at
 *   the enum-valued ones.
 */

const { logWarn, mockSend } = vi.hoisted(() => ({ logWarn: vi.fn(), mockSend: vi.fn() }));

vi.mock('../../../src/utils/aws-clients.js', () => {
  const client = { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } };
  return {
    getAwsClients: () => ({
      ec2: client,
      apiGateway: client,
      iam: client,
      lambda: client,
    }),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const child: Record<string, unknown> = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: logWarn,
    error: vi.fn(),
  };
  child['child'] = () => child;
  return {
    getLogger: () => ({
      child: () => child,
      debug: vi.fn(),
      info: vi.fn(),
      warn: logWarn,
      error: vi.fn(),
    }),
  };
});

import { ApiGatewayProvider } from '../../../src/provisioning/providers/apigateway-provider.js';
import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';
import { IAMAccessKeyProvider } from '../../../src/provisioning/providers/iam-access-key-provider.js';
import { LambdaEventInvokeConfigProvider } from '../../../src/provisioning/providers/lambda-event-invoke-config-provider.js';
import { RDSDBProxyTargetGroupProvider } from '../../../src/provisioning/providers/rds-dbproxy-targetgroup-provider.js';

/** Return the SDK command-input object from the Nth mockSend call. */
function inputOf(callIndex = 0): Record<string, unknown> {
  return mockSend.mock.calls[callIndex][0].input as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AWS::ApiGateway::Method AuthorizationType (create)', () => {
  it('refuses a null AuthorizationType instead of silently publishing a PUBLIC method', async () => {
    const provider = new ApiGatewayProvider();

    await expect(
      provider.create('Method', 'AWS::ApiGateway::Method', {
        RestApiId: 'api123',
        ResourceId: 'res123',
        HttpMethod: 'GET',
        AuthorizationType: null,
      })
    ).rejects.toThrow(/AWS::ApiGateway::Method AuthorizationType must be a non-empty string/);

    // The refusal must land BEFORE the method is put on AWS — otherwise the
    // public method exists and only the state record is missing.
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('refuses a mis-nested object', async () => {
    const provider = new ApiGatewayProvider();

    await expect(
      provider.create('Method', 'AWS::ApiGateway::Method', {
        RestApiId: 'api123',
        ResourceId: 'res123',
        HttpMethod: 'GET',
        AuthorizationType: { Ref: 'SomethingUnresolved' },
      })
    ).rejects.toThrow(/got an object/);
  });

  it('still defaults to NONE when the field is absent', async () => {
    mockSend.mockResolvedValue({});
    const provider = new ApiGatewayProvider();

    await provider.create('Method', 'AWS::ApiGateway::Method', {
      RestApiId: 'api123',
      ResourceId: 'res123',
      HttpMethod: 'GET',
    });

    expect(inputOf().authorizationType).toBe('NONE');
  });
});

describe('AWS::EC2::SecurityGroupIngress IpProtocol (create)', () => {
  it('accepts an unquoted YAML numeric protocol, which deploys fine today', async () => {
    mockSend.mockResolvedValue({});
    const provider = new EC2Provider();

    const result = await provider.create('Ingress', 'AWS::EC2::SecurityGroupIngress', {
      GroupId: 'sg-123',
      IpProtocol: -1,
      CidrIp: '0.0.0.0/0',
    });

    // The physical id is composed from the protocol, so coercion must not
    // change it for a template that already worked.
    expect(result.physicalId).toBe('sg-123|-1|-1|-1');
  });

  it('refuses a null protocol', async () => {
    const provider = new EC2Provider();

    await expect(
      provider.create('Ingress', 'AWS::EC2::SecurityGroupIngress', {
        GroupId: 'sg-123',
        IpProtocol: null,
        CidrIp: '0.0.0.0/0',
      })
    ).rejects.toThrow(/AWS::EC2::SecurityGroupIngress IpProtocol must be a non-empty string/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('leaves buildIpPermission unguarded so a state-borne rule can still be REVOKED', async () => {
    // The delete path builds the IpPermission from the STATE record. A refusal
    // inside `buildIpPermission` would fire here and make the resource
    // undeletable — which is why the guard sits at the create call site.
    mockSend.mockResolvedValue({});
    const provider = new EC2Provider();

    await provider.delete('Ingress', 'sg-123|-1|-1|-1', 'AWS::EC2::SecurityGroupIngress', {
      GroupId: 'sg-123',
      IpProtocol: null,
      CidrIp: '0.0.0.0/0',
    });

    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});

describe('AWS::EC2::Instance InstanceType / AWS::EC2::EIP Domain (create)', () => {
  it('refuses a numeric InstanceType — an enum site does NOT coerce', async () => {
    const provider = new EC2Provider();

    await expect(
      provider.create('Instance', 'AWS::EC2::Instance', {
        ImageId: 'ami-123',
        InstanceType: 5,
      })
    ).rejects.toThrow(/AWS::EC2::Instance InstanceType must be a non-empty string \(got a number\)/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('refuses a blank InstanceType', async () => {
    const provider = new EC2Provider();

    await expect(
      provider.create('Instance', 'AWS::EC2::Instance', { ImageId: 'ami-123', InstanceType: '  ' })
    ).rejects.toThrow(/got a blank string/);
  });

  it('refuses a null EIP Domain instead of silently allocating a VPC address', async () => {
    const provider = new EC2Provider();

    await expect(provider.create('Eip', 'AWS::EC2::EIP', { Domain: null })).rejects.toThrow(
      /AWS::EC2::EIP Domain must be a non-empty string/
    );
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('AWS::IAM::AccessKey Status', () => {
  it('refuses a null Status on create instead of silently minting an ACTIVE key', async () => {
    const provider = new IAMAccessKeyProvider();

    await expect(
      provider.create('Key', 'AWS::IAM::AccessKey', { UserName: 'alice', Status: null })
    ).rejects.toThrow(/AWS::IAM::AccessKey Status must be a non-empty string/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('WARNS and defaults on update, because a rollback replays a STATE record', async () => {
    mockSend.mockResolvedValue({});
    const provider = new IAMAccessKeyProvider();

    const result = await provider.update(
      'Key',
      'AKIAEXAMPLE',
      'AWS::IAM::AccessKey',
      { UserName: 'alice', Status: null },
      { UserName: 'alice', Status: 'Active' }
    );

    expect(result.physicalId).toBe('AKIAEXAMPLE');
    expect(logWarn).toHaveBeenCalledWith(
      expect.stringMatching(/AWS::IAM::AccessKey Status must be a non-empty string/)
    );
    // The warning must say the value is ignored HERE and refused on create —
    // otherwise the two paths read as an inconsistency rather than a decision.
    expect(logWarn).toHaveBeenCalledWith(expect.stringMatching(/REFUSED on create/));
    expect(inputOf().Status).toBe('Active');
  });
});

describe('AWS::Lambda::EventInvokeConfig Qualifier', () => {
  it('accepts an unquoted YAML numeric version qualifier', async () => {
    mockSend.mockResolvedValue({});
    const provider = new LambdaEventInvokeConfigProvider();

    const result = await provider.create('Cfg', 'AWS::Lambda::EventInvokeConfig', {
      FunctionName: 'my-fn',
      Qualifier: 1,
    });

    expect(result.physicalId).toBe('my-fn|1');
    expect(inputOf().Qualifier).toBe('1');
  });

  it('refuses a mis-nested Qualifier on create', async () => {
    const provider = new LambdaEventInvokeConfigProvider();

    await expect(
      provider.create('Cfg', 'AWS::Lambda::EventInvokeConfig', {
        FunctionName: 'my-fn',
        Qualifier: { Ref: 'Unresolved' },
      })
    ).rejects.toThrow(/AWS::Lambda::EventInvokeConfig Qualifier must be a non-empty string/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('WARNS and defaults on update, because a rollback replays a STATE record', async () => {
    mockSend.mockResolvedValue({});
    const provider = new LambdaEventInvokeConfigProvider();

    await provider.update(
      'Cfg',
      'my-fn|$LATEST',
      'AWS::Lambda::EventInvokeConfig',
      { FunctionName: 'my-fn', Qualifier: null, MaximumRetryAttempts: 1 },
      { FunctionName: 'my-fn', Qualifier: '$LATEST', MaximumRetryAttempts: 0 }
    );

    expect(logWarn).toHaveBeenCalledWith(
      expect.stringMatching(/AWS::Lambda::EventInvokeConfig Qualifier must be a non-empty string/)
    );
    // Defaulted to the unqualified target, which the provider omits from the
    // wire input — the point is that the deploy continues, loudly.
    expect(inputOf().Qualifier).toBeUndefined();
  });
});

describe('AWS::RDS::DBProxyTargetGroup TargetGroupName', () => {
  it('refuses a null TargetGroupName on create', async () => {
    const provider = new RDSDBProxyTargetGroupProvider();

    await expect(
      provider.create('Tg', 'AWS::RDS::DBProxyTargetGroup', {
        DBProxyName: 'proxy1',
        TargetGroupName: null,
      })
    ).rejects.toThrow(/AWS::RDS::DBProxyTargetGroup TargetGroupName must be a non-empty string/);
  });

  it('WARNS on update rather than refusing a historical state record', async () => {
    const provider = new RDSDBProxyTargetGroupProvider();

    // The pre-existing immutable-identity guard still fires after the warning
    // (null !== the normalized 'default'); what matters is that the shape guard
    // itself did not throw.
    await expect(
      provider.update(
        'Tg',
        'proxy1|default',
        'AWS::RDS::DBProxyTargetGroup',
        { DBProxyName: 'proxy1', TargetGroupName: null },
        { DBProxyName: 'proxy1' }
      )
    ).rejects.toThrow(/immutable/);

    expect(logWarn).toHaveBeenCalledWith(
      expect.stringMatching(/AWS::RDS::DBProxyTargetGroup TargetGroupName must be a non-empty string/)
    );
  });
});
