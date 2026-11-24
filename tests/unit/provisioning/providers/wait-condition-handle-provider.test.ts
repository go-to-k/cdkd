import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const child = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(function (this: unknown) { return this; }),
};
vi.mock('../../../../src/utils/logger.js', () => ({
  getLogger: () => ({ ...child, child: () => child }),
}));

import { WaitConditionHandleProvider } from '../../../../src/provisioning/providers/wait-condition-handle-provider.js';
import type { WaitConditionSignalStore } from '../../../../src/provisioning/wait-condition-signal-store.js';
import { ProvisioningError } from '../../../../src/utils/error-handler.js';
import { isMarkedNonRetryable } from '../../../../src/deployment/retryable-errors.js';

const TYPE = 'AWS::CloudFormation::WaitConditionHandle';
const BUCKET = 'cdkd-state-123456789012';
const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const KEY = `wait-condition-signals/Placeholder-${UUID}.json`;
const URL_ID = `https://${BUCKET}.s3.us-east-1.amazonaws.com/${KEY}?X-Amz-Signature=abc`;

function fakeStore(opts: { bucket?: string; expiresInMs?: number; issueError?: Error } = {}) {
  const issueSignalUrl = vi.fn(async (logicalId: string) => {
    if (opts.issueError) throw opts.issueError;
    return {
      url: `https://${BUCKET}.s3.amazonaws.com/wait-condition-signals/${logicalId}-${UUID}.json?X-Amz-Signature=s`,
      key: `wait-condition-signals/${logicalId}-${UUID}.json`,
      // A full 12 h URL with long-lived credentials unless the test shortens it.
      expiresAt: new Date(Date.now() + (opts.expiresInMs ?? 12 * 3600 * 1000)),
      limitedByCredentials: opts.expiresInMs !== undefined,
    };
  });
  const deleteSignals = vi.fn().mockResolvedValue(undefined);
  const store = {
    issueSignalUrl,
    deleteSignals,
    requireBucket: () => {
      if (opts.bucket === undefined) throw new Error('No cdkd state bucket is configured');
      return opts.bucket;
    },
  } as unknown as WaitConditionSignalStore;
  return { store, issueSignalUrl, deleteSignals };
}

describe('WaitConditionHandleProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('create', () => {
    it("records the store's signal URL as the physical id (the handle's Ref)", async () => {
      const { store, issueSignalUrl } = fakeStore({ bucket: BUCKET });
      const result = await new WaitConditionHandleProvider(store).create('Placeholder', TYPE, {});
      expect(issueSignalUrl).toHaveBeenCalledWith('Placeholder');
      expect(result).toEqual({
        physicalId: `https://${BUCKET}.s3.amazonaws.com/${KEY}?X-Amz-Signature=s`,
        attributes: {},
      });
      expect(child.warn).not.toHaveBeenCalled();
      // The URL is a bearer credential: no log line carries its signature.
      for (const call of [...child.debug.mock.calls, ...child.info.mock.calls]) {
        expect(String(call[0])).not.toContain('X-Amz-Signature');
      }
    });

    it('warns when temporary credentials cut the URL lifetime under 12 hours', async () => {
      const { store } = fakeStore({ bucket: BUCKET, expiresInMs: 60 * 60 * 1000 });
      await new WaitConditionHandleProvider(store).create('Placeholder', TYPE, {});
      expect(child.warn).toHaveBeenCalledTimes(1);
      expect(String(child.warn.mock.calls[0]![0])).toMatch(/temporary credentials and stops accepting/);
    });

    it('fails non-retryably when no URL can be issued', async () => {
      const { store } = fakeStore({ issueError: new Error('No cdkd state bucket is configured') });
      const error = await new WaitConditionHandleProvider(store)
        .create('Placeholder', TYPE, {})
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProvisioningError);
      expect((error as Error).message).toMatch(/Failed to issue the signal URL.*No cdkd state bucket/);
      expect(isMarkedNonRetryable(error as Error)).toBe(true);
    });
  });

  describe('update', () => {
    it('is a no-op that keeps the existing physical id', async () => {
      const { store } = fakeStore({ bucket: BUCKET });
      const result = await new WaitConditionHandleProvider(store).update(
        'Placeholder',
        URL_ID,
        TYPE,
        {},
        {},
        { expectedRegion: 'us-west-2' }
      );
      expect(result).toEqual({ physicalId: URL_ID, wasReplaced: false, attributes: {} });
    });
  });

  describe('update of a pre-#6694 placeholder (#6704)', () => {
    it('issues a signal URL and reports the replacement', async () => {
      const { store, issueSignalUrl } = fakeStore({ bucket: BUCKET });
      const result = await new WaitConditionHandleProvider(store).update(
        'Placeholder',
        `cdkd-wait-condition-handle-Placeholder-${UUID}`,
        TYPE,
        {},
        {}
      );
      expect(issueSignalUrl).toHaveBeenCalledWith('Placeholder');
      expect(result).toEqual({
        physicalId: `https://${BUCKET}.s3.amazonaws.com/${KEY}?X-Amz-Signature=s`,
        wasReplaced: true,
        attributes: {},
      });
    });
  });

  describe('delete', () => {
    it('removes the signals behind a URL cdkd issued', async () => {
      const { store, deleteSignals } = fakeStore({ bucket: BUCKET });
      await new WaitConditionHandleProvider(store).delete('Placeholder', URL_ID, TYPE);
      expect(deleteSignals).toHaveBeenCalledWith(KEY);
    });

    it.each([
      ['a legacy placeholder', 'cdkd-wait-condition-handle-Placeholder-0f8fad5b-d9cb-469f-a165-70867728950e'],
      ["CloudFormation's URL", 'https://cloudformation-waitcondition-us-east-1.s3.amazonaws.com/abc%3Adef'],
      ['a URL into another bucket', URL_ID.replace(BUCKET, 'someone-else')],
    ])('touches nothing for %s', async (_what, physicalId) => {
      const { store, deleteSignals } = fakeStore({ bucket: BUCKET });
      await new WaitConditionHandleProvider(store).delete('Placeholder', physicalId, TYPE);
      expect(deleteSignals).not.toHaveBeenCalled();
    });

    it('touches nothing when no state bucket is configured', async () => {
      const { store, deleteSignals } = fakeStore();
      await new WaitConditionHandleProvider(store).delete('Placeholder', URL_ID, TYPE);
      expect(deleteSignals).not.toHaveBeenCalled();
    });
  });

  describe('getAttribute', () => {
    it('throws — the type has no Fn::GetAtt attributes', async () => {
      const provider = new WaitConditionHandleProvider(fakeStore().store);
      await expect(
        provider.getAttribute('existing-id', TYPE, 'Anything', 'Placeholder')
      ).rejects.toThrow(/Anything/);
      // The LOGICAL id in the logical-id slot (go-to-k/cdkd#4222).
      await expect(
        provider.getAttribute('existing-id', TYPE, 'Anything', 'Placeholder')
      ).rejects.toMatchObject({ logicalId: 'Placeholder', physicalId: 'existing-id' });
    });
  });

  describe('readCurrentState', () => {
    it('returns an empty managed-property set (nothing can drift)', async () => {
      await expect(new WaitConditionHandleProvider(fakeStore().store).readCurrentState()).resolves.toEqual({});
    });
  });

  describe('import', () => {
    const baseInput = {
      logicalId: 'Placeholder',
      resourceType: TYPE,
      stackName: 'MyStack',
      region: 'us-east-1',
      properties: {} as Record<string, unknown>,
    };

    it('accepts a caller-supplied physical id verbatim (CFn migration path)', async () => {
      const presignedUrl = 'https://cloudformation-waitcondition-us-east-1.s3.amazonaws.com/abc%3Adef';
      const result = await new WaitConditionHandleProvider(fakeStore().store).import({
        ...baseInput,
        knownPhysicalId: presignedUrl,
      });
      expect(result).toEqual({ physicalId: presignedUrl, attributes: {} });
    });

    it('synthesizes a placeholder id when no physical id is supplied', async () => {
      const result = await new WaitConditionHandleProvider(fakeStore().store).import(baseInput);
      expect(result?.physicalId).toMatch(/^cdkd-wait-condition-handle-Placeholder-[0-9a-f-]{36}$/);
    });
  });

  it('declares the type with an empty handled set (schema has no writable properties)', () => {
    expect(new WaitConditionHandleProvider(fakeStore().store).handledProperties.get(TYPE)?.size).toBe(0);
  });
});
