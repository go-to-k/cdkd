import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#1160: `UpdateUserPool` KEEPS a pool's tags when the call omits
// `UserPoolTags`, so a key the template drops must be untagged explicitly.

const mockSend = vi.fn();

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

const { childLogger } = vi.hoisted(() => ({
  childLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  },
}));
childLogger.child.mockReturnValue(childLogger);

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    child: () => childLogger,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { CognitoUserPoolProvider } from '../../../src/provisioning/providers/cognito-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

const POOL_ID = 'us-east-1_abc123';
const POOL_ARN = `arn:aws:cognito-idp:us-east-1:123456789012:userpool/${POOL_ID}`;

interface SentCommand {
  constructor: { name: string };
  input: Record<string, unknown>;
}

function sent(name: string): SentCommand[] {
  return mockSend.mock.calls
    .map((c) => c[0] as SentCommand)
    .filter((cmd) => cmd.constructor.name === name);
}

/** Answer every call; DescribeUserPool returns `arn` (omitted when `null`). */
function routeSend(arn: string | null = POOL_ARN, untagError?: Error): void {
  mockSend.mockImplementation(async (cmd: SentCommand) => {
    switch (cmd.constructor.name) {
      case 'DescribeUserPoolCommand':
        return { UserPool: arn === null ? {} : { Arn: arn } };
      case 'UntagResourceCommand':
        if (untagError) throw untagError;
        return {};
      default:
        return {};
    }
  });
}

describe('CognitoUserPoolProvider.update — UserPoolTags removal (#1160)', () => {
  let provider: CognitoUserPoolProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    childLogger.child.mockReturnValue(childLogger);
    provider = new CognitoUserPoolProvider();
  });

  const update = (desired: Record<string, unknown>, previous: Record<string, unknown>) =>
    provider.update('MyUserPool', POOL_ID, 'AWS::Cognito::UserPool', desired, previous);

  it('untags every key when the template drops UserPoolTags entirely', async () => {
    routeSend();
    await update({ UserPoolName: 'p' }, { UserPoolName: 'p', UserPoolTags: { team: 'a', env: 'b' } });

    expect(sent('UpdateUserPoolCommand')[0]!.input).not.toHaveProperty('UserPoolTags');
    const untag = sent('UntagResourceCommand');
    expect(untag).toHaveLength(1);
    expect(untag[0]!.input).toEqual({ ResourceArn: POOL_ARN, TagKeys: ['team', 'env'] });
  });

  it('untags only the dropped key and still sends the kept ones', async () => {
    routeSend();
    await update(
      { UserPoolTags: { team: 'a2' } },
      { UserPoolTags: { team: 'a', env: 'b' } }
    );

    expect(sent('UpdateUserPoolCommand')[0]!.input['UserPoolTags']).toEqual({ team: 'a2' });
    expect(sent('UntagResourceCommand').map((c) => c.input['TagKeys'])).toEqual([['env']]);
  });

  it('sends no untag when the previous side never had tags', async () => {
    routeSend();
    await update({ UserPoolTags: { team: 'a' } }, {});
    await update({}, {});

    expect(sent('UntagResourceCommand')).toHaveLength(0);
  });

  it('sends no untag when every previous key is still declared', async () => {
    routeSend();
    await update(
      { UserPoolTags: { team: 'a', env: 'b', added: 'c' } },
      { UserPoolTags: { team: 'a', env: 'b' } }
    );

    expect(sent('UntagResourceCommand')).toHaveLength(0);
  });

  it('never untags an aws: key', async () => {
    routeSend();
    await update({}, { UserPoolTags: { 'aws:reserved': 'x', team: 'a' } });

    expect(sent('UntagResourceCommand').map((c) => c.input['TagKeys'])).toEqual([['team']]);
  });

  it('untags after UpdateUserPool, addressing the ARN DescribeUserPool returned', async () => {
    routeSend();
    await update({}, { UserPoolTags: { team: 'a' } });

    const order = mockSend.mock.calls.map((c) => (c[0] as SentCommand).constructor.name);
    expect(order.indexOf('UntagResourceCommand')).toBeGreaterThan(
      order.indexOf('UpdateUserPoolCommand')
    );
    expect(order.indexOf('UntagResourceCommand')).toBeGreaterThan(
      order.indexOf('DescribeUserPoolCommand')
    );
  });

  it('warns and untags nothing when DescribeUserPool returns no ARN', async () => {
    routeSend(null);
    await update({}, { UserPoolTags: { team: 'a' } });

    expect(sent('UntagResourceCommand')).toHaveLength(0);
    const warned = childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('1 UserPoolTags key(s)');
    expect(warned).toContain('untag-resource');
  });

  it('warns and untags nothing when the previous UserPoolTags is unreadable', async () => {
    routeSend();
    await update({ UserPoolTags: { team: 'a' } }, { UserPoolTags: 'not-a-map' });

    expect(sent('UntagResourceCommand')).toHaveLength(0);
    const warned = childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('recorded UserPoolTags');
    expect(warned).toContain('removed no tag');
    expect(warned).not.toContain('applied the');
  });

  it('warns naming UserPoolTags and leaves a recorded secret-derived key alone', async () => {
    routeSend();
    await update({}, { UserPoolTags: { '{{resolve:ssm:/k}}': 'v', team: 'a' } });

    expect(sent('UntagResourceCommand').map((c) => c.input['TagKeys'])).toEqual([['team']]);
    const warned = childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('recorded UserPoolTags');
    expect(warned).toContain('1 key(s) derived from a dynamic reference');
    expect(warned).not.toContain('recorded Tags');
  });

  it('untags nothing when the desired UserPoolTags is not a key -> value map', async () => {
    routeSend();
    await update({ UserPoolTags: ['team'] }, { UserPoolTags: { team: 'a' } });

    expect(sent('UntagResourceCommand')).toHaveLength(0);
  });

  it('surfaces an UntagResource failure as the update failure', async () => {
    routeSend(POOL_ARN, Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
    const error = await update({}, { UserPoolTags: { team: 'a' } }).then(
      () => undefined,
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(ProvisioningError);
    expect((error as Error).message).toContain('Failed to update Cognito User Pool MyUserPool');
  });
});
