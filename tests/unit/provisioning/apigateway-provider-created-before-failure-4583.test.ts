import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#4583: a Stage or Method this create made and left behind is
// named for `cdkd rollback --revert-failed`; one the cleanup delete removed, a
// refusal, and the create call's own failure are not.

const mockSend = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    apiGateway: {
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    },
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

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger: Record<string, unknown> = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  childLogger['child'] = () => childLogger;
  return { getLogger: () => childLogger };
});

import { ApiGatewayProvider } from '../../../src/provisioning/providers/apigateway-provider.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';

const STAGE = 'AWS::ApiGateway::Stage';
const METHOD = 'AWS::ApiGateway::Method';

async function failure(
  provider: ApiGatewayProvider,
  logicalId: string,
  type: string,
  properties: Record<string, unknown>
): Promise<unknown> {
  return provider.create(logicalId, type, properties).then(
    () => expect.fail('create resolved'),
    (e: unknown) => e
  );
}

describe('ApiGatewayProvider createdBeforeFailure mark (go-to-k/cdkd#4583)', () => {
  let provider: ApiGatewayProvider;

  beforeEach(() => {
    mockSend.mockReset();
    provider = new ApiGatewayProvider();
  });

  describe('Stage', () => {
    const props = {
      RestApiId: 'api-id',
      StageName: 'prod',
      DeploymentId: 'deploy-123',
      MethodSettings: [{ ResourcePath: '/*', HttpMethod: '*', ThrottlingRateLimit: 100 }],
    };

    it('marks the stage name when the post-create patch fails and the cleanup delete fails', async () => {
      mockSend.mockResolvedValueOnce({}); // CreateStage
      mockSend.mockRejectedValueOnce(new Error('BadRequestException: bad patch')); // UpdateStage
      mockSend.mockRejectedValueOnce(new Error('DeleteStage boom')); // cleanup
      expect(
        createdBeforeFailure(await failure(provider, 'MyStage', STAGE, props), 'MyStage', STAGE)
      ).toBe('prod');
    });

    it('does not mark when the cleanup delete succeeded', async () => {
      mockSend.mockResolvedValueOnce({});
      mockSend.mockRejectedValueOnce(new Error('BadRequestException: bad patch'));
      mockSend.mockResolvedValueOnce({});
      const error = await failure(provider, 'MyStage', STAGE, props);
      expect(mockSend.mock.calls[2]?.[0].constructor.name).toBe('DeleteStageCommand');
      expect(createdBeforeFailure(error, 'MyStage', STAGE)).toBeUndefined();
    });

    it('does not mark when CreateStage itself fails', async () => {
      mockSend.mockRejectedValueOnce(new Error('ConflictException: Stage already exists'));
      expect(
        createdBeforeFailure(await failure(provider, 'MyStage', STAGE, props), 'MyStage', STAGE)
      ).toBeUndefined();
    });

    it('does not mark a pre-flight refusal', async () => {
      const error = await failure(provider, 'MyStage', STAGE, { RestApiId: 'api-id' });
      expect(mockSend).not.toHaveBeenCalled();
      expect(createdBeforeFailure(error, 'MyStage', STAGE)).toBeUndefined();
    });
  });

  describe('Method', () => {
    const props = {
      RestApiId: 'api-id',
      ResourceId: 'resource-id',
      HttpMethod: 'POST',
      AuthorizationType: 'NONE',
      Integration: { Type: 'MOCK' },
    };

    it('marks the composite method id when the wiring fails and the cleanup delete fails', async () => {
      mockSend.mockResolvedValueOnce({}); // PutMethod
      mockSend.mockRejectedValueOnce(new Error('PutIntegration boom'));
      mockSend.mockRejectedValueOnce(new Error('DeleteMethod boom'));
      expect(
        createdBeforeFailure(await failure(provider, 'MyMethod', METHOD, props), 'MyMethod', METHOD)
      ).toBe('api-id|resource-id|POST');
    });

    it('marks exactly the physicalId a successful create returns', async () => {
      mockSend.mockResolvedValue({});
      const { physicalId } = await provider.create('MyMethod', METHOD, props);
      mockSend.mockReset();

      mockSend.mockResolvedValueOnce({}); // PutMethod
      mockSend.mockRejectedValueOnce(new Error('PutIntegration boom'));
      mockSend.mockRejectedValueOnce(new Error('DeleteMethod boom'));
      const error = await failure(provider, 'MyMethod', METHOD, props);
      expect(mockSend.mock.calls[2]?.[0].constructor.name).toBe('DeleteMethodCommand');
      expect(createdBeforeFailure(error, 'MyMethod', METHOD)).toBe(physicalId);
    });

    it('does not mark when the cleanup delete succeeded', async () => {
      mockSend.mockResolvedValueOnce({});
      mockSend.mockRejectedValueOnce(new Error('PutIntegration boom'));
      mockSend.mockResolvedValueOnce({});
      const error = await failure(provider, 'MyMethod', METHOD, props);
      expect(mockSend.mock.calls[2]?.[0].constructor.name).toBe('DeleteMethodCommand');
      expect(createdBeforeFailure(error, 'MyMethod', METHOD)).toBeUndefined();
    });

    it('does not mark when PutMethod itself fails', async () => {
      mockSend.mockRejectedValueOnce(new Error('ConflictException: Method already exists'));
      expect(
        createdBeforeFailure(await failure(provider, 'MyMethod', METHOD, props), 'MyMethod', METHOD)
      ).toBeUndefined();
    });

    it('does not mark a pre-flight refusal (missing HttpMethod)', async () => {
      const { HttpMethod: _omit, ...missing } = props;
      const error = await failure(provider, 'MyMethod', METHOD, missing);
      expect(mockSend).not.toHaveBeenCalled();
      expect(createdBeforeFailure(error, 'MyMethod', METHOD)).toBeUndefined();
    });

    it('does not mark a pre-flight refusal (a `|` in a composite-id segment)', async () => {
      const error = await failure(provider, 'MyMethod', METHOD, { ...props, ResourceId: 'res|id' });
      expect(mockSend).not.toHaveBeenCalled();
      expect(createdBeforeFailure(error, 'MyMethod', METHOD)).toBeUndefined();
    });
  });
});
