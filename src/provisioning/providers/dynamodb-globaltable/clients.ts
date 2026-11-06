import { DescribeKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { ApplicationAutoScalingClient } from '@aws-sdk/client-application-auto-scaling';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { withoutServerErrorRetries } from '../ambiguous-create.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { isAuxiliaryFailure } from '../../auxiliary-failure.js';
import { markNotGone } from '../../not-gone.js';
import {
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../../deployment/retryable-errors.js';
import { relayedIndexBusyDelete } from '../../dynamodb-index-busy-delete.js';
import { DYNAMODB_DELETE_MIN_RESOURCE_TIMEOUT_MS } from '../dynamodb-delete-budget.js';
import {
  createMaskedLogSinks,
  withDerivedNameMasks,
  type MaskedLogSinks,
} from '../../masked-retry-logger.js';
import type { CreateContext, UpdateContext } from '../../../types/resource.js';
import {
  ambientClientDefaults,
  clientDefaultsFor,
} from '../../../utils/ambient-client-defaults.js';
import { relayedEncryptionChangeLimit } from './capacity.js';
import type { DynamoDBGlobalTableProvider } from '../dynamodb-globaltable-provider.js';

/**
 * The client `CreateTable` goes through: SDK retries on, except a 5xx
 * (`withoutServerErrorRetries`, issue #4639). Separate so every other call
 * -- and every other provider sharing `getAwsClients().dynamoDB` -- keeps
 * the full SDK retry. Built in the shared client's REGION (read from it, as
 * `config.region()` resolves it), so the create cannot land in another
 * region than the calls around it, and with the credentials of the SAME
 * `AwsClients` that client came from, read at construction, so a later
 * `setAwsClients` switch cannot give the create another identity. The PROMISE is cached, so two creates on
 * a cold provider build one client; a rejected region read is not cached,
 * so the next create retries it.
 *
 * `CreateTable` carries no idempotency token and a table name is unique per
 * account and region, so the SDK's own replay of a 5xx whose request had
 * succeeded collides with the table the first send made, and that
 * `ResourceInUseException` surfaced from the engine's FIRST attempt as a
 * table somebody else holds. Refused here, the 5xx reaches the deploy
 * engine's retry, which marks the create as possibly replayed (`withRetry`,
 * #3978). The table is not adopted on that collision: a name is not
 * attribution (`docs/provider-rules.md`, "Adopt only on EXACT attribution").
 */
export function getCreateClient(this: DynamoDBGlobalTableProvider): Promise<DynamoDBClient> {
  this.createClient ??= this.dynamoDBClient.config.region().then(
    (region) =>
      withoutServerErrorRetries(
        new DynamoDBClient({ ...clientDefaultsFor(this.credentialConfig), region })
      ),
    (error: unknown) => {
      this.createClient = undefined;
      throw error;
    }
  );
  return this.createClient;
}

/**
 * Self-reported minimum per-resource deadline (issue #1955).
 *
 * The engine resolves the deadline as
 * `perTypeCliOverride ?? max(getMinResourceTimeoutMs(), globalCliDefault)`,
 * so declaring this is what turns "the shared delete budget fits inside the
 * deadline" from an assumption about the CLI default into a guarantee: a user
 * who lowers `--resource-timeout` globally can no longer re-create the
 * crossing the budget exists to remove. It equals today's
 * `DEFAULT_RESOURCE_TIMEOUT_MS`, so at default settings this changes nothing.
 *
 * **It is TYPE-level, not operation-level**, and that is a real consequence
 * rather than a detail: `deploy-engine.ts` and `destroy-runner.ts` both fold
 * it in through the same `Math.max(...)`, so a user running
 * `--resource-timeout 5m` for fail-fast CI gets 30 minutes for this type's
 * CREATE and UPDATE too, not only for the DELETE the budget is about. The
 * interface has no per-operation form, and the escape hatch for anyone who
 * wants the shorter deadline back is the per-type override
 * (`--resource-timeout AWS::DynamoDB::GlobalTable=5m`), which still wins.
 */
export function getMinResourceTimeoutMs(this: DynamoDBGlobalTableProvider): number {
  return DYNAMODB_DELETE_MIN_RESOURCE_TIMEOUT_MS;
}

/**
 * Return a `DynamoDBClient` pinned to the given region, caching per
 * region for the lifetime of this provider instance. Uses the default
 * credential chain (env / shared config / IAM role) — no explicit
 * credential plumbing needed.
 *
 * Used by `readCurrentState` (cross-region per-replica sub-spec reads)
 * and `update()` (cross-region replica Tag propagation). Both code
 * paths fire region-scoped DynamoDB APIs (`DescribeContributorInsights`
 * / `DescribeContinuousBackups` / `DescribeKinesisStreamingDestination`
 * / `TagResource` / `UntagResource`) against the replica's region.
 *
 * The cache may return `this.dynamoDBClient` when `region` happens to
 * match the local client's region — in tests the local mock is
 * intercepted via `vi.mock('../../utils/aws-clients.js')` so reuse
 * is safe (and explicitly desired so the mock catches the call).
 */
export function getRegionalClient(
  this: DynamoDBGlobalTableProvider,
  region: string
): DynamoDBClient {
  const cached = this.regionalClientCache.get(region);
  if (cached) return cached;
  const client = new DynamoDBClient({ ...ambientClientDefaults(), region });
  this.regionalClientCache.set(region, client);
  return client;
}

/**
 * Return an `ApplicationAutoScalingClient` pinned to the given region,
 * caching per region for the lifetime of this provider instance. Mirrors
 * `getRegionalClient` but for the application-autoscaling service.
 *
 * Used by `readAutoScalingSettings` (Issue #395) to recover per-replica
 * `ReadCapacityAutoScalingSettings` shapes — each cross-region replica's
 * scaling target + policy are registered with the autoscaling control
 * plane in the replica's region, so cross-region drift reads need a
 * region-scoped client.
 */
export function getRegionalAutoScalingClient(
  this: DynamoDBGlobalTableProvider,
  region: string
): ApplicationAutoScalingClient {
  const cached = this.regionalAutoScalingClientCache.get(region);
  if (cached) return cached;
  const client = new ApplicationAutoScalingClient({ ...ambientClientDefaults(), region });
  this.regionalAutoScalingClientCache.set(region, client);
  return client;
}

export async function getLocalAutoScalingClient(
  this: DynamoDBGlobalTableProvider
): Promise<ApplicationAutoScalingClient> {
  if (this.localAutoScalingClient) return this.localAutoScalingClient;
  const region = (await this.dynamoDBClient.config.region()) ?? '';
  this.localAutoScalingClient = new ApplicationAutoScalingClient({
    ...ambientClientDefaults(),
    region,
  });
  return this.localAutoScalingClient;
}

/**
 * Construct the regional table ARN for a cross-region replica of a
 * GlobalTable. AWS replicates the same `TableName` across every
 * replica region, with each replica's ARN differing only in the
 * `:<region>:` segment. Cheaper than a second `DescribeTable` round-
 * trip on the regional client.
 *
 * Example:
 *   local ARN:   arn:aws:dynamodb:us-east-1:123:table/Foo
 *   for eu-west-1 → arn:aws:dynamodb:eu-west-1:123:table/Foo
 *
 * Returns `undefined` when the local ARN is malformed (defensive —
 * downstream callers omit the offending operation rather than throw).
 */
export function replicaArnForRegion(
  this: DynamoDBGlobalTableProvider,
  localTableArn: string,
  targetRegion: string
): string | undefined {
  const segments = localTableArn.split(':');
  if (segments.length < 6) return undefined;
  segments[3] = targetRegion;
  return segments.join(':');
}

/**
 * The masked sinks ONE `create()` / `update()` logs through (issue #2177,
 * `.claude/rules/provider-masking.md`): `createMaskedLogSinks` over the
 * context's masker, extended by `withDerivedNameMasks` with `pairs` — each
 * `[template value, name derived from it]`. The physical id IS the table
 * name, and every auto-scaling resource id, policy name, ARN and pasteable
 * command embeds it, so a secret-derived `TableName` is masked wherever it
 * occurs: below the base masker's substring floor too, and on update when
 * only the PREVIOUS side recorded it (a rotated secret's `{{resolve:`
 * reference). Built per call; never cached on the provider, which serves
 * concurrent resources.
 */
export function operationSinks(
  this: DynamoDBGlobalTableProvider,
  context: CreateContext | UpdateContext | undefined,
  pairs: ReadonlyArray<readonly [raw: unknown, name: string | undefined]>
): MaskedLogSinks {
  return withDerivedNameMasks(
    this.logger,
    createMaskedLogSinks(this.logger, context?.maskSecrets),
    pairs
  );
}

/**
 * Wrap a caught failure, masked through `log`. A provider-local factory so
 * the update-wrap coverage scanner sees the `ProvisioningError` it returns.
 * A catch that only ever sees a cdkd-authored refusal builds its own
 * `ProvisioningError` instead; a catch-all that can see both (the deletes,
 * whose try also runs cdkd's own waits) passes a cdkd-authored error
 * through the masked pass-through below.
 *
 * An AWS-authored failure reaches `build` as its CLASS plus the `--verbose`
 * pointer (go-to-k/cdkd#2319): a thrown message is persisted to
 * `deployments/{runId}.jsonl`, and an `AccessDeniedException` names the
 * caller's assumed-role ARN. AWS's own text goes to `debug`, masked both raw
 * and as the finished line. The wrap is stamped `markRedactedCause`, so
 * retry classification reads the withheld text on the `cause` chain. An
 * "already exists" and an index-busy refusal are restated
 * ({@link relayedNameCollision}, {@link relayedIndexBusyDelete}); the first
 * is not, when a post-CreateTable call raised it ({@link isAuxiliaryFailure}).
 * A cdkd-authored or transport error keeps the masked pass-through of the
 * shared `wrapMaskedAwsError`, which stamps when the mask changed the text
 * (the #4244 class); a non-`Error` throw is withheld like an AWS one,
 * unstamped (it has no chain).
 * The delete checks `ResourceNotFoundException` by type before it wraps.
 *
 * `build` must thread `error` as `cause`, and runs twice, so it must stay a
 * side-effect-free constructor call.
 */
export function wrapMaskedError(
  this: DynamoDBGlobalTableProvider,
  log: MaskedLogSinks,
  error: unknown,
  build: (maskedText: string) => ProvisioningError,
  // go-to-k/cdkd#2762: how the index-busy relay names the index on a table
  // with vector indexes; omitted, {@link relayedIndexBusyDelete}'s default.
  indexNoun?: string
): ProvisioningError {
  const failure = describeAwsFailure(error);
  if (!failure.redacted) return wrapMaskedAwsError(log.mask, error, build);
  log.debug(build(log.mask(failure.detail)).message);
  // Not restated when a post-create call raised it (#3826): "it" would read
  // as this resource.
  const relay = isAuxiliaryFailure(error) ? '' : relayedNameCollision(failure.detail);
  const wrapped = build(
    `${log.mask(failure.summary)}${relay}${relayedIndexBusyDelete(failure.detail, indexNoun)}` +
      relayedEncryptionChangeLimit(failure.detail)
  );
  return error instanceof Error ? markRedactedCause(wrapped) : wrapped;
}

/**
 * The failure text a partial-create cleanup `warn` quotes after `head`, with
 * its closing period (go-to-k/cdkd#2319). An AWS-authored failure is named
 * by its CLASS at warn, since a denied `DeleteTable` names the caller's
 * assumed-role ARN; AWS's own text goes to `debug` under the same `head`,
 * masked. A cdkd-authored or transport error keeps its text, masked.
 */
export function cleanupFailureText(
  this: DynamoDBGlobalTableProvider,
  log: MaskedLogSinks,
  head: string,
  error: unknown
): string {
  const failure = describeAwsFailure(error);
  if (!failure.redacted) return `${log.mask(failure.detail)}.`;
  log.debug(`${head}${log.mask(failure.detail)}`);
  return log.mask(failure.summary);
}

/**
 * {@link wrapMaskedError} for a delete catch. The wrap names an AWS failure
 * by its CLASS, and the delete classifiers read `NotFound` in a message as
 * "already deleted": a class naming ANOTHER object's not-found (this
 * resource's own not-found returned before the wrap) is marked
 * `markNotGone`, so the record is kept (go-to-k/cdkd#2319).
 */
export function wrapDeleteError(
  this: DynamoDBGlobalTableProvider,
  log: MaskedLogSinks,
  error: unknown,
  build: (maskedText: string) => ProvisioningError,
  indexNoun?: string
): ProvisioningError {
  const thrown = this.wrapMaskedError(log, error, build, indexNoun);
  return error instanceof Error && error.name.includes('NotFound') ? markNotGone(thrown) : thrown;
}

/**
 * Resolve the application-autoscaling client that owns a given region's
 * targets. The local region goes through the cached client; every other
 * region gets the per-region cached client.
 */
export async function autoScalingClientForRegion(
  this: DynamoDBGlobalTableProvider,
  region: string,
  localRegion: string
): Promise<ApplicationAutoScalingClient> {
  return region === localRegion
    ? await this.getLocalAutoScalingClient()
    : this.getRegionalAutoScalingClient(region);
}

/**
 * `KeyManager` of the KMS key `arn` (`'AWS'` for an AWS managed key), read in
 * the ARN's own region; `undefined` when it cannot be read, so the caller
 * completes nothing and the drift stays visible (go-to-k/cdkd#5790).
 */
export function kmsClientFor(this: DynamoDBGlobalTableProvider, region: string): KMSClient {
  let client = this.kmsClientCache.get(region);
  if (client === undefined) {
    client = new KMSClient({ ...clientDefaultsFor(this.credentialConfig), region });
    this.kmsClientCache.set(region, client);
  }
  return client;
}

export function kmsKeyManager(
  this: DynamoDBGlobalTableProvider,
  arn: string
): Promise<string | undefined> {
  const cached = this.kmsKeyManagerCache.get(arn);
  if (cached !== undefined) return cached;
  const region = /^arn:aws[a-z-]*:kms:([a-z0-9-]+):/.exec(arn)?.[1];
  const lookup =
    region === undefined
      ? Promise.resolve(undefined)
      : this.kmsClientFor(region)
          .send(new DescribeKeyCommand({ KeyId: arn }))
          .then(
            (out) => out.KeyMetadata?.KeyManager,
            (err: unknown) => {
              this.logger.debug(
                `Could not read the KMS key manager for a replica key: ${describeAwsFailure(err).summary}`
              );
              return undefined;
            }
          );
  this.kmsKeyManagerCache.set(arn, lookup);
  return lookup;
}
