import { CdkdError } from '../../../utils/error-handler.js';
import type { ConsoleLogger } from '../../../utils/logger.js';
import type { StackInfo } from '../../../synthesis/assembly-reader.js';
import { analyzePinCcApiReachability } from '../pin-cc-api-reachability.js';
import type { DeployCommandOptions } from './types.js';

/**
 * The run-level `--pin-cc-api` checks, before any stack deploys.
 */
export function checkPinCcApiOptions(
  options: DeployCommandOptions,
  targetStacks: StackInfo[],
  logger: ConsoleLogger
): void {
  // Issue #2719 — `--pin-cc-api X` and `--recreate-via-sdk-provider X` are
  // opposite requests for one resource: keep it on Cloud Control, and move it
  // off Cloud Control by destroying and recreating it. The recreate wins on
  // the replacement path (the pin does not colour a replacement at all), so
  // without this the pin would silently lose. Mirrors the existing mutual
  // exclusion between the two `--recreate-via-*` flags.
  if (options.pinCcApi?.length && options.recreateViaSdkProvider?.length) {
    const both = options.pinCcApi.filter((id) =>
      (options.recreateViaSdkProvider ?? []).includes(id)
    );
    if (both.length > 0) {
      throw new CdkdError(
        `--pin-cc-api and --recreate-via-sdk-provider both named: ${both.join(', ')}. ` +
          `They are opposite requests — the first keeps the resource on Cloud Control, the ` +
          `second destroys and recreates it via the SDK provider. Pass one.`,
        'PIN_CC_API_INVALID'
      );
    }
  }

  // Issue #2719 — the `--pin-cc-api` reachability check. The DECISION is
  // `analyzePinCcApiReachability`, a pure function tested directly; this site
  // only renders it. Extracted because the previous revision lived entirely
  // inside this command and so had no coverage at all: a review round moved
  // it from `debug` to `warn` and nothing would have noticed it moving back.
  if (options.pinCcApi?.length) {
    const reach = analyzePinCcApiReachability(
      options.pinCcApi,
      targetStacks.map((st) => ({
        stackName: st.stackName,
        logicalIds: Object.keys(st.template.Resources ?? {}),
      }))
    );
    // Throw FIRST: a partial-match advisory printed immediately above a fatal
    // error reads as part of the failure rather than as information about a
    // different id.
    if (reach.unmatched.length > 0) {
      throw new CdkdError(reach.errorMessage, 'PIN_CC_API_INVALID');
    }
    for (const partial of reach.partial) {
      // NAMES, not a count. The per-stack warn this replaced said which
      // stacks did not declare the id, and dropping to "the other N" lost
      // the only part a user can act on.
      logger.info(
        `--pin-cc-api ${partial.logicalId}: applies to ${partial.appliesTo.join(', ')}; ` +
          `not declared by ${partial.absentFrom.join(', ')}`
      );
    }
  }
}
