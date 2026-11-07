import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { getLogger, type ConsoleLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import type { ProvisioningError } from '../../utils/error-handler.js';
import {
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../deployment/retryable-errors.js';
import type { DeleteContext } from '../region-check.js';
import {
  createMaskedLogSinks,
  isSecretDerivedValue,
  withDerivedNameMasks,
  MASK_WALK_DEPTH_CAP_MARKER,
  type MaskedLogSinks,
  type MaskerFn,
} from '../masked-retry-logger.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  CreateContext,
  UpdateContext,
  ResourceNotFound,
} from '../../types/resource.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { create } from './secretsmanager-secret/create.js';
import { update } from './secretsmanager-secret/update.js';
import { deleteImpl, replicaRegionsBlockingDelete } from './secretsmanager-secret/delete.js';
import {
  retainPreviousGenerateBlock,
  changedSecretValue,
  asPersisted,
  generateSecretString,
} from './secretsmanager-secret/secret-value.js';
import { readCurrentState, importImpl } from './secretsmanager-secret/read-state.js';

/**
 * AWS Secrets Manager Secret Provider
 *
 * Implements resource provisioning for AWS::SecretsManager::Secret using the Secrets Manager SDK.
 * WHY: CreateSecret is synchronous - the CC API adds unnecessary polling overhead
 * (1s->2s->4s->8s) for an operation that completes immediately.
 */
export class SecretsManagerSecretProvider implements ResourceProvider {
  smClient: SecretsManagerClient;
  logger: ConsoleLogger = getLogger().child('SecretsManagerSecretProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::SecretsManager::Secret',
      new Set([
        'Name',
        'GenerateSecretString',
        'SecretString',
        'Description',
        'KmsKeyId',
        'Tags',
        'ReplicaRegions',
        'Type',
      ]),
    ],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.smClient = awsClients.secretsManager;
  }

  create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return create.call(this, logicalId, resourceType, properties, context);
  }

  update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    return update.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      context
    );
  }

  /**
   * The failure wrap this provider's create, update and delete catches throw.
   *
   * An AWS-authored failure reaches `build` as its CLASS plus the `--verbose`
   * pointer (go-to-k/cdkd#2319): a thrown message is persisted to
   * `deployments/{runId}.jsonl`, and an `AccessDeniedException` names the
   * caller's assumed-role ARN. AWS's own text goes to `debug` through the
   * operation's masker, and the wrap is stamped `markRedactedCause`, so the
   * retry classifiers read the withheld text on the `cause` chain. An "already
   * exists" (`ResourceExistsException` on a taken name) is restated
   * ({@link relayedNameCollision}) from the create only (`relayCollision`):
   * elsewhere "it" would read as this secret. A cdkd-authored or transport error keeps
   * its text, masked (issue #2177), stamped only when the mask changed it
   * (`wrapMaskedAwsError`, issue #4244); a non-`Error` throw is withheld like
   * an AWS one, unstamped (it has no chain). The delete tests its typed
   * not-found before it wraps. A method, so `gen-update-wrap-coverage` sees the
   * catch that throws it as a wrap.
   *
   * `build` must thread `error` as `cause`, and runs twice, so it must stay a
   * side-effect-free constructor call.
   */
  wrapCaughtError(
    mask: MaskerFn,
    error: unknown,
    build: (text: string) => ProvisioningError,
    relayCollision = false
  ): ProvisioningError {
    const failure = describeAwsFailure(error);
    if (!failure.redacted) return wrapMaskedAwsError(mask, error, build);
    this.logger.debug(mask(build(mask(failure.detail)).message));
    const relay = relayCollision ? relayedNameCollision(failure.detail) : '';
    const wrapped = build(`${mask(failure.summary)}${relay}`);
    return error instanceof Error ? markRedactedCause(wrapped) : wrapped;
  }

  /**
   * The masked sinks ONE `create()` / `update()` logs through (issue #2177),
   * the Glue slice's shape: `createMaskedLogSinks` over the context's masker,
   * extended by `pairs` of `[raw template value, name derived from it]`. A
   * derived name counts when its raw value is secret-derived
   * (`isSecretDerivedValue`: the masker changes it, it still spells a
   * `{{resolve:` reference, or it is exactly `***`); an ARN pair names two
   * spellings, the ARN and its name segment. Each such spelling is:
   *
   *  - rendered as `***` wherever a sink masks it as a WHOLE value, at any
   *    length -- and so is a secret ARN whose name segment is one (the ARN
   *    `CreateSecret` returns, which no pair can name up front);
   *  - a needle for `withDerivedNameMasks`: as itself at
   *    `SELF_NEEDLE_MIN_LENGTH` (3) or more characters, so a bare name AWS
   *    quotes back is masked (a rotated name no bag of this deploy holds
   *    too), and a shorter one only as `:secret:<name>-`, the shape an ARN
   *    quotes it in, so it cannot mask letters of cdkd's own wording.
   *
   * The ordering against the base masker, the needle rendering, and the check
   * that withholds a line where a recorded secret crosses or contains a name
   * all live in `withDerivedNameMasks` (go-to-k/cdkd#4193).
   *
   * Accepted: the floor limits a needle masking letters of cdkd's wording,
   * whose positions would hint at the secret, without closing it (a
   * 3-character `ret` still masks part of `secret`), as in the Glue slice. A
   * bare 1-2 character name AWS quotes back prints. A short secret merely
   * embedded in a longer `Name` does not count as secret-derived at all (the
   * masker's substring floor).
   *
   * Built per call, never cached: the provider is a singleton serving
   * concurrent resources.
   */
  operationSinks(
    maskSecrets: MaskerFn | undefined,
    pairs: ReadonlyArray<readonly [raw: unknown, name: unknown]>
  ): MaskedLogSinks {
    const logger = this.logger;
    const base = createMaskedLogSinks(logger, maskSecrets);
    // The shortest spelling that is a needle as itself (the Glue slice's
    // floor); a shorter one is a needle only in its quoted-ARN shape.
    const SELF_NEEDLE_MIN_LENGTH = 3;
    // The name segment of a secret ARN, minus the 6-character suffix Secrets
    // Manager appends to it.
    const arnName = (text: string): string | undefined =>
      /^arn:[^:]+:secretsmanager:[^:]*:[^:]*:secret:(.+)-[A-Za-z0-9]{6}$/.exec(text)?.[1];
    const secretNames = new Set<string>();
    const needlePairs: Array<readonly [unknown, string]> = [];
    for (const [raw, name] of pairs) {
      if (typeof name !== 'string' || name === '') continue;
      if (!isSecretDerivedValue(raw, base.mask)) continue;
      const embedded = arnName(name);
      for (const spelling of embedded === undefined ? [name] : [name, embedded]) {
        secretNames.add(spelling);
        needlePairs.push([
          raw,
          spelling.length >= SELF_NEEDLE_MIN_LENGTH ? spelling : `:secret:${spelling}-`,
        ]);
      }
    }
    if (secretNames.size === 0) return base;
    const needled = withDerivedNameMasks(logger, base, needlePairs);
    const mask: MaskerFn = (text: string) =>
      secretNames.has(text) || secretNames.has(arnName(text) ?? '')
        ? MASK_WALK_DEPTH_CAP_MARKER
        : needled.mask(text);
    return {
      mask,
      value: (value: unknown) => mask(String(value)),
      debug: (message: string) => logger.debug(mask(message)),
      warn: (message: string) => logger.warn(mask(message)),
    };
  }

  replicaRegionsBlockingDelete(error: unknown, physicalId: string): Promise<string[] | undefined> {
    return replicaRegionsBlockingDelete.call(this, error, physicalId);
  }

  delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    return deleteImpl.call(this, logicalId, physicalId, resourceType, properties, context);
  }

  retainPreviousGenerateBlock(
    logicalId: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Record<string, unknown> {
    return retainPreviousGenerateBlock.call(this, logicalId, properties, previousProperties);
  }

  changedSecretValue(
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    stateBorneDesired: boolean,
    warn: (message: string) => void
  ): { value: string | undefined; skippedGenerate: boolean } {
    return changedSecretValue.call(this, properties, previousProperties, stateBorneDesired, warn);
  }

  asPersisted<T>(bag: T): T {
    return (asPersisted<T>).call(this, bag);
  }

  generateSecretString(
    config: Record<string, unknown>,
    options?: { onUnusable?: (message: string) => void }
  ): string | undefined {
    return generateSecretString.call(this, config, options);
  }

  readCurrentState(
    physicalId: string,
    logicalId: string,
    resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentState.call(this, physicalId, logicalId, resourceType);
  }

  /**
   * `SecretString` and `GenerateSecretString` are set on create but
   * `DescribeSecret` does not return the secret value (that lives behind
   * `GetSecretValue`, which we deliberately never call to avoid surfacing
   * plaintext through drift). Tell the drift comparator to skip both keys
   * so they don't fire guaranteed false-positive drift on every clean run.
   */
  getDriftUnknownPaths(): string[] {
    return ['SecretString', 'GenerateSecretString'];
  }

  import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importImpl.call(this, input);
  }
}
