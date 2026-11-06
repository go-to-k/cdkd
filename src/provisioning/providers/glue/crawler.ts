import { safeMsg } from '../../../utils/display-safe.js';
import {
  GlueClient,
  CreateCrawlerCommand,
  UpdateCrawlerCommand,
  DeleteCrawlerCommand,
  GetCrawlerCommand,
  StartCrawlerScheduleCommand,
  StopCrawlerScheduleCommand,
  StopCrawlerCommand,
  EntityNotFoundException,
  CrawlerRunningException,
} from '@aws-sdk/client-glue';
import { STSClient } from '@aws-sdk/client-sts';
import { safeStringify } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import {
  createMaskedLogSinks,
  type MaskedLogSinks,
  type MaskerFn,
} from '../../masked-retry-logger.js';
import {
  type CreateContext,
  type ResourceCreateResult,
  type ResourceUpdateResult,
  type ResourceImportInput,
  type ResourceImportResult,
  type UpdateContext,
  type ResourceNotFound,
  RESOURCE_NOT_FOUND,
} from '../../../types/resource.js';
import { ambientClientDefaults } from '../../../utils/ambient-client-defaults.js';
import { markNotGone } from '../../not-gone.js';
import { generatedNameFor } from '../../resource-name.js';
import type { GlueCrawlerProvider } from '../glue-provider.js';
import {
  wrapGlueError,
  newGlueClients,
  glueOperationSinks,
  secretNamePairs,
  previousNamePairs,
} from './names.js';
import {
  desiredGlueTags,
  applyGlueTagDiff,
  CRAWLER_STOP_MAX_ATTEMPTS,
  sleep,
  CRAWLER_STOP_POLL_INTERVAL_MS,
  pickDefined,
  fetchGlueTags,
  buildGlueResourceArn,
} from './shared.js';
import {
  toSdkCrawlerTargets,
  buildCrawlerCommonFields,
  toCfnCrawlerTargets,
} from './crawler-targets.js';

/**
 * Crawler properties whose REMOVAL from the template cdkd leaves in place
 * (issue #1160). `UpdateCrawler` keeps a field it is not sent, and cdkd sends
 * no reset, because CloudFormation keeps them too (CFn A/B us-east-1
 * 2026-10-21: all ten schema properties removed at once, with no other change
 * and again beside a `Targets` change, left every live value, and the
 * handler's `UpdateCrawler` carried only Name, Role and Targets).
 * `LineageConfiguration` is not in the
 * CloudFormation schema at all (early validation refuses it); `UpdateCrawler`
 * keeps it the same way.
 */
export const CRAWLER_LEFT_IN_PLACE_ON_REMOVAL = [
  'DatabaseName',
  'Description',
  'Classifiers',
  'TablePrefix',
  'Schedule',
  'SchemaChangePolicy',
  'RecrawlPolicy',
  'LineageConfiguration',
  'LakeFormationConfiguration',
  'Configuration',
  'CrawlerSecurityConfiguration',
] as const;

/**
 * The ONE warning line for {@link CRAWLER_LEFT_IN_PLACE_ON_REMOVAL} removals.
 * Names are template-borne, so they go through `safeMsg`. The deploy line
 * says CloudFormation keeps the value too (the CFn A/B above), but only when
 * every name is a CloudFormation property: `LineageConfiguration` is not one.
 * A rollback revert restores an earlier state record, so there the property
 * is one the failed deploy ADDED, and the line says that instead.
 */
const crawlerLeftInPlaceWarning = (
  logicalId: string,
  names: readonly string[],
  caller: 'deploy' | 'rollback'
): string => {
  const one = names.length === 1;
  const subject = one ? 'property' : 'properties';
  const cfnKeeps = names.includes('LineageConfiguration')
    ? ''
    : `, as CloudFormation leaves ${one ? 'it' : 'them'}`;
  return caller === 'rollback'
    ? safeMsg`${logicalId} (AWS::Glue::Crawler): ${subject} ${names.join(', ')} ${one ? 'is' : 'are'} absent from the state being restored; UpdateCrawler keeps a setting it is not sent, so the rollback leaves the value the failed deploy applied in place.`
    : safeMsg`${logicalId} (AWS::Glue::Crawler): ${subject} ${names.join(', ')} ${one ? 'was' : 'were'} removed from the template and ${one ? 'keeps its' : 'keep their'} current AWS value${cfnKeeps}; UpdateCrawler keeps a setting it is not sent. Declare the intended value explicitly to change it.`;
};

/**
 * go-to-k/cdkd#5487: the top-level keys `UpdateCrawler` sends (`Role`,
 * `Targets` and `buildCrawlerCommonFields`'s), each marked unsettled before
 * the call when it changes.
 */
const CRAWLER_UPDATE_KEYS = [
  'Role',
  'Targets',
  'Classifiers',
  'Configuration',
  'CrawlerSecurityConfiguration',
  'DatabaseName',
  'Description',
  'LakeFormationConfiguration',
  'LineageConfiguration',
  'RecrawlPolicy',
  'Schedule',
  'SchemaChangePolicy',
  'TablePrefix',
] as const;

/** {@link GlueProvider}'s `wrapMaskedError` (issue #4244). */
export function crawlerWrapMaskedError(
  this: GlueCrawlerProvider,
  mask: MaskerFn,
  error: unknown,
  build: (maskedText: string) => ProvisioningError
): ProvisioningError {
  return wrapGlueError(mask, (message) => this.logger.debug(message), error, build);
}

export function crawlerGetClient(this: GlueCrawlerProvider): GlueClient {
  if (!this.client) {
    ({ client: this.client, createClient: this.createClient } = newGlueClients(
      this.providerRegion
    ));
  }
  return this.client;
}

/** The main create's client (issue #4639); see {@link newGlueClients}. */
export function crawlerGetCreateClient(this: GlueCrawlerProvider): GlueClient {
  this.getClient();
  return this.createClient as GlueClient;
}

export function crawlerGetStsClient(this: GlueCrawlerProvider): STSClient {
  if (!this.stsClient) {
    this.stsClient = new STSClient({
      ...ambientClientDefaults(),
      ...(this.providerRegion ? { region: this.providerRegion } : {}),
    });
  }
  return this.stsClient;
}

export async function crawlerCreate(
  this: GlueCrawlerProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  // Issue #2177: ONE masked sink per operation, every bag value masked RAW.
  const log = glueOperationSinks(
    this.logger,
    context?.maskSecrets,
    secretNamePairs([properties['Name']])
  );
  const { value: v } = log;
  log.debug(`Creating Glue Crawler ${logicalId}`);
  // go-to-k/cdkd#5095, as the Glue job's create.
  const name =
    (properties['Name'] as string | undefined) ?? generatedNameFor('AWS::Glue::Crawler', logicalId);
  const role = properties['Role'] as string | undefined;
  const targets = properties['Targets'] as Record<string, unknown> | undefined;
  if (!role) {
    throw new ProvisioningError(
      `Role is required for Glue Crawler ${logicalId}`,
      resourceType,
      logicalId
    );
  }
  if (!targets) {
    throw new ProvisioningError(
      `Targets is required for Glue Crawler ${logicalId}`,
      resourceType,
      logicalId
    );
  }
  // go-to-k/cdkd#4073: a malformed Tags is refused before any call.
  const tags = desiredGlueTags(properties['Tags'], resourceType, logicalId);
  try {
    await this.getCreateClient().send(
      new CreateCrawlerCommand({
        Name: name,
        Role: role,
        Targets: toSdkCrawlerTargets(targets),
        ...buildCrawlerCommonFields(properties),
        ...(tags && { Tags: tags }),
      })
    );
    log.debug(`Successfully created Glue Crawler ${logicalId}: ${v(name)}`);
    return { physicalId: name, attributes: {} };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapMaskedError(
      log.mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create Glue Crawler ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
  }
}

export async function crawlerUpdate(
  this: GlueCrawlerProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  // Issue #2177 -- the recorded name is a needle too after a rotated secret.
  const log = glueOperationSinks(
    this.logger,
    context?.maskSecrets,
    previousNamePairs(physicalId, [previousProperties?.['Name']])
  );
  const { value: v } = log;
  log.debug(`Updating Glue Crawler ${logicalId}: ${v(physicalId)}`);
  // go-to-k/cdkd#4073: a malformed desired Tags is refused before any call.
  desiredGlueTags(properties['Tags'], resourceType, logicalId, physicalId);
  const markUnsettled = (key: string): void => context?.markUnsettled?.(key);
  try {
    const updateInput = {
      Name: physicalId,
      ...(properties['Role'] !== undefined && { Role: properties['Role'] as string }),
      ...(properties['Targets'] !== undefined && {
        Targets: toSdkCrawlerTargets(properties['Targets'] as Record<string, unknown>),
      }),
      ...buildCrawlerCommonFields(properties),
    };
    for (const key of CRAWLER_UPDATE_KEYS) {
      if (JSON.stringify(properties[key]) !== JSON.stringify(previousProperties[key])) {
        markUnsettled(key);
      }
    }
    try {
      await this.getClient().send(new UpdateCrawlerCommand(updateInput));
    } catch (err) {
      // UpdateCrawler rejects a mid-run crawler with CrawlerRunningException.
      // Stop it, wait for it to settle, then retry the update.
      if (err instanceof CrawlerRunningException) {
        log.debug(`Glue Crawler ${v(physicalId)} is running; stopping before update and retrying`);
        await this.stopCrawlerAndWait(physicalId, log);
        await this.getClient().send(new UpdateCrawlerCommand(updateInput));
      } else {
        throw err;
      }
    }

    await applyGlueTagDiff(
      this.getClient(),
      () => this.resourceArn(physicalId),
      previousProperties['Tags'],
      properties['Tags'],
      resourceType,
      logicalId,
      log.warn,
      {
        forceUpsert: context?.unsettledProperties?.has('Tags') === true,
        beforeWrite: () => markUnsettled('Tags'),
      }
    );

    // Issue #1160: a CRAWLER_LEFT_IN_PLACE_ON_REMOVAL property removed from
    // the desired side is simply not sent, as CloudFormation does. Named
    // once, and only after the update SUCCEEDED (the shared caller's warning
    // has the same timing). Not on `drift --revert`: its previous side is an
    // AWS readback, so a key the desired side lacks was never removed from a
    // template.
    if (!context?.desiredFromAwsReadback) {
      // A direct call (no caller context) diffs the previous template itself.
      const removed = context?.removedProperties;
      const leftInPlace: string[] = [];
      for (const key of CRAWLER_LEFT_IN_PLACE_ON_REMOVAL) {
        const gone =
          removed !== undefined
            ? removed.has(key)
            : properties[key] === undefined && previousProperties?.[key] !== undefined;
        if (gone) leftInPlace.push(key);
      }
      if (leftInPlace.length > 0) {
        log.warn(
          crawlerLeftInPlaceWarning(
            logicalId,
            leftInPlace,
            context?.replayingState ? 'rollback' : 'deploy'
          )
        );
      }
    }

    return { physicalId, wasReplaced: false };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapMaskedError(
      log.mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update Glue Crawler ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

export async function crawlerDelete(
  this: GlueCrawlerProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  _properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void> {
  // go-to-k/cdkd#2007: the crawler name can be secret-derived.
  const log = createMaskedLogSinks(this.logger, context?.maskSecrets);
  const { value: v } = log;
  log.debug(`Deleting Glue Crawler ${logicalId}: ${v(physicalId)}`);
  // go-to-k/cdkd#2613: the physical id is a NAME, so a client in another
  // region than the state record would stop and delete a same-named crawler
  // cdkd does not manage. Refuse before any call, not only on NotFound; the
  // client's region is resolved only when there is one to compare with.
  assertRegionMatch(
    context?.expectedRegion ? await this.getClient().config.region() : undefined,
    context?.expectedRegion,
    resourceType,
    logicalId,
    physicalId,
    'pre-delete'
  );
  try {
    await this.getClient().send(new DeleteCrawlerCommand({ Name: physicalId }));
  } catch (error) {
    if (error instanceof EntityNotFoundException) {
      const clientRegion = await this.getClient().config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      log.debug(`Glue Crawler ${v(physicalId)} does not exist, skipping deletion`);
      return;
    }
    // A crawler that is mid-run rejects DeleteCrawler with
    // CrawlerRunningException. Stop it, wait for it to settle, then retry the
    // delete so destroy does not fail on an actively-crawling crawler.
    // A failure of the retry goes through the same wrap rather than escaping
    // raw, so its AWS text is withheld from the thrown message too
    // (go-to-k/cdkd#2319).
    let failure: unknown = error;
    if (error instanceof CrawlerRunningException) {
      log.debug(`Glue Crawler ${v(physicalId)} is running; stopping before delete and retrying`);
      try {
        await this.stopCrawlerAndWait(physicalId, log);
        await this.getClient().send(new DeleteCrawlerCommand({ Name: physicalId }));
        return;
      } catch (retryError) {
        // Gone between the stop and the retry: the region was confirmed
        // before the first call, so this is ordinary idempotency.
        if (retryError instanceof EntityNotFoundException) {
          log.debug(`Glue Crawler ${v(physicalId)} does not exist, skipping deletion`);
          return;
        }
        failure = retryError;
      }
    }
    const cause = failure instanceof Error ? failure : undefined;
    const thrown = this.wrapMaskedError(
      log.mask,
      failure,
      (text) =>
        new ProvisioningError(
          `Failed to delete Glue Crawler ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
    // The wrap names an AWS failure by its CLASS, and the delete classifiers
    // read `NotFoundException` in a message as "already deleted": only the
    // typed not-found above means this resource is gone (go-to-k/cdkd#2319).
    throw failure instanceof Error && failure.name.includes('NotFound')
      ? markNotGone(thrown)
      : thrown;
  }
}

/**
 * Stop a running crawler and poll until it leaves the RUNNING / STOPPING
 * state (or until {@link CRAWLER_STOP_MAX_ATTEMPTS} is exhausted). Tolerates a
 * CrawlerStoppingException / "not running" race (the crawler may have just
 * finished on its own) so callers can unconditionally retry their delete /
 * update afterwards.
 */
export async function stopCrawlerAndWait(
  this: GlueCrawlerProvider,
  physicalId: string,
  // An update passes its masked sink (issue #2177), `delete()` one over its
  // `DeleteContext.maskSecrets` (#2007).
  log: Pick<MaskedLogSinks, 'debug' | 'value'> = {
    debug: (message) => this.logger.debug(message),
    value: (value) => String(value),
  }
): Promise<void> {
  try {
    await this.getClient().send(new StopCrawlerCommand({ Name: physicalId }));
  } catch (err) {
    // CrawlerNotRunningException / CrawlerStoppingException etc. mean the
    // crawler is already stopping or stopped — nothing to do but wait it out.
    log.debug(
      `StopCrawler for ${log.value(physicalId)} returned ${
        err instanceof Error ? err.name : safeStringify(err)
      }; continuing to wait`
    );
  }
  for (let attempt = 0; attempt < CRAWLER_STOP_MAX_ATTEMPTS; attempt++) {
    try {
      const cur = await this.getClient().send(new GetCrawlerCommand({ Name: physicalId }));
      const state = cur.Crawler?.State;
      if (state !== 'RUNNING' && state !== 'STOPPING') return;
    } catch (err) {
      if (err instanceof EntityNotFoundException) return;
      // Inconclusive read — keep polling until the attempt budget is gone.
    }
    await sleep(CRAWLER_STOP_POLL_INTERVAL_MS);
  }
}

// eslint-disable-next-line @typescript-eslint/require-await -- explicit-override-only intentionally has no AWS calls
export async function crawlerGetAttribute(
  this: GlueCrawlerProvider,
  physicalId: string,
  _resourceType: string,
  attributeName: string
): Promise<unknown> {
  if (attributeName === 'Id' || attributeName === 'Ref' || attributeName === 'Name') {
    return physicalId;
  }
  return undefined;
}

export async function crawlerReadCurrentState(
  this: GlueCrawlerProvider,
  physicalId: string,
  _logicalId: string,
  _resourceType: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  let crawler;
  try {
    const resp = await this.getClient().send(new GetCrawlerCommand({ Name: physicalId }));
    crawler = resp.Crawler;
  } catch (err) {
    if (err instanceof EntityNotFoundException) return RESOURCE_NOT_FOUND;
    throw err;
  }
  if (!crawler) return undefined;

  const result: Record<string, unknown> = {
    Name: crawler.Name ?? physicalId,
    Role: crawler.Role ?? '',
    // SDK `DynamoDBTarget.{scanAll,scanRate}` -> the CFn `ScanAll` / `ScanRate`
    // spelling recorded in state, so drift compares like with like.
    Targets: crawler.Targets
      ? toCfnCrawlerTargets(pickDefined(crawler.Targets as Record<string, unknown>))
      : {},
    DatabaseName: crawler.DatabaseName ?? '',
    Description: crawler.Description ?? '',
    // CFn `Schedule` is the structured wrapper; reverse-map from the
    // SDK's `Schedule { ScheduleExpression, State }` Description shape.
    Schedule: crawler.Schedule?.ScheduleExpression
      ? { ScheduleExpression: crawler.Schedule.ScheduleExpression }
      : {},
    Classifiers: crawler.Classifiers ?? [],
    TablePrefix: crawler.TablePrefix ?? '',
    SchemaChangePolicy: crawler.SchemaChangePolicy
      ? pickDefined(crawler.SchemaChangePolicy as Record<string, unknown>)
      : {},
    RecrawlPolicy: crawler.RecrawlPolicy
      ? pickDefined(crawler.RecrawlPolicy as Record<string, unknown>)
      : {},
    LineageConfiguration: crawler.LineageConfiguration
      ? pickDefined(crawler.LineageConfiguration as Record<string, unknown>)
      : {},
    LakeFormationConfiguration: crawler.LakeFormationConfiguration
      ? pickDefined(crawler.LakeFormationConfiguration as Record<string, unknown>)
      : {},
    Configuration: crawler.Configuration ?? '',
    CrawlerSecurityConfiguration: crawler.CrawlerSecurityConfiguration ?? '',
  };
  result['Tags'] = await fetchGlueTags(
    this.getClient(),
    this.getStsClient(),
    'crawler',
    crawler.Name ?? physicalId,
    this.cachedAccountId,
    this.logger
  );
  return result;
}

/**
 * Start (or stop) a crawler's schedule. Exposed for downstream tooling
 * — not part of `update()` because AWS treats schedule activation as a
 * separate side-effect from crawler config update.
 */
export async function crawlerStartSchedule(
  this: GlueCrawlerProvider,
  physicalId: string
): Promise<void> {
  await this.getClient().send(new StartCrawlerScheduleCommand({ CrawlerName: physicalId }));
}

export async function crawlerStopSchedule(
  this: GlueCrawlerProvider,
  physicalId: string
): Promise<void> {
  await this.getClient().send(new StopCrawlerScheduleCommand({ CrawlerName: physicalId }));
}

/** The crawler ARN `TagResource` / `UntagResource` target. */
export function crawlerResourceArn(this: GlueCrawlerProvider, physicalId: string): Promise<string> {
  return buildGlueResourceArn(
    this.getClient(),
    this.getStsClient(),
    'crawler',
    physicalId,
    this.cachedAccountId
  );
}

export async function crawlerImport(
  this: GlueCrawlerProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  const explicitName = input.knownPhysicalId ?? (input.properties['Name'] as string | undefined);
  if (!explicitName) return null;
  try {
    await this.getClient().send(new GetCrawlerCommand({ Name: explicitName }));
    return { physicalId: explicitName, attributes: {} };
  } catch (err) {
    if (err instanceof EntityNotFoundException) return null;
    throw err;
  }
}

export const crawlerMethods = { stopCrawlerAndWait };
