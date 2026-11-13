import { describe, it, expect, afterEach } from 'vite-plus/test';
import { registerVerboseRunProbe } from '../../../src/utils/aws-failure-text.js';
import { abandonedScanStackNote } from '../../../src/cli/commands/scrub/abandoned-scan.js';
import { refuseDivergentRecordRegionForRollback } from '../../../src/cli/commands/rollback/guards.js';
import { divergentRecordRegionRefusalMessage } from '../../../src/state/malformed-resources-bag/divergent-region.js';
import type { StackState } from '../../../src/types/state.js';

/**
 * go-to-k/cdkd#6162: hints worded around `--verbose` say where the detail
 * already is on a `--verbose` run, instead of asking for a re-run. Both arms
 * per site; the sites driven through a command live beside their own suites
 * (drift, s3-state-backend, state-record-shape, scrub-nested-child).
 */
afterEach(() => {
  registerVerboseRunProbe(() => false);
});

const verbose = (on: boolean): void => registerVerboseRunProbe(() => on);

function rollbackRefusal(): string {
  const state = { resources: { A: { resourceType: 'AWS::SQS::Queue' } } } as unknown as StackState;
  try {
    refuseDivergentRecordRegionForRollback(state, 'S', 'us-east-1', 'eu-west-1', 0);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected a refusal');
}

describe('scrub abandoned-scan note', () => {
  it('asks for a re-run on an ordinary run', () => {
    verbose(false);
    expect(abandonedScanStackNote('count', 2)).toContain(
      'Re-run with --verbose for the cause of each.'
    );
  });
  it('points at the debug output on a --verbose run', () => {
    verbose(true);
    const note = abandonedScanStackNote('count', 2);
    expect(note).toContain('The cause of each is in the debug output above.');
    expect(note).not.toContain('--verbose');
  });
});

describe('rollback divergent-region refusal', () => {
  it('asks for a re-run on an ordinary run', () => {
    verbose(false);
    expect(rollbackRefusal()).toContain(
      "Nothing was changed. Re-run with --verbose to see what the record's region field holds, repair that field"
    );
  });
  it('points at the debug output on a --verbose run', () => {
    verbose(true);
    const text = rollbackRefusal();
    expect(text).toContain(
      "Nothing was changed. The debug output shows what the record's region field holds; repair that field"
    );
    expect(text).not.toContain('--verbose');
  });
});

describe('destroy divergent-region refusal', () => {
  it('asks for a re-run on an ordinary run', () => {
    verbose(false);
    expect(divergentRecordRegionRefusalMessage('S', 'us-east-1', 'eu-west-1', 1)).toContain(
      "Re-run with --verbose to see what the record's region field holds, then either destroy"
    );
  });
  it('points at the debug output on a --verbose run', () => {
    verbose(true);
    const text = divergentRecordRegionRefusalMessage('S', 'us-east-1', 'eu-west-1', 1);
    expect(text).toContain("The debug output shows what the record's region field holds. Either destroy");
    expect(text).not.toContain('--verbose');
  });
});
