import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * Issue #2348: `cdkd local invoke --assume-role <arn>` refuses a malformed or
 * EMPTY explicit value at HANDLER ENTRY -- before `--role-arn`'s STS hop, the
 * docker probe or synthesis -- rather than letting the send-site guard throw
 * inside the STS-failure arm, which falls back to the developer's shell
 * credentials.
 *
 * Driven through the real Commander action. `withErrorHandling` is made a
 * pass-through so the refusal surfaces as a rejection instead of
 * `process.exit`; everything else the handler reaches before the check is
 * real. `ensureDockerAvailable` rejects with a sentinel, so the negative
 * control proves a valid ARN got PAST the entry check and stopped at the
 * first step after it.
 */

const mocks = vi.hoisted(() => ({
  applyRoleArnIfSet: vi.fn(),
  ensureDockerAvailable: vi.fn(),
  stsSend: vi.fn(),
}));

vi.mock('../../../src/utils/error-handler.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/error-handler.js')>();
  return { ...actual, withErrorHandling: <T>(fn: T): T => fn };
});

vi.mock('../../../src/utils/role-arn.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/role-arn.js')>();
  return { ...actual, applyRoleArnIfSet: mocks.applyRoleArnIfSet };
});

vi.mock('../../../src/local/docker-runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/local/docker-runner.js')>();
  return { ...actual, ensureDockerAvailable: mocks.ensureDockerAvailable };
});

vi.mock('@aws-sdk/client-sts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-sts')>();
  return {
    ...actual,
    STSClient: vi.fn().mockImplementation(() => ({ send: mocks.stsSend, destroy: vi.fn() })),
  };
});

import { STSClient } from '@aws-sdk/client-sts';
import { createLocalCommand } from '../../../src/cli/commands/local-invoke.js';
import { releaseStdoutForPayload } from '../../../src/utils/logger.js';

const DOCKER_SENTINEL = 'SENTINEL: reached ensureDockerAvailable';

async function invoke(args: string[]): Promise<unknown> {
  const local = createLocalCommand();
  local.exitOverride();
  for (const sub of local.commands) sub.exitOverride();
  try {
    await local.parseAsync(['invoke', 'MyStack/Fn', ...args], { from: 'user' });
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('local invoke refuses an explicit --assume-role at handler entry (issue #2348)', () => {
  beforeEach(() => {
    for (const m of Object.values(mocks)) m.mockReset();
    vi.mocked(STSClient).mockClear();
    mocks.ensureDockerAvailable.mockRejectedValue(new Error(DOCKER_SENTINEL));
  });

  afterEach(() => {
    releaseStdoutForPayload();
  });

  it.each([
    ['a malformed', ['--assume-role', 'arn:aws:iam::123456789012:role/x\nforged']],
    ['an EMPTY', ['--assume-role=']],
  ])('refuses %s value before any STS or docker work', async (_label, args) => {
    const err = await invoke(args);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/^Invalid --assume-role value: AssumeRole refused/);
    expect(mocks.applyRoleArnIfSet).not.toHaveBeenCalled();
    expect(mocks.ensureDockerAvailable).not.toHaveBeenCalled();
    expect(vi.mocked(STSClient)).not.toHaveBeenCalled();
    expect(mocks.stsSend).not.toHaveBeenCalled();
  });

  it('lets a well-formed ARN past the entry check (negative control)', async () => {
    const err = await invoke(['--assume-role', 'arn:aws:iam::123456789012:role/Good']);
    // Stopped at the first step AFTER the check, not by it.
    expect((err as Error).message).toBe(DOCKER_SENTINEL);
    expect(mocks.applyRoleArnIfSet).toHaveBeenCalledTimes(1);
    expect(mocks.ensureDockerAvailable).toHaveBeenCalledTimes(1);
  });
});
