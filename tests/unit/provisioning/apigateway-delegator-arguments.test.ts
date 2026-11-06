/**
 * Every argument an `ApiGatewayProvider` delegator hands to its companion
 * function (go-to-k/cdkd#5835) is observable here. The other suites exercise
 * the happy paths, where `resourceType` and `physicalId` reach only an error
 * field, a request or a timer, so a delegator that dropped one of them still
 * passed them all. Each case below fails when the matching argument is
 * replaced by `undefined`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    apiGateway: {
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    },
  }),
}));
// `CreateAuthorizer` / `CreateDeployment` go through a client the provider
// builds itself (issue #2080); route it to the same `mockSend`.
vi.mock('@aws-sdk/client-api-gateway', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-api-gateway')>();
  return {
    ...actual,
    APIGatewayClient: vi.fn().mockImplementation(() => ({
      send: (command: unknown) => mockSend(command),
      config: { retryStrategy: () => Promise.resolve(undefined) },
    })),
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
    getLogger: () => ({ child: () => childLogger, debug: vi.fn(), warn: vi.fn() }),
  };
});

import {
  CreateAuthorizerCommand,
  CreateDeploymentCommand,
  CreateResourceCommand,
  DeleteAuthorizerCommand,
  DeleteDeploymentCommand,
  DeleteMethodCommand,
  DeleteResourceCommand,
  DeleteStageCommand,
  UpdateAccountCommand,
} from '@aws-sdk/client-api-gateway';
import {
  ApiGatewayProvider,
  resetApiGatewayCreateRetryStateForTests,
} from '../../../src/provisioning/providers/apigateway-provider.js';

const API = 'api-1';

/** The first command each type's create / delete sends. */
const CREATE_COMMAND: Record<string, new (...args: never[]) => unknown> = {
  'AWS::ApiGateway::Account': UpdateAccountCommand,
  'AWS::ApiGateway::Authorizer': CreateAuthorizerCommand,
  'AWS::ApiGateway::Resource': CreateResourceCommand,
  'AWS::ApiGateway::Deployment': CreateDeploymentCommand,
};
const DELETE_COMMAND: Record<string, new (...args: never[]) => unknown> = {
  'AWS::ApiGateway::Account': UpdateAccountCommand,
  'AWS::ApiGateway::Authorizer': DeleteAuthorizerCommand,
  'AWS::ApiGateway::Resource': DeleteResourceCommand,
  'AWS::ApiGateway::Deployment': DeleteDeploymentCommand,
  'AWS::ApiGateway::Stage': DeleteStageCommand,
  'AWS::ApiGateway::Method': DeleteMethodCommand,
};

describe('ApiGatewayProvider delegator arguments (#5835)', () => {
  let provider: ApiGatewayProvider;

  beforeEach(() => {
    mockSend.mockReset();
    resetApiGatewayCreateRetryStateForTests();
    provider = new ApiGatewayProvider();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('a failed create names its resourceType', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['AWS::ApiGateway::Account', { CloudWatchRoleArn: 'arn:aws:iam::123456789012:role/r' }],
      [
        'AWS::ApiGateway::Authorizer',
        {
          RestApiId: API,
          Name: 'auth',
          Type: 'TOKEN',
          AuthorizerUri: 'arn:aws:apigateway:us-east-1:lambda:path/fn',
        },
      ],
      ['AWS::ApiGateway::Resource', { RestApiId: API, ParentId: 'root', PathPart: 'p' }],
      ['AWS::ApiGateway::Deployment', { RestApiId: API }],
    ];
    for (const [resourceType, properties] of cases) {
      it(resourceType, async () => {
        mockSend.mockRejectedValue(new Error('boom'));
        await expect(provider.create('L', resourceType, properties)).rejects.toMatchObject({
          resourceType,
          logicalId: 'L',
        });
        expect(mockSend.mock.calls[0]![0]).toBeInstanceOf(CREATE_COMMAND[resourceType]!);
      });
    }
  });

  it('a failed Account update names its resourceType', async () => {
    mockSend.mockRejectedValue(new Error('boom'));
    await expect(
      provider.update(
        'L',
        'ApiGatewayAccount',
        'AWS::ApiGateway::Account',
        { CloudWatchRoleArn: 'arn:aws:iam::123456789012:role/r2' },
        { CloudWatchRoleArn: 'arn:aws:iam::123456789012:role/r1' }
      )
    ).rejects.toMatchObject({ resourceType: 'AWS::ApiGateway::Account' });
  });

  describe('an update refusal names its resourceType and logicalId', () => {
    const cases: Array<[string, string, Record<string, unknown>]> = [
      // RestApiId missing
      ['AWS::ApiGateway::Authorizer', 'auth-1', { Name: 'n' }],
      ['AWS::ApiGateway::Deployment', 'dep-1', { Description: 'd' }],
      // a physicalId that is not `restApiId|resourceId|httpMethod`
      ['AWS::ApiGateway::Method', 'not-a-method-id', { RestApiId: API }],
    ];
    for (const [resourceType, physicalId, properties] of cases) {
      it(resourceType, async () => {
        await expect(
          provider.update('L', physicalId, resourceType, properties, {})
        ).rejects.toMatchObject({ resourceType, logicalId: 'L', physicalId });
        expect(mockSend).not.toHaveBeenCalled();
      });
    }

    it('AWS::ApiGateway::Resource (the replacing create fails)', async () => {
      mockSend.mockRejectedValue(new Error('boom'));
      await expect(
        provider.update(
          'L',
          'res-1',
          'AWS::ApiGateway::Resource',
          { RestApiId: API, ParentId: 'root', PathPart: 'new' },
          { RestApiId: API, ParentId: 'root', PathPart: 'old' }
        )
      ).rejects.toMatchObject({ resourceType: 'AWS::ApiGateway::Resource', logicalId: 'L' });
    });
  });

  describe('a failed delete names its resourceType and physicalId', () => {
    const cases: Array<[string, string, Record<string, unknown>]> = [
      ['AWS::ApiGateway::Account', 'ApiGatewayAccount', {}],
      ['AWS::ApiGateway::Authorizer', 'auth-1', { RestApiId: API }],
      ['AWS::ApiGateway::Resource', 'res-1', { RestApiId: API }],
      ['AWS::ApiGateway::Deployment', 'dep-1', { RestApiId: API }],
      ['AWS::ApiGateway::Stage', 'prod', { RestApiId: API }],
      ['AWS::ApiGateway::Method', `${API}|res-1|GET`, {}],
    ];
    for (const [resourceType, physicalId, properties] of cases) {
      it(resourceType, async () => {
        mockSend.mockRejectedValue(new Error('boom'));
        await expect(
          provider.delete('L', physicalId, resourceType, properties)
        ).rejects.toMatchObject({ resourceType, physicalId });
        // The command CLASS, so a delegator pointed at a sibling's delete
        // (e.g. deleteAuthorizer -> deleteResource) fails here directly.
        expect(mockSend.mock.calls[0]![0]).toBeInstanceOf(DELETE_COMMAND[resourceType]!);
      });
    }
  });

  it("an Authorizer's AuthorizerId attribute is its physicalId", async () => {
    await expect(
      provider.getAttribute('auth-1', 'AWS::ApiGateway::Authorizer', 'AuthorizerId')
    ).resolves.toBe('auth-1');
  });

  describe('readCurrentState reads the child its physicalId names', () => {
    const cases: Array<[string, string, string]> = [
      ['AWS::ApiGateway::Authorizer', 'auth-1', 'authorizerId'],
      ['AWS::ApiGateway::Resource', 'res-1', 'resourceId'],
      ['AWS::ApiGateway::Deployment', 'dep-1', 'deploymentId'],
      ['AWS::ApiGateway::Stage', 'prod', 'stageName'],
    ];
    for (const [resourceType, physicalId, field] of cases) {
      it(resourceType, async () => {
        mockSend.mockResolvedValue({});
        await provider.readCurrentState(physicalId, 'L', resourceType, { RestApiId: API });
        expect(mockSend).toHaveBeenCalled();
        const input = (mockSend.mock.calls[0]![0] as { input: Record<string, unknown> }).input;
        expect(input).toMatchObject({ restApiId: API, [field]: physicalId });
      });
    }
  });

  it('waits the full IAM propagation delay before retrying UpdateAccount', async () => {
    vi.useFakeTimers();
    mockSend.mockRejectedValueOnce(new Error('The role ARN does not have required trust'));
    mockSend.mockResolvedValueOnce({});
    const promise = provider.create('L', 'AWS::ApiGateway::Account', {
      CloudWatchRoleArn: 'arn:aws:iam::123456789012:role/r',
    });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(mockSend).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(mockSend).toHaveBeenCalledTimes(2);
  });
});
