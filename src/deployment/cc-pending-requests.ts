/**
 * Resume the Cloud Control CREATEs an earlier run stopped waiting for
 * (go-to-k/cdkd#3252).
 *
 * When a Cloud Control status poll fails for longer than its grace (or the
 * wait outlives its budget) the CREATE may still finish in AWS, and no state
 * record holds what it makes. The deploy engine journals the request token on
 * the failed op (`FailedOperation.pendingCloudControlRequest`); `cdkd deploy`,
 * `cdkd destroy` and `cdkd rollback` call {@link resolvePendingCloudControlRequests}
 * under the stack lock, before they read the journal for anything else, and
 * settle each token:
 *
 *  - the create made its resource (SUCCESS, or a FAILED / cancelled one that
 *    left a remnant):
 *     - a deploy whose CREATE of the logical id sends the same properties
 *       TAKES IT OVER (`create.ts` `resumeAbandonedCreate`), but only when
 *       the identifier is UNIQUE ({@link ccIdentifierIsUnique}): a NAME may
 *       since have been freed and taken by another owner, and the SUCCESS
 *       event does not prove the resource now under it is that create's;
 *     - anything else becomes a PROVEN ORPHAN, the shape a provider-proven
 *       failed create journals, carrying `createdIdentifierUnique` when the
 *       identifier is unique. That flag is the proof a delete needs on the
 *       Cloud Control route (`orphanNeedsIdentity`): destroy, `rollback
 *       --revert-failed` and the next successful deploy delete a unique one
 *       and name any other in a warning;
 *  - it made nothing, or Cloud Control no longer has the request (requests
 *    expire after seven days, and a token is invisible from another account
 *    or region) — the token goes, the latter with a warning;
 *  - still unknown (still running after the poll budget, or unreadable) — the
 *    command is REFUSED. Proceeding would let a deploy re-create beside a
 *    create still in flight, or a destroy remove the journal, the only record
 *    of the request.
 *
 * Every identifier it prints is masked by the op's own properties, which can
 * hold a `{{resolve:...}}` reference that produced part of it.
 */

import type { FailedOperation } from './rollback-executor.js';
import type { RollbackJournal, RollbackJournalSegment } from '../types/rollback-journal.js';
import type { AbandonedRequestOutcome } from '../provisioning/cloud-control-provider.js';
import { logicalIdShown, resourceTypeShown } from '../provisioning/composite-id.js';
import { describeAwsFailure } from '../utils/aws-failure-text.js';
import { displaySafe, displayStackName, safeMsg } from '../utils/display-safe.js';
import { CdkdError } from '../utils/error-handler.js';
import { dropFailedCommands } from './rollback-executor/journaled-orphans.js';
import { displacedPhysicalIdShown } from './nested-child-journal.js';
import { carriesSecretMask } from './secret-redaction.js';
import { getPrimaryIdentifierFields } from '../provisioning/cc-import-identifier.js';
import { getTopLevelReadOnlyProperties } from '../provisioning/read-only-properties.js';
import { looksLikeCdkdGeneratedName } from '../provisioning/resource-name.js';
import type { Logger } from '../types/config.js';

/** The two Cloud Control provider methods the resolver needs. */
export interface AbandonedRequestReader {
  resumeAbandonedRequest(
    requestToken: string,
    logicalId: string,
    resourceType: string
  ): Promise<AbandonedRequestOutcome>;
  buildResumeCommand(requestToken: string): Promise<string>;
}

/** The journal access the resolver needs. */
export interface PendingRequestJournal {
  loadRollbackJournal(stackName: string, region: string): Promise<RollbackJournal | null>;
  rewriteRollbackJournalFailedOperations(
    stackName: string,
    region: string,
    rewrite: (op: FailedOperation, segment: RollbackJournalSegment) => FailedOperation | null
  ): Promise<number>;
}

type Settlement =
  | { kind: 'orphan'; physicalId: string; unique: boolean }
  | { kind: 'drop' }
  | { kind: 'keep' }
  | { kind: 'resume' };

type PendingOp = FailedOperation & { pendingCloudControlRequest: { requestToken: string } };

/** True when the op carries a journaled abandoned Cloud Control CREATE. */
export function hasPendingCloudControlRequest(op: FailedOperation): op is PendingOp {
  return op.pendingCloudControlRequest !== undefined;
}

/** How many abandoned Cloud Control CREATEs the journal still holds. */
export function pendingRequestCount(journal: RollbackJournal | null | undefined): number {
  return pendingRequests(journal ?? null).size;
}

/**
 * Re-poll every journaled abandoned Cloud Control CREATE of the stack and
 * settle it in the journal. Throws a {@link CdkdError} when any is still
 * unknown, after persisting what did settle. Returns whether the caller must
 * re-read the journal (it was rewritten, or re-read under the lock).
 *
 * `loaded` is the journal the caller already read, so a stack with nothing
 * pending costs no extra read (`null` when there is none or it could not be
 * read, which the caller's own read reports).
 */
export async function resolvePendingCloudControlRequests(params: {
  journal: PendingRequestJournal;
  loaded: RollbackJournal | null;
  /** Built only when a request is pending, so a stack with none constructs nothing. */
  reader: () => AbandonedRequestReader;
  stackName: string;
  region: string;
  /** The command being run, for the refusal: `deploy`, `destroy` or `rollback`. */
  command: string;
  logger: Logger;
  /**
   * The stack's state resources. A request whose resource state already
   * records under its logical id (a resumed deploy saved it, then failed
   * before the journal was cleared) is dropped, never turned into an orphan
   * of a resource state owns.
   */
  stateResources?: Readonly<Record<string, { physicalId?: unknown }>> | undefined;
  /**
   * Deploy only: offered each CREATE that completed. Answering `true` keeps
   * the request in the journal for the deploy to RESUME — its CREATE of the
   * logical id takes the resource instead of making another (create.ts) and
   * then drops the token. `false` turns it into a proven orphan.
   */
  resume?: (op: FailedOperation, identifier: string) => boolean;
  /** Test seam for {@link ccIdentifierIsUnique}. */
  identifierUnique?: IdentifierUniqueness;
  /**
   * Awaited before the first Cloud Control call, only when a request is
   * pending (a first deploy's state gate, which must refuse before anything
   * is written).
   */
  beforeSettle?: () => Promise<void>;
  /**
   * For a caller NOT already holding the stack lock (destroy reads the journal
   * before it locks): takes the lock around the settle, which then re-reads
   * the journal under it. Called only when a request is pending, so a stack
   * with none pays no lock.
   */
  underLock?: (settle: () => Promise<boolean>) => Promise<boolean>;
}): Promise<boolean> {
  const { journal, stackName, region } = params;
  if (pendingRequests(params.loaded).size === 0) return false;
  const settle = async (): Promise<boolean> => {
    await params.beforeSettle?.();
    let current = params.loaded;
    if (params.underLock) {
      try {
        current = await journal.loadRollbackJournal(stackName, region);
      } catch (error) {
        // Fail CLOSED: the read that started this run held a request, and a
        // caller that went on would sweep the journal holding its only record.
        throw new CdkdError(
          safeMsg`cdkd ${params.command} of ${displayStackName(stackName)} refused: its rollback ` +
            'journal recorded an unsettled Cloud Control CREATE when this run started and cannot ' +
            safeMsg`be read now (${displaySafe(describeAwsFailure(error).summary)}). Nothing was ` +
            'changed; re-run once it can be read.',
          'CC_PENDING_REQUEST_UNREADABLE'
        );
      }
    }
    const pending = pendingRequests(current);
    if (pending.size > 0) await settlePending(params, pending);
    // Under the lock the caller's read is stale whatever happened here.
    return params.underLock !== undefined || pending.size > 0;
  };
  return params.underLock ? params.underLock(settle) : settle();
}

/** The journal's pending requests by token. */
function pendingRequests(loaded: RollbackJournal | null): Map<string, PendingOp> {
  const pending = new Map<string, PendingOp>();
  for (const segment of loaded?.segments ?? []) {
    for (const op of segment.failedOperations ?? []) {
      if (hasPendingCloudControlRequest(op)) {
        pending.set(op.pendingCloudControlRequest.requestToken, op);
      }
    }
  }
  return pending;
}

async function settlePending(
  params: {
    journal: PendingRequestJournal;
    reader: () => AbandonedRequestReader;
    stackName: string;
    region: string;
    command: string;
    logger: Logger;
    stateResources?: Readonly<Record<string, { physicalId?: unknown }>> | undefined;
    resume?: (op: FailedOperation, identifier: string) => boolean;
    identifierUnique?: IdentifierUniqueness;
  },
  pending: Map<string, PendingOp>
): Promise<void> {
  const { journal, stackName, region, command, logger } = params;
  const reader = params.reader();
  const isUnique = params.identifierUnique ?? ccIdentifierIsUnique;
  const stackShown = displayStackName(stackName);
  const settlements = new Map<string, Settlement>();
  const unresolved: string[] = [];
  for (const [token, op] of pending) {
    const named = `${logicalIdShown(op.logicalId)} (${resourceTypeShown(op.resourceType)})`;
    logger.info(
      safeMsg`A previous run of ${stackShown} stopped waiting for the Cloud Control CREATE of ${named}; ` +
        'checking how it ended...'
    );
    const outcome = await reader.resumeAbandonedRequest(token, op.logicalId, op.resourceType);
    switch (outcome.status) {
      case 'succeeded':
      case 'failed':
      case 'cancelled': {
        const made = outcome.status === 'succeeded' ? outcome.identifier : outcome.remnant;
        if (made === undefined) {
          logger.info(
            safeMsg`The CREATE of ${named} ${outcome.status === 'cancelled' ? 'was cancelled' : 'failed'} ` +
              'in AWS and made nothing.'
          );
          settlements.set(token, { kind: 'drop' });
          break;
        }
        // Masked by the op's own properties: an identifier can carry a value
        // a `{{resolve:...}}` reference produced (go-to-k/cdkd#3869).
        const madeShown =
          displacedPhysicalIdShown({ ...op, physicalId: made }, logger, made) ?? 'a resource';
        const held = params.stateResources?.[op.logicalId];
        if (held !== undefined && held.physicalId === made) {
          logger.info(
            safeMsg`The CREATE of ${named} made ${madeShown}, which state already records.`
          );
          settlements.set(token, { kind: 'drop' });
          break;
        }
        const unique = await isUnique({
          resourceType: op.resourceType,
          identifier: made,
          attemptedProperties: op.attemptedProperties,
          logicalId: op.logicalId,
          stackName,
        });
        const ended =
          outcome.status === 'succeeded'
            ? 'completed'
            : outcome.status === 'cancelled'
              ? 'was cancelled'
              : 'failed';
        if (
          outcome.status === 'succeeded' &&
          unique &&
          held === undefined &&
          params.resume?.(op, made)
        ) {
          logger.info(
            safeMsg`The CREATE of ${named} completed in AWS after cdkd stopped waiting, and made ` +
              safeMsg`${madeShown}; this deploy's CREATE of it takes that resource over when it sends ` +
              'the same properties.'
          );
          settlements.set(token, { kind: 'resume' });
          break;
        }
        if (params.resume !== undefined && !unique) {
          // spec-S1: a deploy never takes over a NAME it cannot prove is still
          // that create's, and its own CREATE asks for that same name, so it
          // says what to do rather than leave the user to decode a collision.
          logger.warn(
            safeMsg`The CREATE of ${named} ${ended} in AWS after cdkd stopped waiting, and made ` +
              safeMsg`${madeShown}. cdkd cannot prove its id is unique (it may be a name, which can ` +
              safeMsg`since belong to another resource), so this deploy does not take it over, and creating ${logicalIdShown(op.logicalId)} ` +
              'again will ask for the name it holds. Adopt it with cdkd import (--resource ' +
              safeMsg`${logicalIdShown(op.logicalId)}=<its id>), or delete it, then re-run. It is kept in the ` +
              'rollback journal as a resource the failed deploy created.'
          );
        } else {
          logger.warn(
            safeMsg`The CREATE of ${named} ${ended} in AWS after cdkd stopped waiting, and made ` +
              safeMsg`${madeShown}. It is now recorded in the rollback journal as a resource the failed ` +
              'deploy created: cdkd destroy, cdkd rollback --revert-failed and the next successful deploy ' +
              'delete it as its DeletionPolicy directs when cdkd can prove it is still the resource that ' +
              'create made, and otherwise name it in a warning for you to delete by hand.'
          );
        }
        settlements.set(token, { kind: 'orphan', physicalId: made, unique });
        break;
      }
      case 'not-found':
        logger.warn(
          safeMsg`Cloud Control no longer has the CREATE request of ${named}: requests expire after ` +
            'seven days, and a request is not visible from another account or region. cdkd cannot ' +
            'tell whether it created the resource and stops tracking the request. If it exists, ' +
            'adopt it with cdkd import or delete it by hand.'
        );
        settlements.set(token, { kind: 'drop' });
        break;
      case 'unresolved': {
        settlements.set(token, { kind: 'keep' });
        // The failure text can name the resource (an abandoned wait's message
        // carries the last identifier), which a secret may have produced.
        const reason = holdsSecretReference(op.attemptedProperties)
          ? 'details withheld: its properties carry a secret'
          : displaySafe(describeAwsFailure(outcome.error).summary);
        unresolved.push(
          safeMsg`  - ${named}${reason === '' ? '' : ` (${reason})`}\n` +
            `    Check it with: ${await reader.buildResumeCommand(token)}`
        );
        break;
      }
    }
  }

  if ([...settlements.values()].some((s) => s.kind === 'orphan' || s.kind === 'drop')) {
    await journal.rewriteRollbackJournalFailedOperations(stackName, region, (op) => {
      if (!hasPendingCloudControlRequest(op)) return op;
      const settlement = settlements.get(op.pendingCloudControlRequest.requestToken);
      if (settlement?.kind === 'drop') return withoutPendingRequest(op);
      if (settlement?.kind !== 'orphan') return op;
      return {
        ...withoutPendingRequest(op),
        provisionedBy: 'cc-api',
        physicalId: settlement.physicalId,
        physicalIdRecoveredFromError: true,
        ...(settlement.unique && { createdIdentifierUnique: true }),
      };
    });
  }

  if (unresolved.length > 0) {
    const kept = [...pending.values()].filter(
      (op) => settlements.get(op.pendingCloudControlRequest.requestToken)?.kind === 'keep'
    );
    const drop = dropFailedCommands(
      stackName,
      region,
      kept.map((op) => op.logicalId)
    );
    const withheld = drop?.commands.some((c) => c.includes('<')) === true;
    throw new CdkdError(
      safeMsg`cdkd ${command} of ${stackShown} refused: a previous run stopped waiting for a Cloud ` +
        'Control CREATE, and cdkd still cannot tell whether it made its resource. Proceeding could ' +
        'leave that resource untracked. Nothing was changed.\n' +
        `${unresolved.join('\n')}\n` +
        'Re-run once the request has finished and can be read. If you have reconciled it by hand ' +
        '(cdkd import, or deleted the resource), drop its journal entry with:' +
        (drop === undefined ? '' : drop.commands.map((c) => `\n  ${c}`).join('')) +
        (withheld
          ? "\nA value that is not a plain identifier is shown as a <hole>; read it from the stack's " +
            'state record and rollback-journal.json.'
          : ''),
      'CC_PENDING_REQUEST_UNRESOLVED'
    );
  }
}

/** Whether a journaled bag carries a secret: a mask, or a kept reference. */
function holdsSecretReference(properties: unknown): boolean {
  if (properties === undefined) return false;
  return carriesSecretMask(properties) || JSON.stringify(properties).includes('{{resolve:');
}

/** Decides whether a Cloud Control identifier is unique (see {@link ccIdentifierIsUnique}). */
export type IdentifierUniqueness = (args: {
  resourceType: string;
  identifier: string;
  attemptedProperties: Record<string, unknown> | undefined;
  logicalId: string;
  stackName: string;
}) => Promise<boolean>;

/**
 * Whether a Cloud Control identifier is UNIQUE: no later resource can hold
 * it, so the resource under it is the one the CREATE made, or gone. True only
 * when a component of it (split on `|` into the type's `primaryIdentifier`
 * fields) is a field the type marks read-only — AWS minted it — and none of
 * that component's `:`/`/` segments is, case-insensitively, a value the
 * CREATE sent or the name cdkd generates. An ARN or URL a type mints from a
 * NAME (an SNS topic's `TopicArn`, an SQS `QueueUrl`) is read-only but not
 * unique: a resource re-created under the name gets it back. Anything the
 * schema cannot answer, or a bag carrying a secret (a name cdkd cannot compare
 * against), is NOT unique: the safe answer, which keeps a resource rather than
 * deleting or adopting it.
 */
export const ccIdentifierIsUnique: IdentifierUniqueness = async ({
  resourceType,
  identifier,
  attemptedProperties,
  logicalId,
  stackName,
}) => {
  // No bag: nothing to tell a name from an AWS-minted id by.
  if (attemptedProperties === undefined || holdsSecretReference(attemptedProperties)) return false;
  const [fields, readOnly] = await Promise.all([
    getPrimaryIdentifierFields(resourceType),
    getTopLevelReadOnlyProperties(resourceType),
  ]);
  if (fields === undefined || readOnly === undefined) return false;
  const parts = identifier.split('|');
  if (parts.length !== fields.length) return false;
  const sent = new Set<string>();
  const collect = (value: unknown): void => {
    if (typeof value === 'string' || typeof value === 'number') {
      // Whole and by segment: a sent name holding `/` or `:` is spread over
      // several identifier segments.
      for (const piece of nameSegments(String(value))) sent.add(piece);
    } else if (Array.isArray(value)) value.forEach(collect);
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(collect);
  };
  collect(attemptedProperties);
  return parts.some((part, i) => {
    if (part === '' || !readOnly.has(fields[i]!)) return false;
    return !nameSegments(part).some(
      (segment) => sent.has(segment) || looksLikeCdkdGeneratedName(segment, logicalId, stackName)
    );
  });
};

/**
 * A value's comparable pieces, lowercased: the whole value and its `:` / `/`
 * segments. For an ARN only its RESOURCE part counts: the `arn:<partition>:
 * <service>:<region>:<account>:` header is shared by every ARN in an account,
 * so a sent role ARN would otherwise make every minted ARN read as a name.
 */
function nameSegments(value: string): string[] {
  const text = value.toLowerCase();
  const arn = /^arn:[^:]*:[^:]*:[^:]*:[^:]*:(.*)$/.exec(text);
  const body = arn ? arn[1]! : text;
  return [text, body, ...body.split(/[:/]/)].filter((piece) => piece !== '');
}

/** The op without its request: a plain failed CREATE. */
export function withoutPendingRequest(op: FailedOperation): FailedOperation {
  const { pendingCloudControlRequest: _settled, ...rest } = op;
  return rest;
}
