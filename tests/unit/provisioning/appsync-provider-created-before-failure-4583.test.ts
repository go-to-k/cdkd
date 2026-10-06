import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#4583: a GraphQL API this create made and left behind is named
// for `cdkd rollback --revert-failed`; one the rollback delete removed and
// CreateGraphqlApi's own failure are not.

const mockSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-appsync', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-appsync')>(
    '@aws-sdk/client-appsync'
  );
  return {
    ...actual,
    AppSyncClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
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

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  getAccountInfo: () =>
    Promise.resolve({ partition: 'aws', region: 'us-east-1', accountId: '123456789012' }),
}));

import {
  CreateGraphqlApiCommand,
  DeleteGraphqlApiCommand,
  PutGraphqlApiEnvironmentVariablesCommand,
} from '@aws-sdk/client-appsync';
import { AppSyncProvider } from '../../../src/provisioning/providers/appsync-provider.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';

const TYPE = 'AWS::AppSync::GraphQLApi';
const PROPS = {
  Name: 'MyApi',
  AuthenticationType: 'API_KEY',
  EnvironmentVariables: { STAGE: 'prod' },
};

async function failure(provider: AppSyncProvider): Promise<unknown> {
  return provider.create('Api', TYPE, PROPS).then(
    () => expect.fail('create resolved'),
    (e: unknown) => e
  );
}

describe('AppSyncProvider GraphQLApi createdBeforeFailure mark (go-to-k/cdkd#4583)', () => {
  let provider: AppSyncProvider;

  beforeEach(() => {
    mockSend.mockReset();
    provider = new AppSyncProvider();
  });

  function prime(rollback: 'ok' | 'fail'): void {
    mockSend.mockImplementation(async (command: unknown) => {
      if (command instanceof CreateGraphqlApiCommand) {
        return {
          graphqlApi: {
            apiId: 'api-1',
            arn: 'arn:aws:appsync:us-east-1:123456789012:apis/api-1',
            uris: { GRAPHQL: 'https://x/graphql' },
          },
        };
      }
      if (command instanceof PutGraphqlApiEnvironmentVariablesCommand) {
        throw Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' });
      }
      if (command instanceof DeleteGraphqlApiCommand) {
        if (rollback === 'fail') throw new Error('DeleteGraphqlApi boom');
        return {};
      }
      return {};
    });
  }

  it('marks the API id when the env-var put fails and the rollback delete fails', async () => {
    prime('fail');
    expect(createdBeforeFailure(await failure(provider), 'Api', TYPE)).toBe('api-1');
  });

  it('does not mark when the rollback delete succeeded', async () => {
    prime('ok');
    const error = await failure(provider);
    expect(mockSend.mock.calls.some((c) => c[0] instanceof DeleteGraphqlApiCommand)).toBe(true);
    expect(createdBeforeFailure(error, 'Api', TYPE)).toBeUndefined();
  });

  it('does not mark when CreateGraphqlApi itself fails', async () => {
    mockSend.mockRejectedValue(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
    expect(createdBeforeFailure(await failure(provider), 'Api', TYPE)).toBeUndefined();
  });
});
