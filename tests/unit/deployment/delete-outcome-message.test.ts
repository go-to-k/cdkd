import { describe, expect, it } from 'vite-plus/test';
import { deleteSkippedMessage } from '../../../src/deployment/delete-outcome.js';

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
    expect(message).toContain('so it was NOT deleted');
    expect(message).not.toMatch(/[\n\r]/);
  });

  it('leaves an ordinary message byte-identical', () => {
    expect(deleteSkippedMessage('Tbl', 'phys-1', 'bad id', 'during destroy')).toBe(
      'cdkd could not address Tbl (phys-1) during destroy, so it was NOT deleted and may ' +
        'still exist: bad id'
    );
  });
});
