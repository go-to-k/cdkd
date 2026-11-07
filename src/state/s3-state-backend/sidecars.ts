/**
 * The stack-scoped sidecar objects next to `state.json`: the create-token ledger and the write-ahead `stack-instance.json`.
 *
 * Moved verbatim out of `src/state/s3-state-backend.ts` (go-to-k/cdkd#5835); the
 * `S3StateBackend` class keeps one `f.call(this, ...)` delegator per moved method.
 */
import type { S3StateBackend } from '../s3-state-backend.js';
import { randomUUID } from 'node:crypto';
import { PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { parseCreateTokenLedger, type CreateTokenLedgerDoc } from '../create-token-ledger.js';
import {
  STACK_INSTANCE_SIBLING_FILE,
  parseStackInstanceSibling,
  stackInstanceSiblingBody,
} from '../stack-instance-id.js';
import { isNotImplemented } from '../cross-prefix-stack-scan.js';
import { displayStackName, safeMsg } from '../../utils/display-safe.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { StateError, normalizeAwsError } from '../../utils/error-handler.js';
import {
  withoutFinalPeriod,
  STACK_INSTANCE_OBJECT_DESCRIPTION,
  isConditionalConflict,
  isConditionFailure,
  isNoSuchKey,
} from './shared.js';

/**
 * Read the stack's create-token ledger (go-to-k/cdkd#4438). `null` when
 * there is none. A failed read, or a body this binary does not understand,
 * throws.
 */
export async function loadCreateTokenLedger(
  this: S3StateBackend,
  stackName: string,
  region: string
): Promise<CreateTokenLedgerDoc | null> {
  const body = await this.getRawObject(this.getCreateTokenLedgerKey(stackName, region));
  if (body === null) return null;
  const ledger = parseCreateTokenLedger(body);
  if (ledger === null) {
    // Not "no ledger": a body this binary cannot read -- a newer version's,
    // or a damaged one -- must not be overwritten with a fresh nonce.
    throw new Error(
      `the create-token ledger of stack ${this.stackRef(stackName, region)} (create-tokens.json beside its state.json) is in a format this cdkd version cannot read; upgrade cdkd, or delete that object if it is damaged`
    );
  }
  return ledger;
}

/** Write the stack's create-token ledger. Every writer holds the stack lock. */
export async function saveCreateTokenLedger(
  this: S3StateBackend,
  stackName: string,
  region: string,
  ledger: CreateTokenLedgerDoc
): Promise<void> {
  await this.putRawObject(
    this.getCreateTokenLedgerKey(stackName, region),
    JSON.stringify(ledger, null, 2)
  );
}

/**
 * Replace the ledger's nonce and drop the `sent` entries of `logicalIds`
 * (go-to-k/cdkd#4438): `cdkd orphan` let those resources go while they still
 * hold this stack's tokens, so the stack's next create of them must send a
 * new one. OTHER logical ids keep the token they sent, which a re-run still
 * reuses. No ledger, no-op: the stack's next create
 * mints a fresh nonce anyway. Throws a `StateError` naming the stack when
 * the ledger cannot be read or written, so `cdkd orphan` stops before
 * dropping the record.
 */
export async function rotateCreateTokenNonce(
  this: S3StateBackend,
  stackName: string,
  region: string,
  logicalIds: readonly string[]
): Promise<void> {
  try {
    const ledger = await this.loadCreateTokenLedger(stackName, region);
    if (ledger === null) return;
    ledger.nonce = randomUUID();
    for (const logicalId of logicalIds) delete ledger.sent[logicalId];
    await this.saveCreateTokenLedger(stackName, region, ledger);
  } catch (error) {
    // The SDK's own text (an AccessDenied names the object's ARN) carries
    // the raw stack name: name the stack through `stackRef` instead.
    const normalized = normalizeAwsError(error, { bucket: this.config.bucket });
    throw this.wrapS3Failure(
      normalized,
      (text) =>
        new StateError(
          `Failed to renew the create-token ledger of stack ${this.stackRef(stackName, region)}: ${withoutFinalPeriod(text)}. ` +
            'The state record was left in place; re-run once the ledger can be written.',
          normalized
        )
    );
  }
}

/**
 * Delete the stack's create-token ledger, so the stack's next create mints a
 * fresh nonce. An absent ledger is fine; any other failure throws a
 * `StateError`, so the caller stops before letting resources go with the
 * ledger still naming their tokens.
 */
export async function deleteCreateTokenLedger(
  this: S3StateBackend,
  stackName: string,
  region: string
): Promise<void> {
  await this.ensureClientForBucket();
  try {
    await this.s3Client.send(
      new DeleteObjectCommand({
        Bucket: this.config.bucket,
        ...(await this.ownerParam()),
        Key: this.getCreateTokenLedgerKey(stackName, region),
      })
    );
  } catch (error) {
    if (isNoSuchKey(error) || (error as { name?: string }).name === 'NotFound') return;
    const normalized = normalizeAwsError(error, {
      bucket: this.config.bucket,
      operation: 'DeleteObject',
    });
    throw this.wrapS3Failure(
      normalized,
      (text) =>
        new StateError(
          `Failed to delete the create-token ledger for stack ${this.stackRef(stackName, region)}: ${withoutFinalPeriod(text)}. ` +
            'The state record was left in place; re-run once the ledger can be deleted.',
          normalized
        )
    );
  }
}

/**
 * The stack instance id for a stack's FIRST state write (state schema v13,
 * go-to-k/cdkd#5064). Call it only while the stack has no `state.json`,
 * under the stack lock: an ordinary deploy, whose record carries the id
 * (or none, as a legacy stack), never reaches here.
 *
 * A `stack-instance.json` sibling an earlier run wrote is READ BACK and its
 * id returned: a re-run after a crash must never mint a fresh one. Without
 * one a fresh `crypto.randomUUID()` is minted and, with `writeAhead`
 * (a deploy, before its first create), written with `If-None-Match: *`; a
 * lost race (412) reads the winner's back. `cdkd import` passes
 * `writeAhead: false`: it creates nothing, and its state save is its first
 * write. The first state save carrying the id deletes the sibling.
 *
 * Throws a `StateError` naming the stack (never the id) when the sibling
 * cannot be read or written, or holds a body this binary cannot read, so
 * the deploy stops before any create.
 *
 * INVARIANT: only a binary that also derives generated names from the id
 * may mint one. A record carrying an id says its resources were named with
 * it; an id minted beside the legacy `{stack}-{logicalId}` names would make
 * the next binary derive different names, and an IAM provider re-deriving
 * its name inside `update()` would replace the live resource.
 */
export async function stackInstanceIdForFirstWrite(
  this: S3StateBackend,
  stackName: string,
  region: string,
  options: { writeAhead: boolean }
): Promise<string> {
  const key = this.getStackInstanceKey(stackName, region);
  const read = async (): Promise<string | null> => this.readSiblingId(key, stackName, region);
  // The first read only: a lost race below reads the winner back afresh.
  const prefetched = this.siblingPrefetches.get(key);
  this.siblingPrefetches.delete(key);
  try {
    const existing = await (prefetched ?? read());
    if (existing !== null) {
      this.pendingStackInstanceSiblings.set(key, existing);
      this.logger.debug(
        safeMsg`Reusing the write-ahead stack instance id of ${displayStackName(stackName)}`
      );
      return existing;
    }
    const minted = randomUUID();
    if (!options.writeAhead) return minted;
    await this.ensureClientForBucket();
    const body = stackInstanceSiblingBody(minted);
    const put = async (): Promise<{ VersionId?: string | undefined }> =>
      this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          ...(await this.ownerParam()),
          Key: key,
          Body: body,
          ContentLength: Buffer.byteLength(body),
          ContentType: 'application/json',
          IfNoneMatch: '*',
        })
      );
    let written: { VersionId?: string | undefined } | undefined;
    try {
      try {
        written = await put();
      } catch (error) {
        // 409 ConditionalRequestConflict is a concurrent write in flight, not
        // "one exists": asked once more, it answers (as `ensureRetainedTombstone`).
        if (!isConditionalConflict(error)) throw error;
        written = await put();
      }
    } catch (error) {
      if (isNotImplemented(error)) {
        // An endpoint without conditional writes: the read above, under the
        // stack lock, stands in for the condition.
        await this.putRawObject(key, body);
        this.pendingStackInstanceSiblings.set(key, minted);
        return minted;
      }
      if (!isConditionFailure(error)) throw error;
      // Another writer got there first: its id is the stack's.
      const winner = await read();
      if (winner === null) throw error;
      this.pendingStackInstanceSiblings.set(key, winner);
      return winner;
    }
    this.pendingStackInstanceSiblings.set(key, minted);
    // The ONE version of the sibling, which this write created: the post-save
    // drop removes exactly it (go-to-k/cdkd#5200).
    const versionId = written?.VersionId;
    if (typeof versionId === 'string' && versionId !== '' && versionId !== 'null') {
      this.siblingVersionsWritten.set(key, versionId);
    }
    return minted;
  } catch (error) {
    if (error instanceof StateError) throw error;
    throw this.stackInstanceSiblingError(stackName, region, error, 'write');
  }
}

/**
 * The refusal for a sibling read (`read`) or a first write's read-or-write
 * (`write`) that failed in S3. The SDK's own text can carry the raw key, so
 * the stack is named through `stackRef`, and never the id.
 */
export function stackInstanceSiblingError(
  this: S3StateBackend,
  stackName: string,
  region: string,
  error: unknown,
  access: 'read' | 'write'
): StateError {
  const normalized = normalizeAwsError(error, { bucket: this.config.bucket });
  return this.wrapS3Failure(
    normalized,
    (text) =>
      new StateError(
        `Failed to ${access === 'write' ? 'read or write' : 'read'} the write-ahead stack instance id of stack ${this.stackRef(stackName, region)} ` +
          `(${STACK_INSTANCE_SIBLING_FILE} beside its state.json): ${withoutFinalPeriod(text)}. ` +
          (access === 'write'
            ? 'Nothing was created; re-run once the state bucket can be written.'
            : 'Nothing was changed; re-run once the state bucket can be read.'),
        normalized
      )
  );
}

/**
 * Start the read {@link stackInstanceIdForFirstWrite} opens with, so a
 * first deploy's read overlaps its diff instead of waiting for the approval
 * (go-to-k/cdkd#5200). The caller holds the stack lock, and only a lock
 * holder writes the sibling, so the answer is still current when the write
 * consults it. A failure is reported there, as an unprefetched read's is.
 */
export function prefetchStackInstanceSibling(
  this: S3StateBackend,
  stackName: string,
  region: string
): void {
  const key = this.getStackInstanceKey(stackName, region);
  if (this.siblingPrefetches.has(key)) return;
  const read = this.readSiblingId(key, stackName, region);
  read.catch(() => undefined);
  this.siblingPrefetches.set(key, read);
}

/** The id the sibling at `key` holds, `null` when absent; a body this binary cannot read throws. */
export async function readSiblingId(
  this: S3StateBackend,
  key: string,
  stackName: string,
  region: string
): Promise<string | null> {
  const body = await this.getRawObject(key);
  if (body === null) return null;
  const id = parseStackInstanceSibling(body);
  if (id === null) {
    throw new StateError(
      `The write-ahead stack instance id of stack ${this.stackRef(stackName, region)} ` +
        `(${STACK_INSTANCE_SIBLING_FILE} beside its state.json) is in a format this cdkd version ` +
        'cannot read; upgrade cdkd, or delete that object if it is damaged'
    );
  }
  return id;
}

/**
 * The id a stack's `stack-instance.json` sibling holds, READ ONLY: never
 * mints, never writes, never marks the sibling for the post-save delete.
 * For a caller that must RECOGNIZE a first deploy's generated names while
 * the stack has no `state.json` (the Cloud Control pending-request settle,
 * go-to-k/cdkd#5064); an ordinary deploy, whose record carries the id, never
 * calls it. `undefined` when there is no sibling. Throws a `StateError`
 * naming the stack (never the id) when it cannot be read or holds a body
 * this binary cannot read.
 */
export async function readStackInstanceSibling(
  this: S3StateBackend,
  stackName: string,
  region: string
): Promise<string | undefined> {
  try {
    return (
      (await this.readSiblingId(this.getStackInstanceKey(stackName, region), stackName, region)) ??
      undefined
    );
  } catch (error) {
    if (error instanceof StateError) throw error;
    throw this.stackInstanceSiblingError(stackName, region, error, 'read');
  }
}

/**
 * Delete the stack's `stack-instance.json`. An absent one is fine; any other
 * failure throws a `StateError`, so {@link deleteState} stops before the
 * record goes with the id still readable.
 */
export async function deleteStackInstanceSibling(
  this: S3StateBackend,
  stackName: string,
  region: string
): Promise<void> {
  await this.ensureClientForBucket();
  const key = this.getStackInstanceKey(stackName, region);
  this.pendingStackInstanceSiblings.delete(key);
  try {
    await this.s3Client.send(
      new DeleteObjectCommand({
        Bucket: this.config.bucket,
        ...(await this.ownerParam()),
        Key: key,
      })
    );
  } catch (error) {
    if (isNoSuchKey(error) || (error as { name?: string }).name === 'NotFound') return;
    const normalized = normalizeAwsError(error, {
      bucket: this.config.bucket,
      operation: 'DeleteObject',
    });
    throw this.wrapS3Failure(
      normalized,
      (text) =>
        new StateError(
          `Failed to delete the write-ahead stack instance id for stack ${this.stackRef(stackName, region)}: ${withoutFinalPeriod(text)}. ` +
            'The state record was left in place; re-run once that object can be deleted.',
          normalized
        )
    );
  }
}

/**
 * After the first state save carrying the id: delete the sibling and purge
 * its earlier versions. Best-effort and never throws: the record is
 * authoritative now, and a sibling that survives is read only while the
 * stack has no record, which {@link deleteState} (deleting it first) ends.
 */
export async function dropStackInstanceSiblingAfterSave(
  this: S3StateBackend,
  stackName: string,
  region: string
): Promise<void> {
  // go-to-k/cdkd#5200: a sibling this process wrote is deleted by the
  // version its write created, which removes it without writing a delete
  // marker. Its `If-None-Match: *` write succeeded, so nothing current sat
  // under it (at most an earlier lifetime's delete marker), and removing it
  // brings no older copy back. The purge below still runs, for versions an
  // earlier lifetime's purge left. Any doubt takes the general path.
  const key = this.getStackInstanceKey(stackName, region);
  const versionId = this.siblingVersionsWritten.get(key);
  this.siblingVersionsWritten.delete(key);
  let deleted = false;
  if (versionId !== undefined) {
    try {
      await this.ensureClientForBucket();
      await this.s3Client.send(
        new DeleteObjectCommand({
          Bucket: this.config.bucket,
          ...(await this.ownerParam()),
          Key: key,
          VersionId: versionId,
        })
      );
      deleted = true;
    } catch (error) {
      this.logger.debug(
        safeMsg`Could not delete the written version of the write-ahead stack instance id of ${displayStackName(stackName)}: ${describeAwsFailure(error).summary}`
      );
    }
  }
  if (!deleted) {
    try {
      await this.deleteStackInstanceSibling(stackName, region);
    } catch (error) {
      this.logger.debug(
        safeMsg`Could not delete the write-ahead stack instance id of ${displayStackName(stackName)}: ${describeAwsFailure(error).summary}`
      );
      return;
    }
  }
  await this.purgeNoncurrentVersions([this.getStackInstanceKey(stackName, region)], {
    objectDescription: STACK_INSTANCE_OBJECT_DESCRIPTION,
  });
}
