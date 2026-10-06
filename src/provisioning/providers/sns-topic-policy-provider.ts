import { SetTopicAttributesCommand, GetTopicAttributesCommand } from '@aws-sdk/client-sns';
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
import { stateOrphanRecordRemedy } from '../state-orphan-remedy.js';
import { markNonRetryable } from '../../deployment/retryable-errors.js';
import { attemptedPolicyDocument, policyContentKey } from '../policy-document-content.js';

/**
 * The skip reasons of a failed create's delete (go-to-k/cdkd#4612): a failure
 * not known to be permanent, so the entry is kept and a re-run checks again.
 */
export const TOPIC_POLICY_UNREADABLE_SKIP_REASON =
  'the policy of a topic it wrote could not be read, so whether that topic still carries it is unknown';
export const TOPIC_POLICY_UNRESOLVED_DOCUMENT_SKIP_REASON =
  'the policy document it attempted could not be resolved right now to compare its topics with';

/**
 * What a failed create's delete reports (`leftInPlace`, go-to-k/cdkd#4612)
 * when it settles the entry without resetting every topic: one carries another
 * policy, or the attempted document is known never to be comparable.
 */
export const TOPIC_POLICY_MISMATCH_LEFT_REASON =
  'a topic it wrote carries a policy that does not match the document it attempted, so that topic was not reset';
export const TOPIC_POLICY_NOT_COMPARED_LEFT_REASON =
  'the document it attempted is missing, masked, or references a secret that does not exist or cannot be used, so none of its topics was reset';

/**
 * AWS SNS Topic Policy Provider
 *
 * Implements resource provisioning for AWS::SNS::TopicPolicy using the SNS SDK.
 * This is required because SNS TopicPolicy is not supported by Cloud Control API.
 *
 * SNS TopicPolicy applies a policy document to one or more SNS topics via
 * SetTopicAttributes with AttributeName='Policy'.
 */
export class SNSTopicPolicyProvider implements ResourceProvider {
  private logger = getLogger().child('SNSTopicPolicyProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    ['AWS::SNS::TopicPolicy', new Set(['Topics', 'PolicyDocument'])],
  ]);

  /**
   * Create an SNS topic policy
   *
   * Applies the PolicyDocument to each topic in the Topics array.
   * Physical ID is a comma-separated list of topic ARNs.
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating SNS topic policy ${logicalId}`);

    const topics = properties['Topics'] as string[] | undefined;
    const policyDocument = properties['PolicyDocument'];

    if (!topics || topics.length === 0) {
      throw new ProvisioningError(
        `Topics is required for SNS topic policy ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    if (!policyDocument) {
      throw new ProvisioningError(
        `PolicyDocument is required for SNS topic policy ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    const policyDoc =
      typeof policyDocument === 'string' ? policyDocument : JSON.stringify(policyDocument);

    // go-to-k/cdkd#4583: the topics whose policy this create already wrote.
    const applied: string[] = [];
    try {
      for (const topicArn of topics) {
        await this.setTopicPolicy(topicArn, policyDoc);
        applied.push(topicArn);
      }

      this.logger.debug(`Successfully created SNS topic policy ${logicalId}`);

      // Physical ID is the comma-separated list of topic ARNs
      const physicalId = topics.join(',');

      return {
        physicalId,
        attributes: {},
      };
    } catch (error) {
      const thrown = new ProvisioningError(
        `Failed to create SNS topic policy ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        error instanceof Error ? error : undefined
      );
      // go-to-k/cdkd#4583: name ONLY the topics already written, in the
      // comma-joined form delete() takes, so --revert-failed never clears the
      // policy of a topic this create did not reach.
      if (applied.length > 0) {
        markCreatedBeforeFailure(thrown, logicalId, resourceType, applied.join(','));
      }
      throw thrown;
    }
  }

  /**
   * Update an SNS topic policy
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating SNS topic policy ${logicalId}: ${physicalId}`);

    const topics = properties['Topics'] as string[] | undefined;
    const policyDocument = properties['PolicyDocument'];

    if (!topics || topics.length === 0) {
      throw new ProvisioningError(
        `Topics is required for SNS topic policy ${logicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    if (!policyDocument) {
      throw new ProvisioningError(
        `PolicyDocument is required for SNS topic policy ${logicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    const policyDoc =
      typeof policyDocument === 'string' ? policyDocument : JSON.stringify(policyDocument);

    // go-to-k/cdkd#4610: a topic the record wrote and the new list drops keeps
    // the old statement unless it is reset, as CloudFormation's update does.
    // The record's id is the comma-joined set it wrote, so those are reset by
    // name. Any other topic `previousProperties` lists — an ATTEMPTED list, as
    // a revert of a failed update passes — is reset only while it carries that
    // bag's document (see topicsCarryingDocument), read BEFORE the writes.
    const mask = context?.maskSecrets ?? ((t: string) => t);
    const written = splitTopicArns(physicalId);
    const listedOnly = await this.topicsCarryingDocument(
      listedTopics(previousProperties).filter(
        (arn) => !written.includes(arn) && !topics.includes(arn)
      ),
      previousProperties['PolicyDocument'],
      logicalId,
      mask
    );
    const dropped = written.filter((arn) => !topics.includes(arn));
    // A recorded segment that is not a topic ARN (the policy NAME an old
    // --migrate-from-cloudformation recorded) cannot be addressed. The topics
    // `previousProperties` lists were checked above in its place; only when
    // it lists none is a topic possibly left carrying the policy.
    const unaddressable = dropped.filter((arn) => !isSnsTopicArn(arn));
    if (unaddressable.length > 0) {
      const message = mask(
        safeMsg`The recorded id segment(s) ${unaddressable.join(', ')} of ${logicalId} are not topic ARNs; ` +
          (listedTopics(previousProperties).length > 0
            ? 'the topics its previous Topics listed were checked instead.'
            : 'its previous Topics lists no topic ARN either, so a topic it was attached to may still carry its policy.')
      );
      if (listedTopics(previousProperties).length > 0) this.logger.debug(message);
      else this.logger.warn(message);
    }
    const removed = [...dropped.filter((arn) => isSnsTopicArn(arn)), ...listedOnly];

    try {
      for (const topicArn of topics) {
        await this.setTopicPolicy(topicArn, policyDoc);
      }

      // Then reset the dropped ones, after the new set holds the policy.
      for (const topicArn of removed) {
        await this.resetTopicPolicy(
          topicArn,
          resourceType,
          logicalId,
          context?.expectedRegion,
          'not-found',
          mask
        );
      }

      this.logger.debug(`Successfully updated SNS topic policy ${logicalId}`);

      const newPhysicalId = topics.join(',');

      return {
        physicalId: newPhysicalId,
        wasReplaced: false,
        attributes: {},
      };
    } catch (error) {
      // The region refusal is already a complete ProvisioningError.
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update SNS topic policy ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Delete an SNS topic policy
   *
   * Resets each topic the physical id names (the comma-joined set create() /
   * update() wrote, or a failed create's mark of the topics it reached) to
   * the topic's default policy. SNS requires a policy on a topic (per
   * CloudFormation's own TopicPolicy handler, which writes that default on
   * delete; go-to-k/cdkd#4610), so an empty `Policy` cannot remove one.
   * An id with a segment that is not a topic ARN (the policy NAME an old
   * --migrate-from-cloudformation recorded) falls back to the literal topic
   * ARNs its `Topics` lists.
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void | ResourceDeleteResult> {
    this.logger.debug(`Deleting SNS topic policy ${logicalId}: ${physicalId}`);
    if (context?.failedCreateOrphan === true) {
      return this.deleteFailedCreateOrphan(
        logicalId,
        physicalId,
        resourceType,
        properties,
        context
      );
    }

    const named = splitTopicArns(physicalId);
    // An empty id records no write at all: refuse it rather than widen it to
    // the Topics list (returning normally would read as DELETED).
    if (named.length === 0) {
      throw markNonRetryable(
        new ProvisioningError(
          `Failed to delete SNS topic policy ${logicalId}: its physical id is empty, so cdkd changed no ` +
            `topic. Set each topic the policy is attached to back to its default policy by hand, then ` +
            `drop the record with ${stateOrphanRecordRemedy(context, logicalId)}.`,
          resourceType,
          logicalId,
          physicalId
        )
      );
    }
    // An id that names only topic ARNs is the written set: exactly those. A
    // failed create's mark is always that shape, so it never widens. Any
    // other id (a policy NAME) falls back to the literal topic ARNs its
    // Topics lists.
    const topicArns = named.every((arn) => isSnsTopicArn(arn))
      ? named
      : [
          ...new Set([
            ...named.filter((arn) => isSnsTopicArn(arn)),
            ...listedTopics(properties ?? {}),
          ]),
        ];
    // Refuse before any write when nothing is addressable: returning normally
    // reads as DELETED, and the policy may still be on its topics.
    if (topicArns.length === 0) {
      throw markNonRetryable(
        new ProvisioningError(
          `Failed to delete SNS topic policy ${logicalId}: its physical id names no SNS topic ARN and ` +
            `its Topics lists none either, so cdkd changed no topic. Set each topic the policy is ` +
            `attached to back to its default policy by hand, then drop the record with ` +
            `${stateOrphanRecordRemedy(context, logicalId)}.`,
          resourceType,
          logicalId,
          physicalId
        )
      );
    }

    for (const topicArn of topicArns) {
      try {
        await this.resetTopicPolicy(topicArn, resourceType, logicalId, context?.expectedRegion);
      } catch (error) {
        // The region refusal is already a complete ProvisioningError.
        if (error instanceof ProvisioningError) throw error;
        const cause = error instanceof Error ? error : undefined;
        throw new ProvisioningError(
          `Failed to delete SNS topic policy ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        );
      }
    }

    this.logger.debug(`Successfully deleted SNS topic policy ${logicalId}`);
  }

  /**
   * go-to-k/cdkd#4612: the delete of a proven failed create's journal entry,
   * whose physical id is exactly the topics it wrote (go-to-k/cdkd#4583).
   * SetTopicAttributes REPLACES a topic's policy, so each topic is reset to
   * its default only while its live policy equals, by content, the attempted
   * document: whoever wrote before this create was already replaced. A topic
   * already on its default policy, or gone, needs nothing. A topic carrying
   * anything else is left, named in a warning, and the result reports
   * `leftInPlace`; so is one a TopicPolicy of this very deploy wrote
   * (`writtenThisRun`), which is not read back while it may be stale. The
   * attempted bag is the journal's, secret references redacted, so it is
   * re-resolved first (`attemptedPolicyDocument`). The entry is kept
   * (`skipped`) unless a failure is KNOWN to be permanent: a missing or masked
   * document, or a secret that does not exist or whose reference cdkd refuses
   * settles the entry with every topic named and nothing reset
   * (`leftInPlace`). An unreadable topic policy, and any other resolution
   * failure (credentials, access, throttling), keeps it. Both documents are
   * compared in IAM-equivalent form (`policyContentKey`).
   *
   * Residual: a stale read of a DIFFERENT policy the topic held before the
   * create (the automatic rollback reads it about a second after the write)
   * reports a mismatch, leaving the failed document with a warning and exit 2.
   */
  private async deleteFailedCreateOrphan(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown> | undefined,
    context: DeleteContext
  ): Promise<void | ResourceDeleteResult> {
    const named = splitTopicArns(physicalId);
    if (named.length === 0) {
      throw markNonRetryable(
        new ProvisioningError(
          `Failed to delete SNS topic policy ${logicalId}: its physical id names no topic`,
          resourceType,
          logicalId,
          physicalId
        )
      );
    }
    const resolve = context.resolveAttemptedProperties;
    const attempted = await attemptedPolicyDocument(
      properties?.['PolicyDocument'],
      resolve && (async () => (await resolve())?.['PolicyDocument'])
    );
    if (attempted.kind === 'retry') {
      this.logger.warn(
        safeMsg`The policy document ${logicalId} attempted could not be resolved (${attempted.errorName}), so no topic it wrote is reset; the entry is kept for a re-run once that is fixed.`
      );
      return { outcome: 'skipped', reason: TOPIC_POLICY_UNRESOLVED_DOCUMENT_SKIP_REASON };
    }
    if (attempted.kind === 'unusable') {
      // Known never to compare: settle the entry, naming every topic for a
      // check by hand, rather than keep it forever.
      this.logger.warn(
        safeMsg`${logicalId} is not reset on any topic it wrote (${attempted.why}); check each by hand and reset its policy where it still grants what ${logicalId} declared: ${named.join(', ')}.`
      );
      return { outcome: 'deleted', leftInPlace: TOPIC_POLICY_NOT_COMPARED_LEFT_REASON };
    }
    const document = attempted.document;
    // IAM-equivalent spellings folded (a bare account id and its root ARN).
    const reference = policyContentKey(document);
    // A topic a TopicPolicy of this very deploy wrote: a read may still
    // return the failed create's document, so it is never read back here.
    const fresh = new Set(
      (context.writtenThisRun ?? []).flatMap((r) =>
        r.resourceType === resourceType && typeof r.physicalId === 'string'
          ? [
              ...splitTopicArns(r.physicalId),
              ...listedTopics(
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
    for (const topicArn of named) {
      if (fresh.has(topicArn)) {
        mismatched = true;
        this.logger.warn(
          safeMsg`Topic ${topicArn} was written by a TopicPolicy of this deploy, so it is not reset: its policy may not read back current yet; if it still grants what ${logicalId} declared, reset it manually.`
        );
        continue;
      }
      const current = await this.readPolicyForWidening(topicArn);
      if (current.kind === 'gone') {
        // A topic that is gone has no policy left, once the client is proven
        // to be in the recorded region (resetTopicPolicy's contract).
        const clientRegion = await getAwsClients().sns.config.region();
        assertRegionMatch(
          clientRegion,
          context.expectedRegion,
          resourceType,
          logicalId,
          topicArn,
          'not-found'
        );
        this.logger.debug(safeMsg`Topic ${topicArn} does not exist; nothing to reset`);
        continue;
      }
      if (current.kind === 'unreadable') {
        unreadable = true;
        this.logger.warn(
          safeMsg`Could not read the policy of topic ${topicArn} (${current.reason}), so it is not reset: it may still carry the policy of ${logicalId}.`
        );
        continue;
      }
      const live = current.kind === 'none' ? undefined : policyContentKey(current.policy);
      // No policy read back is reset too: right after the create wrote it
      // (the automatic rollback) a stale read can still show nothing, and the
      // reset writes only the default.
      if (live === undefined || live === reference) {
        try {
          await this.resetTopicPolicy(topicArn, resourceType, logicalId, context.expectedRegion);
        } catch (error) {
          if (error instanceof ProvisioningError) throw error;
          throw new ProvisioningError(
            `Failed to delete SNS topic policy ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
            resourceType,
            logicalId,
            physicalId,
            error instanceof Error ? error : undefined
          );
        }
        continue;
      }
      const defaultPolicy = defaultTopicPolicy(topicArn);
      if (defaultPolicy !== undefined && live === policyContentKey(defaultPolicy)) {
        this.logger.debug(safeMsg`Topic ${topicArn} already carries its default policy`);
        continue;
      }
      mismatched = true;
      this.logger.warn(
        safeMsg`Topic ${topicArn} carries a policy that does not match the document ${logicalId} attempted (a later write, or AWS stored it in another form), so it is not reset; if it still grants what ${logicalId} declared, reset it manually.`
      );
    }
    if (unreadable) return { outcome: 'skipped', reason: TOPIC_POLICY_UNREADABLE_SKIP_REASON };
    if (mismatched) return { outcome: 'deleted', leftInPlace: TOPIC_POLICY_MISMATCH_LEFT_REASON };
    return undefined;
  }

  /**
   * Remove this policy from one topic by writing the topic's default policy
   * ({@link defaultTopicPolicy}). A topic that is gone (`NotFound`) has no
   * policy left to remove, after the recorded-region check. Any other error
   * — `InvalidParameter` included — is thrown: it never proves the policy
   * is gone.
   */
  private async resetTopicPolicy(
    topicArn: string,
    resourceType: string,
    logicalId: string,
    expectedRegion: string | undefined,
    phase: RegionCheckPhase = 'not-found',
    mask: (text: string) => string = (t) => t
  ): Promise<void> {
    const defaultPolicy = defaultTopicPolicy(topicArn);
    if (defaultPolicy === undefined) {
      throw new ProvisioningError(
        `Cannot remove SNS topic policy ${logicalId} from ${topicArn}: not an SNS topic ARN`,
        resourceType,
        logicalId,
        topicArn
      );
    }
    try {
      await this.setTopicPolicy(topicArn, defaultPolicy);
      this.logger.debug(mask(safeMsg`Reset the policy of topic ${topicArn} to the default`));
    } catch (error) {
      const name = (error as { name?: string } | undefined)?.name;
      if (name === 'NotFoundException' || name === 'NotFound') {
        const clientRegion = await getAwsClients().sns.config.region();
        assertRegionMatch(clientRegion, expectedRegion, resourceType, logicalId, topicArn, phase);
        this.logger.debug(mask(safeMsg`Topic ${topicArn} not found, skipping policy removal`));
        return;
      }
      throw error;
    }
  }

  /**
   * The `candidates` (topics a bag lists that the record's id does not name)
   * still carrying `document`, compared by content (canonical JSON). Such a
   * list is an ATTEMPTED one (a revert of a failed update), whose entries
   * hold `document` only where the attempt wrote it. Only the bag's own
   * document is a reference, never a topic's live policy, so a topic another
   * writer holds is left alone. A topic that is gone, carries another
   * policy, or cannot be read is left alone, an unchecked one with a
   * warning naming it.
   */
  private async topicsCarryingDocument(
    candidates: readonly string[],
    document: unknown,
    logicalId: string,
    mask: (text: string) => string
  ): Promise<string[]> {
    if (candidates.length === 0) return [];
    let reference: string | undefined;
    if (typeof document === 'string' && document.length > 0) reference = canonicalPolicy(document);
    else if (document !== null && typeof document === 'object') reference = canonicalJson(document);
    if (reference === undefined) {
      this.logger.warn(
        mask(
          safeMsg`The topics ${candidates.join(', ')} listed by ${logicalId} were not checked (no policy document recorded to compare with) and may still carry its policy.`
        )
      );
      return [];
    }

    const carrying: string[] = [];
    for (const topicArn of candidates) {
      const current = await this.readPolicyForWidening(topicArn);
      if (current.kind === 'policy' && canonicalPolicy(current.policy) === reference) {
        carrying.push(topicArn);
      } else if (current.kind === 'unreadable') {
        this.logger.warn(
          mask(
            safeMsg`Could not read the policy of topic ${topicArn} (${current.reason}), so it is not reset: it may still carry the policy of ${logicalId}.`
          )
        );
      } else {
        this.logger.debug(
          mask(safeMsg`Topic ${topicArn} does not carry the policy of ${logicalId}; left as is`)
        );
      }
    }
    return carrying;
  }

  /** A topic's `Policy` for {@link topicsCarryingDocument}: held, empty, gone, or unreadable. */
  private async readPolicyForWidening(
    topicArn: string
  ): Promise<
    | { kind: 'policy'; policy: string }
    | { kind: 'none' }
    | { kind: 'gone' }
    | { kind: 'unreadable'; reason: string }
  > {
    try {
      const resp = await getAwsClients().sns.send(
        new GetTopicAttributesCommand({ TopicArn: topicArn })
      );
      const policy = resp.Attributes?.['Policy'];
      return policy ? { kind: 'policy', policy } : { kind: 'none' };
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === 'NotFoundException' || name === 'NotFound') return { kind: 'gone' };
      return { kind: 'unreadable', reason: name ?? 'error' };
    }
  }

  /**
   * Read the AWS-current SNS topic policy in CFn-property shape.
   *
   * The provider's `create()` builds `physicalId` as a comma-joined list
   * of topic ARNs. We:
   *   1. Split the physical id back into the list of topic ARNs and surface
   *      them as `Topics` (matching `create()` shape).
   *   2. Fetch `GetTopicAttributes` on the FIRST topic to retrieve the
   *      `Policy` attribute and surface it as `PolicyDocument` (JSON-parsed
   *      to match the object form cdkd state holds).
   *
   * Single-topic fetch is intentional: cdkd applies the same policy to
   * every topic in `Topics`, so the body is the same on each. A future
   * enhancement could verify per-topic that the policy actually matches
   * (catches manual divergence between multiple targets), but the bulk of
   * drift cases involve a single topic and the body content is what users
   * actually care about.
   *
   * Returns `undefined` when no topics are listed in the physical id, and
   * `RESOURCE_NOT_FOUND` when the first listed topic is gone
   * (`NotFoundException`).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    const topics = physicalId.split(',').filter((t) => t.length > 0);
    if (topics.length === 0) return undefined;

    const firstTopic = topics[0]!;
    let policyAttr: string | undefined;
    try {
      const resp = await getAwsClients().sns.send(
        new GetTopicAttributesCommand({ TopicArn: firstTopic })
      );
      policyAttr = resp.Attributes?.['Policy'];
    } catch (err) {
      const e = err as { name?: string; message?: string };
      // The error NAME only (go-to-k/cdkd#4283): message text proves nothing.
      if (e.name === 'NotFoundException' || e.name === 'NotFound') {
        return RESOURCE_NOT_FOUND;
      }
      throw err;
    }

    const result: Record<string, unknown> = {
      Topics: topics,
    };
    if (policyAttr) {
      try {
        result['PolicyDocument'] = JSON.parse(policyAttr) as unknown;
      } catch {
        result['PolicyDocument'] = policyAttr;
      }
    }
    return result;
  }

  /**
   * Adopt an existing SNS topic policy into cdkd state.
   *
   * The operational identifier for a `TopicPolicy` is the **comma-joined
   * list of SNS topic ARNs** the policy is attached to — every AWS SDK
   * call (`SetTopicAttributes` / `GetTopicAttributes`) takes a topic ARN
   * via the `TopicArn` parameter, and cdkd's `create()` records
   * `topics.join(',')` as the resource's `physicalId` so subsequent
   * `update()` / `delete()` / `readCurrentState()` calls hit the right
   * topic(s). A `TopicPolicy` has no standalone identity, no taggable
   * ARN, and no `aws:cdk:path` lookup — only the parent topics are
   * taggable.
   *
   * Resolution order (closes [#356](https://github.com/go-to-k/cdkd/issues/356)):
   *
   * 1. **`knownPhysicalId` if it is a comma-joined list of SNS topic ARNs.**
   *    Preserves the `cdkd import --resource <logicalId>=<topic-arns>`
   *    path that has always worked.
   * 2. **`properties.Topics.join(',')` if every entry is a literal topic
   *    ARN.** Closes the `--migrate-from-cloudformation` case: AWS
   *    CloudFormation's `DescribeStackResources` returns the CFn-generated
   *    policy NAME for `AWS::SNS::TopicPolicy` (e.g.
   *    `MyStack-MyTopicPolicy-XXXXXXXXXX`), which is NOT a valid topic
   *    ARN. The first time cdkd touches the imported state with that
   *    name, `readCurrentState` → `GetTopicAttributes` rejects it.
   * 3. **Hard error** when neither path resolves a topic-ARN list. This
   *    covers (a) `--migrate-from-cloudformation` against a CFn stack
   *    whose template carries `Topics: [{Ref: <MyTopic>}]` (the typical
   *    CDK shape) when the referenced topic is NOT in the importable
   *    set (or hasn't been imported yet in the current run), and (b)
   *    explicit `--resource <logicalId>=<non-arn>` typos. Pointing the
   *    user at `--resource <logicalId>=<topic-arns>` is the recovery
   *    path that always works.
   *
   * Intrinsic-valued `Topics` entries (e.g. `{Ref: <MyTopic>}`) fall into
   * branch 3 here even when the referenced sibling has been imported in
   * the same run — `import()` is called BEFORE
   * `resolveImportedProperties` runs the synth template's Properties
   * through the intrinsic resolver, so the raw intrinsic object is what
   * we see. The recovery message names `--resource` as the explicit
   * escape hatch.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- explicit-override-only intentionally has no AWS calls
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    // 1. knownPhysicalId is a comma-joined list of SNS topic ARNs — use
    //    it as-is (existing `--resource <logicalId>=<topic-arns>` path).
    if (input.knownPhysicalId && isSnsTopicArnList(input.knownPhysicalId)) {
      return { physicalId: input.knownPhysicalId, attributes: {} };
    }

    // 2. Properties.Topics is an array of literal topic ARNs — join and
    //    use (`--migrate-from-cloudformation` happy path when the template
    //    carries literal Topics entries, plus the no-knownPhysicalId
    //    auto path when properties is the only signal).
    const topics = input.properties['Topics'];
    if (Array.isArray(topics) && topics.length > 0) {
      const allLiteralArns = topics.every((t) => typeof t === 'string' && isSnsTopicArn(t));
      if (allLiteralArns) {
        return { physicalId: (topics as string[]).join(','), attributes: {} };
      }
    }

    // 3. No topic-ARN list recoverable — hard error rather than null.
    //    Returning null would silently mark the resource as
    //    `skipped-not-found` in the import summary and bake the unusable
    //    CFn-generated name into cdkd state for any caller passing
    //    `knownPhysicalId`. Naming the explicit override is the
    //    load-bearing recovery hint.
    //
    //    This line carries a `--resource` remedy, so the logical id, the
    //    supplied id and the template's Topics value are each shown only when
    //    plain and described otherwise, and the fragment holes a logical id
    //    that is not plain (go-to-k/cdkd#4226): printed raw or inside cdkd's
    //    own quotes, a `;`, `$( )` or `'` in one of them ran when the line was
    //    pasted.
    const knownNote = input.knownPhysicalId
      ? ` Got knownPhysicalId=${isPlainImportValue(input.knownPhysicalId) ? `'${input.knownPhysicalId}'` : VALUE_NOT_SHOWN} (not a comma-joined list of SNS topic ARNs; CloudFormation returns the policy resource NAME for AWS::SNS::TopicPolicy, which is not the operational identifier).`
      : '';
    const topicsNote =
      Array.isArray(topics) && topics.length > 0
        ? ` Properties.Topics${isPlainImportJson(topics) ? `=${JSON.stringify(topics)}` : ` ${VALUE_NOT_SHOWN}`} did not resolve to a list of literal topic ARNs (intrinsic-valued entries like {Ref: '<Topic>'} are not resolved at import time).`
        : ' Properties.Topics is missing or empty.';
    throw new Error(
      `Cannot determine topic ARNs for ${refusalTypeShown(input.resourceType)} ${logicalIdShown(input.logicalId)}.${knownNote}${topicsNote} ` +
        `Re-run with --resource ${remedyLogicalId(input.logicalId)}=${commandHole('comma-joined-topic-ARNs')} ` +
        `(e.g. arn:aws:sns:${isPasteableIdent(input.region) ? input.region : commandHole('region')}:'<account>':'<topic-name>') to point cdkd at the topic(s) this policy is attached to.`
    );
  }

  /**
   * Set the policy on a single SNS topic
   */
  private async setTopicPolicy(topicArn: string, policyDoc: string): Promise<void> {
    const snsClient = getAwsClients().sns;
    await snsClient.send(
      new SetTopicAttributesCommand({
        TopicArn: topicArn,
        AttributeName: 'Policy',
        AttributeValue: policyDoc,
      })
    );
  }
}

/**
 * Recognize a single SNS topic ARN. AWS standard form is
 * `arn:<partition>:sns:<region>:<account>:<name>`; FIFO topics end in
 * `.fifo`. Accepts every partition (`aws` / `aws-cn` / `aws-us-gov` /
 * `aws-iso` / etc.) via the broader `arn:<partition>:sns:` prefix shape.
 */
function isSnsTopicArn(value: string): boolean {
  return /^arn:[a-z0-9-]+:sns:[a-z0-9-]+:\d{12}:[\w.-]+$/.test(value);
}

/**
 * Recognize a comma-joined list of SNS topic ARNs. cdkd's `create()`
 * records `topics.join(',')` as the `physicalId`, so a single ARN
 * (`arn:aws:sns:us-east-1:123456789012:my-topic`) is also accepted.
 * Every comma-separated segment must be a valid SNS topic ARN — a CFn
 * generated name like `MyStack-MyTopicPolicy-XXX` is correctly rejected
 * because it does not match the ARN prefix, and a partially-valid
 * mixture (one literal ARN + one CFn name) is also rejected so we fall
 * back to the properties-based resolution rather than baking a half-bad
 * list into state.
 */
function isSnsTopicArnList(value: string): boolean {
  const segments = value.split(',');
  if (segments.length === 0) return false;
  return segments.every((s) => isSnsTopicArn(s));
}

/** The topic ARNs a physical id names. */
function splitTopicArns(physicalId: string): string[] {
  return physicalId.split(',').filter((arn) => arn.length > 0);
}

/** A bag's `Topics` entries that are single literal topic ARNs, deduplicated. */
function listedTopics(bag: Record<string, unknown>): string[] {
  const listed = bag['Topics'];
  if (!Array.isArray(listed)) return [];
  const out: string[] = [];
  for (const entry of listed) {
    if (typeof entry === 'string' && isSnsTopicArn(entry) && !out.includes(entry)) {
      out.push(entry);
    }
  }
  return out;
}

/**
 * The policy SNS gives a new topic, which CloudFormation's TopicPolicy
 * delete and update handlers write to remove a policy (SNS rejects an empty
 * one): the topic owner's account may manage, subscribe to and publish to it.
 * The account and the `Resource` come from the topic ARN; `undefined` when
 * `topicArn` is not one.
 */
export function defaultTopicPolicy(topicArn: string): string | undefined {
  if (!isSnsTopicArn(topicArn)) return undefined;
  const account = topicArn.split(':')[4]!;
  return JSON.stringify({
    Version: '2008-10-17',
    Id: '__default_policy_ID',
    Statement: [
      {
        Sid: '__default_statement_ID',
        Effect: 'Allow',
        Principal: { AWS: '*' },
        Action: [
          'SNS:GetTopicAttributes',
          'SNS:SetTopicAttributes',
          'SNS:AddPermission',
          'SNS:RemovePermission',
          'SNS:DeleteTopic',
          'SNS:Subscribe',
          'SNS:ListSubscriptionsByTopic',
          'SNS:Publish',
        ],
        Resource: topicArn,
        Condition: { StringEquals: { 'AWS:SourceOwner': account } },
      },
    ],
  });
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
  return JSON.stringify(sortKeys(value));
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
