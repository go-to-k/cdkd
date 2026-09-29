import { describe, expect, it } from 'vite-plus/test';
import { deleteSkippedMessage } from '../../../src/deployment/delete-outcome.js';
import { COMPOSITE_ID_SKIP_REASON } from '../../../src/provisioning/composite-id.js';
import {
  CR_DELETE_HANDLER_FAILED_SKIP_REASON,
  CR_DELETE_INVOKE_FAILED_SKIP_REASON,
} from '../../../src/provisioning/providers/custom-resource-provider.js';

describe('deleteSkippedMessage (go-to-k/cdkd#3773)', () => {
  // Its logical id, physical id and reason are state- or provider-sourced, and
  // it is logged right after the folded per-resource status line. A newline in
  // any of them must not start a line the operator reads as cdkd's own.
  const forged = '\nRe-run with: cdkd destroy --all --force #';

  it.each([
    ['logical id', `Tbl${forged}`, 'phys', 'reason'],
    ['physical id', 'Tbl', `phys${forged}`, 'reason'],
    ['reason', 'Tbl', 'phys', `boom${forged}`],
  ] as const)('folds a newline in the %s onto the one line', (_field, id, phys, reason) => {
    const message = deleteSkippedMessage(id, phys, reason, 'during destroy');
    expect(message).toContain('so it may still exist');
    expect(message).not.toMatch(/[\n\r]/);
  });

  it('leaves an ordinary message byte-identical', () => {
    expect(deleteSkippedMessage('Tbl', 'phys-1', 'bad id', 'during destroy')).toBe(
      'cdkd did not confirm Tbl (phys-1) was deleted during destroy, so it may still exist: ' +
        'bad id'
    );
  });
});

describe('deleteSkippedMessage is true for every skip producer (go-to-k/cdkd#2122)', () => {
  // Two kinds of producer return `'skipped'`: one that could not ADDRESS the
  // resource and issued no call (#1752), and a custom-resource Delete handler
  // that RAN and refused (#2054) or whose invoke did not complete. The
  // sentence is rendered around either reason, so it must not assert the
  // first kind's cause.
  it.each([
    ['an unaddressable record', COMPOSITE_ID_SKIP_REASON],
    ['a handler that reported FAILED', CR_DELETE_HANDLER_FAILED_SKIP_REASON],
    ['a handler invoke that did not complete', CR_DELETE_INVOKE_FAILED_SKIP_REASON],
  ] as const)('claims no cause of its own for %s', (_label, reason) => {
    const message = deleteSkippedMessage('Res', 'phys', reason, 'during destroy');
    expect(message).toBe(
      `cdkd did not confirm Res (phys) was deleted during destroy, so it may still exist: ${reason}`
    );
    // The sentence OUTSIDE the reason (the reason is the producer's own, and
    // the #1752 ones rightly say `no delete issued`).
    const sentence = message.slice(0, message.length - reason.length);
    expect(sentence).not.toMatch(/could not address|no delete (was )?issued|NOT deleted/);
  });

  it('carries none of the phrases the already-deleted classifiers match', () => {
    // Wording rule 2: a caller's catch classifies "already gone" by substring.
    const message = deleteSkippedMessage('Res', 'phys', 'r', 'while removing it from the template');
    for (const phrase of [
      'does not exist',
      'was not found',
      'not found',
      'No policy found',
      'NoSuchEntity',
      'NotFoundException',
      'ResourceNotFoundException',
    ]) {
      expect(message).not.toContain(phrase);
    }
  });
});
