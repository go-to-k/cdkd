import type { DeployEngine } from '../deploy-engine.js';
import { maskSecretsInText, hasMaskableValues } from '../secret-redaction.js';
import { maskEventTextWithBoundBags, ORPHAN_COMMAND_LABEL } from '../secret-name-needles.js';
import { withPrintingSecrets } from '../resource-secrets-scope.js';
import { printingSecretsFor } from './masking.js';

/**
 * Mask any resolved secret value out of an event's human-authored text before
 * it is persisted to `deployments/*.jsonl` (which outlives `cdkd destroy`)
 * — GHSA fix. An AWS validation error can quote the offending property value
 * (`Value '<secret>' at 'X' failed to satisfy ...`), and a provider `reason`
 * is provider-authored prose; both reach the event store as `error.message` /
 * `reason`. No-op when the deploy recorded no secrets.
 *
 * The LOG-ONLY needles count (go-to-k/cdkd#1998): a `NoEcho` parameter's
 * value quoted inside an AWS error is exactly what this store must not keep,
 * and masking text in an event rewrites no value cdkd reads back.
 *
 * ONE pass over the union of match spans of the event's own resource
 * secrets AND the printing bags bound where it is recorded
 * (go-to-k/cdkd#3869): two passes in either order let a needle of one bag
 * split an overlapping needle of the other and leave a fragment of it. A replay refusal's own
 * `To orphan it:` command line (`ownLines`) is exempt from the BOUND bags
 * only, as `maskEventTextWithBoundBags` documents; the engine bag still
 * masks it, as it always has.
 */
export function maskSecretsInEvent<
  T extends {
    logicalId?: string;
    error?: { message?: string; ownLines?: boolean };
    reason?: string;
  },
>(this: DeployEngine, event: T): T {
  // Mask with the event's own resource secrets; a resource-less (run-level)
  // event carries no properties-derived text.
  // `printingSecretsFor`: a resource named from a secret also masks its
  // physical-id needles here (go-to-k/cdkd#3869). The event's `physicalId`
  // FIELD is left as is: it is the id a cleanup pass needs, and `state.json`
  // beside this store records it too.
  const own = event.logicalId ? printingSecretsFor(this.secretsRun, event.logicalId) : undefined;
  if (own === undefined || !hasMaskableValues(own)) return maskEventTextWithBoundBags(event);
  const masked = withPrintingSecrets(own, () => maskEventTextWithBoundBags(event));
  const message = masked.error?.message;
  if (masked.error?.ownLines !== true || !message) return masked;
  const commandLines = message
    .split('\n')
    .map((line) => (line.startsWith(ORPHAN_COMMAND_LABEL) ? maskSecretsInText(line, own) : line))
    .join('\n');
  return { ...masked, error: { ...masked.error, message: commandLines } };
}
