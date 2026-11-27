import { isDeepStrictEqual } from 'node:util';
import type { CloudControlProvider } from '../../provisioning/cloud-control-provider.js';
import type { ProvisionedBy } from '../../provisioning/provider-registry.js';
import type { ResourceProvider } from '../../types/resource.js';
import { safeMsg } from '../../utils/display-safe.js';
import type { DeployEngine } from '../deploy-engine.js';
import { displacedPhysicalIdShown } from '../nested-child-journal.js';
import type { FailedOperation } from '../rollback-executor.js';
import { redactOperationsForJournal } from './rollback.js';

/**
 * go-to-k/cdkd#3252: the create result for a CREATE an earlier run of this
 * stack sent through Cloud Control and stopped waiting for, which completed
 * in AWS (`engine.resumedCreates`, filled at deploy start). Taken only when
 * this CREATE goes through Cloud Control too, its identifier is not a name
 * (see below), and it would send exactly the bag that one sent (compared as
 * the journal recorded it): a resource made from another bag is not what
 * this deploy wants. One not taken becomes a proven orphan at the deploy's
 * success (`orphanUntakenResumes`). `undefined` means "create as usual".
 */
export async function resumeAbandonedCreate(
  engine: DeployEngine,
  args: {
    logicalId: string;
    resourceType: string;
    stackName: string;
    resolvedProps: Record<string, unknown>;
    createProps: Record<string, unknown>;
    createProvider: ResourceProvider;
    createdVia: ProvisionedBy;
    maskSecrets: (text: string) => string;
  }
): Promise<Awaited<ReturnType<ResourceProvider['create']>> | undefined> {
  const { logicalId, resourceType } = args;
  const resumed = engine.resumedCreates.get(logicalId);
  if (resumed === undefined || resumed.taken || resumed.resourceType !== resourceType) {
    return undefined;
  }
  const reader = args.createProvider as Partial<CloudControlProvider>;
  if (args.createdVia !== 'cc-api' || typeof reader.resumeCreatedResource !== 'function') {
    return undefined;
  }
  // The resolver offers only an identifier it proved unique (an AWS-minted
  // component, `ccIdentifierIsUnique`): a NAME may since belong to someone
  // else, and is never taken over (go-to-k/cdkd#4180, #4705).
  const probe: FailedOperation = {
    logicalId,
    changeType: 'CREATE',
    resourceType,
    attemptedProperties: args.resolvedProps,
  };
  const [redacted] = redactOperationsForJournal(engine.rollbackDeps(), [
    probe,
  ]) as FailedOperation[];
  const sentNow = redacted?.attemptedProperties;
  // As JSON, which is what the journal holds: prototypes and undefined
  // members do not survive the write, so they do not count here either.
  const asJson = (value: unknown): unknown =>
    value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as unknown);
  if (!isDeepStrictEqual(asJson(sentNow), asJson(resumed.attemptedProperties))) {
    engine.logger.warn(
      safeMsg`${logicalId}: the template changed since the CREATE cdkd stopped waiting for, so ` +
        'this deploy creates the resource again; the one that CREATE made is kept in the rollback ' +
        'journal as a resource the failed deploy created.'
    );
    return undefined;
  }
  let result: Awaited<ReturnType<ResourceProvider['create']>>;
  try {
    // Through the engine's retry, like the create it stands in for: a
    // throttled read retries rather than failing the deploy.
    result = await engine.withRetry(
      () =>
        reader.resumeCreatedResource!(
          logicalId,
          resourceType,
          resumed.identifier,
          args.createProps,
          {
            maskSecrets: args.maskSecrets,
          }
        ),
      logicalId,
      undefined,
      undefined,
      args.createProvider
    );
  } catch (error) {
    // Only a resource that is GONE is created again; any other read failure
    // leaves it standing, and a create beside it would duplicate it.
    if ((error as { resumedResourceGone?: unknown }).resumedResourceGone !== true) throw error;
    // Nothing is left to orphan: the success settle drops the request.
    resumed.gone = true;
    engine.logger.warn(
      safeMsg`${logicalId}: the resource the earlier CREATE made no longer exists; creating it as usual.`
    );
    return undefined;
  }
  // The token stays in the journal until the state record holding the
  // resource is saved: the success settle drops it then, and a run that dies
  // first leaves it for the next one, which finds the resource in state.
  resumed.taken = true;
  const shown =
    displacedPhysicalIdShown(
      {
        logicalId,
        changeType: 'CREATE',
        resourceType,
        physicalId: resumed.identifier,
        attemptedProperties: resumed.attemptedProperties,
      },
      engine.logger,
      resumed.identifier
    ) ?? 'the resource';
  engine.logger.info(
    safeMsg`${logicalId}: took over ${shown}, the resource the earlier CREATE made, instead of ` +
      'creating another.'
  );
  return result;
}
