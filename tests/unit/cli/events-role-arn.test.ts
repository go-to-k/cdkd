import { describe, expect, it, vi } from 'vite-plus/test';

/**
 * `cdkd events` / `cdkd events prune` declare `--role-arn` (`commonOptions`) and
 * used to ignore it, so a pasted `cdkd events ... --role-arn '<role-arn>'` hint
 * read the base identity's bucket (go-to-k/cdkd#4177's review). Both now apply
 * it before any AWS call; the sentinel stops each command right there.
 */
const { applyRoleArnIfSet } = vi.hoisted(() => ({
  applyRoleArnIfSet: vi.fn(async () => {
    throw new Error('ROLE_APPLIED_SENTINEL');
  }),
}));
vi.mock('../../../src/utils/role-arn.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/utils/role-arn.js')>()),
  applyRoleArnIfSet,
}));

import { eventsCommand, eventsPruneCommand } from '../../../src/cli/commands/events.js';

describe('cdkd events applies --role-arn', () => {
  it('eventsCommand', async () => {
    applyRoleArnIfSet.mockClear();
    await expect(
      eventsCommand('S', { roleArn: 'arn:aws:iam::123456789012:role/x', region: 'us-east-1' })
    ).rejects.toThrow('ROLE_APPLIED_SENTINEL');
    expect(applyRoleArnIfSet).toHaveBeenCalledWith({
      roleArn: 'arn:aws:iam::123456789012:role/x',
      region: 'us-east-1',
    });
  });

  it('eventsPruneCommand', async () => {
    applyRoleArnIfSet.mockClear();
    await expect(
      eventsPruneCommand('S', {
        roleArn: 'arn:aws:iam::123456789012:role/x',
        region: 'us-east-1',
        all: true,
      })
    ).rejects.toThrow('ROLE_APPLIED_SENTINEL');
    expect(applyRoleArnIfSet).toHaveBeenCalledWith({
      roleArn: 'arn:aws:iam::123456789012:role/x',
      region: 'us-east-1',
    });
  });
});
