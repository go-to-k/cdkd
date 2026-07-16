import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

vi.mock('../../../../src/utils/logger.js', () => {
  const child = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn().mockReturnThis() };
  return { getLogger: () => ({ child: () => child, debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) };
});

import { WaitConditionHandleProvider } from '../../../../src/provisioning/providers/wait-condition-handle-provider.js';
import { ProvisioningError } from '../../../../src/utils/error-handler.js';

const TYPE = 'AWS::CloudFormation::WaitConditionHandle';

describe('WaitConditionHandleProvider', () => {
  let provider: WaitConditionHandleProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new WaitConditionHandleProvider();
  });

  describe('create', () => {
    it('synthesizes a unique placeholder physical id embedding the logical id', async () => {
      const result = await provider.create('Placeholder', TYPE, {});
      expect(result.physicalId).toMatch(/^cdkd-wait-condition-handle-Placeholder-[0-9a-f-]{36}$/);
      expect(result.attributes).toEqual({});
    });

    it('returns a different physical id on each create (replacement-safe)', async () => {
      const first = await provider.create('Placeholder', TYPE, {});
      const second = await provider.create('Placeholder', TYPE, {});
      expect(first.physicalId).not.toBe(second.physicalId);
    });
  });

  describe('update', () => {
    it('is a no-op that keeps the existing physical id', async () => {
      const result = await provider.update('Placeholder', 'existing-id', TYPE, {}, {});
      expect(result).toEqual({ physicalId: 'existing-id', wasReplaced: false, attributes: {} });
    });
  });

  describe('delete', () => {
    it('resolves without calling any AWS API', async () => {
      await expect(provider.delete('Placeholder', 'existing-id', TYPE)).resolves.toBeUndefined();
    });
  });

  describe('getAttribute', () => {
    it('throws — the type has no Fn::GetAtt attributes', async () => {
      await expect(provider.getAttribute('existing-id', TYPE, 'Anything')).rejects.toThrow(
        ProvisioningError
      );
    });
  });

  describe('readCurrentState', () => {
    it('returns an empty managed-property set (nothing can drift)', async () => {
      await expect(provider.readCurrentState()).resolves.toEqual({});
    });
  });

  describe('import', () => {
    const baseInput = {
      logicalId: 'Placeholder',
      resourceType: TYPE,
      cdkPath: 'MyStack/Placeholder',
      stackName: 'MyStack',
      region: 'us-east-1',
      properties: {} as Record<string, unknown>,
    };

    it('accepts a caller-supplied physical id verbatim (CFn migration path)', async () => {
      const presignedUrl = 'https://cloudformation-waitcondition-us-east-1.s3.amazonaws.com/abc%3Adef';
      const result = await provider.import({ ...baseInput, knownPhysicalId: presignedUrl });
      expect(result).toEqual({ physicalId: presignedUrl, attributes: {} });
    });

    it('synthesizes a placeholder id when no physical id is supplied', async () => {
      const result = await provider.import(baseInput);
      expect(result?.physicalId).toMatch(
        /^cdkd-wait-condition-handle-Placeholder-[0-9a-f-]{36}$/
      );
    });
  });

  describe('handledProperties', () => {
    it('declares the type with an empty handled set (schema has no writable properties)', () => {
      expect(provider.handledProperties.get(TYPE)?.size).toBe(0);
    });
  });
});
