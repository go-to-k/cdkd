import { derivePartitionAndUrlSuffix } from './aws-partition.js';

/**
 * Matching the HOST half of an ECR image URI:
 * `<acct>.dkr.ecr.<region>.<urlSuffix>/`.
 *
 * The suffix is CAPTURED rather than spelled out (issue #1758): the previous
 * pattern hardcoded `amazonaws.com` with an optional `.cn` tail, so a `us-iso*`
 * registry (`c2s.ic.gov` / `sc2s.sgov.gov`) never matched and the caller
 * silently classified a real ECR image as a user-managed one — skipping the
 * `docker login` it needs.
 */
const ECR_URI_HOST_REGEX = /^(\d{12})\.dkr\.ecr\.([^.]+)\.([^/]+)\//;

/**
 * The account + region of an ECR image URI, or `undefined` when the URI is not
 * an ECR registry host for the region it names.
 *
 * Lives in `src/utils/` rather than beside its first caller because it has TWO
 * consumers in different layers — `src/local/ecr-puller.ts` (which needs the
 * `:tag` tail too) and `src/local/ecs-task-resolver.ts` (which classifies an
 * image that may carry a digest or no tag at all). Before issue #1758 they each
 * carried their own copy of the hardcoded commercial pattern, and fixing only
 * the pull path left `cdkd local run-task` broken outside the commercial
 * partition; ONE definition is what stops them drifting apart again.
 *
 * The module is deliberately free of AWS SDK imports, which is what lets
 * `ecs-task-resolver.ts` consume it without breaking the invariant that module
 * documents about itself (it resolves secrets through a separate module for
 * exactly that reason).
 */
export function parseEcrRegistryHost(
  imageUri: string
): { accountId: string; region: string } | undefined {
  const m = ECR_URI_HOST_REGEX.exec(imageUri);
  if (!m) return undefined;
  const region = m[2]!;
  // The captured suffix must be the one the region's partition actually uses.
  // Accepting ANY suffix would classify `<acct>.dkr.ecr.<region>.example.com`
  // as ECR and point a `docker login` at a registry cdkd does not own.
  if (m[3] !== derivePartitionAndUrlSuffix(region).urlSuffix) return undefined;
  return { accountId: m[1]!, region };
}

/**
 * True when the URI has the ECR HOST SHAPE but its suffix does not belong to
 * the region it names — i.e. exactly the case {@link parseEcrRegistryHost}
 * rejects for a reason the caller may want to report.
 *
 * The two rejections are worth telling apart at a call site that degrades
 * silently: a genuinely public image and a registry in a partition
 * `derivePartitionAndUrlSuffix` does not know yet (issue #1764) both come back
 * `undefined`, and only the second is a cdkd gap rather than a user choice.
 */
export function looksLikeEcrHostWithForeignSuffix(imageUri: string): boolean {
  const m = ECR_URI_HOST_REGEX.exec(imageUri);
  return m !== null && m[3] !== derivePartitionAndUrlSuffix(m[2]!).urlSuffix;
}
