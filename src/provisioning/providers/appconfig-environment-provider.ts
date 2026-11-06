import {
  AppConfigClient,
  CreateEnvironmentCommand,
  DeleteEnvironmentCommand,
  GetEnvironmentCommand,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateEnvironmentCommand,
  type DeletionProtectionCheck,
  type Monitor,
} from '@aws-sdk/client-appconfig';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { clearOnUpdateRemoval } from '../update-removal.js';
import type {
  ResourceImportInput,
  ResourceImportResult,
  ResourceProvider,
  CreateContext,
  ResourceCreateResult,
  ResourceUpdateResult,
  UpdateContext,
} from '../../types/resource.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { derivePartitionAndUrlSuffix } from '../../utils/aws-partition.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import {
  markNonRetryable,
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../deployment/retryable-errors.js';
import { maskerOrIdentity } from '../masked-retry-logger.js';
import { planTagDiff, refuseMalformedDesiredTags, tagPlanWarning } from '../tag-list.js';
import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { safeMsg } from '../../utils/display-safe.js';

const TYPE = 'AWS::AppConfig::Environment';

/** The values `DeleteEnvironment` accepts for `DeletionProtectionCheck`. */
const DELETION_PROTECTION_CHECKS: ReadonlySet<string> = new Set([
  'ACCOUNT_DEFAULT',
  'APPLY',
  'BYPASS',
]);

/**
 * AWS AppConfig Environment provider (`AWS::AppConfig::Environment`).
 *
 * Exists because `DeletionProtectionCheck` is a WRITE-ONLY property: AppConfig
 * takes it as a parameter of the `DeleteEnvironment` call and stores it
 * nowhere. CloudFormation passes the template's value into that call; Cloud
 * Control's `DeleteResource` sends only the identifier, so the value was lost
 * and an environment polled within AppConfig's protection window could not be
 * destroyed (go-to-k/cdkd#5875). `delete` reads the value from the recorded
 * properties and forwards it.
 *
 * The physical id is `<ApplicationId>|<EnvironmentId>`, the Cloud Control
 * primary identifier, so records created through either route stay valid; the
 * `Ref` value is the segment after the pipe (`ref-values.ts`).
 */
export class AppConfigEnvironmentProvider implements ResourceProvider {
  private appConfigClient?: AppConfigClient;
  private readonly providerRegion = ambientRegion();
  private logger = getLogger().child('AppConfigEnvironmentProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::AppConfig::Environment',
      new Set([
        'ApplicationId',
        'Name',
        'Description',
        'Monitors',
        'Tags',
        'DeletionProtectionCheck',
      ]),
    ],
  ]);

  private getClient(): AppConfigClient {
    if (!this.appConfigClient) {
      this.appConfigClient = new AppConfigClient({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      });
    }
    return this.appConfigClient;
  }

  private assertType(resourceType: string, logicalId: string, physicalId?: string): void {
    if (resourceType !== TYPE) {
      throw new ProvisioningError(
        `Unsupported resource type: ${resourceType}`,
        resourceType,
        logicalId,
        physicalId
      );
    }
  }

  /** Split `<appId>|<envId>`; refuses an id that is not that pair. */
  private splitId(
    physicalId: string,
    resourceType: string,
    logicalId: string
  ): { applicationId: string; environmentId: string } {
    const idx = physicalId.indexOf('|');
    if (idx <= 0 || idx === physicalId.length - 1 || physicalId.indexOf('|', idx + 1) !== -1) {
      throw markNonRetryable(
        new ProvisioningError(
          `The recorded physical id of ${resourceType} ${logicalId} is not "<ApplicationId>|<EnvironmentId>"`,
          resourceType,
          logicalId,
          physicalId
        )
      );
    }
    return {
      applicationId: physicalId.slice(0, idx),
      environmentId: physicalId.slice(idx + 1),
    };
  }

  private wrapCaughtError(
    mask: ((text: string) => string) | undefined,
    error: unknown,
    build: (text: string) => ProvisioningError
  ): ProvisioningError {
    const m = maskerOrIdentity(mask);
    const failure = describeAwsFailure(error);
    if (!failure.redacted) return wrapMaskedAwsError(m, error, build);
    this.logger.debug(m(build(m(failure.detail)).message));
    const wrapped = build(`${m(failure.summary)}${relayedNameCollision(failure.detail)}`);
    return error instanceof Error ? markRedactedCause(wrapped) : wrapped;
  }

  private async environmentArn(applicationId: string, environmentId: string): Promise<string> {
    const region = (await this.getClient().config.region()) || ambientRegion() || 'us-east-1';
    const identity = await getAwsClients().sts.send(new GetCallerIdentityCommand({}));
    if (!identity.Account) throw new Error('Failed to resolve AWS account id from STS');
    const { partition } = derivePartitionAndUrlSuffix(region);
    return `arn:${partition}:appconfig:${region}:${identity.Account}:application/${applicationId}/environment/${environmentId}`;
  }

  private monitorsOf(value: unknown): Monitor[] | undefined {
    if (!Array.isArray(value)) return undefined;
    return value.map((m) => {
      const entry = m as { AlarmArn?: string; AlarmRoleArn?: string };
      return {
        AlarmArn: entry.AlarmArn,
        ...(entry.AlarmRoleArn !== undefined && { AlarmRoleArn: entry.AlarmRoleArn }),
      };
    });
  }

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    this.assertType(resourceType, logicalId);
    this.logger.debug(safeMsg`Creating AppConfig Environment ${logicalId}`);
    const tags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);
    const applicationId = properties['ApplicationId'] as string | undefined;
    const name = properties['Name'] as string | undefined;
    if (!applicationId || !name) {
      throw markNonRetryable(
        new ProvisioningError(
          `ApplicationId and Name are required for ${resourceType} ${logicalId}`,
          resourceType,
          logicalId
        )
      );
    }

    try {
      const monitors = this.monitorsOf(properties['Monitors']);
      const resp = await this.getClient().send(
        new CreateEnvironmentCommand({
          ApplicationId: applicationId,
          Name: name,
          ...(properties['Description'] !== undefined && {
            Description: properties['Description'] as string,
          }),
          ...(monitors && monitors.length > 0 && { Monitors: monitors }),
          ...(tags.length > 0 && {
            Tags: Object.fromEntries(tags.map((t) => [t.Key, t.Value])),
          }),
        })
      );
      if (!resp.Id) {
        throw new Error('CreateEnvironment returned no environment id');
      }
      return {
        physicalId: `${applicationId}|${resp.Id}`,
        attributes: { EnvironmentId: resp.Id },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapCaughtError(
        context?.maskSecrets,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to create AppConfig Environment ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            undefined,
            cause
          )
      );
    }
  }

  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    this.assertType(resourceType, logicalId, physicalId);
    this.logger.debug(safeMsg`Updating AppConfig Environment ${logicalId}: ${physicalId}`);
    assertRegionMatch(
      context?.expectedRegion ? await this.getClient().config.region() : undefined,
      context?.expectedRegion,
      resourceType,
      logicalId,
      physicalId,
      'pre-update'
    );
    refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);
    const { applicationId, environmentId } = this.splitId(physicalId, resourceType, logicalId);

    try {
      const monitors = clearOnUpdateRemoval(
        this.monitorsOf(properties['Monitors']),
        this.monitorsOf(previousProperties['Monitors']),
        []
      );
      const description = clearOnUpdateRemoval(
        properties['Description'] as string | undefined,
        previousProperties['Description'] as string | undefined,
        ''
      );
      await this.getClient().send(
        new UpdateEnvironmentCommand({
          ApplicationId: applicationId,
          EnvironmentId: environmentId,
          ...(properties['Name'] !== undefined && { Name: properties['Name'] as string }),
          ...(description !== undefined && { Description: description }),
          ...(monitors !== undefined && { Monitors: monitors }),
        })
      );

      const plan = planTagDiff(previousProperties['Tags'], properties['Tags']);
      const warning = tagPlanWarning(plan, resourceType, physicalId);
      if (warning) this.logger.warn(warning);
      if (plan.set.size > 0 || plan.remove.length > 0) {
        const arn = await this.environmentArn(applicationId, environmentId);
        if (plan.remove.length > 0) {
          await this.getClient().send(
            new UntagResourceCommand({ ResourceArn: arn, TagKeys: plan.remove })
          );
        }
        if (plan.set.size > 0) {
          await this.getClient().send(
            new TagResourceCommand({ ResourceArn: arn, Tags: Object.fromEntries(plan.set) })
          );
        }
      }

      return {
        physicalId,
        wasReplaced: false,
        attributes: { EnvironmentId: environmentId },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapCaughtError(
        context?.maskSecrets,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to update AppConfig Environment ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }
  }

  /**
   * Delete the environment, forwarding the template's `DeletionProtectionCheck`
   * (from the recorded properties) so `BYPASS` is honored as under
   * CloudFormation (go-to-k/cdkd#5875). An absent or unrecognised value sends
   * nothing, which keeps AppConfig's account-level default.
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.assertType(resourceType, logicalId, physicalId);
    this.logger.debug(safeMsg`Deleting AppConfig Environment ${logicalId}: ${physicalId}`);
    const { applicationId, environmentId } = this.splitId(physicalId, resourceType, logicalId);
    const check = properties?.['DeletionProtectionCheck'];
    const protectionCheck =
      typeof check === 'string' && DELETION_PROTECTION_CHECKS.has(check)
        ? (check as DeletionProtectionCheck)
        : undefined;

    try {
      await this.getClient().send(
        new DeleteEnvironmentCommand({
          ApplicationId: applicationId,
          EnvironmentId: environmentId,
          ...(protectionCheck !== undefined && { DeletionProtectionCheck: protectionCheck }),
        })
      );
      this.logger.debug(safeMsg`Successfully deleted AppConfig Environment ${logicalId}`);
    } catch (error) {
      if ((error as { name?: unknown } | null)?.name === 'ResourceNotFoundException') {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(
          safeMsg`AppConfig Environment ${physicalId} does not exist, skipping deletion`
        );
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapCaughtError(
        context?.maskSecrets,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to delete AppConfig Environment ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }
  }

  /**
   * Adopt an existing environment. AppConfig names are not unique identifiers
   * and `ApplicationId` is not recoverable from a name, so only an explicit
   * `--resource <logicalId>=<ApplicationId>|<EnvironmentId>` is supported; the
   * environment's existence is verified with `GetEnvironment`.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    if (input.resourceType !== TYPE || !input.knownPhysicalId) return null;
    const { applicationId, environmentId } = this.splitId(
      input.knownPhysicalId,
      input.resourceType,
      input.logicalId
    );
    try {
      await this.getClient().send(
        new GetEnvironmentCommand({ ApplicationId: applicationId, EnvironmentId: environmentId })
      );
    } catch (err) {
      if ((err as { name?: unknown } | null)?.name === 'ResourceNotFoundException') return null;
      throw err;
    }
    return {
      physicalId: input.knownPhysicalId,
      attributes: { EnvironmentId: environmentId },
    };
  }
}
