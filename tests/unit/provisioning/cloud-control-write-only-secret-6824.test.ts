import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockCloudControlSend = vi.fn();
const mockCloudControlConfigRegion = vi.fn();
const mockCloudFormationSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudControl: {
      send: mockCloudControlSend,
      config: { region: mockCloudControlConfigRegion },
    },
    // DescribeType for write-only property resolution on the update path.
    cloudFormation: { send: mockCloudFormationSend },
    dynamoDB: { send: vi.fn() },
    apiGateway: { send: vi.fn() },
    cloudFront: { send: vi.fn() },
    lambda: { send: vi.fn() },
    eventBridge: { send: vi.fn() },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => {
    const child = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(() => child),
    };
    return {
      child: () => child,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
  },
}));

import { CloudControlProvider } from '../../../src/provisioning/cloud-control-provider.js';
import { clearWriteOnlyPropertiesCache } from '../../../src/provisioning/write-only-properties.js';
import { clearCreateOnlyPropertiesCache } from '../../../src/provisioning/create-only-properties.js';

/**
 * go-to-k/cdkd#6824: the provider's half. A measured write-only key held as a
 * `{{resolve:...}}` reference is left out of the patch only when the engine
 * names it in `UpdateContext.unchangedWriteOnlySecretProperties` AND the
 * provider's own table keeps it (`getWriteOnlyKeysKeptWhenOmitted`) AND the
 * two sides still differ by references alone. Each is flipped singly: the key
 * is then sent. The engine's decision: `write-only-secret-skip-6824.test.ts`.
 */

type PatchOp = { op: string; path: string; value?: unknown };

function schema(writeOnly: string[]): string {
  return JSON.stringify({ writeOnlyProperties: writeOnly.map((p) => `/properties/${p}`) });
}

function wireUpdateSuccess(): void {
  mockCloudControlSend.mockImplementation((cmd: { constructor: { name: string } }) => {
    const name = cmd.constructor.name;
    if (name === 'UpdateResourceCommand') {
      return Promise.resolve({ ProgressEvent: { RequestToken: 'tok-update' } });
    }
    if (name === 'GetResourceRequestStatusCommand') {
      return Promise.resolve({ ProgressEvent: { OperationStatus: 'SUCCESS', Identifier: 'id-1' } });
    }
    return Promise.resolve({});
  });
}

function sentPatch(): PatchOp[] {
  const call = mockCloudControlSend.mock.calls.find(
    (c) => c[0]?.constructor?.name === 'UpdateResourceCommand'
  );
  expect(call).toBeDefined();
  return JSON.parse(
    (call![0] as { input: { PatchDocument: string } }).input.PatchDocument
  ) as PatchOp[];
}

const TAGS_A = [{ Key: 'k', Value: 'a' }];
const TAGS_B = [{ Key: 'k', Value: 'b' }];
const TOKEN = '{{resolve:secretsmanager:db-secret:SecretString:password::}}';
const PLAIN = 'resolved-password-value';
const maskSecrets = (text: string): string => text.split(PLAIN).join('***');
const NAMED = { maskSecrets, unchangedWriteOnlySecretProperties: new Set(['Password']) };

describe('CloudControlProvider update: an unchanged write-only secret reference the engine names (go-to-k/cdkd#6824)', () => {
  let provider: CloudControlProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    clearWriteOnlyPropertiesCache();
    clearCreateOnlyPropertiesCache();
    wireUpdateSuccess();
    provider = new CloudControlProvider();
    mockCloudFormationSend.mockResolvedValue({ Schema: schema(['Password']) });
  });

  const update = (
    desired: Record<string, unknown>,
    previous: Record<string, unknown>,
    context: Record<string, unknown> | undefined,
    type = 'AWS::DMS::Endpoint'
  ) => provider.update('Endpoint', 'endpoint-1', type, desired, previous, context as never);

  it('all arms green: a Tags-only patch, no Password op', async () => {
    await update({ Password: PLAIN, Tags: TAGS_B }, { Password: TOKEN, Tags: TAGS_A }, NAMED);
    expect(sentPatch()).toEqual([{ op: 'replace', path: '/Tags', value: TAGS_B }]);
  });

  it('flipped: the engine does not name it -- Password is sent', async () => {
    await update({ Password: PLAIN, Tags: TAGS_B }, { Password: TOKEN, Tags: TAGS_A }, { maskSecrets });
    expect(sentPatch()).toContainEqual({ op: 'add', path: '/Password', value: PLAIN });
  });

  it('flipped: no context at all (a caller passing nothing) -- Password is sent', async () => {
    await update({ Password: PLAIN, Tags: TAGS_B }, { Password: TOKEN, Tags: TAGS_A }, undefined);
    expect(sentPatch()).toContainEqual({ op: 'add', path: '/Password', value: PLAIN });
  });

  it('flipped: the table does not keep it (a travelling sibling changed) -- Passwords is sent', async () => {
    mockCloudFormationSend.mockResolvedValue({ Schema: schema(['Passwords']) });
    await update(
      { Passwords: [PLAIN], AuthenticationMode: { Type: 'password' }, Tags: TAGS_B },
      { Passwords: [TOKEN], AuthenticationMode: { Type: 'iam' }, Tags: TAGS_A },
      { maskSecrets, unchangedWriteOnlySecretProperties: new Set(['Passwords']) },
      'AWS::ElastiCache::User'
    );
    expect(sentPatch()).toContainEqual({ op: 'add', path: '/Passwords', value: [PLAIN] });
  });

  it('flipped: a type the table does not name -- the key is sent', async () => {
    await update(
      { Password: PLAIN, Tags: TAGS_B },
      { Password: TOKEN, Tags: TAGS_A },
      NAMED,
      'AWS::Some::Unmeasured'
    );
    expect(sentPatch()).toContainEqual({ op: 'add', path: '/Password', value: PLAIN });
  });

  it('flipped: the previous side holds the mask -- Password is sent', async () => {
    await update({ Password: PLAIN, Tags: TAGS_B }, { Password: '***', Tags: TAGS_A }, NAMED);
    expect(sentPatch()).toContainEqual({ op: 'add', path: '/Password', value: PLAIN });
  });

  it('flipped: the desired value is not one the masker recognises -- Password is sent', async () => {
    await update({ Password: 'other-value', Tags: TAGS_B }, { Password: TOKEN, Tags: TAGS_A }, NAMED);
    expect(sentPatch()).toContainEqual({ op: 'add', path: '/Password', value: 'other-value' });
  });

  it('a named key that is the only difference sends nothing at all', async () => {
    await update({ Password: PLAIN, Tags: TAGS_A }, { Password: TOKEN, Tags: TAGS_A }, NAMED);
    expect(
      mockCloudControlSend.mock.calls.some(
        (c) => c[0]?.constructor?.name === 'UpdateResourceCommand'
      )
    ).toBe(false);
  });
});
