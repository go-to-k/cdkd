import { supersededResourcesOf } from '../../../deployment/superseded-resources.js';
import {
  NO_LOCAL_CUSTOM_RESOURCES_FLAG,
  customResourcesRunWithoutApp,
  localCustomResourceCommand,
} from '../../../local/custom-resource-runtime-gate.js';
import { isCustomResource } from '../../../provisioning/provider-registry.js';
import type { StackState } from '../../../types/state.js';
import { CdkdError } from '../../../utils/error-handler.js';
import {
  pasteableCommand,
  plainOrDescribed,
  withheldTargetClause,
} from '../../../utils/pasteable-command.js';

/** How many custom resources the refusal names before summarizing the rest. */
const NAMED_MAX = 5;

/**
 * go-to-k/cdkd#6246: refuse, BEFORE the prompt and before anything is deleted,
 * a destroy under `--aws-emulator` that read no CDK app while the stack's
 * record holds custom resources.
 *
 * Without the app, the local custom-resource runtime has no function code, so
 * every Delete goes to AWS Emulator's own Lambda runtime, which fails CDK's own
 * providers (`AwsCustomResource`, `autoDeleteObjects`, `BucketDeployment`).
 * The run then went on to delete the handler functions with the rest of the
 * stack, so the advised `cdkd destroy` from the app could no longer run them
 * and whatever they manage stayed live. Refused here, the handlers are still
 * in place when the operator follows the remedy.
 *
 * Only `cdkd destroy` / `cdkd state destroy` (a nested child of either
 * included): a rollback that removes a nested stack reads no app either, but
 * has its own remedy (go-to-k/cdkd#6247). `--no-local-custom-resources` turns
 * the local runtime off, which is the operator accepting the emulator's
 * runtime, so this never fires under it.
 */
export function refuseCustomResourcesWithoutApp(stackName: string, state: StackState): void {
  const command = localCustomResourceCommand();
  if (command !== 'destroy' && command !== 'state destroy') return;
  if (!customResourcesRunWithoutApp()) return;
  const ids = [
    ...Object.entries(state.resources)
      .filter(([, r]) => isCustomResource(r.resourceType))
      .map(([id]) => id),
    ...supersededResourcesOf(state)
      .filter((e) => isCustomResource(e.state.resourceType))
      .map((e) => e.logicalId),
  ];
  if (ids.length === 0) return;
  throw new CdkdError(customResourcesWithoutAppMessage(stackName, ids), 'EMULATOR_CR_NO_APP');
}

/** The refusal text, exported for the unit test. */
export function customResourcesWithoutAppMessage(
  stackName: string,
  logicalIds: readonly string[]
): string {
  const named = logicalIds.slice(0, NAMED_MAX).map((id) => plainOrDescribed(id, 'logical id'));
  const more = logicalIds.length - named.length;
  const list = named.join(', ') + (more > 0 ? ` and ${more} more` : '');
  const destroy = pasteableCommand('cdkd destroy', [
    { value: stackName, hole: 'stack', opts: { plainIdent: true } },
  ]);
  return (
    `Stack ${plainOrDescribed(stackName, 'stack name')} has custom resources (${list}) whose Delete handlers ` +
    `would run in AWS Emulator's own Lambda runtime, because this command did not synthesize the ` +
    `CDK app, and that runtime fails CDK's own provider functions. The destroy would then delete ` +
    `the handler functions too, leaving what the custom resources manage behind with nothing ` +
    `left to delete it. Nothing was deleted.\n` +
    `Run the destroy from the app's directory (Docker running), so the handlers run locally, ` +
    `or pass ${NO_LOCAL_CUSTOM_RESOURCES_FLAG} to send them to AWS Emulator's runtime anyway.` +
    withheldTargetClause(destroy, 'stack', 'cdkd destroy', "This stack's name") +
    `\nRun from the app's directory: ${destroy.command}`
  );
}
