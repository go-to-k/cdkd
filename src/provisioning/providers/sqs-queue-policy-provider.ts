import {
  SQSClient,
  SetQueueAttributesCommand,
  GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext, type RegionCheckPhase } from '../region-check.js';
import { logicalIdShown } from '../composite-id.js';
import { isPasteableIdent, safeMsg } from '../../utils/display-safe.js';
import {
  isPlainImportValue,
  refusalTypeShown,
  isPlainImportJson,
  remedyLogicalId,
  VALUE_NOT_SHOWN,
} from '../import-helpers.js';
import { commandHole } from '../../utils/pasteable-command.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceDeleteResult,
  ResourceImportInput,
  ResourceImportResult,
  ResourceNotFound,
  UpdateContext,
} from '../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../types/resource.js';
import { markCreatedBeforeFailure } from '../auxiliary-failure.js';
import { attemptedPolicyDocument, policyContentKey } from '../policy-document-content.js';

/**
 * The skip reasons of a failed create's delete (go-to-k/cdkd#4612): a failure
 * not known to be permanent, so the entry is kept and a re-run checks again.
 */
export const QUEUE_POLICY_UNREADABLE_SKIP_REASON =
  'the policy of a queue it wrote could not be read, so whether that queue still carries it is unknown';
export const QUEUE_POLICY_UNRESOLVED_DOCUMENT_SKIP_REASON =
  'the policy document it attempted could not be resolved right now to compare its queues with';

/**
 * What a failed create's delete reports (`leftInPlace`, go-to-k/cdkd#4612)
 * when it settles the entry without clearing every queue: one carries another
 * policy, or the attempted document is known never to be comparable.
 */
export const QUEUE_POLICY_MISMATCH_LEFT_REASON =
  'a queue it wrote carries a policy that does not match the document it attempted, so that queue was not cleared';
export const QUEUE_POLICY_NOT_COMPARED_LEFT_REASON =
  'the document it attempted is missing, masked, or references a secret that does not exist or cannot be used, so none of its queues was cleared';

/**
 * AWS SQS Queue Policy Provider
 *
 * Implements resource provisioning for AWS::SQS::QueuePolicy using the SQS SDK.
 * This is required because SQS Queue Policy is not supported by Cloud Control API.
 */
export class SQSQueuePolicyProvider implements ResourceProvider {
  private sqsClient: SQSClient;
  private logger = getLogger().child('SQSQueuePolicyProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    ['AWS::SQS::QueuePolicy', new Set(['Queues', 'PolicyDocument'])],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.sqsClient = awsClients.sqs;
  }

  /**
   * Create an SQS queue policy
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating SQS queue policy ${logicalId}`);

    const queues = properties['Queues'] as string[] | undefined;
    const policyDocument = properties['PolicyDocument'];

    if (!queues || queues.length === 0) {
      throw new ProvisioningError(
        `Queues is required for SQS queue policy ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    if (!policyDocument) {
      throw new ProvisioningError(
        `PolicyDocument is required for SQS queue policy ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    // go-to-k/cdkd#4583: the queue URLs whose SetQueueAttributes returned —
    // exactly the queues this create wrote its policy onto.
    const applied: string[] = [];
    try {
      // Serialize policy document
      const policyDoc =
        typeof policyDocument === 'string' ? policyDocument : JSON.stringify(policyDocument);

      // Apply policy to all queues
      for (const queueUrl of queues) {
        this.logger.debug(`Setting policy for queue: ${queueUrl}`);
        await this.sqsClient.send(
          new SetQueueAttributesCommand({
            QueueUrl: queueUrl,
            Attributes: {
              Policy: policyDoc,
            },
          })
        );
        applied.push(queueUrl);
      }

      this.logger.debug(`Successfully created SQS queue policy ${logicalId}`);

      // Physical id: the first queue URL, stable across an update that keeps
      // it (go-to-k/cdkd#4594: rollback reads a changed id as a replacement).
      // The written set rides in an attribute delete() / update() read.
      return {
        physicalId: queues[0]!,
        attributes: { [WRITTEN_QUEUES_KEY]: queues.join(',') },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      const thrown = new ProvisioningError(
        `Failed to create SQS queue policy ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        queues[0],
        cause
      );
      // go-to-k/cdkd#4583: name exactly the written queues, comma-joined (a
      // form delete() takes), so --revert-failed clears no queue this create
      // never wrote. Queue URLs carry no comma (queue names: [A-Za-z0-9_-]).
      if (applied.length > 0) {
        markCreatedBeforeFailure(thrown, logicalId, resourceType, applied.join(','));
      }
      throw thrown;
    }
  }

  /**
   * Update an SQS queue policy
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating SQS queue policy ${logicalId}: ${physicalId}`);

    const queues = properties['Queues'] as string[] | undefined;
    const policyDocument = properties['PolicyDocument'];

    if (!queues || queues.length === 0) {
      throw new ProvisioningError(
        `Queues is required for SQS queue policy ${logicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    if (!policyDocument) {
      throw new ProvisioningError(
        `PolicyDocument is required for SQS queue policy ${logicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    // go-to-k/cdkd#4594: a queue the record wrote and the new list drops keeps
    // the old statement unless it is cleared, as CloudFormation does. The
    // record's written set (its attribute; for a record without one, its id)
    // is cleared by name; any other queue `previousProperties` lists only
    // while it carries that bag's document (see queuesCarryingDocument), read
    // BEFORE the writes below.
    const written = recordedQueues(physicalId, context?.recordedAttributes);
    const listedOnly = await this.queuesCarryingDocument(
      listedQueues(previousProperties).filter(
        (url) => !written.includes(url) && !queues.includes(url)
      ),
      previousProperties['PolicyDocument'],
      logicalId
    );
    const removed = [...written.filter((url) => !queues.includes(url)), ...listedOnly];

    try {
      // Serialize policy document
      const policyDoc =
        typeof policyDocument === 'string' ? policyDocument : JSON.stringify(policyDocument);

      // Apply policy to all queues
      for (const queueUrl of queues) {
        this.logger.debug(`Updating policy for queue: ${queueUrl}`);
        await this.sqsClient.send(
          new SetQueueAttributesCommand({
            QueueUrl: queueUrl,
            Attributes: {
              Policy: policyDoc,
            },
          })
        );
      }

      // Then clear the dropped ones, after the new set holds the policy.
      for (const queueUrl of removed) {
        await this.clearQueuePolicy(
          queueUrl,
          resourceType,
          logicalId,
          context?.expectedRegion,
          'pre-update'
        );
      }

      this.logger.debug(`Successfully updated SQS queue policy ${logicalId}`);

      return {
        physicalId: queues[0]!,
        wasReplaced: false,
        attributes: { [WRITTEN_QUEUES_KEY]: queues.join(',') },
      };
    } catch (error) {
      // The region refusal is already a complete ProvisioningError.
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update SQS queue policy ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Delete an SQS queue policy
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void | ResourceDeleteResult> {
    this.logger.debug(`Deleting SQS queue policy ${logicalId}: ${physicalId}`);
    if (context?.failedCreateOrphan === true) {
      return this.deleteFailedCreateOrphan(
        logicalId,
        physicalId,
        resourceType,
        properties,
        context
      );
    }

    // The queues to clear by name: a failed create's journaled id
    // (go-to-k/cdkd#4583) is the comma-joined URLs it wrote, exactly (the
    // rollback's delete of such an entry takes the content check above,
    // go-to-k/cdkd#4612); a
    // record's are its written-set attribute (go-to-k/cdkd#4594) plus its id.
    // A record without the attribute (written before #4594, or imported) or a
    // one-queue mark also has `Queues` entries it may or may not have written
    // — a failed create's revert passes the ATTEMPTED list — so those are
    // cleared only while they carry the bag's document. They go first: a
    // retry after a partial run still finds them by content.
    const named = physicalId.includes(',')
      ? splitQueueUrls(physicalId)
      : recordedQueues(physicalId, context?.recordedAttributes);
    const listedOnly = physicalId.includes(',')
      ? []
      : await this.queuesCarryingDocument(
          listedQueues(properties ?? {}).filter((url) => !named.includes(url)),
          properties?.['PolicyDocument'],
          logicalId
        );
    const queueUrls = [...listedOnly, ...named];
    // An id naming no queue must not return normally: that reads as DELETED.
    if (queueUrls.length === 0) {
      throw new ProvisioningError(
        `Failed to delete SQS queue policy ${logicalId}: its physical id names no queue URL`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    for (const queueUrl of queueUrls) {
      try {
        await this.clearQueuePolicy(queueUrl, resourceType, logicalId, context?.expectedRegion);
      } catch (error) {
        // The region refusal is already a complete ProvisioningError.
        if (error instanceof ProvisioningError) throw error;
        const cause = error instanceof Error ? error : undefined;
        throw new ProvisioningError(
          `Failed to delete SQS queue policy ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        );
      }
    }

    this.logger.debug(`Successfully deleted SQS queue policy ${logicalId}`);
  }

  /**
   * go-to-k/cdkd#4612: the delete of a proven failed create's journal entry,
   * whose physical id is exactly the queues it wrote (go-to-k/cdkd#4583).
   * SetQueueAttributes REPLACES a queue's policy, so each queue is cleared only
   * while its live policy equals, by content, the attempted document: whoever
   * wrote before this create was already replaced. A queue carrying anything
   * else is left, named in a warning, and the result reports `leftInPlace`.
   * The comparison is per queue, so how any holder's id is spelled never
   * matters. The attempted bag is the journal's, secret references redacted,
   * so it is re-resolved first (`attemptedPolicyDocument`). The entry is kept
   * (`skipped`) unless a failure is KNOWN to be permanent: a missing or masked
   * document, or a secret that does not exist or whose reference cdkd refuses
   * settles the entry with every queue named and nothing cleared
   * (`leftInPlace`). An unreadable queue policy, and any other resolution
   * failure (credentials, access, throttling), keeps it. Both documents are
   * compared in IAM-equivalent form (`policyContentKey`).
   *
   * Residual: a stale read of a DIFFERENT policy the queue held before the
   * create (the automatic rollback reads it about a second after the write)
   * reports a mismatch, leaving the failed document on that queue with a
   * warning and exit 2.
   */
  private async deleteFailedCreateOrphan(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown> | undefined,
    context: DeleteContext
  ): Promise<void | ResourceDeleteResult> {
    const named = splitQueueUrls(physicalId);
    if (named.length === 0) {
      throw new ProvisioningError(
        `Failed to delete SQS queue policy ${logicalId}: its physical id names no queue URL`,
        resourceType,
        logicalId,
        physicalId
      );
    }
    const resolve = context.resolveAttemptedProperties;
    const attempted = await attemptedPolicyDocument(
      properties?.['PolicyDocument'],
      resolve && (async () => (await resolve())?.['PolicyDocument'])
    );
    if (attempted.kind === 'retry') {
      this.logger.warn(
        safeMsg`The policy document ${logicalId} attempted could not be resolved (${attempted.errorName}), so no queue it wrote is cleared; the entry is kept for a re-run once that is fixed.`
      );
      return { outcome: 'skipped', reason: QUEUE_POLICY_UNRESOLVED_DOCUMENT_SKIP_REASON };
    }
    if (attempted.kind === 'unusable') {
      // Known never to compare: settle the entry, naming every queue for a
      // check by hand, rather than keep it forever.
      this.logger.warn(
        safeMsg`${logicalId} is not cleared from any queue it wrote (${attempted.why}); check each by hand and remove its policy where it still grants what ${logicalId} declared: ${named.join(', ')}.`
      );
      return { outcome: 'deleted', leftInPlace: QUEUE_POLICY_NOT_COMPARED_LEFT_REASON };
    }
    // IAM-equivalent spellings folded: SQS stores a bare account-id principal
    // as its root ARN, for one.
    const reference = policyContentKey(attempted.document);
    // A queue a QueuePolicy of this very deploy wrote: a read may still return
    // the failed create's document (SQS propagates in up to 60 seconds), so it
    // is never read back here.
    const fresh = new Set(
      (context.writtenThisRun ?? []).flatMap((r) =>
        r.resourceType === resourceType && typeof r.physicalId === 'string'
          ? [
              ...recordedQueues(
                r.physicalId,
                r.attributes !== null && typeof r.attributes === 'object'
                  ? (r.attributes as Record<string, unknown>)
                  : undefined
              ),
              ...listedQueues(
                r.properties !== null && typeof r.properties === 'object'
                  ? (r.properties as Record<string, unknown>)
                  : {}
              ),
            ]
          : []
      )
    );
    let unreadable = false;
    let mismatched = false;
    for (const queueUrl of named) {
      if (fresh.has(queueUrl)) {
        mismatched = true;
        this.logger.warn(
          safeMsg`Queue ${queueUrl} was written by a QueuePolicy of this deploy, so it is not cleared: its policy may not read back current yet; if it still grants what ${logicalId} declared, remove it manually.`
        );
        continue;
      }
      const current = await this.readPolicyForWidening(queueUrl);
      if (current.kind === 'gone') {
        // A queue that is gone has no policy left, once the client is proven
        // to be in the recorded region (clearQueuePolicy's contract).
        const clientRegion = await this.sqsClient.config.region();
        assertRegionMatch(
          clientRegion,
          context.expectedRegion,
          resourceType,
          logicalId,
          queueUrl,
          'not-found'
        );
        this.logger.debug(safeMsg`Queue ${queueUrl} does not exist; nothing to clear`);
      } else if (current.kind === 'unreadable') {
        unreadable = true;
        this.logger.warn(
          safeMsg`Could not read the policy of queue ${queueUrl} (${current.reason}), so it is not cleared: it may still carry the policy of ${logicalId}.`
        );
      } else if (current.kind === 'none' || policyContentKey(current.policy) === reference) {
        // No policy read back is cleared too: right after the create wrote
        // it (the automatic rollback) a stale read can still show the empty
        // policy from before, and clearing an empty queue changes nothing.
        try {
          await this.clearQueuePolicy(queueUrl, resourceType, logicalId, context.expectedRegion);
        } catch (error) {
          if (error instanceof ProvisioningError) throw error;
          throw new ProvisioningError(
            `Failed to delete SQS queue policy ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
            resourceType,
            logicalId,
            physicalId,
            error instanceof Error ? error : undefined
          );
        }
      } else {
        mismatched = true;
        this.logger.warn(
          safeMsg`Queue ${queueUrl} carries a policy that does not match the document ${logicalId} attempted (a later write, or AWS stored it in another form), so it is not cleared; if it still grants what ${logicalId} declared, remove it manually.`
        );
      }
    }
    if (unreadable) return { outcome: 'skipped', reason: QUEUE_POLICY_UNREADABLE_SKIP_REASON };
    if (mismatched) return { outcome: 'deleted', leftInPlace: QUEUE_POLICY_MISMATCH_LEFT_REASON };
    return undefined;
  }

  /**
   * Remove the policy from one queue by setting it to empty. A queue that is
   * gone has no policy left to remove (after the recorded-region check).
   */
  private async clearQueuePolicy(
    queueUrl: string,
    resourceType: string,
    logicalId: string,
    expectedRegion: string | undefined,
    phase: RegionCheckPhase = 'not-found'
  ): Promise<void> {
    try {
      await this.sqsClient.send(
        new SetQueueAttributesCommand({
          QueueUrl: queueUrl,
          Attributes: {
            Policy: '',
          },
        })
      );
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === 'QueueDoesNotExist' || error.message.includes('does not exist'))
      ) {
        const clientRegion = await this.sqsClient.config.region();
        assertRegionMatch(clientRegion, expectedRegion, resourceType, logicalId, queueUrl, phase);
        this.logger.debug(`Queue ${queueUrl} does not exist, skipping policy deletion`);
        return;
      }
      throw error;
    }
  }

  /**
   * The `candidates` (queues a bag lists that no record names as written)
   * still carrying `document`, compared by content (canonical JSON). Such a
   * list is a record written before go-to-k/cdkd#4594 — its create wrote
   * every entry — or an ATTEMPTED list (a failed create's revert, or
   * `--revert-failed` of a failed update), whose entries hold `document` only
   * where the attempt wrote it. Only the bag's own document is a reference,
   * never a queue's live policy, so a queue another writer holds is left
   * alone. Residual: another writer's byte-identical document on a shared
   * queue matches too (go-to-k/cdkd#4612). A queue that is gone, carries
   * another or no policy, or cannot be read is left alone, an unchecked one
   * with a warning naming it.
   */
  private async queuesCarryingDocument(
    candidates: readonly string[],
    document: unknown,
    logicalId: string
  ): Promise<string[]> {
    const carrying: string[] = [];
    if (candidates.length === 0) return carrying;
    const reference = policyReference(document);
    if (reference === undefined) {
      this.logger.warn(
        safeMsg`The queues ${candidates.join(', ')} listed by ${logicalId} were not checked (no policy document recorded to compare with) and may still carry its policy.`
      );
      return carrying;
    }

    for (const queueUrl of candidates) {
      const current = await this.readPolicyForWidening(queueUrl);
      if (current.kind === 'policy' && canonicalPolicy(current.policy) === reference) {
        carrying.push(queueUrl);
      } else if (current.kind === 'unreadable') {
        this.logger.warn(
          safeMsg`Could not read the policy of queue ${queueUrl} (${current.reason}), so it is not cleared: it may still carry the policy of ${logicalId}.`
        );
      } else {
        this.logger.debug(
          safeMsg`Queue ${queueUrl} does not carry the policy of ${logicalId}; left as is`
        );
      }
    }
    return carrying;
  }

  /** A queue's `Policy` for {@link queuesCarryingDocument}: held, empty, gone, or unreadable. */
  private async readPolicyForWidening(
    queueUrl: string
  ): Promise<
    | { kind: 'policy'; policy: string }
    | { kind: 'none' }
    | { kind: 'gone' }
    | { kind: 'unreadable'; reason: string }
  > {
    try {
      const resp = await this.sqsClient.send(
        new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['Policy'] })
      );
      const policy = resp.Attributes?.['Policy'];
      return policy ? { kind: 'policy', policy } : { kind: 'none' };
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === 'QueueDoesNotExist' || name === 'AWS.SimpleQueueService.NonExistentQueue') {
        return { kind: 'gone' };
      }
      return { kind: 'unreadable', reason: name ?? 'error' };
    }
  }

  /**
   * Read the AWS-current SQS queue policy in CFn-property shape.
   *
   * The physical id is the first queue URL (a failed create's journaled id,
   * go-to-k/cdkd#4583, the comma-joined URLs it wrote). Each URL it names is
   * read with `GetQueueAttributes` (the readback receives no recorded
   * attributes, so the other queues of a multi-queue policy are not read):
   *   - `Queues` — the named queues that still carry a policy, in id order.
   *   - `PolicyDocument` — the first such queue's `Policy`, JSON-parsed back
   *     to the object form cdkd state holds. An out-of-band edit to another
   *     queue's policy is not surfaced.
   *
   * Returns `RESOURCE_NOT_FOUND` when no named queue carries a policy (each
   * is gone — `QueueDoesNotExist` — or its `Policy` attribute is absent or
   * empty, which is what deleting the QueuePolicy leaves).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    const queueUrls = splitQueueUrls(physicalId);
    if (queueUrls.length === 0) return undefined;

    const held: string[] = [];
    let firstPolicy: string | undefined;
    for (const queueUrl of queueUrls) {
      let policyAttr: string | undefined;
      try {
        const resp = await this.sqsClient.send(
          new GetQueueAttributesCommand({
            QueueUrl: queueUrl,
            AttributeNames: ['Policy'],
          })
        );
        policyAttr = resp.Attributes?.['Policy'];
      } catch (err) {
        const e = err as { name?: string; message?: string };
        // The error NAME only: SQS's cross-account denial also reads "does not
        // exist or you do not have access to it" (go-to-k/cdkd#4283). The NAME
        // carries the same ambiguity: SQS answers `QueueDoesNotExist` for a
        // queue URL in an account the caller cannot see, so a cross-account
        // policy read by the wrong principal also reads as deleted. cdkd
        // records same-account queue URLs, where the name is unambiguous.
        if (
          e.name === 'QueueDoesNotExist' ||
          e.name === 'AWS.SimpleQueueService.NonExistentQueue'
        ) {
          continue;
        }
        throw err;
      }
      // go-to-k/cdkd#4283: an empty Policy attribute is what deleting the QueuePolicy leaves.
      if (!policyAttr) continue;
      held.push(queueUrl);
      firstPolicy ??= policyAttr;
    }
    if (firstPolicy === undefined) return RESOURCE_NOT_FOUND;

    const result: Record<string, unknown> = {
      Queues: held,
    };
    try {
      result['PolicyDocument'] = JSON.parse(firstPolicy) as unknown;
    } catch {
      result['PolicyDocument'] = firstPolicy;
    }
    return result;
  }

  /**
   * Adopt an existing SQS queue policy into cdkd state.
   *
   * The operational identifier for a `QueuePolicy` is the **queue URL**
   * (`https://sqs.<region>.amazonaws.com/<account>/<name>`) — every AWS
   * SDK call (`SetQueueAttributes` / `GetQueueAttributes`) takes a queue
   * URL via the `QueueUrl` parameter, and cdkd's `create()` records the
   * first `Queues` entry as the resource's `physicalId` so subsequent
   * `update()` / `delete()` / `readCurrentState()` calls hit the right
   * queue. A `QueuePolicy` has no standalone identity, no taggable ARN,
   * and no `aws:cdk:path` lookup — only the parent queue is taggable.
   *
   * Resolution order (closes [#351](https://github.com/go-to-k/cdkd/issues/351)):
   *
   * 1. **`knownPhysicalId` if it is a valid queue URL.** Preserves the
   *    `cdkd import --resource <logicalId>=<queueUrl>` path that has
   *    always worked.
   * 2. **First entry of `properties.Queues` if it is a literal queue URL.**
   *    Closes the `--migrate-from-cloudformation` case: AWS CloudFormation's
   *    `DescribeStackResources` returns the CFn-generated policy NAME for
   *    `AWS::SQS::QueuePolicy` (e.g. `MyStack-MyQueuePolicy-XXXXXXXXXX`),
   *    which is NOT a valid `QueueUrl` and crashes the AWS SDK
   *    `queueUrlMiddleware` with `TypeError: Invalid URL` the first time
   *    cdkd touches it (typically `captureObservedForImportedResources` →
   *    `readCurrentState` → `GetQueueAttributes`). The user can also
   *    point `--migrate-from-cloudformation` at a stack whose QueuePolicy
   *    is templated as `Queues: ['https://sqs...']` (rare but valid) —
   *    that literal form falls into this branch.
   * 3. **Hard error** when neither path resolves a queue URL. This
   *    covers (a) `--migrate-from-cloudformation` against a CFn stack
   *    whose template carries `Queues: [{Ref: <MyQueue>}]` (the typical
   *    CDK shape) when the referenced queue is NOT in the importable
   *    set (or hasn't been imported yet in the current run), and (b)
   *    explicit `--resource <logicalId>=<non-url>` typos. Pointing the
   *    user at `--resource <logicalId>=<queueUrl>` is the recovery path
   *    that always works.
   *
   * Intrinsic-valued `Queues[0]` (e.g. `{Ref: <MyQueue>}`) falls into
   * branch 3 here even when the referenced sibling has been imported in
   * the same run — `import()` is called BEFORE
   * `resolveImportedProperties` runs the synth template's Properties
   * through the intrinsic resolver, so the raw intrinsic object is what
   * we see. The recovery message names `--resource` as the explicit
   * escape hatch.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- explicit-override-only intentionally has no AWS calls
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    // 1. knownPhysicalId is a valid queue URL — use it as-is (existing
    //    `--resource <logicalId>=<queueUrl>` path).
    if (input.knownPhysicalId && isSqsQueueUrl(input.knownPhysicalId)) {
      return { physicalId: input.knownPhysicalId, attributes: {} };
    }

    // 2. Properties.Queues[0] is a literal queue URL — use it
    //    (`--migrate-from-cloudformation` happy path when the template
    //    carries a literal Queues entry, plus the no-knownPhysicalId
    //    auto path when properties is the only signal).
    const queues = input.properties['Queues'];
    if (Array.isArray(queues) && queues.length > 0) {
      const first = queues[0];
      if (typeof first === 'string' && isSqsQueueUrl(first)) {
        return { physicalId: first, attributes: {} };
      }
    }

    // 3. No queue URL recoverable — hard error rather than null. Returning
    //    null would silently mark the resource as `skipped-not-found` in
    //    the import summary and bake the unusable CFn-generated name into
    //    cdkd state for any caller passing `knownPhysicalId`. Naming the
    //    explicit override is the load-bearing recovery hint.
    //
    //    This line carries a `--resource` remedy, so the logical id, the
    //    supplied id and the template's Queues value are each shown only when
    //    plain and described otherwise, and the fragment holes a logical id
    //    that is not plain (go-to-k/cdkd#4226): printed raw or inside cdkd's
    //    own quotes, a `;`, `$( )` or `'` in one of them ran when the line was
    //    pasted.
    const knownNote = input.knownPhysicalId
      ? ` Got knownPhysicalId=${isPlainImportValue(input.knownPhysicalId) ? `'${input.knownPhysicalId}'` : VALUE_NOT_SHOWN} (not a queue URL; CloudFormation returns the policy resource NAME for AWS::SQS::QueuePolicy, which is not the operational identifier).`
      : '';
    const queuesNote =
      Array.isArray(queues) && queues.length > 0
        ? ` Properties.Queues[0]${isPlainImportJson(queues[0]) ? `=${JSON.stringify(queues[0])}` : ` ${VALUE_NOT_SHOWN}`} did not resolve to a literal queue URL (intrinsic-valued entries like {Ref: '<Queue>'} are not resolved at import time).`
        : ' Properties.Queues is missing or empty.';
    throw new Error(
      `Cannot determine queue URL for ${refusalTypeShown(input.resourceType)} ${logicalIdShown(input.logicalId)}.${knownNote}${queuesNote} ` +
        `Re-run with --resource ${remedyLogicalId(input.logicalId)}=${commandHole('queueUrl')} ` +
        `(e.g. https://sqs.${isPasteableIdent(input.region) ? input.region : commandHole('region')}.amazonaws.com/'<account>'/'<queue-name>') to point cdkd at the queue this policy is attached to.`
    );
  }
}

/**
 * Recognize an SQS queue URL. AWS standard form is
 * `https://sqs.<region>.amazonaws.com/<account>/<name>`; FIFO queues end
 * in `.fifo`. Non-standard partitions (`amazonaws.com.cn` /
 * `c2s.ic.gov` / etc.) are accepted via the broader prefix check.
 */
function isSqsQueueUrl(value: string): boolean {
  return value.startsWith('https://sqs.') && value.includes('/');
}

/**
 * The attribute key under which cdkd records every queue URL a create or
 * update wrote, comma-joined (go-to-k/cdkd#4594). Not a CloudFormation
 * attribute: no template can `Fn::GetAtt` it, and no CloudFormation name
 * contains `:`.
 */
export const WRITTEN_QUEUES_KEY = 'cdkd:WrittenQueues';

/**
 * The queues a record names as written: its id plus its written-set
 * attribute's URLs. An attribute that is absent, or any of whose entries is
 * not a queue URL (state redaction can rewrite a secret-derived segment),
 * contributes nothing, so only the id is named.
 */
function recordedQueues(
  physicalId: string,
  attributes: Readonly<Record<string, unknown>> | undefined
): string[] {
  const named = splitQueueUrls(physicalId);
  const value = attributes?.[WRITTEN_QUEUES_KEY];
  if (typeof value !== 'string') return named;
  const recorded = splitQueueUrls(value);
  if (recorded.length === 0 || !recorded.every(isListedQueueUrl)) return named;
  for (const url of recorded) if (!named.includes(url)) named.push(url);
  return named;
}

/** A bag's string `Queues` entries that are single queue URLs, deduplicated. */
function listedQueues(bag: Record<string, unknown>): string[] {
  const listed = bag['Queues'];
  if (!Array.isArray(listed)) return [];
  const out: string[] = [];
  for (const entry of listed) {
    if (typeof entry === 'string' && isListedQueueUrl(entry) && !out.includes(entry)) {
      out.push(entry);
    }
  }
  return out;
}

function isListedQueueUrl(value: string): boolean {
  return isSqsQueueUrl(value) && !value.includes(',') && !value.includes('*');
}

/** A JSON value with object keys sorted at every depth, serialized; array order kept. */
function canonicalJson(value: unknown): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v !== null && typeof v === 'object') {
      // Null prototype: a `__proto__` member stays an own key and is compared.
      const out = Object.create(null) as Record<string, unknown>;
      for (const key of Object.keys(v).sort()) {
        out[key] = sortKeys((v as Record<string, unknown>)[key]);
      }
      return out;
    }
    return v;
  };
  const sorted = sortKeys(value);
  return JSON.stringify(sorted);
}

/**
 * A policy string's content key: its canonical JSON, or — when it does not
 * parse — the raw text under a prefix no canonical form can produce, so
 * unparseable text matches only itself.
 */
function canonicalPolicy(text: string): string {
  try {
    return canonicalJson(JSON.parse(text) as unknown);
  } catch {
    return `raw:${text}`;
  }
}

/** A policy document's content key, or `undefined` when there is none to compare. */
function policyReference(document: unknown): string | undefined {
  if (typeof document === 'string' && document.length > 0) return canonicalPolicy(document);
  if (document !== null && typeof document === 'object') return canonicalJson(document);
  return undefined;
}

/** The queue URLs a physical id names. */
function splitQueueUrls(physicalId: string): string[] {
  return physicalId.split(',').filter((url) => url.length > 0);
}
