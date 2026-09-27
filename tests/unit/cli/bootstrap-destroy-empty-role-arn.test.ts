import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * Issue #2348: `cdkd bootstrap --destroy --role-arn ""` must REFUSE before any
 * STS call. `bootstrap.ts` forwarded the flag to `bootstrapDestroyCommand` on
 * truthiness, so an empty value was DROPPED and this destructive command ran
 * as the caller -- or as `CDKD_ROLE_ARN`, which then won over the explicit
 * flag. `role-arn.ts` is REAL here; only the STS client is stubbed.
 */

const mocks = vi.hoisted(() => ({ stsSend: vi.fn() }));

vi.mock('../../../src/utils/error-handler.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/error-handler.js')>();
  return {
    ...actual,
    withErrorHandling: <Args extends unknown[]>(fn: (...args: Args) => Promise<void> | void) => fn,
  };
});

vi.mock('@aws-sdk/client-sts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-sts')>();
  return {
    ...actual,
    STSClient: vi.fn().mockImplementation(() => ({ send: mocks.stsSend, destroy: vi.fn() })),
  };
});

import { STSClient } from '@aws-sdk/client-sts';
import { createBootstrapCommand } from '../../../src/cli/commands/bootstrap.js';
import { resetAwsClientDefaults } from '../../../src/utils/aws-client-defaults.js';

describe('bootstrap --destroy --role-arn "" (issue #2348)', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    mocks.stsSend.mockReset();
    vi.mocked(STSClient).mockClear();
    resetAwsClientDefaults();
    savedEnv = process.env['CDKD_ROLE_ARN'];
    // A VALID env role: the empty flag must not let it win.
    process.env['CDKD_ROLE_ARN'] = 'arn:aws:iam::123456789012:role/FromEnv';
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env['CDKD_ROLE_ARN'];
    else process.env['CDKD_ROLE_ARN'] = savedEnv;
    resetAwsClientDefaults();
  });

  it('refuses before any STS client is built', async () => {
    const cmd = createBootstrapCommand();
    cmd.exitOverride();
    await expect(
      cmd.parseAsync(['--destroy', '--region', 'us-east-1', '--role-arn', '', '--yes'], {
        from: 'user',
      })
    ).rejects.toThrow(/AssumeRole refused.*Nothing was sent to STS/);
    expect(vi.mocked(STSClient)).not.toHaveBeenCalled();
    expect(mocks.stsSend).not.toHaveBeenCalled();
  });
});
