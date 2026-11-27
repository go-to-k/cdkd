import { holdsMaskLeaf } from '../../secret-redaction/recorded-secrecy.js';
/**
 * go-to-k/cdkd#6824: a measured write-only key (a password Cloud Control
 * re-sets on every re-send, `getWriteOnlyKeysKeptWhenOmitted`) held as a
 * `{{resolve:...}}` reference never compares equal: the record keeps the
 * reference, the desired side the value. It is left out of an update only
 * when the secret VERSION this deploy resolved is the one the record attests
 * AWS was last sent. Versions are immutable, and a rotation, `PutSecretValue`,
 * `PutParameter` or a stage move all change the version served, so an equal
 * single id means an equal value, with no value read or hashed.
 *
 * The attestation (`ReferenceProvenance.versionsSent`) is only true while
 * every send of another version is WRITTEN AHEAD: {@link recordToWriteAhead}
 * names the record persisted, without that token's version arm, before such a
 * send, so a send that fails or is killed after AWS applied it leaves a record
 * naming no version, and the next deploy re-sends.
 *
 * Any arm unknown means the key is sent, as before.
 */
import type { ResourceState } from '../../../types/state.js';
import type { DeployEngine } from '../../deploy-engine.js';
import { CdkdError } from '../../../utils/error-handler.js';
import { markNonRetryable } from '../../retryable-errors.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { asIsMessage, safeMsg } from '../../../utils/display-safe.js';
import { writeOnlyKeysKeptWhenOmittedCandidates } from '../../../provisioning/write-only-properties.js';
import { onlySecretReferencesDiffer } from '../../../provisioning/secret-reference-immutable.js';
import type { MaskerFn } from '../../../provisioning/masked-retry-logger.js';
import { createSecretMasker } from '../../secret-redaction.js';
import type { RecordedSecretValues } from '../../secret-redaction/pairs.js';
import { passProvenanceFor } from '../../secret-redaction/reference-provenance.js';
import {
  recordedProvenanceOf,
  referenceTokensIn,
  withTokenVersionsDropped,
} from '../../reference-provenance-record.js';

/** What the engine's update arm knows about one in-place update. */
export interface WriteOnlySecretSkipInput {
  resourceType: string;
  /** The record as loaded (its routing layer and provenance). */
  record: ResourceState;
  /** The layer this update goes through. */
  route: 'sdk' | 'cc-api' | undefined;
  /** The update moves a Cloud Control record to its SDK provider. */
  sdkMigration: boolean;
  /** `DeployEngine.writeOnlySecretSkipAllowed`: the journal arm. */
  skipAllowed: boolean;
  /** Names an earlier failed update left unsettled. */
  unsettled: ReadonlySet<string>;
  /**
   * The keys this update changes as WRITTEN, template to template
   * (`UpdateContext.changedProperties`). The value comparison below cannot see
   * a literal added around a reference (`x{{resolve:...}}` resolves to a value
   * the masker still recognises), so only an unchanged spelling qualifies.
   */
  changed: ReadonlySet<string>;
  /** The previous side the provider diffs. */
  previous: Record<string, unknown>;
  /** The desired (resolved) side the provider sends. */
  desired: Record<string, unknown>;
  /** This resource's pass bag, which holds the pass's provenance. */
  secrets: RecordedSecretValues;
  /** The masker the provider is handed. */
  maskSecrets: MaskerFn;
}

/**
 * The value at `key` is the same reference at the version the record attests:
 * only `{{resolve:` spans differ between the sides, and every token there has
 * a single attested version and region in the record equal to the single
 * version and region this pass resolved.
 */
function sameAttestedVersion(
  key: string,
  previous: Record<string, unknown>,
  desired: Record<string, unknown>,
  record: ResourceState,
  secrets: RecordedSecretValues,
  maskSecrets: MaskerFn
): boolean {
  if (!Object.hasOwn(previous, key) || !Object.hasOwn(desired, key)) return false;
  const before = previous[key];
  if (holdsMaskLeaf(before)) return false;
  if (!onlySecretReferencesDiffer(desired[key], before, maskSecrets)) return false;
  const tokens = referenceTokensIn(before);
  if (tokens.size === 0) return false;
  for (const token of tokens) {
    const recorded = recordedProvenanceOf(record, token);
    const pass = passProvenanceFor(secrets, token);
    if (
      recorded?.versionsSent !== true ||
      recorded.versions?.length !== 1 ||
      recorded.region === undefined ||
      pass?.versions?.length !== 1 ||
      pass.region === undefined ||
      recorded.versions[0] !== pass.versions[0] ||
      recorded.region !== pass.region
    ) {
      return false;
    }
  }
  return true;
}

/**
 * `UpdateContext.unchangedWriteOnlySecretProperties`, or `undefined` for none.
 * The provider honours a name only where its own table also names it.
 */
export function unchangedWriteOnlySecretProperties(
  input: WriteOnlySecretSkipInput
): ReadonlySet<string> | undefined {
  const { resourceType, record, unsettled, changed, previous, desired, secrets, maskSecrets } =
    input;
  if (!input.skipAllowed) return undefined;
  // Provenance records the version RESOLVED; only a Cloud Control write is
  // known to have sent it for these keys.
  if (input.route !== 'cc-api' || input.sdkMigration || record.provisionedBy !== 'cc-api') {
    return undefined;
  }
  let out: Set<string> | undefined;
  for (const key of writeOnlyKeysKeptWhenOmittedCandidates(resourceType)) {
    if (unsettled.has(key) || changed.has(key)) continue;
    if (!sameAttestedVersion(key, previous, desired, record, secrets, maskSecrets)) continue;
    (out ??= new Set()).add(key);
  }
  return out;
}

/**
 * The record to persist BEFORE this update is sent, or `undefined` when the
 * update sends no other value for an attested token: each candidate key whose
 * tokens are attested and which is changed as written, or whose desired value
 * is not the same reference at the same version, has those tokens' version
 * arm dropped.
 */
export function recordToWriteAhead(
  input: Pick<
    WriteOnlySecretSkipInput,
    'resourceType' | 'record' | 'changed' | 'desired' | 'secrets' | 'maskSecrets'
  >
): ResourceState | undefined {
  const { resourceType, record, changed, desired, secrets, maskSecrets } = input;
  const recorded = record.properties ?? {};
  const drop = new Set<string>();
  for (const key of writeOnlyKeysKeptWhenOmittedCandidates(resourceType)) {
    if (!Object.hasOwn(recorded, key)) continue;
    const attested = [...referenceTokensIn(recorded[key])].filter(
      (token) => recordedProvenanceOf(record, token)?.versionsSent === true
    );
    if (attested.length === 0) continue;
    if (
      !changed.has(key) &&
      sameAttestedVersion(key, recorded, desired, record, secrets, maskSecrets)
    ) {
      continue;
    }
    for (const token of attested) drop.add(token);
  }
  return drop.size === 0 ? undefined : withTokenVersionsDropped(record, drop);
}

/**
 * The update arm's whole step, before its provider call: write the record
 * ahead when this update sends another version of an attested token (a
 * failed or unavailable write-ahead fails the update before anything is
 * sent), then name the keys it may leave out. Never reached by a rollback
 * replay or `drift --revert`, which therefore name none.
 */
export async function writeOnlySecretsForUpdate(
  engine: Pick<DeployEngine, 'writeAheadRecord' | 'writeOnlySecretSkipAllowed'>,
  logicalId: string,
  input: Omit<WriteOnlySecretSkipInput, 'skipAllowed' | 'maskSecrets'>
): Promise<ReadonlySet<string> | undefined> {
  const { resourceType } = input;
  const full: WriteOnlySecretSkipInput = {
    ...input,
    skipAllowed: engine.writeOnlySecretSkipAllowed,
    maskSecrets: createSecretMasker(input.secrets),
  };
  const ahead = recordToWriteAhead(full);
  if (ahead !== undefined) {
    if (engine.writeAheadRecord === undefined) {
      throw markNonRetryable(
        new CdkdError(
          safeMsg`${logicalId} (${resourceType}): cdkd could not record, before sending it, that a secret value is changing, so it sent nothing. Re-run the deploy.`,
          WRITE_AHEAD_FAILED
        )
      );
    }
    try {
      await engine.writeAheadRecord(logicalId, ahead);
    } catch (error) {
      throw markNonRetryable(
        new CdkdError(
          safeMsg`${logicalId} (${resourceType}): cdkd could not save state before sending a changed secret value, so it sent nothing: ${asIsMessage(describeAwsFailure(error).detail)}. Re-run the deploy once the state bucket accepts writes.`,
          WRITE_AHEAD_FAILED,
          error instanceof Error ? error : undefined
        )
      );
    }
  }
  return unchangedWriteOnlySecretProperties(full);
}

const WRITE_AHEAD_FAILED = 'WRITE_ONLY_SECRET_WRITE_AHEAD_FAILED';
