import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * go-to-k/cdkd#3952: a `delete()` that addresses the resource through a
 * RECORDED property used to send cdkd's own redaction -- the `***` mask of a
 * NoEcho value, or a secret `{{resolve:...}}` expression -- to AWS as a name or
 * a record value. Every such site now either falls back to an unredacted
 * source or reports a named skip before any AWS call.
 *
 * Each skip case asserts NO call reached a client: every client these
 * providers build is a stub sharing one `send` spy.
 */

const warnSpy = vi.hoisted(() => vi.fn());
const send = vi.hoisted(() => vi.fn());
const stubClient = vi.hoisted(
  () => () => ({ send, config: { region: () => Promise.resolve('us-east-1') } })
);

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => new Proxy({}, { get: () => stubClient() }),
}));
for (const [pkg, ctor] of [
  ['@aws-sdk/client-apigatewayv2', 'ApiGatewayV2Client'],
  ['@aws-sdk/client-ecs', 'ECSClient'],
  ['@aws-sdk/client-glue', 'GlueClient'],
  ['@aws-sdk/client-sts', 'STSClient'],
  ['@aws-sdk/client-scheduler', 'SchedulerClient'],
  ['@aws-sdk/client-route-53', 'Route53Client'],
  ['@aws-sdk/client-emr', 'EMRClient'],
  ['@aws-sdk/client-rds', 'RDSClient'],
] as const) {
  vi.doMock(pkg, async () => {
    const actual = await vi.importActual<Record<string, unknown>>(pkg);
    return { ...actual, [ctor]: vi.fn().mockImplementation(stubClient) };
  });
}

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

const {
  isRedactedRecordedValue,
  redactedDeleteAddressFields,
  redactedDeleteAddressSkip,
  REDACTED_DELETE_ADDRESS_SKIP_REASON,
} = await import('../../../src/provisioning/redacted-delete-address.js');
const { SECRET_MASK } = await import('../../../src/deployment/secret-redaction.js');
const { ApiGatewayProvider } = await import(
  '../../../src/provisioning/providers/apigateway-provider.js'
);
const { ApiGatewayV2Provider } = await import(
  '../../../src/provisioning/providers/apigatewayv2-provider.js'
);
const { ECSProvider } = await import('../../../src/provisioning/providers/ecs-provider.js');
const { GlueProvider, GlueConnectionProvider } = await import(
  '../../../src/provisioning/providers/glue-provider.js'
);
const { SchedulerScheduleProvider } = await import(
  '../../../src/provisioning/providers/scheduler-schedule-provider.js'
);
const { Route53Provider } = await import('../../../src/provisioning/providers/route53-provider.js');
const { EC2Provider } = await import('../../../src/provisioning/providers/ec2-provider.js');
const { CloudWatchAnomalyDetectorProvider } = await import(
  '../../../src/provisioning/providers/cloudwatch-anomaly-detector-provider.js'
);
const { IAMUserGroupProvider } = await import(
  '../../../src/provisioning/providers/iam-user-group-provider.js'
);
const { IAMPolicyProvider } = await import(
  '../../../src/provisioning/providers/iam-policy-provider.js'
);
const { IAMAccessKeyProvider } = await import(
  '../../../src/provisioning/providers/iam-access-key-provider.js'
);
const { LambdaPermissionProvider } = await import(
  '../../../src/provisioning/providers/lambda-permission-provider.js'
);
const { EMRInstanceFleetConfigProvider } = await import(
  '../../../src/provisioning/providers/emr-instance-fleet-config-provider.js'
);
const { EMRInstanceGroupConfigProvider } = await import(
  '../../../src/provisioning/providers/emr-instance-group-config-provider.js'
);
const { RDSDBProxyTargetGroupProvider } = await import(
  '../../../src/provisioning/providers/rds-dbproxy-targetgroup-provider.js'
);
const { isMarkedNonRetryable } = await import('../../../src/deployment/retryable-errors.js');

const SECRET_REF = '{{resolve:secretsmanager:some-secret:SecretString:id}}';
const warnText = () => warnSpy.mock.calls.map((c) => String(c[0])).join('\n');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('isRedactedRecordedValue / redactedDeleteAddressFields', () => {
  it.each([
    ['the whole mask', SECRET_MASK, true],
    ['a nested mask', { Dimensions: [{ Name: 'n', Value: SECRET_MASK }] }, true],
    ['a whole secret reference', SECRET_REF, true],
    ['a reference embedded in a longer value', `arn:aws:x:::${SECRET_REF}`, true],
    ['a reference nested in an object', { AliasTarget: { DNSName: SECRET_REF } }, true],
    ['a plain name', 'my-api-id', false],
    ['a value merely containing asterisks', 'a***b', false],
    ['an unterminated reference opener', '{{resolve:secretsmanager:x', false],
    ['undefined', undefined, false],
  ])('%s -> %s', (_label, value, expected) => {
    expect(isRedactedRecordedValue(value)).toBe(expected);
  });

  it('names only the redacted fields, in the caller order', () => {
    expect(
      redactedDeleteAddressFields({ A: 'ok', B: SECRET_MASK, C: undefined, D: SECRET_REF })
    ).toEqual(['B', 'D']);
  });
});

describe('redactedDeleteAddressSkip', () => {
  it('returns undefined and warns nothing for an empty list', () => {
    expect(redactedDeleteAddressSkip({ warn: warnSpy }, 'X', 'Thing', [])).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns naming the fields but never a value, and returns the fixed skip', () => {
    const result = redactedDeleteAddressSkip({ warn: warnSpy }, 'MyStage', 'Stage', ['RestApiId']);
    expect(result).toEqual({ outcome: 'skipped', reason: REDACTED_DELETE_ADDRESS_SKIP_REASON });
    const text = warnText();
    expect(text).toContain('Stage MyStage is recorded in state with RestApiId redacted');
    expect(text).toContain('LEFT IN PLACE');
    expect(text).toContain("'cdkd state orphan <stack>'");
    expect(text).toContain('https://github.com/go-to-k/cdkd/issues/1762');
  });

  it('keeps the reason short, state-named, and free of already-deleted wording', () => {
    expect(REDACTED_DELETE_ADDRESS_SKIP_REASON.length).toBeLessThanOrEqual(64);
    expect(REDACTED_DELETE_ADDRESS_SKIP_REASON).toMatch(/state/);
    expect(REDACTED_DELETE_ADDRESS_SKIP_REASON).toMatch(/no delete issued/);
    expect(REDACTED_DELETE_ADDRESS_SKIP_REASON).not.toMatch(/not found|does not exist|NotFound/i);
  });
});

describe('every addressed site skips a redacted address before any AWS call', () => {
  const cases: Array<{ name: string; field: string; run: () => Promise<unknown> }> = [
    ...(
      [
        'AWS::ApiGateway::Authorizer',
        'AWS::ApiGateway::Resource',
        'AWS::ApiGateway::Deployment',
        'AWS::ApiGateway::Stage',
      ] as const
    ).map((type) => ({
      name: type,
      field: 'RestApiId',
      run: () => new ApiGatewayProvider().delete('R', 'child-id', type, { RestApiId: SECRET_MASK }),
    })),
    ...(
      [
        'AWS::ApiGatewayV2::Stage',
        'AWS::ApiGatewayV2::Integration',
        'AWS::ApiGatewayV2::Route',
        'AWS::ApiGatewayV2::Authorizer',
      ] as const
    ).map((type) => ({
      name: type,
      field: 'ApiId',
      run: () => new ApiGatewayV2Provider().delete('R', 'child-id', type, { ApiId: SECRET_REF }),
    })),
    {
      // The SHORT-format service ARN names no cluster, so nothing is left.
      name: 'AWS::ECS::Service (short-format ARN)',
      field: 'Cluster',
      run: () =>
        new ECSProvider().delete(
          'R',
          'arn:aws:ecs:us-east-1:111122223333:service/s',
          'AWS::ECS::Service',
          { Cluster: SECRET_MASK }
        ),
    },
    {
      name: 'AWS::RDS::DBProxyTargetGroup',
      field: 'DBClusterIdentifiers',
      run: () =>
        new RDSDBProxyTargetGroupProvider().delete(
          'R',
          'arn:aws:rds:us-east-1:111122223333:target-group:prx-tg-1',
          'AWS::RDS::DBProxyTargetGroup',
          { DBProxyName: 'proxy', TargetGroupName: 'default', DBClusterIdentifiers: [SECRET_MASK] }
        ),
    },
    {
      name: 'AWS::Glue::Database',
      field: 'CatalogId',
      run: () =>
        new GlueProvider().delete('R', 'db', 'AWS::Glue::Database', { CatalogId: SECRET_MASK }),
    },
    {
      name: 'AWS::Glue::Table',
      field: 'CatalogId',
      run: () =>
        new GlueProvider().delete('R', 'db|tbl', 'AWS::Glue::Table', {
          CatalogId: SECRET_MASK,
          DatabaseName: 'db',
        }),
    },
    {
      name: 'AWS::Glue::Connection',
      field: 'CatalogId',
      run: () =>
        new GlueConnectionProvider().delete('R', 'conn', 'AWS::Glue::Connection', {
          CatalogId: SECRET_REF,
        }),
    },
    {
      name: 'AWS::Scheduler::Schedule',
      field: 'GroupName',
      run: () =>
        new SchedulerScheduleProvider().delete('R', 'sched', 'AWS::Scheduler::Schedule', {
          GroupName: SECRET_MASK,
        }),
    },
    {
      name: 'AWS::Route53::RecordSet (TXT value)',
      field: 'ResourceRecords',
      run: () =>
        new Route53Provider().delete('R', 'x.example.com', 'AWS::Route53::RecordSet', {
          HostedZoneId: 'Z123',
          Name: 'x.example.com.',
          Type: 'TXT',
          TTL: '60',
          ResourceRecords: [SECRET_MASK],
        }),
    },
    {
      name: 'AWS::Route53::RecordSet (zone name)',
      field: 'HostedZoneName',
      run: () =>
        new Route53Provider().delete('R', 'x.example.com', 'AWS::Route53::RecordSet', {
          HostedZoneName: SECRET_MASK,
          Name: 'x.example.com.',
          Type: 'A',
          TTL: '60',
          ResourceRecords: ['192.0.2.1'],
        }),
    },
    {
      name: 'AWS::EC2::SecurityGroupIngress',
      field: 'CidrIp',
      run: () =>
        new EC2Provider().delete('R', 'sg-1|tcp|443|443', 'AWS::EC2::SecurityGroupIngress', {
          GroupId: 'sg-1',
          IpProtocol: 'tcp',
          FromPort: 443,
          ToPort: 443,
          CidrIp: SECRET_MASK,
        }),
    },
    {
      name: 'AWS::CloudWatch::AnomalyDetector',
      field: 'Dimensions',
      run: () =>
        new CloudWatchAnomalyDetectorProvider().delete(
          'R',
          'detector',
          'AWS::CloudWatch::AnomalyDetector',
          {
            Namespace: 'AWS/EC2',
            MetricName: 'CPUUtilization',
            Stat: 'Average',
            Dimensions: [{ Name: 'InstanceId', Value: SECRET_MASK }],
          }
        ),
    },
    {
      name: 'AWS::IAM::UserToGroupAddition',
      field: 'GroupName',
      run: () =>
        new IAMUserGroupProvider().delete('R', 'R', 'AWS::IAM::UserToGroupAddition', {
          GroupName: SECRET_MASK,
          Users: ['u1'],
        }),
    },
    {
      name: 'AWS::IAM::Policy (no physicalId name, redacted PolicyName)',
      field: 'PolicyName',
      run: () =>
        new IAMPolicyProvider().delete('R', '', 'AWS::IAM::Policy', {
          PolicyName: SECRET_MASK,
          Roles: ['r1'],
        }),
    },
    {
      name: 'AWS::Lambda::Permission (no function in physicalId, redacted FunctionName)',
      field: 'FunctionName',
      run: () =>
        new LambdaPermissionProvider().delete('R', '|AllowInvoke', 'AWS::Lambda::Permission', {
          FunctionName: SECRET_REF,
        }),
    },
  ];

  it.each(cases)('$name', async ({ field, run }) => {
    const result = await run();

    expect(result).toEqual({ outcome: 'skipped', reason: REDACTED_DELETE_ADDRESS_SKIP_REASON });
    expect(send).not.toHaveBeenCalled();
    expect(warnText()).toContain(`with ${field}`);
    // Never the redacted value itself.
    expect(warnText()).not.toContain('some-secret');
  });

  it('a Method does NOT consult RestApiId (it addresses by physicalId only)', async () => {
    send.mockResolvedValue({});
    const result = await new ApiGatewayProvider().delete(
      'M',
      'restapi|resource|GET',
      'AWS::ApiGateway::Method',
      { RestApiId: SECRET_MASK }
    );
    expect(result).not.toEqual({
      outcome: 'skipped',
      reason: REDACTED_DELETE_ADDRESS_SKIP_REASON,
    });
    expect(send).toHaveBeenCalled();
  });
});

describe('Route 53: every field the DELETE sends is an address', () => {
  const base = {
    HostedZoneId: 'Z123',
    Name: 'x.example.com.',
    Type: 'A',
    TTL: '60',
    ResourceRecords: ['192.0.2.1'],
  };
  it.each([
    ['Name', { Name: SECRET_MASK }],
    ['Type', { Type: SECRET_MASK }],
    ['TTL', { TTL: SECRET_MASK }],
    ['SetIdentifier', { SetIdentifier: SECRET_MASK }],
    ['Weight', { Weight: SECRET_REF }],
    ['Region', { Region: SECRET_MASK }],
    ['Failover', { Failover: SECRET_MASK }],
    ['MultiValueAnswer', { MultiValueAnswer: SECRET_MASK }],
    ['HealthCheckId', { HealthCheckId: SECRET_MASK }],
    ['GeoLocation', { GeoLocation: { CountryCode: SECRET_MASK } }],
    ['GeoProximityLocation', { GeoProximityLocation: { AWSRegion: SECRET_MASK } }],
    ['CidrRoutingConfig', { CidrRoutingConfig: { CollectionId: SECRET_MASK } }],
    ['AliasTarget', { AliasTarget: { DNSName: SECRET_MASK, HostedZoneId: 'Z2' } }],
    ['HostedZoneId', { HostedZoneId: SECRET_MASK }],
  ])('%s', async (field, patch) => {
    const result = await new Route53Provider().delete(
      'R',
      'x.example.com',
      'AWS::Route53::RecordSet',
      { ...base, ...patch }
    );
    expect(result).toEqual({ outcome: 'skipped', reason: REDACTED_DELETE_ADDRESS_SKIP_REASON });
    expect(send).not.toHaveBeenCalled();
    expect(warnText()).toContain(`with ${field}`);
  });

  it('a composite physicalId addresses the zone, so a redacted zone field does not block', async () => {
    send.mockResolvedValue({});
    const result = await new Route53Provider().delete(
      'R',
      'Z123|x.example.com.|A',
      'AWS::Route53::RecordSet',
      { ...base, HostedZoneId: SECRET_MASK }
    );
    // `compositeAgreesWithTemplate` checks Name / Type only, so the composite
    // is used and the zone comes from the physicalId, never the record.
    expect(result).toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].input).toMatchObject({ HostedZoneId: 'Z123' });
    expect(JSON.stringify(send.mock.calls[0]![0].input)).not.toContain(SECRET_MASK);
  });
});

describe('EC2 SecurityGroupIngress: every permission field is an address, Description is not', () => {
  const base = {
    GroupId: 'sg-1',
    IpProtocol: 'tcp',
    FromPort: 443,
    ToPort: 443,
    CidrIp: '10.0.0.0/8',
  };
  it.each([
    ['IpProtocol', { IpProtocol: SECRET_MASK }],
    ['FromPort', { FromPort: SECRET_MASK }],
    ['ToPort', { ToPort: SECRET_REF }],
    [
      'SourceSecurityGroupOwnerId',
      { CidrIp: undefined, SourceSecurityGroupId: 'sg-2', SourceSecurityGroupOwnerId: SECRET_MASK },
    ],
    ['CidrIpv6', { CidrIp: undefined, CidrIpv6: SECRET_MASK }],
    ['SourceSecurityGroupId', { CidrIp: undefined, SourceSecurityGroupId: SECRET_MASK }],
    ['SourcePrefixListId', { CidrIp: undefined, SourcePrefixListId: SECRET_REF }],
  ])('%s', async (field, patch) => {
    const result = await new EC2Provider().delete(
      'R',
      'sg-1|tcp|443|443',
      'AWS::EC2::SecurityGroupIngress',
      { ...base, ...patch }
    );
    expect(result).toEqual({ outcome: 'skipped', reason: REDACTED_DELETE_ADDRESS_SKIP_REASON });
    expect(send).not.toHaveBeenCalled();
    expect(warnText()).toContain(`with ${field}`);
  });

  // go-to-k/cdkd#4355: a revoke never needs the description, and a SENT one
  // must match the live rule's — a rule adopted from another owner carries
  // none, so sending the recorded one answered NotFound and left it live.
  it('an unredacted Description is left out of the revoke too', async () => {
    send.mockResolvedValue({});
    await new EC2Provider().delete('R', 'sg-1|tcp|443|443', 'AWS::EC2::SecurityGroupIngress', {
      ...base,
      Description: 'https in',
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(send.mock.calls[0]![0].input)).not.toContain('https in');
    expect(JSON.stringify(send.mock.calls[0]![0].input)).not.toContain('Description');
  });

  it('a redacted Description is left out of the revoke instead of blocking it', async () => {
    send.mockResolvedValue({});
    const result = await new EC2Provider().delete(
      'R',
      'sg-1|tcp|443|443',
      'AWS::EC2::SecurityGroupIngress',
      { ...base, Description: SECRET_MASK }
    );
    expect(result).toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(send.mock.calls[0]![0].input)).not.toContain(SECRET_MASK);
    expect(send.mock.calls[0]![0].input).toMatchObject({ GroupId: 'sg-1' });
  });
});

describe('RDS DBProxyTargetGroup: every deregister field is an address', () => {
  const base = {
    DBProxyName: 'proxy',
    TargetGroupName: 'default',
    DBClusterIdentifiers: ['cluster-1'],
  };
  it.each([
    ['DBProxyName', { DBProxyName: SECRET_MASK }],
    ['TargetGroupName', { TargetGroupName: SECRET_REF }],
    // The only target named, so nothing else addresses the deregistration.
    ['DBInstanceIdentifiers', { DBClusterIdentifiers: undefined, DBInstanceIdentifiers: [SECRET_MASK] }],
  ])('%s', async (field, patch) => {
    const result = await new RDSDBProxyTargetGroupProvider().delete(
      'R',
      'arn:aws:rds:us-east-1:111122223333:target-group:prx-tg-1',
      'AWS::RDS::DBProxyTargetGroup',
      { ...base, ...patch }
    );
    expect(result).toEqual({ outcome: 'skipped', reason: REDACTED_DELETE_ADDRESS_SKIP_REASON });
    expect(send).not.toHaveBeenCalled();
    expect(warnText()).toContain(`with ${field}`);
  });
});

describe('CloudWatch AnomalyDetector: every descriptor field is an address', () => {
  it.each([
    ['Namespace', { Namespace: SECRET_MASK }],
    ['MetricName', { MetricName: SECRET_MASK }],
    ['Stat', { Stat: SECRET_REF }],
    ['SingleMetricAnomalyDetector', { SingleMetricAnomalyDetector: { MetricName: SECRET_MASK } }],
    ['MetricMathAnomalyDetector', { MetricMathAnomalyDetector: { MetricDataQueries: [SECRET_MASK] } }],
  ])('%s', async (field, patch) => {
    const result = await new CloudWatchAnomalyDetectorProvider().delete(
      'R',
      'detector',
      'AWS::CloudWatch::AnomalyDetector',
      { Namespace: 'AWS/EC2', MetricName: 'CPUUtilization', Stat: 'Average', ...patch }
    );
    expect(result).toEqual({ outcome: 'skipped', reason: REDACTED_DELETE_ADDRESS_SKIP_REASON });
    expect(send).not.toHaveBeenCalled();
    expect(warnText()).toContain(`with ${field}`);
  });
});

describe('sites with a second source fall back to it instead of skipping', () => {
  it('AWS::ECS::Service uses the cluster in a long-format service ARN', async () => {
    send.mockResolvedValue({});
    await new ECSProvider().delete(
      'R',
      'arn:aws:ecs:us-east-1:111122223333:service/my-cluster/s',
      'AWS::ECS::Service',
      { Cluster: SECRET_MASK }
    );
    expect(send).toHaveBeenCalled();
    for (const call of send.mock.calls) {
      expect(JSON.stringify(call[0].input)).not.toContain(SECRET_MASK);
    }
    expect(send.mock.calls[0]![0].input).toMatchObject({ cluster: 'my-cluster' });
  });

  it('AWS::Lambda::Permission uses the function in the physicalId', async () => {
    send.mockResolvedValue({});
    await new LambdaPermissionProvider().delete(
      'R',
      'my-fn|AllowInvoke',
      'AWS::Lambda::Permission',
      { FunctionName: SECRET_MASK }
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].input).toEqual({
      FunctionName: 'my-fn',
      StatementId: 'AllowInvoke',
    });
  });

  // The physicalId was already the FIRST source before #3952; this pins that a
  // redacted PolicyName never displaces it. The redacted-fallback filter itself
  // is held by the skip case above (no name in the physicalId).
  it('AWS::IAM::Policy keeps the physicalId name ahead of a redacted PolicyName', async () => {
    send.mockResolvedValue({});
    await new IAMPolicyProvider().delete('R', 'my-policy', 'AWS::IAM::Policy', {
      PolicyName: SECRET_MASK,
      Roles: ['r1'],
    });
    expect(send).toHaveBeenCalled();
    expect(send.mock.calls[0]![0].input).toMatchObject({ PolicyName: 'my-policy' });
  });

  it('AWS::IAM::AccessKey looks the owning user up instead of sending the mask', async () => {
    send.mockResolvedValueOnce({ UserName: 'real-user' }).mockResolvedValueOnce({});
    await new IAMAccessKeyProvider().delete('R', 'AKIAEXAMPLE', 'AWS::IAM::AccessKey', {
      UserName: SECRET_MASK,
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]![0].input).toEqual({ AccessKeyId: 'AKIAEXAMPLE' });
    expect(send.mock.calls[1]![0].input).toEqual({
      UserName: 'real-user',
      AccessKeyId: 'AKIAEXAMPLE',
    });
  });
});

describe('EMR TASK configs skip only the best-effort scale-to-0', () => {
  it.each([
    [
      'instance fleet',
      () =>
        new EMRInstanceFleetConfigProvider().delete(
          'F',
          'if-1',
          'AWS::EMR::InstanceFleetConfig',
          { InstanceFleetType: 'TASK', ClusterId: SECRET_MASK }
        ),
      'ClusterId is redacted',
    ],
    [
      'instance group',
      () =>
        new EMRInstanceGroupConfigProvider().delete(
          'G',
          'ig-1',
          'AWS::EMR::InstanceGroupConfig',
          { InstanceRole: 'TASK', JobFlowId: SECRET_REF }
        ),
      'JobFlowId is redacted',
    ],
  ])('%s: no call, a warning, and the delete completes as before', async (_n, run, needle) => {
    await expect(run()).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
    expect(warnText()).toContain(needle);
  });
});

describe('replacement paths that delete through the same address', () => {
  it('SecurityGroupIngress update ABORTS before authorizing when the old rule cannot be revoked', async () => {
    const previous = {
      GroupId: 'sg-1',
      IpProtocol: 'tcp',
      FromPort: 443,
      ToPort: 443,
      CidrIp: SECRET_MASK,
    };
    await expect(
      new EC2Provider().update(
        'R',
        'sg-1|tcp|443|443',
        'AWS::EC2::SecurityGroupIngress',
        { ...previous, CidrIp: '10.0.0.0/8' },
        previous
      )
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof Error &&
        /the new rule was\s+NOT authorized/.test(error.message) &&
        isMarkedNonRetryable(error)
    );
    // Neither the revoke nor the authorize reached AWS.
    expect(send).not.toHaveBeenCalled();
  });

  it('ApiGateway Resource replacement reports the old resource as a survivor, not deleted', async () => {
    // createResource's CreateResource answers; nothing else may be called.
    send.mockResolvedValueOnce({ id: 'new-resource' });
    const result = await new ApiGatewayProvider().update(
      'R',
      'old-resource',
      'AWS::ApiGateway::Resource',
      { RestApiId: 'api-1', ParentId: 'root', PathPart: 'new' },
      { RestApiId: SECRET_MASK, ParentId: 'root', PathPart: 'old' }
    );
    expect(result).toMatchObject({ wasReplaced: true, outcome: 'partial' });
    expect((result as { reason?: string }).reason).toContain('RestApiId is redacted');
    expect(send).toHaveBeenCalledTimes(1);
  });
});
