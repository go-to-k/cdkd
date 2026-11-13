import { awsEndpointOverrideActive } from './aws-client-defaults.js';
import { cdkdRemedy } from './pasteable-command.js';

/**
 * The remedy sentence for a missing cdkd state bucket (go-to-k/cdkd#6245).
 *
 * Against real AWS: `Run 'cdkd bootstrap' to create <what>.`, as before.
 *
 * Under `--aws-emulator` (an active endpoint override), the bucket is missing
 * because AWS Emulator keeps nothing across restarts, and `cdkd deploy` /
 * `cdkd import` create it on their own (`emulator-auto-bootstrap.ts`). Only a
 * command that creates nothing reaches this: a state read (`state list`,
 * `diff`, `drift`, `destroy`) or `deploy --dry-run`, which
 * docs/aws-emulator.md promises creates nothing, so it is not auto-bootstrapped
 * here either. The text says that, and its `cdkd bootstrap` carries the run's
 * `--aws-emulator`, so pasting it does not bootstrap the real account.
 *
 * @param what - What `cdkd bootstrap` creates, as the sentence names it
 *   (`'cdkd-state-123456789012'`, or `it`).
 */
export function missingStateBucketRemedy(what: string): string {
  if (!awsEndpointOverrideActive())
    return `Run '${cdkdRemedy('cdkd bootstrap')}' to create ${what}.`;
  return (
    'AWS Emulator keeps nothing across restarts, so a new or restarted emulator has no cdkd ' +
    'bootstrap yet. A cdkd deploy without --dry-run creates the state bucket on its own; or ' +
    `bootstrap the emulator now with:\n${cdkdRemedy('cdkd bootstrap')}`
  );
}
