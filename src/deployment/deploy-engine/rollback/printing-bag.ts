/**
 * The printing bag a replay of the automatic rollback runs under.
 * Split out of `deploy-engine/rollback.ts` (go-to-k/cdkd#5835), which
 * re-exports what it exported.
 */
import { namingSecretsFor, printingSecretsFor } from '../masking.js';
import type { ResourceState } from '../../../types/state.js';
import { secretNameNeedlesOf, secretNamesReadBy } from '../../secret-name-needles.js';
import {
  type RecordedSecretValues,
  recordLogOnlyValue,
  unionOfSecretBags,
} from '../../secret-redaction.js';
import type { RollbackDeps } from './deps.js';

/**
 * The PRINTING bag the automatic rollback replays its journaled orphans and
 * its completed ops under (go-to-k/cdkd#3869), one per replay; each entry is
 * an op's record (and, for a completed op, the record it replaced). Unlike
 * `cdkd rollback`'s, the ops and records here are
 * IN MEMORY, so a name this deploy resolved is plaintext and no `{{resolve:`
 * spelling marks it: the judge is the engine's own, which also sees a record
 * still spelling a reference (one loaded from state). The union of:
 *  - each entry's printing bag (`printingSecretsFor`): its resolved secrets
 *    and the derived-name registry `create.ts` filled right after resolving;
 *  - each entry's own record judged with its id;
 *  - the names each entry READ from a record, judged with that record's own
 *    resolution (`namingSecretsFor`), as `noteSecretNamedReads` judges them.
 * Log-only: bound with `withPrintingSecrets`, read by nothing that decides.
 */
export function replayPrintingBag(
  deps: RollbackDeps,
  entries: readonly {
    logicalId: string;
    resourceType: string;
    physicalId?: string | undefined;
    properties?: Record<string, unknown> | undefined;
  }[],
  stateResources: Record<string, ResourceState>
): RecordedSecretValues {
  const read: RecordedSecretValues = new Map();
  for (const entry of entries) {
    const names = secretNamesReadBy(
      entry.logicalId,
      { properties: entry.properties },
      stateResources,
      (otherId) => ({
        secrets: namingSecretsFor(deps.secretsRun(), otherId),
        embedded: deps.secretsRun().perResourceSecrets.get(otherId),
      })
    );
    for (const needle of names) recordLogOnlyValue(read, needle);
  }
  // Each entry's own record WITH its id: the registry entry `create.ts` made
  // had no id yet, so its id-needing arms (an IAM `Path`'s whole id, a needle
  // embedded in the id) never fired.
  const own: RecordedSecretValues = new Map();
  for (const entry of entries) {
    const needles = secretNameNeedlesOf(
      entry.logicalId,
      {
        resourceType: entry.resourceType,
        physicalId: entry.physicalId,
        properties: entry.properties,
      },
      namingSecretsFor(deps.secretsRun(), entry.logicalId),
      { embedded: deps.secretsRun().perResourceSecrets.get(entry.logicalId) }
    );
    for (const needle of needles ?? []) recordLogOnlyValue(own, needle);
  }
  return unionOfSecretBags([
    ...entries.map((entry) => printingSecretsFor(deps.secretsRun(), entry.logicalId)),
    own,
    read,
  ]);
}
