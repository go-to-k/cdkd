import type { DeliveryStreamEncryptionConfiguration } from '@aws-sdk/client-firehose';
import { holdsSecretDerivedEntry } from '../../iam-policy-targets.js';
import { isDeepStrictEqual } from 'node:util';

export const ENCRYPTION_KEY = 'DeliveryStreamEncryptionConfigurationInput';

/** One read of a declared `DeliveryStreamEncryptionConfigurationInput`. */
export type EncryptionInputRead =
  /** Not declared (`undefined` / `null`). On an UPDATE this is a REMOVAL. */
  | { kind: 'absent' }
  | { kind: 'usable'; keyType: string; keyArn?: string }
  /** Declared but not an object with a string `KeyType` (and a string `KeyARN`, if any). */
  | { kind: 'unusable' };

/**
 * Read a `DeliveryStreamEncryptionConfigurationInput` block, accepting the
 * `KeyArn` spelling the create path also reads.
 *
 * `readCurrentState` spells "not encrypted" as an EMPTY `{}` placeholder, so
 * with `emptyIsAbsent` that reads as absent: set for a recorded previous side
 * (`cdkd drift --accept` can write the readback into a record) and for a
 * desired bag that is a readback (`desiredFromAwsReadback`). A TEMPLATE `{}`
 * stays unusable (the CFn schema requires `KeyType`), and so does a replayed
 * state record's: `replayingState` never licenses removing live config.
 */
export function readEncryptionInput(value: unknown, emptyIsAbsent: boolean): EncryptionInputRead {
  if (value === undefined || value === null) return { kind: 'absent' };
  if (typeof value !== 'object' || Array.isArray(value)) return { kind: 'unusable' };
  const block = value as Record<string, unknown>;
  if (emptyIsAbsent && Object.keys(block).length === 0) return { kind: 'absent' };
  const keyType = block['KeyType'];
  const keyArn = block['KeyArn'] || block['KeyARN'];
  if (typeof keyType !== 'string' || keyType.length === 0) return { kind: 'unusable' };
  if (keyArn !== undefined && keyArn !== null && keyArn !== '' && typeof keyArn !== 'string') {
    return { kind: 'unusable' };
  }
  return typeof keyArn === 'string' && keyArn.length > 0
    ? { kind: 'usable', keyType, keyArn }
    : { kind: 'usable', keyType };
}

/** `true` when the desired and the recorded block ask AWS for the same thing. */
export function sameEncryptionInput(
  next: unknown,
  nextRead: EncryptionInputRead,
  prev: unknown
): boolean {
  const b = readEncryptionInput(prev, true);
  if (nextRead.kind === 'unusable' || b.kind === 'unusable') {
    return JSON.stringify(next) === JSON.stringify(prev);
  }
  if (nextRead.kind === 'absent' || b.kind === 'absent') return nextRead.kind === b.kind;
  return nextRead.keyType === b.keyType && nextRead.keyArn === b.keyArn;
}

/**
 * `true` when the stream's reported encryption is ENABLED with the requested
 * key. A KeyARN is compared only for a customer-managed key: AWS reports none
 * for `AWS_OWNED_CMK`.
 */
export function encryptionMatches(
  live: DeliveryStreamEncryptionConfiguration | undefined,
  desired: { keyType: string; keyArn?: string }
): boolean {
  if (live?.Status !== 'ENABLED' || live.KeyType !== desired.keyType) return false;
  return desired.keyType !== 'CUSTOMER_MANAGED_CMK' || live.KeyARN === desired.keyArn;
}

/**
 * The CFn input shape of the stream's reported encryption, as
 * `readCurrentState` emits it: `{KeyARN?, KeyType}` while the stream is
 * encrypted or becoming so (ENABLED, ENABLING, DISABLING_FAILED), else the
 * `{}` placeholder. A KeyType AWS still reports beside DISABLED or
 * ENABLING_FAILED is not encryption in effect.
 */
export function liveEncryptionAsCfn(
  live: DeliveryStreamEncryptionConfiguration | undefined
): Record<string, unknown> {
  const status = live?.Status;
  if (status !== 'ENABLED' && status !== 'ENABLING' && status !== 'DISABLING_FAILED') return {};
  return {
    ...(live?.KeyARN !== undefined && { KeyARN: live.KeyARN }),
    ...(live?.KeyType !== undefined && { KeyType: live.KeyType }),
  };
}

/** Polling cadence and cap for an encryption transition (measured at ~80-95 s). */
export const ENCRYPTION_POLL_INTERVAL_MS = 5000;
export const ENCRYPTION_POLL_MAX_ATTEMPTS = 120;

/**
 * Polling cadence and cap for the create-time wait for ACTIVE. The engine's
 * per-resource deadline ends the wait first under the default 30 min timeout;
 * the cap bounds it where no deadline encloses the call.
 */
export const ACTIVE_POLL_INTERVAL_MS = 5000;
export const ACTIVE_POLL_MAX_ATTEMPTS = 360;
/**
 * What the wait leaves of the resource deadline for its last read and its
 * throw to settle before the deadline fires (go-to-k/cdkd#5509).
 */
export const ACTIVE_DEADLINE_MARGIN_MS = 2000;

/** Errors for an `ENABLING_FAILED` / `DISABLING_FAILED` report: AWS ended the transition. */
export const terminalEncryptionFailures = new WeakSet<object>();

/**
 * `true` for `undefined` / `null` (ABSENT, the empty list) or a list of tag
 * objects each carrying a non-empty string `Key`. Anything else is malformed:
 * the Tags diff derives its `UntagDeliveryStream` keys from the gap between the
 * two sides, so reading a malformed side as empty would untag every key the
 * other side holds (go-to-k/cdkd#3948).
 */
export function isReadableTagList(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return (
    Array.isArray(value) &&
    value.every(
      (t) =>
        typeof t === 'object' &&
        t !== null &&
        !Array.isArray(t) &&
        typeof (t as { Key?: unknown }).Key === 'string' &&
        (t as { Key: string }).Key.length > 0 &&
        // A dynamic reference or its mask names no tag key the stream holds.
        // Refused on BOTH sides, unlike the Auto Scaling group's recorded side:
        // Firehose's documented TagKey pattern admits neither `{` nor `:`, so an
        // UntagDeliveryStream of a recorded `{{resolve:...}}` key is rejected
        // rather than ignored, and the update never converged anyway.
        !holdsSecretDerivedEntry((t as { Key: string }).Key)
    )
  );
}

/**
 * The destinations whose `S3BackupMode` cannot change after the stream is
 * created (go-to-k/cdkd#5386), each with the `DescribeDeliveryStream`
 * description member that reports the live mode. Their `UpdateDestination`
 * shapes (`ElasticsearchDestinationUpdate`,
 * `AmazonopensearchserviceDestinationUpdate`,
 * `AmazonOpenSearchServerlessDestinationUpdate`) have no `S3BackupMode`
 * member, so the change has nothing to be sent through.
 *
 * CloudFormation behaves the same way, and `S3BackupMode` is not a
 * create-only property in its schema. Measured in us-east-1 on 2026-10-27: a
 * stack with an `AmazonOpenSearchServerlessDestinationConfiguration` at
 * `FailedDocumentsOnly`, updated to `AllDocuments`, ended `UPDATE_COMPLETE`
 * with the same stream, its `VersionId` still 1 and its mode still
 * `FailedDocumentsOnly`. (The two domain-backed destinations could not be
 * created without a live OpenSearch domain; they share the schema and the
 * update shape's gap.) cdkd keeps that outcome, records the declared value as
 * CloudFormation's stored template does, and warns instead of staying silent.
 */
export const FIXED_BACKUP_MODE_DESTINATIONS: Readonly<
  Record<
    string,
    | 'ElasticsearchDestinationDescription'
    | 'AmazonopensearchserviceDestinationDescription'
    | 'AmazonOpenSearchServerlessDestinationDescription'
  >
> = {
  ElasticsearchDestinationConfiguration: 'ElasticsearchDestinationDescription',
  AmazonopensearchserviceDestinationConfiguration: 'AmazonopensearchserviceDestinationDescription',
  AmazonOpenSearchServerlessDestinationConfiguration:
    'AmazonOpenSearchServerlessDestinationDescription',
};

/** The mode Firehose applies when these destinations declare none. */
export const DEFAULT_OPENSEARCH_BACKUP_MODE = 'FailedDocumentsOnly';

/**
 * The destination key whose `S3BackupMode` changed between the two bags but
 * cannot be applied in place (go-to-k/cdkd#5386), or `undefined`. Only a
 * destination both bags declare as an object is compared: a destination switch
 * is refused earlier, and with `changedProperties` set (the deploy's in-place
 * update) a destination the engine did not report as changed is skipped.
 */
export function unappliedS3BackupModeDestination(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  destKey: string | undefined,
  changedProperties: ReadonlySet<string> | undefined
): string | undefined {
  if (destKey === undefined || !Object.hasOwn(FIXED_BACKUP_MODE_DESTINATIONS, destKey)) {
    return undefined;
  }
  if (changedProperties !== undefined && !changedProperties.has(destKey)) return undefined;
  const desired = properties[destKey];
  const previous = previousProperties[destKey];
  if (!isPlainRecord(desired) || !isPlainRecord(previous)) return undefined;
  return isDeepStrictEqual(desired['S3BackupMode'], previous['S3BackupMode']) ? undefined : destKey;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Poll cadence and cap for the post-delete gone-wait (issue #3872). The
 * DELETING window measured ~103-107s (us-east-1), so the cap is generous
 * headroom, not an estimate, and sits well under the 30-min per-resource
 * deadline.
 */
export const FIREHOSE_DELETE_POLL_INTERVAL_MS = 5_000;
export const FIREHOSE_DELETE_MAX_WAIT_MS = 10 * 60 * 1000;
