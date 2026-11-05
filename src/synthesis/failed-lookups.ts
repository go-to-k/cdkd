import type { StackInfo } from './assembly-reader.js';
import { SynthesisError } from '../utils/error-handler.js';
import { displaySafe } from '../utils/display-safe.js';

/**
 * A context lookup that failed and was still missing when context resolution
 * stopped making progress (go-to-k/cdkd#5805). `error` is the `$providerError`
 * text handed to the app, which `ContextProvider.getValue` adds VERBATIM as an
 * error annotation on the construct that asked, before falling back to the
 * lookup's dummy value.
 */
export interface FailedLookup {
  key: string;
  error: string;
}

/**
 * The refusal for failed lookups: what failed, and the next step.
 */
export function failedLookupsError(failed: readonly FailedLookup[]): SynthesisError {
  return new SynthesisError(
    'Context lookup failed: ' +
      failed.map((f) => `${displaySafe(f.key)}: ${displaySafe(f.error)}`).join('; ') +
      '. Grant the permissions the lookup needs or refresh the AWS credentials, ' +
      'or supply the value in cdk.context.json or with -c <key>=<value>.'
  );
}

/**
 * Refuse when a stack the command USES asked for a lookup that failed — for a
 * command that does not run `processStackMessages` (diff, import, local, ...).
 * Only the selected stacks count, as in the AWS CDK CLI's `validateStacks`, so
 * a failed lookup in a sibling stack does not block a command on another one
 * (go-to-k/cdkd#5807). A stack is matched by the error annotation the app adds
 * for the failure, the one place a failed lookup is attributed to a stack:
 * `manifest.missing` entries name none.
 */
export function refuseFailedLookups(
  stacks: readonly StackInfo[],
  failedLookups: readonly FailedLookup[] | undefined
): void {
  if (!failedLookups || failedLookups.length === 0) return;
  const hits = failedLookups.filter((f) =>
    stacks.some((stack) =>
      stack.messages?.some((m) => m.level === 'error' && m.message.includes(f.error))
    )
  );
  if (hits.length > 0) throw failedLookupsError(hits);
}
