import { describe, it, expect, vi } from 'vite-plus/test';

/**
 * go-to-k/cdkd#4383 review: the same-stack readers a `--recreate-via-*`
 * deploy REPLACES when a target's id moves, and the engine's refusal of a
 * stateful one on the condition-evaluated template.
 *
 * DescribeType answers from the committed schema snapshot (no write-only
 * properties) for the API Gateway types only, which the registry does not
 * classify; every other type is classified by the registry alone.
 */
const mockCloudFormationSend = vi.fn((command: { input?: { TypeName?: string } }) => {
  const type = command.input?.TypeName ?? '';
  const paths = type.startsWith('AWS::ApiGateway::')
    ? CREATE_ONLY_PATHS_SNAPSHOT.get(type)
    : undefined;
  if (paths === undefined) {
    return Promise.reject(
      Object.assign(new Error('not authorized to perform: cloudformation:DescribeType'), {
        name: 'AccessDeniedException',
        $metadata: { httpStatusCode: 403 },
      })
    );
  }
  return Promise.resolve({
    Schema: JSON.stringify({
      createOnlyProperties: paths.map((path) => `/properties/${path.join('/')}`),
      writeOnlyProperties: [],
    }),
  });
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ cloudFormation: { send: mockCloudFormationSend } }),
}));

import {
  findReplacedReadersOfRecreateTargets,
  isPlainReferenceTo,
  refuseStatefulReplacedReaders,
} from '../../../src/deployment/recreate-target-readers.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import { CREATE_ONLY_PATHS_SNAPSHOT } from '../../../src/provisioning/create-only-snapshot.generated.js';
import { clearCreateOnlyPropertiesCache } from '../../../src/provisioning/create-only-properties.js';
import { clearWriteOnlyPropertiesCache } from '../../../src/provisioning/write-only-properties.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';

function record(resourceType: string, properties: Record<string, unknown> = {}): ResourceState {
  return { physicalId: 'p', resourceType, properties, attributes: {} } as ResourceState;
}

function stateOf(resources: Record<string, ResourceState>): StackState {
  return { version: 1, stackName: 'S', resources, outputs: {}, lastModified: 0 };
}

/**
 * A KMS key (the target) read by: an EBS volume through create-only
 * `KmsKeyId` (stateful), a topic through create-only `TopicName`, whose own
 * reader holds it in create-only `TopicName` too (the cascade), a parameter
 * through the mutable `Value`, and a volume this deploy creates (no record).
 */
const TEMPLATE: CloudFormationTemplate = {
  Resources: {
    Key: { Type: 'AWS::KMS::Key', Properties: {} },
    Volume: {
      Type: 'AWS::EC2::Volume',
      Properties: { AvailabilityZone: 'us-east-1a', KmsKeyId: { 'Fn::GetAtt': ['Key', 'Arn'] } },
    },
    NamedByKey: {
      Type: 'AWS::SNS::Topic',
      Properties: { TopicName: { Ref: 'Key' } },
    },
    NamedByParam: {
      Type: 'AWS::SNS::Topic',
      Properties: { TopicName: { 'Fn::GetAtt': ['NamedByKey', 'TopicName'] } },
    },
    ValueReader: {
      Type: 'AWS::SSM::Parameter',
      Properties: { Name: 'v', Type: 'String', Value: { Ref: 'Key' } },
    },
    NewVolume: {
      Type: 'AWS::EC2::Volume',
      Properties: { AvailabilityZone: 'us-east-1a', KmsKeyId: { Ref: 'Key' } },
    },
  },
};

const STATE = stateOf({
  Key: record('AWS::KMS::Key'),
  Volume: record('AWS::EC2::Volume'),
  NamedByKey: record('AWS::SNS::Topic'),
  NamedByParam: record('AWS::SNS::Topic'),
  ValueReader: record('AWS::SSM::Parameter'),
});

describe('findReplacedReadersOfRecreateTargets (go-to-k/cdkd#4383)', () => {
  it('lists the create-only readers, transitively, with the stateful verdict', async () => {
    const readers = await findReplacedReadersOfRecreateTargets({
      template: TEMPLATE,
      state: STATE,
      targetIds: ['Key'],
    });
    expect(readers).toEqual([
      {
        logicalId: 'Volume',
        resourceType: 'AWS::EC2::Volume',
        reads: 'Key',
        properties: ['KmsKeyId'],
        statefulReason: 'always',
      },
      {
        logicalId: 'NamedByKey',
        resourceType: 'AWS::SNS::Topic',
        reads: 'Key',
        properties: ['TopicName'],
        statefulReason: null,
      },
      {
        logicalId: 'NamedByParam',
        resourceType: 'AWS::SNS::Topic',
        reads: 'NamedByKey',
        properties: ['TopicName'],
        statefulReason: null,
      },
    ]);
  });

  it('treats a stateful reader under UpdateReplacePolicy: Retain as losing nothing', async () => {
    const template = structuredClone(TEMPLATE);
    template.Resources['Volume']!.UpdateReplacePolicy = 'Retain';
    const readers = await findReplacedReadersOfRecreateTargets({
      template,
      state: STATE,
      targetIds: ['Key'],
    });
    expect(readers.find((r) => r.logicalId === 'Volume')?.statefulReason).toBeNull();
  });

  it('asks the CFn schema for a property the registry does not classify', async () => {
    const template: CloudFormationTemplate = {
      Resources: {
        Api: { Type: 'AWS::ApiGateway::RestApi', Properties: { Name: 'api' } },
        Deployment: {
          Type: 'AWS::ApiGateway::Deployment',
          Properties: { RestApiId: { Ref: 'Api' }, Description: { Ref: 'Api' } },
        },
      },
    };
    const readers = await findReplacedReadersOfRecreateTargets({
      template,
      state: stateOf({
        Api: record('AWS::ApiGateway::RestApi'),
        Deployment: record('AWS::ApiGateway::Deployment'),
      }),
      targetIds: ['Api'],
    });
    expect(readers).toEqual([
      expect.objectContaining({ logicalId: 'Deployment', properties: ['RestApiId'] }),
    ]);
  });

  it('finds nothing for a target absent from the template or the state', async () => {
    expect(
      await findReplacedReadersOfRecreateTargets({
        template: TEMPLATE,
        state: stateOf({ Volume: record('AWS::EC2::Volume') }),
        targetIds: ['Key'],
      })
    ).toEqual([]);
    expect(
      await findReplacedReadersOfRecreateTargets({
        template: TEMPLATE,
        state: STATE,
        targetIds: ['Missing'],
      })
    ).toEqual([]);
  });
});

describe('a write-only create-only reference the registry names (go-to-k/cdkd#4689)', () => {
  // The LIVE ListenerRule schema: `ListenerArn` is create-only AND write-only,
  // so the schema fallback alone leaves it out. AWS deletes the rule with the
  // old listener, so the recreate replaces it and the pre-flight must say so.
  const RULE = 'AWS::ElasticLoadBalancingV2::ListenerRule';
  const LISTENER = 'AWS::ElasticLoadBalancingV2::Listener';

  const template: CloudFormationTemplate = {
    Resources: {
      Listener: {
        Type: LISTENER,
        Properties: { LoadBalancerArn: 'arn:lb', Port: 80, Protocol: 'HTTP' },
      },
      Rule: {
        Type: RULE,
        Properties: {
          ListenerArn: { Ref: 'Listener' },
          Priority: 10,
          Conditions: [{ Field: 'path-pattern', PathPatternConfig: { Values: ['/h'] } }],
          Actions: [{ Type: 'fixed-response', FixedResponseConfig: { StatusCode: '200' } }],
        },
      },
    },
  };
  const expected = [
    {
      logicalId: 'Rule',
      resourceType: RULE,
      reads: 'Listener',
      properties: ['ListenerArn'],
      statefulReason: null,
    },
  ];

  it('lists it with DescribeType denied for the rule too: the registry, not the schema, decides', async () => {
    // This file's default mock denies every non-API-Gateway type.
    clearCreateOnlyPropertiesCache();
    clearWriteOnlyPropertiesCache();
    expect(
      await findReplacedReadersOfRecreateTargets({
        template,
        state: stateOf({ Listener: record(LISTENER), Rule: record(RULE) }),
        targetIds: ['Listener'],
      })
    ).toEqual(expected);
  });

  it('lists the rule of a recreated listener as replaced through ListenerArn', async () => {
    clearCreateOnlyPropertiesCache();
    clearWriteOnlyPropertiesCache();
    const fallback = mockCloudFormationSend.getMockImplementation()!;
    mockCloudFormationSend.mockImplementation((command: { input?: { TypeName?: string } }) =>
      command.input?.TypeName === RULE
        ? Promise.resolve({
            Schema: JSON.stringify({
              createOnlyProperties: ['/properties/ListenerArn'],
              writeOnlyProperties: [
                '/properties/Actions/*/AuthenticateOidcConfig/ClientSecret',
                '/properties/ListenerArn',
              ],
            }),
          })
        : fallback(command)
    );
    try {
      const readers = await findReplacedReadersOfRecreateTargets({
        template,
        state: stateOf({ Listener: record(LISTENER), Rule: record(RULE) }),
        targetIds: ['Listener'],
      });
      expect(readers).toEqual(expected);
    } finally {
      mockCloudFormationSend.mockImplementation(fallback);
      clearCreateOnlyPropertiesCache();
      clearWriteOnlyPropertiesCache();
    }
  });
});

describe('a write-only create-only property holding a plain reference (go-to-k/cdkd#4701)', () => {
  // Types the registry does not classify, with the schema fallback alone.
  const SCALING_POLICY = 'AWS::ApplicationAutoScaling::ScalingPolicy';
  const SCALABLE_TARGET = 'AWS::ApplicationAutoScaling::ScalableTarget';
  const LOCATION_S3 = 'AWS::DataSync::LocationS3';
  const SIMPLE_AD = 'AWS::DirectoryService::SimpleAD';
  const LIVE: Readonly<Record<string, { createOnly: string[]; writeOnly: string[] }>> = {
    // The live schemas, trimmed to the top-level keys these cases read.
    [SCALING_POLICY]: {
      createOnly: ['PolicyName', 'ScalingTargetId'],
      writeOnly: ['ScalingTargetId'],
    },
    [LOCATION_S3]: { createOnly: ['S3BucketArn', 'Subdirectory'], writeOnly: ['S3BucketArn'] },
    [SIMPLE_AD]: { createOnly: ['Password', 'Name'], writeOnly: ['Password'] },
  };

  async function withLiveSchemas<T>(run: () => Promise<T>): Promise<T> {
    clearCreateOnlyPropertiesCache();
    clearWriteOnlyPropertiesCache();
    const fallback = mockCloudFormationSend.getMockImplementation()!;
    mockCloudFormationSend.mockImplementation((command: { input?: { TypeName?: string } }) => {
      const live = LIVE[command.input?.TypeName ?? ''];
      return live === undefined
        ? fallback(command)
        : Promise.resolve({
            Schema: JSON.stringify({
              createOnlyProperties: live.createOnly.map((key) => `/properties/${key}`),
              writeOnlyProperties: live.writeOnly.map((key) => `/properties/${key}`),
            }),
          });
    });
    try {
      return await run();
    } finally {
      mockCloudFormationSend.mockImplementation(fallback);
      clearCreateOnlyPropertiesCache();
      clearWriteOnlyPropertiesCache();
    }
  }

  async function readersOf(
    target: CloudFormationTemplate['Resources'][string],
    reader: CloudFormationTemplate['Resources'][string]
  ): Promise<Array<{ logicalId: string; properties: string[] }>> {
    return withLiveSchemas(() =>
      findReplacedReadersOfRecreateTargets({
        template: { Resources: { Target: target, Reader: reader } },
        state: stateOf({ Target: record(target.Type), Reader: record(reader.Type) }),
        targetIds: ['Target'],
      })
    );
  }

  const scalableTarget = { Type: SCALABLE_TARGET, Properties: { ResourceId: 'table/t' } };
  const bucket = { Type: 'AWS::S3::Bucket', Properties: {} };

  it('lists a scaling policy holding the recreated target in ScalingTargetId (Ref)', async () => {
    const readers = await readersOf(scalableTarget, {
      Type: SCALING_POLICY,
      Properties: { PolicyName: 'p', ScalingTargetId: { Ref: 'Target' } },
    });
    expect(readers).toEqual([
      expect.objectContaining({ logicalId: 'Reader', reads: 'Target', properties: ['ScalingTargetId'] }),
    ]);
  });

  it('lists a reader holding a Fn::GetAtt of it, in either spelling', async () => {
    for (const getAtt of [{ 'Fn::GetAtt': ['Target', 'Arn'] }, { 'Fn::GetAtt': 'Target.Arn' }]) {
      const readers = await readersOf(bucket, {
        Type: LOCATION_S3,
        Properties: { S3BucketArn: getAtt, S3Config: { BucketAccessRoleArn: 'arn:role' } },
      });
      expect(readers).toEqual([
        expect.objectContaining({ logicalId: 'Reader', properties: ['S3BucketArn'] }),
      ]);
    }
  });

  it('does not list a write-only value only built from the reference (go-to-k/cdkd#3803 kept)', async () => {
    // A dynamic reference to a recreated secret: the resolved value is a
    // secret AWS never returns there, so it stays an in-place update.
    const readers = await readersOf(
      { Type: 'AWS::SecretsManager::Secret', Properties: {} },
      {
        Type: SIMPLE_AD,
        Properties: {
          Name: 'corp.example.com',
          Password: {
            'Fn::Join': ['', ['{{resolve:secretsmanager:', { Ref: 'Target' }, ':SecretString:pw}}']],
          },
        },
      }
    );
    expect(readers).toEqual([]);
  });

  it('does not list a Fn::GetAtt of a recreated custom resource or nested stack, which may be NoEcho', async () => {
    for (const type of [
      'Custom::Thing',
      'AWS::CloudFormation::CustomResource',
      'AWS::CloudFormation::Stack',
    ]) {
      const readers = await readersOf(
        { Type: type, Properties: { ServiceToken: 'arn:fn' } },
        {
          Type: SIMPLE_AD,
          Properties: { Name: 'corp.example.com', Password: { 'Fn::GetAtt': ['Target', 'Text'] } },
        }
      );
      expect(readers).toEqual([]);
    }
  });

  it('still lists a NON-write-only create-only property whatever its shape (unchanged)', async () => {
    const readers = await readersOf(
      { Type: 'AWS::SecretsManager::Secret', Properties: {} },
      {
        Type: SIMPLE_AD,
        Properties: { Name: { 'Fn::Join': ['.', [{ Ref: 'Target' }, 'example.com']] } },
      }
    );
    expect(readers).toEqual([expect.objectContaining({ logicalId: 'Reader', properties: ['Name'] })]);
  });

  it('lists a plain Ref when the write-only list is unknown, and nothing else', async () => {
    // DescribeType denied for every type: the create-only paths come from the
    // committed snapshot, and the write-only list is unknown.
    clearCreateOnlyPropertiesCache();
    clearWriteOnlyPropertiesCache();
    const fallback = mockCloudFormationSend.getMockImplementation()!;
    mockCloudFormationSend.mockImplementation(() =>
      Promise.reject(
        Object.assign(new Error('not authorized to perform: cloudformation:DescribeType'), {
          name: 'AccessDeniedException',
          $metadata: { httpStatusCode: 403 },
        })
      )
    );
    try {
      const readers = await findReplacedReadersOfRecreateTargets({
        template: {
          Resources: {
            Api: { Type: 'AWS::ApiGateway::RestApi', Properties: { Name: 'api' } },
            Plain: {
              Type: 'AWS::ApiGateway::Deployment',
              Properties: { RestApiId: { Ref: 'Api' } },
            },
            Built: {
              Type: 'AWS::ApiGateway::Stage',
              Properties: { RestApiId: { 'Fn::Join': ['', [{ Ref: 'Api' }]] }, StageName: 's' },
            },
          },
        },
        state: stateOf({
          Api: record('AWS::ApiGateway::RestApi'),
          Plain: record('AWS::ApiGateway::Deployment'),
          Built: record('AWS::ApiGateway::Stage'),
        }),
        targetIds: ['Api'],
      });
      expect(readers.map((r) => [r.logicalId, r.properties])).toEqual([['Plain', ['RestApiId']]]);
    } finally {
      mockCloudFormationSend.mockImplementation(fallback);
      clearCreateOnlyPropertiesCache();
      clearWriteOnlyPropertiesCache();
    }
  });
});

describe('isPlainReferenceTo (go-to-k/cdkd#4701)', () => {
  const BUCKET = 'AWS::S3::Bucket';
  it.each<[string, unknown, string | undefined, boolean]>([
    ['Ref of the id', { Ref: 'T' }, BUCKET, true],
    ['Ref of the id, producer a custom resource (its physical id is no NoEcho value)', { Ref: 'T' }, 'Custom::X', true],
    ['Ref of another id', { Ref: 'T2' }, BUCKET, false],
    ['GetAtt array', { 'Fn::GetAtt': ['T', 'Arn'] }, BUCKET, true],
    ['GetAtt string', { 'Fn::GetAtt': 'T.Arn' }, BUCKET, true],
    ['GetAtt string of a longer id', { 'Fn::GetAtt': 'T2.Arn' }, BUCKET, false],
    ['GetAtt string with no attribute', { 'Fn::GetAtt': 'T.' }, BUCKET, false],
    ['GetAtt array of another id', { 'Fn::GetAtt': ['T2', 'Arn'] }, BUCKET, false],
    ['GetAtt array with a computed attribute', { 'Fn::GetAtt': ['T', { Ref: 'A' }] }, BUCKET, false],
    ['GetAtt array of three', { 'Fn::GetAtt': ['T', 'Arn', 'x'] }, BUCKET, false],
    ['GetAtt with an unknown producer type', { 'Fn::GetAtt': ['T', 'Arn'] }, undefined, false],
    ['GetAtt of a custom resource', { 'Fn::GetAtt': ['T', 'Arn'] }, 'Custom::X', false],
    ['GetAtt of a nested stack', { 'Fn::GetAtt': ['T', 'Outputs.X'] }, 'AWS::CloudFormation::Stack', false],
    ['a two-key object', { Ref: 'T', Other: 1 }, BUCKET, false],
    ['Fn::Join around the Ref', { 'Fn::Join': ['', [{ Ref: 'T' }]] }, BUCKET, false],
    ['Fn::Sub of the id', { 'Fn::Sub': '${T}' }, BUCKET, false],
    ['an array holding the Ref', [{ Ref: 'T' }], BUCKET, false],
    ['a literal', 'T', BUCKET, false],
    ['null', null, BUCKET, false],
  ])('%s', (_name, value, type, expected) => {
    expect(isPlainReferenceTo(value, 'T', type)).toBe(expected);
  });
});

describe('a target whose fixed name is its physical id keeps it (go-to-k/cdkd#4383 round 3)', () => {
  // A stateful parameter whose create-only `Name` embeds the target's id.
  const reader = {
    Type: 'AWS::SSM::Parameter',
    Properties: { Name: { 'Fn::Sub': '/app/${Target}' }, Type: 'String', Value: 'v' },
  };
  const readerRecord = record('AWS::SSM::Parameter', { Name: '/app/x', Type: 'String', Value: 'v' });

  it('a fixed-name function: its readers are neither listed nor refused', async () => {
    const template: CloudFormationTemplate = {
      Resources: {
        Target: { Type: 'AWS::Lambda::Function', Properties: { FunctionName: 'my-fn' } },
        Param: reader,
      },
    };
    const state = stateOf({
      Target: { ...record('AWS::Lambda::Function'), physicalId: 'my-fn' },
      Param: readerRecord,
    });
    const input = { template, state, targetIds: ['Target'] };
    expect(await findReplacedReadersOfRecreateTargets(input)).toEqual([]);
    await expect(
      refuseStatefulReplacedReaders({ ...input, conditions: {}, forceStatefulRecreation: false })
    ).resolves.toBeUndefined();
  });

  it('an AWS-assigned id: the same reader is refused', async () => {
    const template: CloudFormationTemplate = {
      Resources: {
        Target: { Type: 'AWS::EC2::SecurityGroup', Properties: { GroupDescription: 'sg' } },
        Param: reader,
      },
    };
    const state = stateOf({
      Target: { ...record('AWS::EC2::SecurityGroup'), physicalId: 'sg-123' },
      Param: readerRecord,
    });
    await expect(
      refuseStatefulReplacedReaders({
        template,
        state,
        targetIds: ['Target'],
        conditions: {},
        forceStatefulRecreation: false,
      })
    ).rejects.toMatchObject({ code: 'STATEFUL_REPLACE_BLOCKED' });
  });

  it.each([
    ['a computed name', { FunctionName: { 'Fn::Sub': '${AWS::StackName}-fn' } }, 'S-fn'],
    ['no name (cdkd generates one)', {}, 'S-Target-ABC'],
    ['a literal name the record does not hold', { FunctionName: 'my-fn' }, 'other-fn'],
  ])('%s is not known to keep its id, so the reader is refused', async (_, props, physicalId) => {
    const template: CloudFormationTemplate = {
      Resources: {
        Target: { Type: 'AWS::Lambda::Function', Properties: props },
        Param: reader,
      },
    };
    const state = stateOf({
      Target: { ...record('AWS::Lambda::Function'), physicalId },
      Param: readerRecord,
    });
    await expect(
      refuseStatefulReplacedReaders({
        template,
        state,
        targetIds: ['Target'],
        conditions: {},
        forceStatefulRecreation: false,
      })
    ).rejects.toMatchObject({ code: 'STATEFUL_REPLACE_BLOCKED' });
  });

  it('a type whose provider rewrites the sent name is not trusted to keep it', async () => {
    const template: CloudFormationTemplate = {
      Resources: {
        Target: { Type: 'AWS::IAM::Role', Properties: { RoleName: 'my-role' } },
        Param: reader,
      },
    };
    const state = stateOf({
      Target: { ...record('AWS::IAM::Role'), physicalId: 'my-role' },
      Param: readerRecord,
    });
    expect(
      (await findReplacedReadersOfRecreateTargets({ template, state, targetIds: ['Target'] })).map(
        (r) => r.logicalId
      )
    ).toEqual(['Param']);
  });
});

describe('a stable target is excluded per reference, not per reader (go-to-k/cdkd#4383 round 4)', () => {
  // A fixed-name table keeps its physical id across the recreate, but not its
  // stream: `StreamArn` carries a new timestamp label.
  const table = {
    Type: 'AWS::DynamoDB::Table',
    Properties: { TableName: 'orders' },
  };
  const tableRecord = { ...record('AWS::DynamoDB::Table'), physicalId: 'orders' };
  const run = (name: unknown) => {
    const template: CloudFormationTemplate = {
      Resources: {
        Table: table,
        Param: { Type: 'AWS::SSM::Parameter', Properties: { Name: name, Type: 'String', Value: 'v' } },
      },
    };
    const state = stateOf({ Table: tableRecord, Param: record('AWS::SSM::Parameter') });
    return {
      list: () => findReplacedReadersOfRecreateTargets({ template, state, targetIds: ['Table'] }),
      refuse: () =>
        refuseStatefulReplacedReaders({
          template,
          state,
          targetIds: ['Table'],
          conditions: {},
          forceStatefulRecreation: false,
        }),
    };
  };

  it.each([
    ['Fn::GetAtt [Table, StreamArn]', { 'Fn::GetAtt': ['Table', 'StreamArn'] }],
    ['Fn::GetAtt "Table.StreamArn"', { 'Fn::GetAtt': 'Table.StreamArn' }],
    ['${Table.StreamArn} in an Fn::Sub', { 'Fn::Sub': '/app/${Table.StreamArn}' }],
    ['a Ref AND a GetAtt in one property', { 'Fn::Join': ['', [{ Ref: 'Table' }, { 'Fn::GetAtt': ['Table', 'StreamArn'] }]] }],
  ])('a stateful reader via %s is listed and refused', async (_, name) => {
    const { list, refuse } = run(name);
    expect((await list()).map((r) => r.logicalId)).toEqual(['Param']);
    await expect(refuse()).rejects.toMatchObject({ code: 'STATEFUL_REPLACE_BLOCKED' });
  });

  it.each([
    ['Ref', { Ref: 'Table' }],
    ['${Table} in an Fn::Sub', { 'Fn::Sub': '/app/${Table}' }],
    ['${T} bound to a Ref in an Fn::Sub variable map', { 'Fn::Sub': ['/app/${T}', { T: { Ref: 'Table' } }] }],
  ])('the same reader via %s is neither listed nor refused', async (_, name) => {
    const { list, refuse } = run(name);
    expect(await list()).toEqual([]);
    await expect(refuse()).resolves.toBeUndefined();
  });
});

describe('a template-controlled __proto__ key (go-to-k/cdkd#4383 round 3)', () => {
  it('keeps a reference held under a __proto__ key inside an Fn::If-resolved value', async () => {
    const template = structuredClone(TEMPLATE);
    template.Resources['Volume']!.Properties!['KmsKeyId'] = JSON.parse(
      '{"__proto__": {"Fn::GetAtt": ["Key", "Arn"]}}'
    ) as unknown;
    await expect(
      refuseStatefulReplacedReaders({
        template,
        state: STATE,
        targetIds: ['Key'],
        conditions: {},
        forceStatefulRecreation: false,
      })
    ).rejects.toMatchObject({ code: 'STATEFUL_REPLACE_BLOCKED' });
  });

  it('walks a resource whose logical id is __proto__', async () => {
    const template: CloudFormationTemplate = {
      Resources: JSON.parse(
        JSON.stringify({ Key: TEMPLATE.Resources['Key'] }).replace(/}$/, ',') +
          '"__proto__": ' +
          JSON.stringify(TEMPLATE.Resources['Volume']) +
          '}'
      ) as CloudFormationTemplate['Resources'],
    };
    const state = stateOf({ Key: record('AWS::KMS::Key') });
    Object.defineProperty(state.resources, '__proto__', {
      value: record('AWS::EC2::Volume'),
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const readers = await findReplacedReadersOfRecreateTargets({
      template,
      state,
      targetIds: ['Key'],
    });
    expect(readers.map((r) => r.logicalId)).toEqual(['__proto__']);
  });
});

describe('a state record is read by OWN key only (go-to-k/cdkd#4383 round 4)', () => {
  it('a __proto__ reader with no record is one this deploy creates: not listed', async () => {
    const template: CloudFormationTemplate = {
      Resources: JSON.parse(
        JSON.stringify({ Key: TEMPLATE.Resources['Key'] }).replace(/}$/, ',') +
          '"__proto__": ' +
          JSON.stringify(TEMPLATE.Resources['Volume']) +
          '}'
      ) as CloudFormationTemplate['Resources'],
    };
    const readers = await findReplacedReadersOfRecreateTargets({
      template,
      state: stateOf({ Key: record('AWS::KMS::Key') }),
      targetIds: ['Key'],
    });
    expect(readers).toEqual([]);
  });
});

describe('refuseStatefulReplacedReaders (go-to-k/cdkd#4383)', () => {
  const refuse = (
    template: CloudFormationTemplate,
    conditions: Record<string, boolean> = {},
    forceStatefulRecreation = false
  ): Promise<void> =>
    refuseStatefulReplacedReaders({
      template,
      state: STATE,
      targetIds: ['Key'],
      conditions,
      forceStatefulRecreation,
    });

  it('refuses a stateful replaced reader without --force-stateful-recreation, naming only it', async () => {
    const error = (await refuse(TEMPLATE).catch((e: unknown) => e)) as {
      code?: string;
      message?: string;
    };
    expect(error.code).toBe('STATEFUL_REPLACE_BLOCKED');
    // Declared non-retryable, as the engine's sibling refusals are.
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(error.message?.split('\n')).toContain(
      '  - Volume (AWS::EC2::Volume) reads Key via KmsKeyId'
    );
    expect(error.message).not.toContain('NamedByKey');
  });

  it('passes under --force-stateful-recreation', async () => {
    await expect(refuse(TEMPLATE, {}, true)).resolves.toBeUndefined();
  });

  it('passes when no replaced reader is stateful', async () => {
    const template = structuredClone(TEMPLATE);
    delete template.Resources['Volume'];
    await expect(refuse(template)).resolves.toBeUndefined();
  });

  it('passes a stateful reader whose Condition is false: the deploy deletes it', async () => {
    const template = structuredClone(TEMPLATE);
    template.Resources['Volume']!.Condition = 'WithVolume';
    await expect(refuse(template, { WithVolume: false })).resolves.toBeUndefined();
    // ...and refuses it when the condition holds.
    await expect(refuse(template, { WithVolume: true })).rejects.toMatchObject({
      code: 'STATEFUL_REPLACE_BLOCKED',
    });
  });

  it('reads only the taken Fn::If arm of a create-only reference', async () => {
    const template = structuredClone(TEMPLATE);
    template.Resources['Volume']!.Properties!['KmsKeyId'] = {
      'Fn::If': ['UseKey', { 'Fn::GetAtt': ['Key', 'Arn'] }, 'alias/aws/ebs'],
    };
    await expect(refuse(template, { UseKey: false })).resolves.toBeUndefined();
    await expect(refuse(template, { UseKey: true })).rejects.toMatchObject({
      code: 'STATEFUL_REPLACE_BLOCKED',
    });
  });

  it('counts both arms when the condition is not in the bag (the prompt\'s raw read)', async () => {
    const template = structuredClone(TEMPLATE);
    template.Resources['Volume']!.Properties!['KmsKeyId'] = {
      'Fn::If': ['UseKey', 'alias/aws/ebs', { 'Fn::GetAtt': ['Key', 'Arn'] }],
    };
    const readers = await findReplacedReadersOfRecreateTargets({
      template,
      state: STATE,
      targetIds: ['Key'],
    });
    expect(readers.map((r) => r.logicalId)).toContain('Volume');
  });
});
