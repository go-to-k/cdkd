/**
 * Helpers shared by the three CloudWatch Logs delivery providers
 * (`AWS::Logs::DeliverySource`, `AWS::Logs::DeliveryDestination`,
 * `AWS::Logs::Delivery`): tag reconciliation on the resource ARN, property
 * readers that refuse a malformed template value, and the error wrap.
 */
import {
  ListTagsForResourceCommand,
  TagResourceCommand,
  UntagResourceCommand,
  type CloudWatchLogsClient,
} from '@aws-sdk/client-cloudwatch-logs';
import type { ConsoleLogger } from '../../../utils/logger.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { markRedactedCause, relayedNameCollision } from '../../../deployment/retryable-errors.js';
import { logicalIdShown } from '../../composite-id.js';
import { normalizeAwsTagsToCfn } from '../../import-helpers.js';
import { configBooleanRefusal, coerceCfnBoolean } from '../../config-shape.js';
import {
  planTagDiff,
  refuseMalformedDesiredTags,
  tagPlanWarning,
  type CfnTagEntry,
} from '../../tag-list.js';
import type { CreateContext, UpdateContext } from '../../../types/resource.js';

/** Whether `error` is CloudWatch Logs' not-found answer. */
export function isLogsNotFound(error: unknown): boolean {
  return error instanceof Error && error.name === 'ResourceNotFoundException';
}

/** A plain object (not an array, not null). */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether the bag is state-borne (a rollback replay or a `drift --revert`
 * readback): a refusal there would leave the resource un-rollbackable, so the
 * readers warn and omit the value instead (provider-replay-and-refusals.md).
 */
export function isStateBorne(context?: CreateContext | UpdateContext): boolean {
  if (context?.replayingState === true) return true;
  return (
    context !== undefined &&
    'desiredFromAwsReadback' in context &&
    context.desiredFromAwsReadback === true
  );
}

/** Reads the delivery properties, refusing a malformed template value before any call. */
export class PropertyReader {
  private readonly properties: Record<string, unknown>;
  private readonly what: string;
  private readonly resourceType: string;
  private readonly logicalId: string;
  private readonly physicalId: string | undefined;
  private readonly logger: ConsoleLogger;
  private readonly stateBorne: boolean;

  constructor(
    properties: Record<string, unknown>,
    what: string,
    resourceType: string,
    logicalId: string,
    physicalId: string | undefined,
    logger: ConsoleLogger,
    stateBorne: boolean
  ) {
    this.properties = properties;
    this.what = what;
    this.resourceType = resourceType;
    this.logicalId = logicalId;
    this.physicalId = physicalId;
    this.logger = logger;
    this.stateBorne = stateBorne;
  }

  private refuse(message: string): undefined {
    const text = `${message} for ${this.what} ${logicalIdShown(this.logicalId)}`;
    if (this.stateBorne) {
      this.logger.warn(safeMsg`${text}; omitting it while applying a state-borne bag`);
      return undefined;
    }
    throw new ProvisioningError(text, this.resourceType, this.logicalId, this.physicalId);
  }

  /** A required string, refused on every path: there is no safe default. */
  requiredString(key: string): string {
    const value = this.properties[key];
    if (typeof value === 'string' && value !== '') return value;
    throw new ProvisioningError(
      `${key} must be a non-empty string for ${this.what} ${logicalIdShown(this.logicalId)}`,
      this.resourceType,
      this.logicalId,
      this.physicalId
    );
  }

  /** An optional string; `undefined` when absent. */
  optionalString(key: string): string | undefined {
    const value = this.properties[key];
    if (value === undefined || typeof value === 'string') return value;
    return this.refuse(`${key} must be a string`);
  }

  /** An optional list of strings; `undefined` when absent. */
  optionalStringList(key: string): string[] | undefined {
    const value = this.properties[key];
    if (value === undefined) return undefined;
    if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      return [...(value as string[])];
    }
    return this.refuse(`${key} must be a list of strings`);
  }

  /** An optional string-to-string map; `undefined` when absent. */
  optionalStringMap(key: string): Record<string, string> | undefined {
    const value = this.properties[key];
    if (value === undefined) return undefined;
    if (isPlainRecord(value) && Object.values(value).every((v) => typeof v === 'string')) {
      return { ...(value as Record<string, string>) };
    }
    return this.refuse(`${key} must be a map of string values`);
  }

  /** An optional boolean (CFn spells it `true` or `"true"`); `undefined` when absent. */
  optionalBoolean(key: string): boolean | undefined {
    const refusal = configBooleanRefusal(this.properties, key, 'Properties');
    if (refusal !== undefined) return this.refuse(refusal);
    return coerceCfnBoolean(this.properties[key]);
  }

  /** The validated `Tags` list, refused when malformed on every path. */
  tags(): CfnTagEntry[] {
    return refuseMalformedDesiredTags(
      this.properties['Tags'],
      this.resourceType,
      this.logicalId,
      this.physicalId
    );
  }
}

/** A CFn tag list as the `Record<string, string>` the Logs API takes; `undefined` when empty. */
export function tagMap(tags: CfnTagEntry[]): Record<string, string> | undefined {
  return tags.length > 0 ? Object.fromEntries(tags.map((t) => [t.Key, t.Value])) : undefined;
}

/** Apply the difference between the recorded and the desired `Tags` to `arn`. */
export async function reconcileTags(
  client: CloudWatchLogsClient,
  logger: ConsoleLogger,
  arn: string,
  resourceType: string,
  logicalId: string,
  newTags: unknown,
  oldTags: unknown
): Promise<void> {
  const plan = planTagDiff(oldTags, newTags);
  const warning = tagPlanWarning(plan, resourceType, logicalId);
  if (warning !== undefined) logger.warn(warning);
  if (plan.remove.length > 0) {
    await client.send(new UntagResourceCommand({ resourceArn: arn, tagKeys: plan.remove }));
  }
  if (plan.set.size > 0) {
    await client.send(
      new TagResourceCommand({ resourceArn: arn, tags: Object.fromEntries(plan.set) })
    );
  }
}

/** The live user tags of `arn` in the CFn shape (`aws:`-prefixed keys filtered out). */
export async function readTags(
  client: CloudWatchLogsClient,
  arn: string
): Promise<Array<{ Key: string; Value: string }>> {
  const resp = await client.send(new ListTagsForResourceCommand({ resourceArn: arn }));
  return normalizeAwsTagsToCfn(resp.tags);
}

/**
 * The `ProvisioningError` a failed operation throws. AWS-authored text can
 * name the caller's assumed-role ARN and is persisted to the deploy journal,
 * so it is named by its error class plus the `--verbose` pointer, with AWS's
 * own text on `debug` and the original error as `cause` (the
 * lambda-network-connector provider's wrap). cdkd-authored text passes through.
 */
export function wrapLogsError(
  logger: ConsoleLogger,
  what: string,
  operation: string,
  logicalId: string,
  resourceType: string,
  physicalId: string | undefined,
  error: unknown
): ProvisioningError {
  if (error instanceof ProvisioningError) return error;
  const cause = error instanceof Error ? error : undefined;
  const build = (text: string): ProvisioningError =>
    new ProvisioningError(
      `Failed to ${operation} ${what} ${logicalIdShown(logicalId)}: ${text}`,
      resourceType,
      logicalId,
      physicalId,
      cause
    );
  const failure = describeAwsFailure(error);
  if (!(error instanceof Error) || !failure.redacted) return build(failure.detail);
  logger.debug(build(failure.detail).message);
  return markRedactedCause(build(`${failure.summary}${relayedNameCollision(failure.detail)}`));
}
