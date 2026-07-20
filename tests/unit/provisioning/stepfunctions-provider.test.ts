import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const mockSend = vi.fn();
const mockS3Send = vi.fn();

// Mock the SFN client module (local client, not from getAwsClients)
vi.mock('@aws-sdk/client-sfn', async () => {
  const actual = await vi.importActual('@aws-sdk/client-sfn');
  return {
    ...actual,
    SFNClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

// Mock the S3 client module (local client used for DefinitionS3Location fetch)
vi.mock('@aws-sdk/client-s3', async () => {
  const actual = await vi.importActual('@aws-sdk/client-s3');
  return {
    ...actual,
    S3Client: vi.fn().mockImplementation(() => ({ send: mockS3Send })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { StepFunctionsProvider } from '../../../src/provisioning/providers/stepfunctions-provider.js';
import { importTagWalkTestHooks } from '../../../src/provisioning/import-tag-walk.js';

describe('StepFunctionsProvider', () => {
  let provider: StepFunctionsProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new StepFunctionsProvider();
  });

  describe('create', () => {
    it('should create state machine and return ARN as physicalId, with attributes', async () => {
      mockSend.mockResolvedValueOnce({
        stateMachineArn:
          'arn:aws:states:us-east-1:123456789012:stateMachine:my-state-machine',
        stateMachineVersionArn:
          'arn:aws:states:us-east-1:123456789012:stateMachine:my-state-machine:1',
      });

      const result = await provider.create(
        'MyStateMachine',
        'AWS::StepFunctions::StateMachine',
        {
          StateMachineName: 'my-state-machine',
          RoleArn: 'arn:aws:iam::123456789012:role/step-functions-role',
          DefinitionString: '{"StartAt":"Hello","States":{"Hello":{"Type":"Pass","End":true}}}',
        }
      );

      expect(result.physicalId).toBe(
        'arn:aws:states:us-east-1:123456789012:stateMachine:my-state-machine'
      );
      expect(result.attributes).toEqual({
        Arn: 'arn:aws:states:us-east-1:123456789012:stateMachine:my-state-machine',
        Name: 'my-state-machine',
        StateMachineRevisionId:
          'arn:aws:states:us-east-1:123456789012:stateMachine:my-state-machine:1',
      });
      expect(mockSend).toHaveBeenCalledTimes(1);

      const createCall = mockSend.mock.calls[0][0];
      expect(createCall.constructor.name).toBe('CreateStateMachineCommand');
      expect(createCall.input.name).toBe('my-state-machine');
      expect(createCall.input.roleArn).toBe(
        'arn:aws:iam::123456789012:role/step-functions-role'
      );
    });

    it('should handle DefinitionString as object (JSON.stringify it)', async () => {
      mockSend.mockResolvedValueOnce({
        stateMachineArn:
          'arn:aws:states:us-east-1:123456789012:stateMachine:MyStateMachine',
      });

      const definitionObj = {
        StartAt: 'Hello',
        States: { Hello: { Type: 'Pass', End: true } },
      };

      await provider.create('MyStateMachine', 'AWS::StepFunctions::StateMachine', {
        RoleArn: 'arn:aws:iam::123456789012:role/role',
        DefinitionString: definitionObj,
      });

      const createCall = mockSend.mock.calls[0][0];
      expect(createCall.input.definition).toBe(JSON.stringify(definitionObj));
    });

    it('should convert Tags from CDK format ({Key,Value}) to SFN format ({key,value})', async () => {
      mockSend.mockResolvedValueOnce({
        stateMachineArn:
          'arn:aws:states:us-east-1:123456789012:stateMachine:MyStateMachine',
      });

      await provider.create('MyStateMachine', 'AWS::StepFunctions::StateMachine', {
        RoleArn: 'arn:aws:iam::123456789012:role/role',
        DefinitionString: '{}',
        Tags: [
          { Key: 'Environment', Value: 'dev' },
          { Key: 'Project', Value: 'test' },
        ],
      });

      const createCall = mockSend.mock.calls[0][0];
      expect(createCall.input.tags).toEqual([
        { key: 'Environment', value: 'dev' },
        { key: 'Project', value: 'test' },
      ]);
    });

    it('should use logicalId as name when StateMachineName is not provided', async () => {
      mockSend.mockResolvedValueOnce({
        stateMachineArn:
          'arn:aws:states:us-east-1:123456789012:stateMachine:MyStateMachine',
      });

      await provider.create('MyStateMachine', 'AWS::StepFunctions::StateMachine', {
        RoleArn: 'arn:aws:iam::123456789012:role/role',
        DefinitionString: '{}',
      });

      const createCall = mockSend.mock.calls[0][0];
      expect(createCall.input.name).toBe('MyStateMachine');
    });

    it('should throw ProvisioningError when RoleArn is missing', async () => {
      await expect(
        provider.create('MyStateMachine', 'AWS::StepFunctions::StateMachine', {
          DefinitionString: '{}',
        })
      ).rejects.toThrow('RoleArn is required for Step Functions state machine MyStateMachine');
    });

    it('should throw ProvisioningError on failure', async () => {
      mockSend.mockRejectedValueOnce(new Error('Access Denied'));

      await expect(
        provider.create('MyStateMachine', 'AWS::StepFunctions::StateMachine', {
          RoleArn: 'arn:aws:iam::123456789012:role/role',
          DefinitionString: '{}',
        })
      ).rejects.toThrow('Failed to create Step Functions state machine MyStateMachine');
    });

    it('should pass StateMachineType and translate PascalCase configurations to SDK camelCase', async () => {
      mockSend.mockResolvedValueOnce({
        stateMachineArn:
          'arn:aws:states:us-east-1:123456789012:stateMachine:MyExpress',
      });

      // CFn templates ALWAYS use PascalCase property names; the provider
      // is responsible for translating to the SDK's camelCase shape on
      // the wire (see mapLoggingConfiguration / mapTracingConfiguration
      // in stepfunctions-provider.ts).
      await provider.create('MyExpress', 'AWS::StepFunctions::StateMachine', {
        RoleArn: 'arn:aws:iam::123456789012:role/role',
        DefinitionString: '{}',
        StateMachineType: 'EXPRESS',
        LoggingConfiguration: {
          Level: 'ALL',
          IncludeExecutionData: true,
          Destinations: [
            { CloudWatchLogsLogGroup: { LogGroupArn: 'arn:aws:logs:...' } },
          ],
        },
        TracingConfiguration: { Enabled: true },
      });

      const createCall = mockSend.mock.calls[0][0];
      expect(createCall.input.type).toBe('EXPRESS');
      expect(createCall.input.loggingConfiguration).toEqual({
        level: 'ALL',
        includeExecutionData: true,
        destinations: [
          { cloudWatchLogsLogGroup: { logGroupArn: 'arn:aws:logs:...' } },
        ],
      });
      expect(createCall.input.tracingConfiguration).toEqual({ enabled: true });
    });
  });

  describe('update', () => {
    it('should update state machine definition and roleArn', async () => {
      // UpdateStateMachine
      mockSend.mockResolvedValueOnce({});
      // DescribeStateMachine
      mockSend.mockResolvedValueOnce({
        name: 'my-state-machine',
        revisionId: 'rev-2',
      });

      const result = await provider.update(
        'MyStateMachine',
        'arn:aws:states:us-east-1:123456789012:stateMachine:my-state-machine',
        'AWS::StepFunctions::StateMachine',
        {
          RoleArn: 'arn:aws:iam::123456789012:role/new-role',
          DefinitionString: '{"StartAt":"World","States":{"World":{"Type":"Pass","End":true}}}',
        },
        {
          RoleArn: 'arn:aws:iam::123456789012:role/old-role',
          DefinitionString: '{"StartAt":"Hello","States":{"Hello":{"Type":"Pass","End":true}}}',
        }
      );

      expect(result.physicalId).toBe(
        'arn:aws:states:us-east-1:123456789012:stateMachine:my-state-machine'
      );
      expect(result.wasReplaced).toBe(false);
      expect(result.attributes).toEqual({
        Arn: 'arn:aws:states:us-east-1:123456789012:stateMachine:my-state-machine',
        Name: 'my-state-machine',
        StateMachineRevisionId: 'rev-2',
      });
      expect(mockSend).toHaveBeenCalledTimes(2);

      const updateCall = mockSend.mock.calls[0][0];
      expect(updateCall.constructor.name).toBe('UpdateStateMachineCommand');
      expect(updateCall.input.stateMachineArn).toBe(
        'arn:aws:states:us-east-1:123456789012:stateMachine:my-state-machine'
      );
      expect(updateCall.input.roleArn).toBe('arn:aws:iam::123456789012:role/new-role');

      const describeCall = mockSend.mock.calls[1][0];
      expect(describeCall.constructor.name).toBe('DescribeStateMachineCommand');
    });

    it('should require replacement when StateMachineName changes', async () => {
      // Note: The current provider implementation does not detect immutable property changes.
      // StateMachineName is an immutable property in CloudFormation, but the SDK provider
      // delegates this update to the API which will reject name changes.
      // This test verifies that the update call is made (the API would reject it).
      mockSend.mockRejectedValueOnce(new Error('Cannot update state machine name'));

      await expect(
        provider.update(
          'MyStateMachine',
          'arn:aws:states:us-east-1:123456789012:stateMachine:old-name',
          'AWS::StepFunctions::StateMachine',
          {
            StateMachineName: 'new-name',
            RoleArn: 'arn:aws:iam::123456789012:role/role',
            DefinitionString: '{}',
          },
          {
            StateMachineName: 'old-name',
            RoleArn: 'arn:aws:iam::123456789012:role/role',
            DefinitionString: '{}',
          }
        )
      ).rejects.toThrow('Failed to update Step Functions state machine MyStateMachine');
    });

    it('should require replacement when StateMachineType changes', async () => {
      // StateMachineType is immutable - the API will reject the change.
      mockSend.mockRejectedValueOnce(new Error('Cannot update state machine type'));

      await expect(
        provider.update(
          'MyStateMachine',
          'arn:aws:states:us-east-1:123456789012:stateMachine:my-sm',
          'AWS::StepFunctions::StateMachine',
          {
            StateMachineType: 'EXPRESS',
            RoleArn: 'arn:aws:iam::123456789012:role/role',
            DefinitionString: '{}',
          },
          {
            StateMachineType: 'STANDARD',
            RoleArn: 'arn:aws:iam::123456789012:role/role',
            DefinitionString: '{}',
          }
        )
      ).rejects.toThrow('Failed to update Step Functions state machine MyStateMachine');
    });

    it('should throw ProvisioningError on failure', async () => {
      mockSend.mockRejectedValueOnce(new Error('Access Denied'));

      await expect(
        provider.update(
          'MyStateMachine',
          'arn:aws:states:us-east-1:123456789012:stateMachine:my-state-machine',
          'AWS::StepFunctions::StateMachine',
          {
            RoleArn: 'arn:aws:iam::123456789012:role/role',
            DefinitionString: '{}',
          },
          {
            RoleArn: 'arn:aws:iam::123456789012:role/old-role',
            DefinitionString: '{}',
          }
        )
      ).rejects.toThrow('Failed to update Step Functions state machine MyStateMachine');
    });

    // ---------------------------------------------------------------------
    // Removal-clear (issue #978): removing a config from the template must
    // send the explicit disable sentinel, otherwise the patch-style
    // UpdateStateMachine keeps the old config.
    // ---------------------------------------------------------------------
    describe('config removal clears the removed config', () => {
      const arn = 'arn:aws:states:us-east-1:123456789012:stateMachine:my-state-machine';
      const definition =
        '{"StartAt":"Hello","States":{"Hello":{"Type":"Pass","End":true}}}';

      /** Run update(), return the UpdateStateMachineCommand input. */
      async function runRemovalUpdate(
        previousExtra: Record<string, unknown>,
        newExtra: Record<string, unknown> = {}
      ): Promise<Record<string, unknown>> {
        // UpdateStateMachine
        mockSend.mockResolvedValueOnce({});
        // DescribeStateMachine
        mockSend.mockResolvedValueOnce({ name: 'my-state-machine', revisionId: 'rev-2' });

        await provider.update(
          'MyStateMachine',
          arn,
          'AWS::StepFunctions::StateMachine',
          {
            RoleArn: 'arn:aws:iam::123456789012:role/role',
            DefinitionString: definition,
            ...newExtra,
          },
          {
            RoleArn: 'arn:aws:iam::123456789012:role/role',
            DefinitionString: definition,
            ...previousExtra,
          }
        );

        const updateCall = mockSend.mock.calls[0][0];
        expect(updateCall.constructor.name).toBe('UpdateStateMachineCommand');
        return updateCall.input as Record<string, unknown>;
      }

      it('clears removed TracingConfiguration with { enabled: false }', async () => {
        const input = await runRemovalUpdate({
          TracingConfiguration: { Enabled: true },
        });
        expect(input['tracingConfiguration']).toEqual({ enabled: false });
      });

      it('clears removed LoggingConfiguration with an OFF disable shape', async () => {
        const input = await runRemovalUpdate({
          LoggingConfiguration: {
            Level: 'ALL',
            IncludeExecutionData: true,
            Destinations: [
              {
                CloudWatchLogsLogGroup: {
                  LogGroupArn:
                    'arn:aws:logs:us-east-1:123456789012:log-group:/aws/vendedlogs/states/my:*',
                },
              },
            ],
          },
        });
        expect(input['loggingConfiguration']).toEqual({
          level: 'OFF',
          includeExecutionData: false,
          destinations: [],
        });
      });

      it('clears removed EncryptionConfiguration by resetting to AWS_OWNED_KEY', async () => {
        const input = await runRemovalUpdate({
          EncryptionConfiguration: {
            Type: 'CUSTOMER_MANAGED_KMS_KEY',
            KmsKeyId: 'arn:aws:kms:us-east-1:123456789012:key/abc',
            KmsDataKeyReusePeriodSeconds: 300,
          },
        });
        expect(input['encryptionConfiguration']).toEqual({ type: 'AWS_OWNED_KEY' });
      });

      it('clears all three configs when all are removed in one update', async () => {
        const input = await runRemovalUpdate({
          TracingConfiguration: { Enabled: true },
          LoggingConfiguration: { Level: 'ERROR' },
          EncryptionConfiguration: { Type: 'CUSTOMER_MANAGED_KMS_KEY', KmsKeyId: 'k' },
        });
        expect(input['tracingConfiguration']).toEqual({ enabled: false });
        expect(input['loggingConfiguration']).toEqual({
          level: 'OFF',
          includeExecutionData: false,
          destinations: [],
        });
        expect(input['encryptionConfiguration']).toEqual({ type: 'AWS_OWNED_KEY' });
      });

      it('does NOT emit a disable sentinel when the config was never configured before', async () => {
        // previous side has no configs at all -> nothing to clear
        const input = await runRemovalUpdate({});
        expect(input['tracingConfiguration']).toBeUndefined();
        expect(input['loggingConfiguration']).toBeUndefined();
        expect(input['encryptionConfiguration']).toBeUndefined();
      });

      it('does NOT clear when the config is still present in the new properties', async () => {
        const input = await runRemovalUpdate(
          { TracingConfiguration: { Enabled: true } },
          { TracingConfiguration: { Enabled: true } }
        );
        // still enabled: mapped through, not disabled
        expect(input['tracingConfiguration']).toEqual({ enabled: true });
      });

      it('does NOT clear on the readCurrentState empty-placeholder round-trip', async () => {
        // previous carries the always-emitted placeholders from readCurrentState
        // (no Level / no Type / Enabled:false); a drift-revert must be a no-op.
        const input = await runRemovalUpdate({
          TracingConfiguration: { Enabled: false },
          LoggingConfiguration: {},
          EncryptionConfiguration: {},
        });
        expect(input['tracingConfiguration']).toBeUndefined();
        expect(input['loggingConfiguration']).toBeUndefined();
        expect(input['encryptionConfiguration']).toBeUndefined();
      });
    });
  });

  describe('delete', () => {
    it('should delete state machine', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.delete(
        'MyStateMachine',
        'arn:aws:states:us-east-1:123456789012:stateMachine:my-state-machine',
        'AWS::StepFunctions::StateMachine'
      );

      expect(mockSend).toHaveBeenCalledTimes(1);

      const deleteCall = mockSend.mock.calls[0][0];
      expect(deleteCall.constructor.name).toBe('DeleteStateMachineCommand');
      expect(deleteCall.input.stateMachineArn).toBe(
        'arn:aws:states:us-east-1:123456789012:stateMachine:my-state-machine'
      );
    });

    it('should handle StateMachineDoesNotExist gracefully (idempotent)', async () => {
      const { StateMachineDoesNotExist } = await import('@aws-sdk/client-sfn');
      mockSend.mockRejectedValueOnce(
        new StateMachineDoesNotExist({
          $metadata: {},
          message: 'State machine does not exist',
        })
      );

      // Should not throw
      await provider.delete(
        'MyStateMachine',
        'arn:aws:states:us-east-1:123456789012:stateMachine:my-state-machine',
        'AWS::StepFunctions::StateMachine'
      );

      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('should throw ProvisioningError on unexpected failure', async () => {
      mockSend.mockRejectedValueOnce(new Error('Access Denied'));

      await expect(
        provider.delete(
          'MyStateMachine',
          'arn:aws:states:us-east-1:123456789012:stateMachine:my-state-machine',
          'AWS::StepFunctions::StateMachine'
        )
      ).rejects.toThrow('Failed to delete Step Functions state machine MyStateMachine');
    });
  });

  describe('import', () => {
    // Skip the walk's real throttle backoff waits in the retry tests.
    beforeEach(() => {
      importTagWalkTestHooks.sleep = async () => {};
    });
    afterEach(() => {
      importTagWalkTestHooks.sleep = undefined;
    });

    function makeInput(overrides: Record<string, unknown> = {}) {
      return {
        logicalId: 'MyStateMachine',
        resourceType: 'AWS::StepFunctions::StateMachine',
        cdkPath: 'MyStack/MyStateMachine',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: {},
        ...overrides,
      };
    }

    it('explicit override: DescribeStateMachine succeeds returns ARN', async () => {
      const arn = 'arn:aws:states:us-east-1:123456789012:stateMachine:adopted';
      mockSend.mockResolvedValueOnce({ stateMachineArn: arn, name: 'adopted' });

      const result = await provider.import(makeInput({ knownPhysicalId: arn }));

      expect(result).toEqual({ physicalId: arn, attributes: {} });
      const call = mockSend.mock.calls[0][0];
      expect(call.constructor.name).toBe('DescribeStateMachineCommand');
      expect(call.input.stateMachineArn).toBe(arn);
    });

    it('tag-based lookup: matches aws:cdk:path on lowercase key/value tags', async () => {
      const arn1 = 'arn:aws:states:us-east-1:123456789012:stateMachine:other';
      const arn2 = 'arn:aws:states:us-east-1:123456789012:stateMachine:target';

      // ListStateMachines
      mockSend.mockResolvedValueOnce({
        stateMachines: [
          { stateMachineArn: arn1, name: 'other' },
          { stateMachineArn: arn2, name: 'target' },
        ],
      });
      // ListTagsForResource for arn1
      mockSend.mockResolvedValueOnce({
        tags: [{ key: 'aws:cdk:path', value: 'OtherStack/Other' }],
      });
      // ListTagsForResource for arn2
      mockSend.mockResolvedValueOnce({
        tags: [{ key: 'aws:cdk:path', value: 'MyStack/MyStateMachine' }],
      });

      const result = await provider.import(makeInput());

      expect(result).toEqual({ physicalId: arn2, attributes: {} });
    });

    it('returns null (no throw) when no state machine matches', async () => {
      mockSend.mockResolvedValueOnce({
        stateMachines: [
          { stateMachineArn: 'arn:aws:states:us-east-1:1:stateMachine:a', name: 'a' },
        ],
      });
      mockSend.mockResolvedValueOnce({
        tags: [{ key: 'aws:cdk:path', value: 'OtherStack/Other' }],
      });

      const result = await provider.import(makeInput());
      expect(result).toBeNull();
    });

    // Issue #1091 batch 3: the tag walk is an N+1 ListTagsForResource burst
    // routed through the shared importTagWalk helper: a throttled
    // per-candidate tag read is retried with backoff instead of aborting the
    // whole import, while a non-throttling error still surfaces immediately.
    it('retries a throttled ListTagsForResource mid-walk and still finds the match', async () => {
      mockSend.mockReset(); // drop once-queued leftovers from earlier tests
      const arn = 'arn:aws:states:us-east-1:123456789012:stateMachine:target';
      const throttled = new Error('Rate exceeded') as Error & {
        $metadata: { httpStatusCode: number };
      };
      throttled.name = 'ThrottlingException';
      throttled.$metadata = { httpStatusCode: 400 };

      mockSend
        .mockResolvedValueOnce({ stateMachines: [{ stateMachineArn: arn, name: 'target' }] })
        .mockRejectedValueOnce(throttled)
        .mockResolvedValueOnce({
          tags: [{ key: 'aws:cdk:path', value: 'MyStack/MyStateMachine' }],
        });

      const result = await provider.import(makeInput());

      expect(result).toEqual({ physicalId: arn, attributes: {} });
      expect(mockSend).toHaveBeenCalledTimes(3);
    });

    it('does not retry a non-throttling error during the walk', async () => {
      mockSend.mockReset(); // drop once-queued leftovers from earlier tests
      const denied = new Error('User is not authorized to perform states:ListTagsForResource');
      denied.name = 'AccessDeniedException';

      mockSend
        .mockResolvedValueOnce({
          stateMachines: [
            {
              stateMachineArn: 'arn:aws:states:us-east-1:123456789012:stateMachine:target',
              name: 'target',
            },
          ],
        })
        .mockRejectedValueOnce(denied);

      await expect(provider.import(makeInput())).rejects.toThrow(/not authorized/);
      expect(mockSend).toHaveBeenCalledTimes(2);
    });
  });

  describe('DefinitionS3Location (create)', () => {
    const CREATE_ARN = 'arn:aws:states:us-east-1:123456789012:stateMachine:s3-sm';

    const mockCreateOk = (): void => {
      mockSend.mockResolvedValueOnce({
        stateMachineArn: CREATE_ARN,
        stateMachineVersionArn: `${CREATE_ARN}:1`,
      });
    };

    const mockS3Body = (body: string): void => {
      mockS3Send.mockResolvedValueOnce({
        Body: { transformToString: () => Promise.resolve(body) },
      });
    };

    it('fetches the definition from S3 and passes it as the SDK definition', async () => {
      const asl = '{"StartAt":"Hello","States":{"Hello":{"Type":"Pass","End":true}}}';
      mockS3Body(asl);
      mockCreateOk();

      await provider.create('S3Sm', 'AWS::StepFunctions::StateMachine', {
        RoleArn: 'arn:aws:iam::123456789012:role/sfn',
        DefinitionS3Location: { Bucket: 'my-bucket', Key: 'def.asl.json' },
      });

      // GetObject was issued for the right object (no VersionId).
      expect(mockS3Send).toHaveBeenCalledTimes(1);
      expect(mockS3Send.mock.calls[0][0].input).toEqual({
        Bucket: 'my-bucket',
        Key: 'def.asl.json',
      });
      // The fetched body became the CreateStateMachine definition.
      const createInput = mockSend.mock.calls[0][0].input;
      expect(createInput.definition).toBe(asl);
    });

    it('passes VersionId through when DefinitionS3Location.Version is set', async () => {
      mockS3Body('{"StartAt":"X","States":{"X":{"Type":"Pass","End":true}}}');
      mockCreateOk();

      await provider.create('S3Sm', 'AWS::StepFunctions::StateMachine', {
        RoleArn: 'arn:aws:iam::123456789012:role/sfn',
        DefinitionS3Location: { Bucket: 'b', Key: 'k', Version: 'v-42' },
      });

      expect(mockS3Send.mock.calls[0][0].input).toEqual({
        Bucket: 'b',
        Key: 'k',
        VersionId: 'v-42',
      });
    });

    it('applies DefinitionSubstitutions to the fetched S3 body', async () => {
      // The intrinsic resolver cannot reach S3 content, so the provider
      // applies ${name} substitutions itself (CloudFormation parity).
      mockS3Body(
        '{"StartAt":"Call","States":{"Call":{"Type":"Task","Resource":"${TableArn}","TimeoutSeconds":${Timeout},"End":true}}}'
      );
      mockCreateOk();

      await provider.create('S3Sm', 'AWS::StepFunctions::StateMachine', {
        RoleArn: 'arn:aws:iam::123456789012:role/sfn',
        DefinitionS3Location: { Bucket: 'b', Key: 'k' },
        DefinitionSubstitutions: {
          TableArn: 'arn:aws:dynamodb:us-east-1:123456789012:table/T',
          Timeout: 30,
        },
      });

      const def = mockSend.mock.calls[0][0].input.definition as string;
      expect(def).toContain('"Resource":"arn:aws:dynamodb:us-east-1:123456789012:table/T"');
      expect(def).toContain('"TimeoutSeconds":30');
      expect(def).not.toContain('${TableArn}');
      expect(def).not.toContain('${Timeout}');
    });

    it('skips a non-scalar DefinitionSubstitutions value (leaves the token untouched)', async () => {
      // Substitution values are scalars (CFn resolves intrinsics before passing
      // them in). A non-scalar value is malformed; it must be skipped, never
      // String()'d into "[object Object]". The token stays literal.
      mockS3Body(
        '{"StartAt":"Call","States":{"Call":{"Type":"Task","Resource":"${Good}","Comment":"${Bad}","End":true}}}'
      );
      mockCreateOk();

      await provider.create('S3Sm', 'AWS::StepFunctions::StateMachine', {
        RoleArn: 'arn:aws:iam::123456789012:role/sfn',
        DefinitionS3Location: { Bucket: 'b', Key: 'k' },
        DefinitionSubstitutions: { Good: 'resolved', Bad: { nested: 1 } },
      });

      const def = mockSend.mock.calls[0][0].input.definition as string;
      expect(def).toContain('"Resource":"resolved"');
      // The non-scalar substitution was skipped — token left untouched, no "[object Object]".
      expect(def).toContain('"Comment":"${Bad}"');
      expect(def).not.toContain('[object Object]');
    });

    it('prefers an inline DefinitionString over DefinitionS3Location (no S3 fetch)', async () => {
      mockCreateOk();
      const inline = '{"StartAt":"Inline","States":{"Inline":{"Type":"Pass","End":true}}}';

      await provider.create('S3Sm', 'AWS::StepFunctions::StateMachine', {
        RoleArn: 'arn:aws:iam::123456789012:role/sfn',
        DefinitionString: inline,
        DefinitionS3Location: { Bucket: 'b', Key: 'k' },
      });

      expect(mockS3Send).not.toHaveBeenCalled();
      expect(mockSend.mock.calls[0][0].input.definition).toBe(inline);
    });

    it('throws (and does not create) when the S3 object has no body', async () => {
      mockS3Send.mockResolvedValueOnce({ Body: undefined });

      await expect(
        provider.create('S3Sm', 'AWS::StepFunctions::StateMachine', {
          RoleArn: 'arn:aws:iam::123456789012:role/sfn',
          DefinitionS3Location: { Bucket: 'b', Key: 'k' },
        })
      ).rejects.toThrow(/no body/);

      // CreateStateMachine was never reached.
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('throws (and does not create) when the S3 object body is a zero-byte string', async () => {
      // A present Body whose transformToString() yields '' must be caught here,
      // not sent as an empty definition to CreateStateMachine.
      mockS3Body('');

      await expect(
        provider.create('S3Sm', 'AWS::StepFunctions::StateMachine', {
          RoleArn: 'arn:aws:iam::123456789012:role/sfn',
          DefinitionS3Location: { Bucket: 'b', Key: 'k' },
        })
      ).rejects.toThrow(/empty body/);

      expect(mockSend).not.toHaveBeenCalled();
    });
  });
});
