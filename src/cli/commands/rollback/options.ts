import { Option } from 'commander';
import { parseStackRegion } from '../../options.js';
import { setupStateBackend } from '../state.js';
import type { StackStateRef } from '../../../state/s3-state-backend.js';
import { producerRecordKey } from '../../../state/record-keys.js';

export interface RollbackOptions {
  force?: boolean;
  yes?: boolean;
  orphan?: string[];
  revertFailed?: boolean;
  /** go-to-k/cdkd#4633: drop this logical id's journaled failed-CREATE orphan entry. */
  dropFailed?: string;
  skipFinalSnapshot?: boolean;
  /**
   * go-to-k/cdkd#4678: turn protection off before this stack's rollback
   * deletes a resource the failed deploy left (a completed CREATE's, or a
   * failed CREATE's once proven), as `cdkd destroy --remove-protection` does;
   * a nested stack's revert carries it into that child (go-to-k/cdkd#4703).
   */
  removeProtection?: boolean;
  stackRegion?: string;
  stateBucket?: string;
  statePrefix: string;
  region?: string;
  profile?: string;
  roleArn?: string;
  verbose: boolean;
}

/**
 * `--stack-region <region>` — disambiguate when the same stackName has state
 * in multiple regions (same pattern + messages as the `state` subcommands).
 */
export function stackRegionOption(): Option {
  return new Option(
    '--stack-region <region>',
    'Region of the target stack when the same name has state in multiple regions'
  ).argParser(parseStackRegion);
}

/**
 * Discover every stack that currently has a rollback journal. One raw key
 * listing under the prefix (journals live at
 * `{prefix}/{stackName}/{region}/rollback-journal.json`), parsed back to
 * `(stackName, region)` refs.
 */
export async function findJournalCandidates(
  backend: Awaited<ReturnType<typeof setupStateBackend>>['stateBackend'],
  prefix: string
): Promise<StackStateRef[]> {
  const keys = await backend.listRawKeys(`${prefix}/`);
  const refs: StackStateRef[] = [];
  const suffix = '/rollback-journal.json';
  const seen = new Set<string>();
  for (const key of keys) {
    if (!key.endsWith(suffix)) continue;
    const rest = key.slice(prefix.length + 1, key.length - suffix.length);
    const segments = rest.split('/');
    // {stackName}/{region}
    if (segments.length !== 2) continue;
    const [stackName, region] = segments;
    if (!stackName || !region) continue;
    // {@link producerRecordKey}, not a separator (go-to-k/cdkd#3323). Both
    // halves are S3 key segments, exactly as in `listStacks`' dedupe.
    const dedupe = producerRecordKey(stackName, region);
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    refs.push({ stackName, region });
  }
  return refs;
}
