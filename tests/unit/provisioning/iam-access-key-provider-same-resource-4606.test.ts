import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#4606: the live identity read a successful deploy asks before
// deleting a fix-forward's earlier access key. Only `'different'` lets it
// delete.

const { mockSend, clientRegion } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  clientRegion: { value: 'us-east-1' },
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    iam: { send: mockSend, config: { region: () => Promise.resolve(clientRegion.value) } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return { getLogger: () => ({ ...childLogger, child: () => childLogger }) };
});

import {
  GetAccessKeyLastUsedCommand,
  ListAccessKeysCommand,
  NoSuchEntityException,
} from '@aws-sdk/client-iam';
import { IAMAccessKeyProvider } from '../../../src/provisioning/providers/iam-access-key-provider.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';

const TYPE = 'AWS::IAM::AccessKey';
const CTX = { expectedRegion: 'us-east-1' };
// Assembled at runtime: a literal 20-character key id trips git-secrets.
const keyId = (prefix: string, body: string): string => `${prefix}${body}`;
const KEY_A = keyId('AKIA', 'AAAAAAAAAAAAAAA1');
const KEY_B = keyId('AKIA', 'BBBBBBBBBBBBBBB2');
const USER = 'ci-user';

const noSuchEntity = (): Error =>
  new NoSuchEntityException({ message: 'The specified key does not exist', $metadata: {} });
const awsError = (name: string, message = name): Error =>
  Object.assign(new Error(message), { name });

/**
 * Per key id: listed by `USER`, `'gone'` (NoSuchEntity), `'unlisted'` (an owner
 * whose ListAccessKeys does not carry it), `'ownerless'` (no UserName), or an
 * error thrown by GetAccessKeyLastUsed.
 */
type KeyState = 'live' | 'gone' | 'unlisted' | 'ownerless' | Error;

function keys(live: Record<string, KeyState>): void {
  mockSend.mockImplementation(async (cmd: unknown) => {
    if (cmd instanceof GetAccessKeyLastUsedCommand) {
      const state = live[cmd.input.AccessKeyId!] ?? 'gone';
      if (state === 'gone') throw noSuchEntity();
      if (state instanceof Error) throw state;
      return state === 'ownerless' ? {} : { UserName: USER };
    }
    if (cmd instanceof ListAccessKeysCommand) {
      return {
        AccessKeyMetadata: Object.entries(live)
          .filter(([, state]) => state === 'live')
          .map(([id]) => ({ AccessKeyId: id, Status: 'Active' })),
      };
    }
    throw new Error('unexpected command');
  });
}

const lastUsedIds = (): unknown[] =>
  mockSend.mock.calls
    .map(([c]) => c)
    .filter((c) => c instanceof GetAccessKeyLastUsedCommand)
    .map((c) => (c as GetAccessKeyLastUsedCommand).input.AccessKeyId);

let provider: IAMAccessKeyProvider;

beforeEach(() => {
  vi.clearAllMocks();
  mockSend.mockReset();
  clientRegion.value = 'us-east-1';
  provider = new IAMAccessKeyProvider();
});

describe('IAMAccessKeyProvider.isSameResource (go-to-k/cdkd#4606)', () => {
  it('another live key is different, after reading the record first, then the journaled one', async () => {
    keys({ [KEY_A]: 'live', [KEY_B]: 'live' });
    expect(await provider.isSameResource(KEY_A, { physicalId: KEY_B }, TYPE, CTX)).toBe(
      'different'
    );
    expect(lastUsedIds()).toEqual([KEY_B, KEY_A]);
  });

  it.each(['gone', 'unlisted'] as const)(
    'a journaled key %s is different once the record reads back',
    async (journaled) => {
      keys({ [KEY_A]: journaled, [KEY_B]: 'live' });
      expect(await provider.isSameResource(KEY_A, { physicalId: KEY_B }, TYPE, CTX)).toBe(
        'different'
      );
    }
  );

  it('a journaled key IAM names no owner for is unknown', async () => {
    keys({ [KEY_A]: 'ownerless', [KEY_B]: 'live' });
    expect(await provider.isSameResource(KEY_A, { physicalId: KEY_B }, TYPE, CTX)).toBe('unknown');
  });

  it.each(['gone', 'unlisted', 'ownerless'] as const)(
    'the record key %s is unknown, not different, and the journaled one is not read',
    async (recorded) => {
      keys({ [KEY_A]: 'live', [KEY_B]: recorded });
      expect(await provider.isSameResource(KEY_A, { physicalId: KEY_B }, TYPE, CTX)).toBe(
        'unknown'
      );
      expect(lastUsedIds()).toEqual([KEY_B]);
    }
  );

  it('equal ids are the same without a read', async () => {
    keys({});
    expect(await provider.isSameResource(KEY_A, { physicalId: KEY_A }, TYPE, CTX)).toBe('same');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('a read that fails other than not-found throws (the caller reads it as unknown)', async () => {
    keys({ [KEY_A]: awsError('AccessDenied', 'denied'), [KEY_B]: 'live' });
    await expect(provider.isSameResource(KEY_A, { physicalId: KEY_B }, TYPE, CTX)).rejects.toThrow(
      'denied'
    );
  });

  it('a record ListAccessKeys failing other than not-found throws', async () => {
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof GetAccessKeyLastUsedCommand) return { UserName: USER };
      throw awsError('Throttling', 'slow down');
    });
    await expect(provider.isSameResource(KEY_A, { physicalId: KEY_B }, TYPE, CTX)).rejects.toThrow(
      'slow down'
    );
  });

  it('a record key found on a later ListAccessKeys page reads back', async () => {
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof GetAccessKeyLastUsedCommand) {
        if (cmd.input.AccessKeyId === KEY_A) throw noSuchEntity();
        return { UserName: USER };
      }
      if (cmd instanceof ListAccessKeysCommand) {
        return cmd.input.Marker === 'page-2'
          ? { AccessKeyMetadata: [{ AccessKeyId: KEY_B }] }
          : { AccessKeyMetadata: [], IsTruncated: true, Marker: 'page-2' };
      }
      throw new Error('unexpected command');
    });
    expect(await provider.isSameResource(KEY_A, { physicalId: KEY_B }, TYPE, CTX)).toBe(
      'different'
    );
  });

  it('a client in another region is unknown before any read', async () => {
    clientRegion.value = 'eu-west-1';
    keys({ [KEY_A]: 'live', [KEY_B]: 'live' });
    expect(await provider.isSameResource(KEY_A, { physicalId: KEY_B }, TYPE, CTX)).toBe('unknown');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each([
    ['a short id', 'AKIA0001', KEY_B],
    ['a temporary ASIA id', keyId('ASIA', 'AAAAAAAAAAAAAAA1'), KEY_B],
    ['a lowercase id', KEY_A.toLowerCase(), KEY_B],
    ['an id one character too long', `${KEY_A}X`, KEY_B],
    ['a record id of another form', KEY_A, `ci-user/${KEY_B}`],
    ['an empty record id', KEY_A, ''],
  ])('%s is unknown without a read', async (_label, journaled, recorded) => {
    keys({ [KEY_A]: 'live', [KEY_B]: 'live' });
    expect(await provider.isSameResource(journaled, { physicalId: recorded }, TYPE, CTX)).toBe(
      'unknown'
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('another type is unknown without a read', async () => {
    keys({ [KEY_A]: 'live', [KEY_B]: 'live' });
    expect(
      await provider.isSameResource(KEY_A, { physicalId: KEY_B }, 'AWS::IAM::User', CTX)
    ).toBe('unknown');
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('IAMAccessKeyProvider.readCurrentState after the findAccessKey split', () => {
  it('a listed key reads back with its owner and status', async () => {
    keys({ [KEY_A]: 'live' });
    expect(await provider.readCurrentState(KEY_A, 'Key', TYPE)).toEqual({
      UserName: USER,
      Status: 'Active',
    });
  });

  it.each(['gone', 'unlisted'] as const)('a key %s is RESOURCE_NOT_FOUND', async (state) => {
    keys({ [KEY_A]: state });
    expect(await provider.readCurrentState(KEY_A, 'Key', TYPE)).toBe(RESOURCE_NOT_FOUND);
  });

  it('a key IAM names no owner for is undefined', async () => {
    keys({ [KEY_A]: 'ownerless' });
    expect(await provider.readCurrentState(KEY_A, 'Key', TYPE)).toBeUndefined();
  });
});
