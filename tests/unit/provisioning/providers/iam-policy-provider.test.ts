import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();
vi.mock('../../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    iam: { send: mockSend, config: { region: () => 'us-east-1' } },
  }),
}));
vi.mock('../../../../src/utils/logger.js', () => {
  const child = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn().mockReturnThis() };
  return { getLogger: () => ({ child: () => child, debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) };
});

import { IAMPolicyProvider } from '../../../../src/provisioning/providers/iam-policy-provider.js';

describe('IAMPolicyProvider — import (override-only)', () => {
  let provider: IAMPolicyProvider;
  beforeEach(() => {
    vi.clearAllMocks();
    provider = new IAMPolicyProvider();
  });

  function makeInput(overrides: Record<string, unknown> = {}) {
    return {
      logicalId: 'MyInlinePolicy',
      resourceType: 'AWS::IAM::Policy',
      cdkPath: 'MyStack/MyInlinePolicy',
      stackName: 'MyStack',
      region: 'us-east-1',
      properties: {} as Record<string, unknown>,
      ...overrides,
    };
  }

  it('passes through explicit knownPhysicalId without an AWS call (inline policies have no Get API)', async () => {
    const result = await provider.import!(makeInput({ knownPhysicalId: 'MyRole/MyInlinePolicy' }));
    expect(result).toEqual({ physicalId: 'MyRole/MyInlinePolicy', attributes: {} });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns null when no override is supplied (inline policies are not auto-discoverable)', async () => {
    const result = await provider.import!(makeInput());
    expect(result).toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });
});
