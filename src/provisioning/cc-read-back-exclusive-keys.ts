import type { JsonPatchOp } from './json-patch-generator.js';

/** One measured pair: the read-back key, and the write-only keys AWS refuses beside it. */
export interface CcReadBackExclusiveKey {
  /** The top-level key the Cloud Control read model always spells the value as. */
  readonly readBack: string;
  /** Write-only top-level keys the handler refuses together with `readBack`. */
  readonly writtenAs: readonly string[];
}

/**
 * Per type: a top-level key the Cloud Control read model holds IN PLACE of a
 * write-only key the template declares, which the handler refuses beside it
 * (go-to-k/cdkd#6818, go-to-k/cdkd#6819).
 *
 * Cloud Control applies an update patch on top of the model its read handler
 * returns. That model never holds the write-only key, only the read-back
 * spelling of the same setting, so a patch that writes the write-only key
 * sends both, and the update fails, where CloudFormation hands the handler the
 * template's model:
 *
 * - `AWS::StepFunctions::StateMachineAlias`: the model holds
 *   `RoutingConfiguration`; a patch writing `DeploymentPreference` (the normal
 *   way to shift the alias to a new version) fails with "Specify exactly one of
 *   'RoutingConfiguration' or 'DeploymentPreference', not both.".
 * - `AWS::Bedrock::Flow`: the model holds `Definition`; a patch writing
 *   `DefinitionString` (or `DefinitionS3Location`) fails with "you can only
 *   specify one of Definition, DefinitionString or DefinitionS3Location".
 *
 * The same patch plus `remove /<readBack>` was measured to succeed for each,
 * with AWS then reporting the new value. A type joins by measurement, never by
 * reading its schema.
 */
export const CC_READ_BACK_EXCLUSIVE_KEYS: Readonly<
  Record<string, readonly CcReadBackExclusiveKey[]>
> = {
  'AWS::Bedrock::Flow': [
    { readBack: 'Definition', writtenAs: ['DefinitionString', 'DefinitionS3Location'] },
  ],
  'AWS::StepFunctions::StateMachineAlias': [
    { readBack: 'RoutingConfiguration', writtenAs: ['DeploymentPreference'] },
  ],
};

/** Whether `resourceType` has pairs in {@link CC_READ_BACK_EXCLUSIVE_KEYS}. */
export function hasCcReadBackExclusiveKeys(resourceType: string): boolean {
  return Object.prototype.hasOwnProperty.call(CC_READ_BACK_EXCLUSIVE_KEYS, resourceType);
}

/**
 * Extend a Cloud Control update patch with `remove /<readBack>` for each
 * listed pair of the type when ALL hold:
 *
 * - the patch has an `add` / `replace` on one of the pair's `writtenAs` keys;
 * - the patch has no op on `/<readBack>`, and `desired` does not declare it: a
 *   template declaring both is refused by AWS either way, and
 *   `cdkd drift --revert`'s desired bag is the read-back snapshot, which holds
 *   `readBack` and never a write-only key;
 * - the live model (the Cloud Control read model the patch is applied to) HAS
 *   the key: a `remove` on a path the model lacks fails the whole patch
 *   (RFC 6902).
 *
 * `readLiveModel` is called only once the first two hold, so an update that
 * writes no listed key pays no `GetResource`. An unreadable model
 * (`undefined`) leaves the patch as the generator wrote it.
 *
 * Every other type, or nothing to remove, returns the same array.
 */
export async function withCcReadBackExclusiveKeyRemovals(
  resourceType: string,
  patch: JsonPatchOp[],
  desired: Record<string, unknown>,
  readLiveModel: () => Promise<Record<string, unknown> | undefined>
): Promise<JsonPatchOp[]> {
  const pairs = hasCcReadBackExclusiveKeys(resourceType)
    ? CC_READ_BACK_EXCLUSIVE_KEYS[resourceType]!
    : [];
  const candidates = pairs.filter(
    ({ readBack, writtenAs }) =>
      patch.some(
        (op) =>
          (op.op === 'add' || op.op === 'replace') &&
          writtenAs.some((key) => op.path === `/${escapeJsonPointer(key)}`)
      ) &&
      !patch.some((op) => op.path === `/${escapeJsonPointer(readBack)}`) &&
      !Object.prototype.hasOwnProperty.call(desired, readBack)
  );
  if (candidates.length === 0) return patch;
  const liveModel = await readLiveModel();
  if (liveModel === undefined) return patch;
  const extra: JsonPatchOp[] = candidates
    .filter(({ readBack }) => Object.prototype.hasOwnProperty.call(liveModel, readBack))
    .map(({ readBack }) => ({ op: 'remove', path: `/${escapeJsonPointer(readBack)}` }));
  return extra.length === 0 ? patch : [...patch, ...extra];
}

/** RFC 6901, as `json-patch-generator.ts` spells the paths it emits. */
function escapeJsonPointer(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1');
}
