/**
 * go-to-k/cdkd#6755: the `AWS::IAM::User` drift readback returns `Tags` and,
 * for a record declaring one, `LoginProfile.PasswordResetRequired`.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  GetLoginProfileCommand,
  GetUserCommand,
  NoSuchEntityException,
} from '@aws-sdk/client-iam';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    iam: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return { getLogger: () => logger };
});

import { IAMUserGroupProvider } from '../../../src/provisioning/providers/iam-user-group-provider.js';

const noSuchEntity = (): NoSuchEntityException =>
  new NoSuchEntityException({ message: 'none', $metadata: {} });

describe('IAM user readback: Tags and LoginProfile (go-to-k/cdkd#6755)', () => {
  let provider: IAMUserGroupProvider;

  beforeEach(() => {
    mockSend.mockReset();
    provider = new IAMUserGroupProvider();
    // No re-read delays on the post-write capture.
    (provider as unknown as { ownWriteRereadDelaysMs: number[] }).ownWriteRereadDelaysMs = [];
  });

  const read = async (opts: {
    tags?: unknown;
    profile?: { PasswordResetRequired?: boolean } | 'none' | Error;
    properties?: Record<string, unknown>;
    afterOwnWrite?: boolean;
  }): Promise<Record<string, unknown>> => {
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof GetUserCommand) {
        return Promise.resolve({ User: { UserName: 'alice', Path: '/', Tags: opts.tags } });
      }
      if (command instanceof GetLoginProfileCommand) {
        if (opts.profile === 'none') return Promise.reject(noSuchEntity());
        if (opts.profile instanceof Error) return Promise.reject(opts.profile);
        return Promise.resolve({ LoginProfile: { UserName: 'alice', ...opts.profile } });
      }
      return Promise.resolve({});
    });
    return (await provider.readCurrentState('alice', 'L', 'AWS::IAM::User', opts.properties, {
      afterOwnWrite: opts.afterOwnWrite === true,
    })) as Record<string, unknown>;
  };
  const loginProfileCalls = (): number =>
    mockSend.mock.calls.filter(([command]) => command instanceof GetLoginProfileCommand).length;

  describe('Tags', () => {
    it('returns the GetUser tags, the reserved aws: ones dropped', async () => {
      const result = await read({
        tags: [
          { Key: 'aws:cloudformation:stack-name', Value: 'S' },
          { Key: 'team', Value: 'a' },
        ],
      });
      expect(result['Tags']).toEqual([{ Key: 'team', Value: 'a' }]);
    });

    it('omits Tags for an untagged user', async () => {
      expect(await read({ tags: undefined })).not.toHaveProperty('Tags');
      expect(await read({ tags: [] })).not.toHaveProperty('Tags');
    });

    it('keeps the declared tags on the capture right after its own write', async () => {
      const declared = [{ Key: 'team', Value: 'b' }];
      const result = await read({
        tags: [{ Key: 'team', Value: 'a' }],
        properties: { Tags: declared },
        afterOwnWrite: true,
      });
      expect(result['Tags']).toEqual(declared);
    });

    it('reports the live tags outside that capture', async () => {
      const result = await read({
        tags: [{ Key: 'team', Value: 'a' }],
        properties: { Tags: [{ Key: 'team', Value: 'b' }] },
      });
      expect(result['Tags']).toEqual([{ Key: 'team', Value: 'a' }]);
    });
  });

  describe('LoginProfile', () => {
    const declared = { LoginProfile: { Password: 'pw', PasswordResetRequired: false } };

    it('reads PasswordResetRequired for a record declaring a login profile, never the password', async () => {
      const result = await read({
        profile: { PasswordResetRequired: true },
        properties: declared,
      });
      expect(result['LoginProfile']).toEqual({ PasswordResetRequired: true });
      expect(loginProfileCalls()).toBe(1);
    });

    it('reads PasswordResetRequired as false when AWS omits it', async () => {
      const result = await read({ profile: {}, properties: declared });
      expect(result['LoginProfile']).toEqual({ PasswordResetRequired: false });
    });

    it('omits LoginProfile when the user has none, so a declared one reads as deleted', async () => {
      const result = await read({ profile: 'none', properties: declared });
      expect(result).not.toHaveProperty('LoginProfile');
    });

    it('keeps the declared shape when the profile is not visible yet right after its own write', async () => {
      const result = await read({
        profile: 'none',
        properties: { LoginProfile: { Password: 'pw', PasswordResetRequired: 'true' } },
        afterOwnWrite: true,
      });
      expect(result['LoginProfile']).toEqual({ PasswordResetRequired: true });
    });

    it('throws on a failed read rather than reading it as deleted', async () => {
      await expect(
        read({
          profile: Object.assign(new Error('denied'), { name: 'AccessDenied' }),
          properties: declared,
        })
      ).rejects.toThrow('denied');
    });

    it('makes no GetLoginProfile call for a record without a login profile', async () => {
      const result = await read({ profile: { PasswordResetRequired: true }, properties: {} });
      expect(result).not.toHaveProperty('LoginProfile');
      expect(loginProfileCalls()).toBe(0);
    });

    it('declares the write-only password unknown for drift', () => {
      expect(provider.getDriftUnknownPaths('AWS::IAM::User')).toEqual(['LoginProfile.Password']);
      expect(provider.getDriftUnknownPaths('AWS::IAM::Group')).toEqual([]);
    });
  });
});
