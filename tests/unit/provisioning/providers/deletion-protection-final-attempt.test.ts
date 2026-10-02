/**
 * Issue #4318: the `--remove-protection` compensation keys on whether the
 * destroy loop will re-enter `delete()`. Two halves pin that answer:
 *
 *  - the loop's attempt cap: `runDeleteAttempt(true, ...)` makes ANY failure of
 *    the last attempt terminal, so a persistent retryable refusal is
 *    compensated once, at the cap, instead of leaving the guard off silently;
 *  - the classification text: the predicate reads `retryClassificationText`
 *    like the loop does, so a redacted-cause error the loop retries is not
 *    called terminal (which released the record before the retry).
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import {
  ProtectionFlipRegistry,
  deleteWithProtectionCompensation,
  isTerminalDeleteFailure,
  logGroupProtectionSite,
  runDeleteAttempt,
} from '../../../../src/provisioning/providers/deletion-protection-compensation.js';
import { markRedactedCause } from '../../../../src/deployment/retryable-errors.js';

const IAM_DENY =
  'User: arn:aws:iam::123456789012:user/ci is not authorized to perform: logs:DeleteLogGroup';

function throttle(): Error {
  return Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
}

/** A wrap whose own message withholds the cause's retryable wording. */
function redactedDeny(stamped: boolean): Error {
  const cause = Object.assign(new Error(IAM_DENY), { name: 'AccessDeniedException' });
  const wrap = new Error('DELETE of Res was abandoned (AccessDeniedException).', { cause });
  return stamped ? markRedactedCause(wrap) : wrap;
}

describe('isTerminalDeleteFailure: the attempt scope (issue #4318)', () => {
  it('a retryable failure is terminal on the LAST attempt only', async () => {
    expect(isTerminalDeleteFailure(throttle())).toBe(false);
    expect(await runDeleteAttempt(false, async () => isTerminalDeleteFailure(throttle()))).toBe(
      false
    );
    expect(await runDeleteAttempt(true, async () => isTerminalDeleteFailure(throttle()))).toBe(
      true
    );
  });

  it('an inner attempt scope overrides an outer final one (a nested child destroy)', async () => {
    const inner = await runDeleteAttempt(true, () =>
      runDeleteAttempt(false, async () => isTerminalDeleteFailure(throttle()))
    );
    expect(inner).toBe(false);
  });

  it('the scope reaches across an await inside the attempt', async () => {
    const seen = await runDeleteAttempt(true, async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return isTerminalDeleteFailure(throttle());
    });
    expect(seen).toBe(true);
  });
});

describe('isTerminalDeleteFailure: reads the chain like the destroy loop (issue #4318)', () => {
  it('a STAMPED redacted wrap over a retryable cause is retryable', () => {
    expect(isTerminalDeleteFailure(redactedDeny(true))).toBe(false);
  });

  it('NEGATIVE CONTROL: the same wrap UNSTAMPED stays terminal', () => {
    expect(isTerminalDeleteFailure(redactedDeny(false))).toBe(true);
  });
});

describe('deleteWithProtectionCompensation across a capped retry sequence (issue #4318)', () => {
  it('holds the record through the early attempts and compensates once, at the cap', async () => {
    const registry = new ProtectionFlipRegistry();
    const reEnable = vi.fn(() => Promise.resolve());
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const attempt = () =>
      deleteWithProtectionCompensation({
        registry,
        key: 'k',
        run: async (flip) => {
          flip.flippedOffByThisRun = true;
          throw throttle();
        },
        compensation: {
          logicalId: 'Res',
          physicalId: '/lg',
          logger: logger as never,
          site: logGroupProtectionSite('/lg', 'us-east-1'),
          reEnable,
        },
      });

    for (let i = 0; i < 3; i += 1) {
      await expect(runDeleteAttempt(false, attempt)).rejects.toThrow('Rate exceeded');
      expect(reEnable).not.toHaveBeenCalled();
      expect(registry.size).toBe(1);
    }
    await expect(runDeleteAttempt(true, attempt)).rejects.toThrow('Rate exceeded');
    expect(reEnable).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('re-enabled on /lg'));
    // Restored at the cap, so nothing is left for a later delete to inherit.
    expect(registry.size).toBe(0);
  });
});
