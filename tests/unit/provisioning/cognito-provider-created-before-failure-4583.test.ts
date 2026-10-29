import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#4583: a user pool this create made and left behind is named for
// `cdkd rollback --revert-failed`; one the rollback delete removed, a refusal,
// and CreateUserPool's own failure are not.

const mockSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-cognito-identity-provider', async () => {
  const actual = await vi.importActual('@aws-sdk/client-cognito-identity-provider');
  return {
    ...actual,
    CognitoIdentityProviderClient: vi.fn().mockImplementation(() => ({
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

import { CognitoUserPoolProvider } from '../../../src/provisioning/providers/cognito-provider.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';
import {
  CreatedResourceSink,
  collectCreatedResources,
} from '../../../src/provisioning/created-resource-sink.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';

const TYPE = 'AWS::Cognito::UserPool';
const POOL_ID = 'us-east-1_abc123';
const MFA_PROPS = { MfaConfiguration: 'OPTIONAL', EnabledMfas: ['SOFTWARE_TOKEN_MFA'] };

async function failure(
  provider: CognitoUserPoolProvider,
  properties: Record<string, unknown>
): Promise<unknown> {
  return provider.create('Pool', TYPE, properties).then(
    () => expect.fail('create resolved'),
    (e: unknown) => e
  );
}

describe('CognitoUserPoolProvider createdBeforeFailure mark (go-to-k/cdkd#4583)', () => {
  let provider: CognitoUserPoolProvider;

  beforeEach(() => {
    mockSend.mockReset();
    provider = new CognitoUserPoolProvider();
  });

  function prime(rollback: 'ok' | 'fail'): void {
    mockSend.mockImplementation(async (command: { constructor: { name: string } }) => {
      switch (command.constructor.name) {
        case 'CreateUserPoolCommand':
          return { UserPool: { Id: POOL_ID, Arn: `arn:aws:cognito-idp:us-east-1:1:userpool/${POOL_ID}` } };
        case 'SetUserPoolMfaConfigCommand':
          throw Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' });
        case 'DeleteUserPoolCommand':
          if (rollback === 'fail') throw new Error('DeleteUserPool boom');
          return {};
        default:
          return {};
      }
    });
  }

  it('marks the pool id when SetUserPoolMfaConfig fails and the rollback delete fails', async () => {
    prime('fail');
    const error = await failure(provider, MFA_PROPS);
    expect(createdBeforeFailure(error, 'Pool', TYPE)).toBe(POOL_ID);
    // go-to-k/cdkd#4945: a replayed CreateUserPool would make another pool.
    expect(isMarkedNonRetryable(error)).toBe(true);
  });

  it('does not mark when the rollback delete succeeded', async () => {
    prime('ok');
    const error = await failure(provider, MFA_PROPS);
    expect(mockSend.mock.calls.map((c) => c[0].constructor.name)).toContain('DeleteUserPoolCommand');
    expect(createdBeforeFailure(error, 'Pool', TYPE)).toBeUndefined();
    expect(isMarkedNonRetryable(error)).toBe(false);
  });

  it('does not mark when CreateUserPool itself fails', async () => {
    mockSend.mockRejectedValue(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
    expect(createdBeforeFailure(await failure(provider, MFA_PROPS), 'Pool', TYPE)).toBeUndefined();
  });

  it('does not mark a pre-flight refusal', async () => {
    const error = await failure(provider, { MfaConfiguration: ['ON'] });
    expect(mockSend).not.toHaveBeenCalled();
    expect(createdBeforeFailure(error, 'Pool', TYPE)).toBeUndefined();
  });

  // go-to-k/cdkd#5511: the sink holds the pool id once CreateUserPool returned,
  // before the MFA wiring.
  it('reports the pool id before the MFA wiring (rollback delete fails)', async () => {
    const sink = new CreatedResourceSink('Pool', TYPE);
    let atMfa: unknown = 'unset';
    prime('fail');
    const base = mockSend.getMockImplementation()!;
    mockSend.mockImplementation(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'SetUserPoolMfaConfigCommand') atMfa = sink.report;
      return base(command);
    });
    await collectCreatedResources(sink, () => failure(provider, MFA_PROPS));
    expect(atMfa).toEqual({ physicalId: POOL_ID });
    expect(sink.report).toEqual({ physicalId: POOL_ID });
  });

  it('leaves nothing reported when the rollback delete succeeded', async () => {
    const sink = new CreatedResourceSink('Pool', TYPE);
    prime('ok');
    await collectCreatedResources(sink, () => failure(provider, MFA_PROPS));
    expect(mockSend.mock.calls.map((c) => c[0].constructor.name)).toContain('DeleteUserPoolCommand');
    expect(sink.report).toBeUndefined();
  });

  it('reports nothing when CreateUserPool itself fails', async () => {
    const sink = new CreatedResourceSink('Pool', TYPE);
    mockSend.mockRejectedValue(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
    await collectCreatedResources(sink, () => failure(provider, MFA_PROPS));
    expect(sink.report).toBeUndefined();
  });
});
