import { getLogger } from '../../../utils/logger.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { confirmOrRefuse } from '../confirm-prompt.js';
import {
  hasMaskableValues,
  maskSecretsInText,
  type RecordedSecretValues,
} from '../../../deployment/secret-redaction.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { commandHole } from '../../../utils/pasteable-command.js';
import { remedyLogicalId } from '../../../provisioning/import-helpers.js';
import { logicalIdShown, resourceTypeShown } from '../../../provisioning/composite-id.js';
import type { ResourceImportInput, ResourceImportResult } from '../../../types/resource.js';
import type { ResourceState } from '../../../types/state.js';
import { secretNamePrintingBag } from '../../../deployment/secret-name-needles.js';
import { withPrintingSecrets } from '../../../deployment/resource-secrets-scope.js';
import { substituteOverrideRefs } from './overrides.js';
import { resolvePseudoParameterIntrinsics } from './pseudo-parameters.js';
import type { ImportOutcome, ImportRow, ImportTask } from './types.js';

/**
 * `{ physicalIdShown }` when `bag` changes how `physicalId` prints
 * (go-to-k/cdkd#3869), else nothing.
 */
function shownPhysicalId(
  physicalId: string,
  bag: RecordedSecretValues
): { physicalIdShown?: string } {
  if (!hasMaskableValues(bag)) return {};
  const shown = maskSecretsInText(physicalId, bag);
  return shown === physicalId ? {} : { physicalIdShown: shown };
}

export async function importOne(task: ImportTask): Promise<ImportRow> {
  const logger = getLogger();
  const { logicalId, resource, stackName, region, providerRegistry, override, overrides } = task;

  if (!providerRegistry.hasProvider(resource.Type)) {
    return {
      logicalId,
      resourceType: resource.Type,
      outcome: 'skipped-no-impl',
      reason: 'no provider registered',
    };
  }

  // The routing decision carries the layer it chose, which the row records
  // (go-to-k/cdkd#4706): a type with no SDK provider is read through Cloud
  // Control, and a record saying `sdk` for it let `--recreate-via-cc-api`
  // through its already-on-Cloud-Control refusal.
  const route = providerRegistry.getProviderFor({ resourceType: resource.Type });
  const provider = route.provider;
  if (!provider.import) {
    return {
      logicalId,
      resourceType: resource.Type,
      outcome: 'skipped-no-impl',
      reason: `provider does not implement import (yet)`,
    };
  }

  // Pre-resolve `{Ref: <X>}` intrinsics in Properties against the overrides
  // map. For `--migrate-from-cloudformation` this map is pre-populated from
  // CFn's `DescribeStackResources` with every resource's PhysicalResourceId,
  // so sub-resource providers (e.g. `SQSQueuePolicyProvider`) whose
  // `Properties` carries `{Ref: <Parent>}` see the parent's operational
  // identifier here rather than the raw intrinsic. The post-import
  // `resolveImportedProperties` pass still runs full intrinsic resolution
  // (incl. `Fn::GetAtt` / `Fn::Sub` / etc.) — this hook is the targeted
  // pre-pass needed at provider.import() time. Closes issue #361.
  //
  // Before it, resolve intrinsics built only from literals and the account /
  // region pseudo-parameters (issue #1897), so a name like
  // `cdkd-test-${AWS::AccountId}.internal` reaches the provider as the string
  // it names. It runs FIRST so it only ever sees what the template spelled: a
  // `Fn::Join` mixing a pseudo-parameter with a resource `Ref` is left whole.
  //
  // Inside the per-resource `try`, so an unexpected rejection costs this ONE
  // row (`failed`) rather than the whole import.
  // go-to-k/cdkd#3869: a resource the TEMPLATE names from a secret (its name
  // property spells a `{{resolve:` reference) prints its physical id in the
  // provider's lines and in AWS's error. Judged with the record as the
  // template spells it: an id from `--resource` before the read, the found
  // one after it, for the listing.
  const printingBagWith = (physicalId: string | undefined): RecordedSecretValues =>
    secretNamePrintingBag(logicalId, {
      [logicalId]: {
        resourceType: resource.Type,
        properties: resource.Properties ?? {},
        physicalId: physicalId ?? '',
        attributes: {},
        dependencies: [],
      } as ResourceState,
    });
  const readBag = printingBagWith(override);
  try {
    const pseudoResolved = await resolvePseudoParameterIntrinsics(
      resource.Properties ?? {},
      region
    );
    const properties = substituteOverrideRefs(pseudoResolved, overrides) as Record<string, unknown>;
    const input: ResourceImportInput = {
      logicalId,
      resourceType: resource.Type,
      stackName,
      region,
      properties,
      ...(override !== undefined && { knownPhysicalId: override }),
    };
    const result: ResourceImportResult | null = await withPrintingSecrets(readBag, () =>
      provider.import!(input)
    );
    if (!result) {
      // The provider could not resolve a physical id: no `--resource`
      // override, no same-named CloudFormation stack to answer
      // `DescribeStackResources`, and no physical-name property in the
      // template. (There is deliberately no `aws:cdk:path` tag lookup — AWS
      // reserves the `aws:` prefix, so that tag never exists on a real
      // resource; issue #1134.)
      return {
        logicalId,
        resourceType: resource.Type,
        outcome: 'skipped-not-found',
        // The `--resource` fragment names the logical id only when
        // `isPasteableIdent` admits it, and both placeholders are quoted holes:
        // a bare `<physicalId>` redirects when the line is pasted
        // (go-to-k/cdkd#3950).
        reason:
          'no matching AWS resource — pass --resource ' +
          `${remedyLogicalId(logicalId)}=${commandHole('physicalId')} ` +
          'to adopt it explicitly',
      };
    }
    return {
      logicalId,
      resourceType: resource.Type,
      outcome: 'imported',
      physicalId: result.physicalId,
      ...shownPhysicalId(result.physicalId, printingBagWith(result.physicalId)),
      ...(result.attributes !== undefined && { attributes: result.attributes }),
      provisionedBy: route.provisionedBy,
    };
  } catch (error) {
    // Masked with the read's bag: AWS's error text can quote the id.
    const msg = maskSecretsInText(describeAwsFailure(error).detail, readBag);
    // The provider refusals end in a `--resource` remedy, so this line names
    // the logical id and type only when plain and describes them otherwise
    // (go-to-k/cdkd#3950's S1 rule, judged per line): printed raw, they put back
    // the value the refusal itself describes.
    logger.error(
      `Failed to import ${logicalIdShown(logicalId)} (${resourceTypeShown(resource.Type)}): ${msg}`
    );
    return {
      logicalId,
      resourceType: resource.Type,
      outcome: 'failed',
      reason: msg,
    };
  }
}

/**
 * The `--migrate-from-cloudformation` partial-import warning: after
 * `DeleteStack` a resource that is not imported stays in AWS, managed by
 * neither tool. `where` names a nested child; the root passes nothing.
 */
export function warnMigrationOrphans(
  logger: ReturnType<typeof getLogger>,
  total: number,
  imported: number,
  where?: string
): void {
  const orphaned = total - imported;
  if (orphaned <= 0) return;
  logger.warn(
    `--migrate-from-cloudformation: ${orphaned} of ${total} ` +
      `template resource(s)${where ? safeMsg` in ${where}` : ''} were NOT imported into cdkd. After the ` +
      `CloudFormation stack is retired, those resources remain in AWS ` +
      `but are unmanaged by both CloudFormation and cdkd.`
  );
}

/**
 * Refuse when a resource the Retain update REPLACED could not be imported by
 * its new id (issue #4873): adopting the rest and deleting the stack would
 * leave both copies unmanaged with no warning. `written` says what this run
 * has already saved. A re-run cannot catch this, since no update runs then.
 */
export function refuseLostReplacedRows(lost: string[], written: string): void {
  if (lost.length === 0) return;
  throw new Error(
    safeMsg`--migrate-from-cloudformation: after CloudFormation replaced resources, ` +
      safeMsg`${lost.map((id) => logicalIdShown(id)).join(', ')} could no longer be imported. ` +
      `${written} Re-run the same command once the new resource is readable: the re-run ` +
      `runs no update, so it cannot tell the resource was replaced, and a resource it ` +
      `still cannot import is left managed by neither tool after the stack is retired.`
  );
}

export function printSummary(rows: ImportRow[]): void {
  const logger = getLogger();
  const counts = {
    imported: 0,
    'skipped-no-impl': 0,
    'skipped-not-found': 0,
    'skipped-out-of-scope': 0,
    failed: 0,
  } as Record<ImportOutcome, number>;

  logger.info('');
  logger.info('Import plan:');
  for (const r of rows) {
    counts[r.outcome]++;
    const tag = formatOutcome(r.outcome);
    const detail =
      r.outcome === 'imported'
        ? ` (${r.physicalIdShown ?? r.physicalId})`
        : r.reason
          ? ` — ${r.reason}`
          : '';
    // A row's reason can carry the `--resource` remedy, so the logical id and
    // type are named only when plain (go-to-k/cdkd#3950).
    logger.info(
      `  ${tag} ${logicalIdShown(r.logicalId)} (${resourceTypeShown(r.resourceType)})${detail}`
    );
  }
  logger.info('');
  logger.info(
    `Summary: ${counts.imported} imported, ${counts['skipped-not-found']} not found, ` +
      `${counts['skipped-no-impl']} unsupported, ` +
      `${counts['skipped-out-of-scope']} out of scope, ${counts.failed} failed`
  );
}

function formatOutcome(outcome: ImportOutcome): string {
  switch (outcome) {
    case 'imported':
      return '✓';
    case 'skipped-not-found':
      return '·';
    case 'skipped-no-impl':
      return '?';
    case 'skipped-out-of-scope':
      return '-';
    case 'failed':
      return '✗';
  }
}

/**
 * `cdkd import`'s confirmation prompt. Its only call site is inside the
 * `if (!options.yes)` block above, which is what keeps `confirmOrRefuse`'s
 * non-interactive refusal (issue #2275) from firing on a `--yes` run.
 *
 * Exported for unit testing — internal to the command flow otherwise.
 */
export async function confirmPrompt(prompt: string): Promise<boolean> {
  return confirmOrRefuse(prompt, {
    refusal:
      'The cdkd import confirmation prompt cannot run in a non-interactive ' +
      'environment. Pass -y / --yes to confirm the state write, or run the command ' +
      'from a real terminal.',
  });
}
