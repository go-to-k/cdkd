/**
 * The deploy side's existence-read deps for `deleted-outside-cdkd.ts`
 * (go-to-k/cdkd#6106): the deploy's own provider registry, and each read under
 * the op's printing bag, as the replaced-delete retry binds it.
 */
import type { DeletedOutsideReadDeps } from '../../deleted-outside-cdkd.js';
import { withPrintingSecrets } from '../../resource-secrets-scope.js';
import { secretNameBagFor } from '../masking.js';
import type { RollbackDeps } from './deps.js';

export function deletedOutsideReadDeps(deps: RollbackDeps): DeletedOutsideReadDeps {
  return {
    providerRegistry: deps.providerRegistry,
    withPrinting: (logicalId, read) =>
      withPrintingSecrets(secretNameBagFor(deps.secretsRun(), logicalId), read),
  };
}
