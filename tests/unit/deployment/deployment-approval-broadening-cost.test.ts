import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const diffSecurity = vi.hoisted(() => vi.fn(async () => ({ broadening: false, rendered: '' })));
vi.mock('../../../src/analyzer/security-diff.js', () => ({ diffSecurity }));

import { requireDeploymentApproval } from '../../../src/deployment/deployment-approval.js';
import type { RequireApprovalLevel } from '../../../src/deployment/deploy-engine/options.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';

const secretMask = vi.fn(() => (text: string) => text);
const ask = (level: RequireApprovalLevel) =>
  requireDeploymentApproval({
    options: { requireApproval: level, approveDeployment: async () => true },
    stackName: 'S',
    changes: [{ logicalId: 'R', changeType: 'CREATE', resourceType: 'AWS::IAM::Role' }],
    records: {},
    template: { Resources: {} },
    secretMask,
  });

// go-to-k/cdkd#4601: the security diff (and the package behind it) is paid for
// only when `broadening` is the level.
describe('requireDeploymentApproval security-diff cost', () => {
  beforeEach(() => {
    diffSecurity.mockClear();
    secretMask.mockClear();
  });

  it.each(['never', 'any-change', 'destructive'] as const)('computes none under %s', async (level) => {
    await ask(level);
    expect(diffSecurity).not.toHaveBeenCalled();
    expect(secretMask).not.toHaveBeenCalled();
  });

  it('computes it under broadening, handing it the secret mask for the table', async () => {
    await ask('broadening');
    expect(diffSecurity).toHaveBeenCalledTimes(1);
    expect(diffSecurity).toHaveBeenCalledWith(expect.objectContaining({ secretMask }));
  });

  it('fails the deploy, non-retryably, when it cannot be computed', async () => {
    diffSecurity.mockRejectedValueOnce(new Error('boom'));
    const error = await ask('broadening').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('boom');
    expect(isMarkedNonRetryable(error as Error)).toBe(true);
  });
});
