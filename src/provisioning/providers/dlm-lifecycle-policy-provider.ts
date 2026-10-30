import {
  DLMClient,
  CreateLifecyclePolicyCommand,
  UpdateLifecyclePolicyCommand,
  DeleteLifecyclePolicyCommand,
  GetLifecyclePolicyCommand,
  GetLifecyclePoliciesCommand,
  TagResourceCommand,
  UntagResourceCommand,
  ResourceNotFoundException,
  type CreateLifecyclePolicyCommandInput,
  type CreateLifecyclePolicyCommandOutput,
  type UpdateLifecyclePolicyCommandInput,
  type PolicyDetails,
  type CrossRegionCopyTarget,
  type Exclusions,
} from '@aws-sdk/client-dlm';
import { getLogger } from '../../utils/logger.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { ProvisioningError, ResourceUpdateNotSupportedError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { markNotGone } from '../not-gone.js';
import { normalizeAwsTagsToCfn } from '../import-helpers.js';
import { planTagDiff, tagPlanWarning, refuseMalformedDesiredTags } from '../tag-list.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  UpdateContext,
  ResourceImportInput,
  ResourceImportResult,
  ResourceNotFound,
  CreateContext,
} from '../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../types/resource.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import {
  createMaskedLogSinks,
  maskerOrIdentity,
  type MaskedLogSinks,
  type MaskerFn,
} from '../masked-retry-logger.js';
import {
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../deployment/retryable-errors.js';
import { pasteableAwsCommand } from '../replacement-protection-advice.js';
import {
  AmbiguousCreateLatch,
  RecentIdSet,
  isInsideWindow,
  replayedSendWindow,
  withoutServerErrorRetries,
  type AmbiguousCreateWindow,
} from './ambiguous-create.js';
import { orphanCommandRegionArg, reportPossibleOrphans } from './orphan-report.js';
import { removedTemplateKeys } from '../update-removal.js';
import { safeMsg } from '../../utils/display-safe.js';

/**
 * Issue #5546: the properties `UpdateLifecyclePolicy` is not sent once the
 * template drops them, and which the policy therefore keeps. CloudFormation
 * keeps each one too: a CFn A/B in us-east-1 (2026-10-30) removed
 * `Description` alone and again beside a `State` + `RetainRule` change, then
 * `State` + `ExecutionRoleArn` together, then `PolicyDetails`; every update
 * was `UPDATE_COMPLETE`, CloudTrail's `UpdateLifecyclePolicy` request carried
 * no member for the removed property, and `GetLifecyclePolicy` still showed
 * the old value for three to four minutes after. #5004's A/B measured the
 * other six the same way. So cdkd sends no reset ('' is rejected for
 * `Description` anyway) and names what it kept.
 */
const KEPT_ON_REMOVAL = [
  'Description',
  'ExecutionRoleArn',
  'State',
  'PolicyDetails',
  'CreateInterval',
  'RetainInterval',
  'CopyTags',
  'ExtendDeletion',
  'CrossRegionCopyTargets',
  'Exclusions',
] as const;

/**
 * The ONE warning line for {@link KEPT_ON_REMOVAL} removals. Names are
 * template-borne, so they go through `safeMsg`. A rollback revert restores an
 * earlier state record, so there the property is one the failed deploy ADDED.
 */
const keptOnRemovalWarning = (
  logicalId: string,
  names: readonly string[],
  caller: 'deploy' | 'rollback'
): string => {
  const one = names.length === 1;
  const subject = one ? 'property' : 'properties';
  return caller === 'rollback'
    ? safeMsg`${logicalId} (AWS::DLM::LifecyclePolicy): ${subject} ${names.join(', ')} ${one ? 'is' : 'are'} absent from the state being restored; UpdateLifecyclePolicy keeps a field it is not sent, so the rollback leaves the value the failed deploy applied in place.`
    : safeMsg`${logicalId} (AWS::DLM::LifecyclePolicy): ${subject} ${names.join(', ')} ${one ? 'was' : 'were'} removed from the template and ${one ? 'keeps its' : 'keep their'} current AWS value, as CloudFormation leaves ${one ? 'it' : 'them'}; UpdateLifecyclePolicy keeps a field it is not sent. Declare the intended value explicitly to change it.`;
};

/**
 * Issue #2080: `CreateLifecyclePolicy` carries no idempotency token and the
 * policy id is minted by DLM, so a 5xx whose request had succeeded leaves a
 * second, unrecorded policy -- which keeps snapshotting (and deleting
 * snapshots) on its schedule. Armed by an ambiguous create failure; the next
 * attempt reports candidates before creating again.
 */
const createLifecyclePolicyLatch = new AmbiguousCreateLatch('dlm:CreateLifecyclePolicy');
/** Policy ids this process created, never reported as orphan candidates. */
const policiesCreatedByThisProcess = new RecentIdSet();

/** Reset the module-scoped retry-safety state. TEST-ONLY. */
export function resetLifecyclePolicyCreateRetryStateForTests(): void {
  createLifecyclePolicyLatch.resetForTests();
  policiesCreatedByThisProcess.resetForTests();
}

/**
 * SDK Provider for AWS::DLM::LifecyclePolicy (Data Lifecycle Manager).
 *
 * Why an SDK provider (issue #1040): the type is
 * `ProvisioningType: NON_PROVISIONABLE`, so cdkd's Cloud Control fallback
 * cannot handle it and pre-flight rejected it. The DLM API surface is small
 * and the CFn property shape maps 1:1 onto the SDK's PascalCase inputs; the
 * only conversion is the CFn `Tags` list <-> DLM tag-map.
 *
 * physicalId is the service-generated policy id (`policy-0123456789abcdef0`)
 * — matches CFn, where `Ref` returns the policy id (`Id` is the
 * primaryIdentifier). `Fn::GetAtt Arn` returns the policy ARN.
 *
 * API mapping:
 *   - create      -> CreateLifecyclePolicy (+ GetLifecyclePolicy for the Arn
 *                    attribute — the create response only carries PolicyId)
 *   - update      -> UpdateLifecyclePolicy for policy fields, plus explicit
 *                    TagResource / UntagResource for tag diffs (the update
 *                    API has no Tags parameter). Tag removal — including a
 *                    FULL `Tags` property removal — is handled explicitly
 *                    via UntagResource (the #981 ECR regression class).
 *   - delete      -> DeleteLifecyclePolicy (NotFound idempotent, guarded by
 *                    assertRegionMatch)
 *   - getAttribute-> GetLifecyclePolicy (`Arn` from Policy.PolicyArn)
 *
 * `DefaultPolicy` is create-only at the API level (UpdateLifecyclePolicy has
 * no such parameter; CFn documents it as "Update requires: Replacement"), so
 * a change is rejected with `ResourceUpdateNotSupportedError` and the deploy
 * engine's `--replace` fallback recreates the policy.
 */
export class DLMLifecyclePolicyProvider implements ResourceProvider {
  private client: DLMClient | undefined;
  private createClient: DLMClient | undefined;
  private readonly providerRegion = ambientRegion();
  private logger = getLogger().child('DLMLifecyclePolicyProvider');

  /**
   * The failure wrap the create / update / delete / getAttribute catches throw.
   *
   * An AWS-authored failure reaches `build` as its CLASS plus the `--verbose`
   * pointer (go-to-k/cdkd#2319): a thrown message is persisted to
   * `deployments/{runId}.jsonl`, and an `AccessDeniedException` names the
   * caller's assumed-role ARN. AWS's own text goes to `debug` through the
   * operation's `maskSecrets` (`mask`), and the wrap is stamped
   * `markRedactedCause`, so the retry classifiers read the withheld text on the
   * `cause` chain. An "already exists" is restated ({@link relayedNameCollision}).
   * A cdkd-authored or transport error keeps its text, masked, stamped only
   * when the mask changed it (`wrapMaskedAwsError`, issue #4244); a non-`Error`
   * throw is withheld like an AWS one, unstamped (it has no chain). The delete
   * checks `ResourceNotFoundException` by type before it wraps.
   *
   * `build` must thread `error` as `cause`, and runs twice, so it must stay a
   * side-effect-free constructor call.
   */
  private wrapCaughtError(
    mask: MaskerFn | undefined,
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

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::DLM::LifecyclePolicy',
      new Set<string>([
        'Description',
        'ExecutionRoleArn',
        'State',
        'PolicyDetails',
        'Tags',
        'DefaultPolicy',
        'CreateInterval',
        'RetainInterval',
        'CopyTags',
        'ExtendDeletion',
        'CrossRegionCopyTargets',
        'Exclusions',
      ]),
    ],
  ]);

  /**
   * Issue #1160 (`ResourceProvider.removalHandledInUpdate`): every handled
   * property, each removal handled by `update()`, so the shared caller warns
   * about none. `Tags` is diffed (UntagResource), a `DefaultPolicy` change is
   * refused toward `--replace`, and each {@link KEPT_ON_REMOVAL} property is
   * kept, as CloudFormation keeps it, and named in `update()`'s own warning.
   */
  removalHandledInUpdate = new Map<string, ReadonlySet<string>>([
    ['AWS::DLM::LifecyclePolicy', new Set<string>([...KEPT_ON_REMOVAL, 'Tags', 'DefaultPolicy'])],
  ]);

  private getClient(): DLMClient {
    if (!this.client) {
      this.client = new DLMClient({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      });
    }
    return this.client;
  }

  /**
   * The client `CreateLifecyclePolicy` goes through: SDK retries on, except a
   * 5xx (`withoutServerErrorRetries`, issue #2080). Separate so every other
   * call keeps the full SDK retry.
   */
  private getCreateClient(): DLMClient {
    if (!this.createClient) {
      this.createClient = withoutServerErrorRetries(
        new DLMClient({
          ...ambientClientDefaults(),
          ...(this.providerRegion ? { region: this.providerRegion } : {}),
        })
      );
    }
    return this.createClient;
  }

  /**
   * Issue #2080: after an attempt at `CreateLifecyclePolicy` ended AMBIGUOUS
   * (a 5xx: DLM may have made the policy and lost the answer), name the
   * policies that could be its orphan -- the same description and the same
   * default-or-custom kind, created inside the failed attempts' window
   * (`GetLifecyclePolicy`'s `DateCreated`; the list summary carries no date),
   * and not recorded by this process. Detection only: a description is not
   * attribution, and another deploy can create a policy with the same one in
   * the window, so the report leads with a read command and offers the delete
   * command only after confirming (`orphan-report.ts`).
   *
   * `GetLifecyclePolicies` takes no page token: one call returns every policy
   * in the region (a per-region quota bounds the count).
   */
  private async reportPossibleOrphanPolicies(
    logicalId: string,
    input: CreateLifecyclePolicyCommandInput,
    window: AmbiguousCreateWindow,
    log: MaskedLogSinks
  ): Promise<void> {
    const description = input.Description ?? '';
    const isDefault = input.DefaultPolicy != null;
    const kind = isDefault ? 'a default lifecycle policy' : 'a lifecycle policy';
    const aws = pasteableAwsCommand(log.mask);
    const regionArg = await orphanCommandRegionArg(this.getClient(), aws);
    await reportPossibleOrphans(logicalId, window, log, {
      action: 'CreateLifecyclePolicy',
      service: 'DLM',
      listAction: 'GetLifecyclePolicies',
      subject:
        description === ''
          ? `${kind} with no description`
          : `${kind} described ${log.value(description)}`,
      noun: 'lifecycle policy(ies)',
      list: async () => {
        const page = await this.getClient().send(new GetLifecyclePoliciesCommand({}));
        const ids: string[] = [];
        for (const summary of page.Policies ?? []) {
          const id = summary.PolicyId;
          if (
            !id ||
            (summary.Description ?? '') !== description ||
            (summary.DefaultPolicy === true) !== isDefault ||
            policiesCreatedByThisProcess.has(id)
          ) {
            continue;
          }
          let created: Date | undefined;
          let defaultType: string | undefined;
          try {
            const detail = await this.getClient().send(
              new GetLifecyclePolicyCommand({ PolicyId: id })
            );
            created = detail.Policy?.DateCreated;
            defaultType = detail.Policy?.PolicyDetails?.ResourceType;
          } catch (error) {
            // Deleted since the listing: not an orphan any more.
            if (error instanceof ResourceNotFoundException) continue;
            throw error;
          }
          // A default policy exists once per resource type (VOLUME /
          // INSTANCE): one of the other type is not this create's.
          if (isDefault && defaultType !== undefined && defaultType !== input.DefaultPolicy) {
            continue;
          }
          if (isInsideWindow(created, window)) ids.push(id);
        }
        return { ids, truncated: false };
      },
      inspect: (id) => aws`aws dlm get-lifecycle-policy --policy-id ${id}${regionArg}`.render(),
      remove: (id) => aws`aws dlm delete-lifecycle-policy --policy-id ${id}${regionArg}`.render(),
    });
  }

  /**
   * Map the CFn property shape to the SDK input shape (shared by create and
   * update — every field name is PascalCase-identical). `Tags` and
   * `DefaultPolicy` are intentionally NOT included: create wires them
   * separately (update has neither parameter). `!= null` (not
   * `!== undefined`) so an explicit-null template value is treated as
   * absent instead of being passed to the SDK as `null`.
   */
  private toSdkFields(
    properties: Record<string, unknown>
  ): Omit<UpdateLifecyclePolicyCommandInput, 'PolicyId'> {
    return {
      ...(properties['ExecutionRoleArn'] != null && {
        ExecutionRoleArn: properties['ExecutionRoleArn'] as string,
      }),
      ...(properties['Description'] != null && {
        Description: properties['Description'] as string,
      }),
      ...(properties['State'] != null && {
        State: properties['State'] as UpdateLifecyclePolicyCommandInput['State'],
      }),
      ...(properties['PolicyDetails'] != null && {
        PolicyDetails: properties['PolicyDetails'] as PolicyDetails,
      }),
      ...(properties['CreateInterval'] != null && {
        CreateInterval: properties['CreateInterval'] as number,
      }),
      ...(properties['RetainInterval'] != null && {
        RetainInterval: properties['RetainInterval'] as number,
      }),
      ...(properties['CopyTags'] != null && {
        CopyTags: properties['CopyTags'] as boolean,
      }),
      ...(properties['ExtendDeletion'] != null && {
        ExtendDeletion: properties['ExtendDeletion'] as boolean,
      }),
      ...(properties['CrossRegionCopyTargets'] != null && {
        CrossRegionCopyTargets: properties['CrossRegionCopyTargets'] as CrossRegionCopyTarget[],
      }),
      ...(properties['Exclusions'] != null && {
        Exclusions: properties['Exclusions'] as Exclusions,
      }),
    };
  }

  /** Fetch the policy ARN (`Fn::GetAtt Arn`) for a policy id. */
  private async fetchPolicyArn(policyId: string): Promise<string> {
    const response = await this.getClient().send(
      new GetLifecyclePolicyCommand({ PolicyId: policyId })
    );
    return response.Policy?.PolicyArn ?? '';
  }

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating DLM Lifecycle Policy ${logicalId}`);
    // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
    const desiredTags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);
    // One sink set for this create (issue #2177): a template value (the
    // description) can be secret-derived, and AWS may quote it back.
    const log = createMaskedLogSinks(this.logger, context?.maskSecrets);

    try {
      // CFn `[{ Key, Value }]` -> DLM tag map; omitted when empty.
      const tags =
        desiredTags.length > 0
          ? Object.fromEntries(desiredTags.map((t) => [t.Key, t.Value]))
          : undefined;
      const input: CreateLifecyclePolicyCommandInput = {
        ...this.toSdkFields(properties),
        ...(properties['DefaultPolicy'] != null && {
          DefaultPolicy: properties[
            'DefaultPolicy'
          ] as CreateLifecyclePolicyCommandInput['DefaultPolicy'],
        }),
        ...(tags && { Tags: tags }),
      } as CreateLifecyclePolicyCommandInput;

      // Issue #2080: after an earlier ambiguous attempt, name the policy it
      // may have made before a second CreateLifecyclePolicy is sent.
      // Detection only -- see `orphan-report.ts`.
      const orphanWindow = createLifecyclePolicyLatch.take(logicalId);
      if (orphanWindow !== undefined) {
        await this.reportPossibleOrphanPolicies(logicalId, input, orphanWindow, log);
      }
      const attemptStartMs = Date.now();
      let response: CreateLifecyclePolicyCommandOutput;
      try {
        response = await this.getCreateClient().send(new CreateLifecyclePolicyCommand(input));
      } catch (error) {
        createLifecyclePolicyLatch.noteFailure(logicalId, error, attemptStartMs, orphanWindow);
        throw error;
      }
      if (!response.PolicyId) {
        throw new Error('CreateLifecyclePolicy did not return a PolicyId');
      }
      policiesCreatedByThisProcess.add(response.PolicyId);
      // Issue #4687: the SDK replayed this CreateLifecyclePolicy inside its `send`, so
      // an earlier attempt may have made one too. Detection only.
      const replayWindow = replayedSendWindow(response, attemptStartMs);
      if (replayWindow !== undefined) {
        await this.reportPossibleOrphanPolicies(logicalId, input, replayWindow, log);
      }

      // The create response only carries PolicyId; fetch the ARN for the
      // `Fn::GetAtt Arn` attribute cache. Best-effort: a failure here MUST
      // NOT fail the create — the policy already exists, and the deploy
      // engine's outer withRetry would re-invoke create() and mint a SECOND
      // policy (DLM has no idempotency token). getAttribute() resolves the
      // Arn lazily on first Fn::GetAtt when the cache is empty.
      let arn = '';
      try {
        arn = await this.fetchPolicyArn(response.PolicyId);
      } catch (err) {
        log.warn(
          `Created DLM Lifecycle Policy ${response.PolicyId} but could not fetch its ARN: ${log.value(describeAwsFailure(err).detail)}`
        );
      }

      this.logger.debug(
        `Successfully created DLM Lifecycle Policy ${logicalId}: ${response.PolicyId}`
      );
      return {
        physicalId: response.PolicyId,
        attributes: arn ? { Arn: arn } : {},
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapCaughtError(
        context?.maskSecrets,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to create DLM Lifecycle Policy ${logicalId}: ${text}`,
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
    // go-to-k/cdkd#2613: the update addresses the policy by its id, so a client in another region
    // than the state record would send `UpdateLifecyclePolicy` and the tag diff to a region this
    // record was not written through. Ahead of the DefaultPolicy refusal too: that one is a
    // `ResourceUpdateNotSupportedError` steering toward a replacement, which is the wrong next step
    // when the region is what disagrees. Refuse before any call; the client's region is resolved
    // only when there is one to compare with.
    assertRegionMatch(
      context?.expectedRegion ? await this.getClient().config.region() : undefined,
      context?.expectedRegion,
      resourceType,
      logicalId,
      physicalId,
      'pre-update'
    );
    // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
    refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);

    if (
      JSON.stringify(properties['DefaultPolicy']) !==
      JSON.stringify(previousProperties['DefaultPolicy'])
    ) {
      // UpdateLifecyclePolicy has no DefaultPolicy parameter (CFn documents
      // the property as "Update requires: Replacement"). The engine's
      // --replace fallback recreates the policy.
      throw new ResourceUpdateNotSupportedError(
        resourceType,
        logicalId,
        // Issue [#2610] site 12. `--replace` is
        // `new Option('--replace', ...).default(false)` — a BOOLEAN with no
        // `<value>` — while `cdkd deploy` declares `.argument('[stacks...]')`,
        // so the logical id this line used to append was parsed as a STACK
        // NAME and the pasted command silently deployed something else. The
        // shape was copied from `--recreate-via-cc-api <ids>`, which does take
        // an argument. Nothing is lost by dropping it: the error's own
        // `ResourceUpdateNotSupportedError` head already renders
        // `<type> (<logicalId>) cannot be updated in place: ...`.
        `DefaultPolicy cannot be changed in place; ` +
          `re-run with \`cdkd deploy --replace\` to recreate the policy ` +
          `(--replace is a boolean flag and takes no resource id; it applies to every ` +
          `resource in the run whose in-place update is refused)`
      );
    }

    this.logger.debug(`Updating DLM Lifecycle Policy ${logicalId} (${physicalId})`);

    try {
      // Removal semantics (#5004): UpdateLifecyclePolicy merges, and a real
      // CloudFormation A/B showed CFn KEEPS the live CreateInterval,
      // RetainInterval, CopyTags, ExtendDeletion, CrossRegionCopyTargets and
      // Exclusions when removed, so nothing is sent for a removed member
      // (parity; supersedes the #1160 resets). A removed Description,
      // ExecutionRoleArn, State or PolicyDetails is kept by CFn too (#5546's
      // A/B, KEPT_ON_REMOVAL); each kept removal is named in a warning below.
      // A kept-but-partial Exclusions is replaced whole by the API.
      await this.getClient().send(
        new UpdateLifecyclePolicyCommand({
          PolicyId: physicalId,
          ...this.toSdkFields(properties),
          // A kept string-form numeric (a template literal "3") is sent as a number.
          ...(properties['CreateInterval'] != null && {
            CreateInterval: Number(properties['CreateInterval']),
          }),
          ...(properties['RetainInterval'] != null && {
            RetainInterval: Number(properties['RetainInterval']),
          }),
        })
      );

      // Tag diff via TagResource / UntagResource — UpdateLifecyclePolicy has
      // no Tags parameter. TagResource is additive-only, so a tag dropped
      // from the template (partial removal) — or the entire `Tags` property
      // removed (full removal, newTags === undefined) — would survive on AWS
      // unless we explicitly UntagResource the removed keys (the #981 ECR
      // regression class). Both sides are read through `planTagDiff`
      // (go-to-k/cdkd#3994): an unreadable record untags nothing.
      const plan = planTagDiff(previousProperties['Tags'], properties['Tags']);
      const tagWarning = tagPlanWarning(plan, resourceType, logicalId);
      if (tagWarning !== undefined) {
        this.logger.warn(tagWarning);
      }
      const arn = await this.fetchPolicyArn(physicalId);
      const tagsChanged = plan.set.size > 0 || plan.remove.length > 0;
      if (tagsChanged && !arn) {
        // GetLifecyclePolicy returned a Policy without PolicyArn — should not
        // happen in practice, but silently skipping the tag diff would leave
        // AWS-side tags stale with no signal.
        this.logger.warn(
          `Skipping tag update for DLM Lifecycle Policy ${physicalId}: GetLifecyclePolicy returned no PolicyArn`
        );
      }
      if (tagsChanged && arn) {
        const removedKeys = plan.remove;
        if (removedKeys.length > 0) {
          await this.getClient().send(
            new UntagResourceCommand({ ResourceArn: arn, TagKeys: removedKeys })
          );
          this.logger.debug(
            `Removed ${removedKeys.length} tag(s) from DLM Lifecycle Policy ${physicalId}`
          );
        }
        const tagsToAdd = Object.fromEntries(plan.set);
        if (Object.keys(tagsToAdd).length > 0) {
          await this.getClient().send(
            new TagResourceCommand({ ResourceArn: arn, Tags: tagsToAdd })
          );
          this.logger.debug(
            `Added/updated ${Object.keys(tagsToAdd).length} tag(s) on DLM Lifecycle Policy ${physicalId}`
          );
        }
      }

      // Issue #5546: name each removed property the policy kept, once and only
      // after the update SUCCEEDED. `drift --revert` hands an EMPTY
      // `removedProperties` (its previous side is an AWS readback), so it
      // names none; a direct call (no context) compares the two bags.
      const removed = new Set(
        context?.removedProperties ?? removedTemplateKeys(previousProperties, properties)
      );
      // A recorded explicit null declared nothing, so nothing was kept.
      const keptNames = KEPT_ON_REMOVAL.filter(
        (key) => removed.has(key) && previousProperties[key] != null
      );
      if (keptNames.length > 0) {
        this.logger.warn(
          keptOnRemovalWarning(
            logicalId,
            keptNames,
            context?.replayingState ? 'rollback' : 'deploy'
          )
        );
      }

      return {
        physicalId,
        wasReplaced: false,
        // Omit Arn when the read-back lacked PolicyArn so a previously-good
        // cached attribute is not clobbered with an empty string.
        attributes: arn ? { Arn: arn } : {},
      };
    } catch (error) {
      if (error instanceof ResourceUpdateNotSupportedError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapCaughtError(
        context?.maskSecrets,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to update DLM Lifecycle Policy ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting DLM Lifecycle Policy ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(new DeleteLifecyclePolicyCommand({ PolicyId: physicalId }));
      this.logger.debug(`Successfully deleted DLM Lifecycle Policy ${logicalId}`);
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`DLM Lifecycle Policy ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      const thrown = this.wrapCaughtError(
        context?.maskSecrets,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to delete DLM Lifecycle Policy ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
      // The wrap names an AWS failure by its CLASS, which the delete classifiers
      // read as "already deleted" on a `NotFound` needle: only the typed
      // not-found above means this one is gone (go-to-k/cdkd#2319).
      throw error instanceof Error && error.name.includes('NotFound')
        ? markNotGone(thrown)
        : thrown;
    }
  }

  /**
   * Attribute fallback. `Arn` is cached in state at create/update time, so
   * this only fires for imported/degraded records.
   */
  async getAttribute(
    physicalId: string,
    resourceType: string,
    attributeName: string,
    logicalId: string
  ): Promise<unknown> {
    // `Ref` / the readOnly `Id` property are the policy id itself.
    if (attributeName === 'Id' || attributeName === 'PolicyId') {
      return physicalId;
    }
    if (attributeName !== 'Arn') {
      throw new ProvisioningError(
        `Unknown attribute ${attributeName} for ${resourceType}`,
        resourceType,
        logicalId,
        physicalId
      );
    }
    try {
      return await this.fetchPolicyArn(physicalId);
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapCaughtError(
        undefined,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to resolve Arn for DLM Lifecycle Policy ${physicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }
  }

  /**
   * Drift read-back. Surfaces `Description`, `State`, `ExecutionRoleArn`,
   * and `Tags` (DLM tag map -> CFn list via `normalizeAwsTagsToCfn`).
   *
   * `PolicyDetails` is intentionally NOT surfaced (see
   * `getDriftUnknownPaths`): the service normalizes the stored details —
   * filling `PolicyType` / `ResourceTypes` / per-schedule defaults the
   * template omitted — and the drift comparator's positional array equality
   * would flag those AWS-added defaults as phantom drift on every clean run.
   * The default-policy shorthand fields (`CreateInterval` / `RetainInterval`
   * / `CopyTags` / `ExtendDeletion` / `CrossRegionCopyTargets` /
   * `Exclusions`) are folded into the normalized `PolicyDetails` by the
   * service (GetLifecyclePolicy does not return them at the top level), so
   * they are excluded for the same reason.
   *
   * Returns `RESOURCE_NOT_FOUND` when the policy is gone (ResourceNotFoundException).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    try {
      const response = await this.getClient().send(
        new GetLifecyclePolicyCommand({ PolicyId: physicalId })
      );
      const policy = response.Policy;
      if (!policy) return undefined;

      return {
        ...(policy.Description !== undefined && { Description: policy.Description }),
        ...(policy.State !== undefined && { State: policy.State }),
        ...(policy.ExecutionRoleArn !== undefined && {
          ExecutionRoleArn: policy.ExecutionRoleArn,
        }),
        Tags: normalizeAwsTagsToCfn(policy.Tags),
      };
    } catch (error) {
      if (error instanceof ResourceNotFoundException) return RESOURCE_NOT_FOUND;
      throw error;
    }
  }

  /**
   * State property paths the provider deliberately does not read back from
   * AWS — see `readCurrentState` for the rationale.
   */
  getDriftUnknownPaths(_resourceType: string): string[] {
    return [
      'PolicyDetails',
      'CreateInterval',
      'RetainInterval',
      'CopyTags',
      'ExtendDeletion',
      'CrossRegionCopyTargets',
      'Exclusions',
      'DefaultPolicy',
    ];
  }

  /**
   * Adopt an existing lifecycle policy into cdkd state.
   *
   * Lookup order:
   *  1. `--resource` override (`knownPhysicalId`) -> verify via
   *     GetLifecyclePolicy. There is no template name property — the policy
   *     id is service-generated — so no name fallback applies.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    if (input.knownPhysicalId) {
      try {
        const response = await this.getClient().send(
          new GetLifecyclePolicyCommand({ PolicyId: input.knownPhysicalId })
        );
        return response.Policy?.PolicyId
          ? {
              physicalId: input.knownPhysicalId,
              // Omit Arn when the read-back lacked PolicyArn, matching
              // create() / update(). Persisting `''` would be worse than
              // omitting it: the intrinsic resolver treats any non-undefined
              // flat attribute as a hit, so an empty string beats
              // constructAttribute's fallback and Fn::GetAtt resolves to ''.
              attributes: response.Policy.PolicyArn ? { Arn: response.Policy.PolicyArn } : {},
            }
          : null;
      } catch (err) {
        if (err instanceof ResourceNotFoundException) return null;
        throw err;
      }
    }

    // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
    // that tag never exists on a real resource and the walk could not match
    // (issue #1134). Auto-mode import resolves ids from CloudFormation's
    // DescribeStackResources or the template's physical-name property; a policy
    // reaching here needs an explicit `--resource` override.
    return null;
  }
}
