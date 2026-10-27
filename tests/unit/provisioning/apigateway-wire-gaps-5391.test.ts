import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  PutIntegrationCommand,
  UpdateAuthorizerCommand,
  UpdateDeploymentCommand,
} from '@aws-sdk/client-api-gateway';

// go-to-k/cdkd#5391: three ApiGatewayProvider wire gaps, each settled against a
// CloudFormation A/B in us-east-1:
// - Method `Integration.IntegrationTarget` reaches `PutIntegration`;
// - an Authorizer `Type` change is patched in place (`replace /type`; CFn kept
//   the authorizer id);
// - a Deployment `Description` change is patched in place
//   (`replace /description`; CFn kept the deployment id) instead of failing.
const mockSend = vi.fn();
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    apiGateway: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));
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

import {
  ApiGatewayProvider,
  methodChildCalls,
} from '../../../src/provisioning/providers/apigateway-provider.js';

const ALB =
  'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/alb/50dc6c495c0c9188';
const ALB_2 = ALB.replace('50dc6c495c0c9188', '1111c6c495c0c9188');
const vpcIntegration = (target: string | undefined): Record<string, unknown> => ({
  Type: 'HTTP_PROXY',
  IntegrationHttpMethod: 'GET',
  ConnectionType: 'VPC_LINK',
  ConnectionId: 'vpclink-1',
  Uri: 'http://internal-alb.example/',
  ...(target !== undefined && { IntegrationTarget: target }),
});
const IDS = { restApiId: 'api', resourceId: 'res', httpMethod: 'GET' };

/** The `input` of every sent command of class `cls`. */
function sentInputs<T>(cls: abstract new (...args: never[]) => { input: T }): T[] {
  return mockSend.mock.calls
    .map(([command]) => command as unknown)
    .filter((command): command is { input: T } => command instanceof cls)
    .map((command) => command.input);
}

describe('ApiGatewayProvider wire gaps (go-to-k/cdkd#5391)', () => {
  let provider: ApiGatewayProvider;
  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockResolvedValue({});
    provider = new ApiGatewayProvider();
  });

  describe('Method Integration.IntegrationTarget', () => {
    it('is sent on create', async () => {
      await provider.create('M', 'AWS::ApiGateway::Method', {
        RestApiId: 'api',
        ResourceId: 'res',
        HttpMethod: 'GET',
        AuthorizationType: 'NONE',
        Integration: vpcIntegration(ALB),
      });
      const puts = sentInputs(PutIntegrationCommand);
      expect(puts).toHaveLength(1);
      expect(puts[0]).toMatchObject({ connectionType: 'VPC_LINK', integrationTarget: ALB });
    });

    it('a changed target puts the integration with the new target', () => {
      const calls = methodChildCalls(
        IDS,
        { Integration: vpcIntegration(ALB_2) },
        { Integration: vpcIntegration(ALB) }
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]!.command).toBeInstanceOf(PutIntegrationCommand);
      expect((calls[0]!.command as PutIntegrationCommand).input.integrationTarget).toBe(ALB_2);
    });

    it('a removed target puts the integration without one (PutIntegration replaces it)', () => {
      const calls = methodChildCalls(
        IDS,
        { Integration: vpcIntegration(undefined) },
        { Integration: vpcIntegration(ALB) }
      );
      expect(calls).toHaveLength(1);
      const input = (calls[0]!.command as PutIntegrationCommand).input;
      expect(input.connectionId).toBe('vpclink-1');
      expect(input.integrationTarget).toBeUndefined();
    });
  });

  describe('Authorizer Type', () => {
    const base = {
      RestApiId: 'api',
      Name: 'authz',
      IdentitySource: 'method.request.header.Authorization',
      AuthorizerUri: 'arn:aws:apigateway:us-east-1:lambda:path/fn/invocations',
    };

    it('a changed Type is patched in place, not dropped', async () => {
      const result = await provider.update(
        'A',
        'auth-1',
        'AWS::ApiGateway::Authorizer',
        { ...base, Type: 'REQUEST' },
        { ...base, Type: 'TOKEN' }
      );
      expect(result).toEqual({ physicalId: 'auth-1', wasReplaced: false });
      expect(sentInputs(UpdateAuthorizerCommand)).toEqual([
        {
          restApiId: 'api',
          authorizerId: 'auth-1',
          patchOperations: [{ op: 'replace', path: '/type', value: 'REQUEST' }],
        },
      ]);
    });

    it('an unchanged Type sends nothing', async () => {
      await provider.update(
        'A',
        'auth-1',
        'AWS::ApiGateway::Authorizer',
        { ...base, Type: 'TOKEN' },
        { ...base, Type: 'TOKEN' }
      );
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('Deployment Description', () => {
    it('a changed Description is patched in place', async () => {
      const result = await provider.update(
        'D',
        'dep-1',
        'AWS::ApiGateway::Deployment',
        { RestApiId: 'api', Description: 'v2' },
        { RestApiId: 'api', Description: 'v1' }
      );
      expect(result).toEqual({ physicalId: 'dep-1', wasReplaced: false });
      expect(sentInputs(UpdateDeploymentCommand)).toEqual([
        {
          restApiId: 'api',
          deploymentId: 'dep-1',
          patchOperations: [{ op: 'replace', path: '/description', value: 'v2' }],
        },
      ]);
    });

    it('an added Description is patched in', async () => {
      await provider.update(
        'D',
        'dep-1',
        'AWS::ApiGateway::Deployment',
        { RestApiId: 'api', Description: 'v1' },
        { RestApiId: 'api' }
      );
      expect(sentInputs(UpdateDeploymentCommand)[0]?.patchOperations).toEqual([
        { op: 'replace', path: '/description', value: 'v1' },
      ]);
    });

    it('a removed Description is cleared with an empty value', async () => {
      await provider.update(
        'D',
        'dep-1',
        'AWS::ApiGateway::Deployment',
        { RestApiId: 'api' },
        { RestApiId: 'api', Description: 'v1' }
      );
      expect(sentInputs(UpdateDeploymentCommand)[0]?.patchOperations).toEqual([
        { op: 'replace', path: '/description', value: '' },
      ]);
    });

    it.each([
      ['an empty read-back to none', { Description: '' }, {}],
      ['none to an empty value', {}, { Description: '' }],
    ])('sends nothing from %s (both mean no description)', async (_label, prev, next) => {
      await provider.update(
        'D',
        'dep-1',
        'AWS::ApiGateway::Deployment',
        { RestApiId: 'api', ...next },
        { RestApiId: 'api', ...prev }
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('a failed UpdateDeployment is reported with the logical id', async () => {
      mockSend.mockRejectedValueOnce(new Error('TooManyRequests'));
      await expect(
        provider.update(
          'D',
          'dep-1',
          'AWS::ApiGateway::Deployment',
          { RestApiId: 'api', Description: 'v2' },
          { RestApiId: 'api', Description: 'v1' }
        )
      ).rejects.toThrow('Failed to update API Gateway Deployment D: TooManyRequests');
    });

    it('refuses an update with no RestApiId before any call', async () => {
      await expect(
        provider.update('D', 'dep-1', 'AWS::ApiGateway::Deployment', { Description: 'v2' }, {})
      ).rejects.toThrow('RestApiId is required to update API Gateway Deployment D');
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
});
