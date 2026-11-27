import {
  IAMClient,
  GetPolicyCommand,
  DeletePolicyVersionCommand,
  ListPolicyVersionsCommand,
  ListEntitiesForPolicyCommand,
  ListPoliciesCommand,
  TagPolicyCommand,
  UntagPolicyCommand,
  AttachGroupPolicyCommand,
  DetachGroupPolicyCommand,
  AttachRolePolicyCommand,
  DetachRolePolicyCommand,
  AttachUserPolicyCommand,
  DetachUserPolicyCommand,
  NoSuchEntityException,
  type Policy,
} from '@aws-sdk/client-iam';
import { getLogger, type ConsoleLogger } from '../../utils/logger.js';
import { OWN_WRITE_REREAD_DELAYS_MS } from '../settle-after-own-write.js';
import { clearOwnWriteRemovals, recordOwnWriteRemoval } from '../own-write-removals.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { IamCreateClientCache } from './iam-create-client.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { planTagDiff, tagPlanWarning } from '../tag-list.js';
import { type MaskedLogSinks, type MaskerFn } from '../masked-retry-logger.js';
import type {
  CreateContext,
  ReadCurrentStateContext,
  UpdateContext,
  ResourceProvider,
  ResourceCreateResult,
  ResourceDeleteResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  ResourceNotFound,
  ResourceIdentityVerdict,
} from '../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../types/resource.js';
import { safeMsg } from '../../utils/display-safe.js';
import { isAuxiliaryFailure } from '../auxiliary-failure.js';
import { type DeleteProgress } from '../delete-started.js';
import {
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../deployment/retryable-errors.js';
import { create } from './iam-managed-policy/create.js';
import { update } from './iam-managed-policy/update.js';
import { deleteImpl } from './iam-managed-policy/delete.js';
import { readCurrentState, importImpl } from './iam-managed-policy/read-state.js';
import {
  MANAGED_POLICY_READ_BACK_KEYS,
  managedPolicyAttributes,
} from './iam-managed-policy/shared.js';
import {
  policyIdentityToken,
  type DeclaredPrincipals,
  type UndeclaredPrincipal,
} from './iam-managed-policy/shared.js';
import {
  assertInlinePolicyAttachTargets,
  MANAGED_POLICY_OWNER,
  verifyInlinePolicyPrincipals,
} from './iam-policy/principal-identity.js';
import { injectiveKey } from '../../state/record-keys.js';
import { diffPrincipalNames } from '../iam-policy-targets.js';
import type { InlinePolicyPrincipalKind } from '../../types/resource.js';

const MANAGED_POLICY_TYPE = 'AWS::IAM::ManagedPolicy';

/** A managed policy's `Groups` / `Roles` / `Users` (each absent when not set). */
type PrincipalLists = Readonly<
  Partial<Record<'Groups' | 'Roles' | 'Users', readonly string[] | undefined>>
>;

/** Each listed principal as `[kind, name]`, the order `updatePrincipals` writes. */
function principalPairs(
  lists: PrincipalLists
): Array<readonly [InlinePolicyPrincipalKind, string]> {
  return [
    ...(lists.Groups ?? []).map((n) => ['group', n] as const),
    ...(lists.Roles ?? []).map((n) => ['role', n] as const),
    ...(lists.Users ?? []).map((n) => ['user', n] as const),
  ];
}

/**
 * A CUSTOMER-managed policy ARN, the physical id this provider records:
 * `arn:<partition>:iam::<12-digit account>:policy/<path><name>`, the path `/`
 * or `/…/` of printable ASCII, the name 1-128 of `A-Z a-z 0-9 + = , . @ _ -`
 * (IAM's `PolicyName` pattern). Captures the partition-and-account prefix
 * and the name. An AWS-managed ARN (account `aws`) never matches.
 */
const CUSTOMER_POLICY_ARN_RE =
  /^(arn:aws[a-z0-9-]*:iam::\d{12}):policy\/(?:[!-~]{0,510}\/)?([\w+=,.@-]{1,128})$/;

/**
 * AWS IAM Managed Policy Provider
 *
 * Implements resource provisioning for AWS::IAM::ManagedPolicy using the IAM SDK.
 * Cloud Control API does support this type, but a dedicated SDK provider wins
 * via Tier 1 of the provider registry and gives cdkd direct control over:
 *   - PolicyDocument updates (via CreatePolicyVersion + SetDefaultPolicyVersion +
 *     prune oldest non-default when at the 5-version limit)
 *   - Attachment fan-out (Groups / Roles / Users) on create + update
 *   - Detach-before-delete cleanup (a ManagedPolicy with attached principals
 *     or with non-default versions cannot be deleted directly)
 *
 * Physical id is the policy ARN (`arn:<partition>:iam::<account>:policy/<path><name>`)
 * since path is part of the identity — two policies with the same name in
 * different paths are distinct.
 */
export class IAMManagedPolicyProvider implements ResourceProvider {
  iamClient: IAMClient;
  /** `CreatePolicy` goes through this client, which refuses the SDK retry of a 5xx (issue #4639). */
  readonly createClient = new IamCreateClientCache(() => this.iamClient);
  logger: ConsoleLogger = getLogger().child('IAMManagedPolicyProvider');
  /** Re-read schedule of the post-write baseline capture; tests set it to zeros. */
  ownWriteRereadDelaysMs: readonly number[] = OWN_WRITE_REREAD_DELAYS_MS;

  /**
   * A failure wrap that never quotes AWS's own text (issue #2319). The thrown
   * message is persisted to `deployments/{runId}.jsonl`, and an IAM
   * `AccessDenied` names the caller's assumed-role ARN, so an AWS-authored
   * failure is named by its class plus the `--verbose` pointer: AWS's text
   * goes to `debug` through the masker, and the wrap is stamped
   * `markRedactedCause` so the retry classifiers read the withheld text on the
   * unmasked `cause` chain. An "already exists" is restated
   * ({@link relayedNameCollision}). A cdkd-authored or transport error, or a
   * non-`Error` throw, keeps its text masked (issue #2177,
   * `wrapMaskedAwsError`, issue #4244).
   *
   * `build` must thread `error` as `cause`, and runs twice, so it must stay a
   * side-effect-free constructor call. A method, so `gen-update-wrap-coverage`
   * sees the catch that throws it as a wrap.
   */
  wrapMaskedError(
    mask: MaskerFn,
    error: unknown,
    build: (maskedText: string) => ProvisioningError
  ): ProvisioningError {
    const failure = describeAwsFailure(error);
    if (!(error instanceof Error)) return build(mask(failure.detail));
    if (!failure.redacted) return wrapMaskedAwsError(mask, error, build);
    this.logger.debug(mask(build(mask(failure.detail)).message));
    // Not from a post-create step (`markAuxiliaryFailure`), where "it" would
    // read as the resource just created.
    const relay = isAuxiliaryFailure(error) ? '' : relayedNameCollision(failure.detail);
    return markRedactedCause(build(`${mask(failure.summary)}${relay}`));
  }

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::IAM::ManagedPolicy',
      new Set([
        'ManagedPolicyName',
        'Description',
        'Path',
        'PolicyDocument',
        'Groups',
        'Roles',
        'Users',
        'Tags',
      ]),
    ],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.iamClient = awsClients.iam;
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

  delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void | ResourceDeleteResult> {
    return deleteImpl.call(this, logicalId, physicalId, resourceType, properties, context);
  }

  /**
   * The not-found arm of `delete`, after the region check. A journaled
   * failed-CREATE orphan already gone settles with exit 0 (go-to-k/cdkd#4606),
   * so it is said once at info; the ARN is interpolated verbatim for the
   * caller's printing bag to mask.
   */
  async goneOnDelete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    context: DeleteContext | undefined,
    mask: MaskerFn
  ): Promise<void> {
    const clientRegion = await this.iamClient.config.region();
    assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
    if (context?.failedCreateOrphan === true) {
      this.logger.info(
        mask(
          safeMsg`  IAM managed policy ${physicalId} (${logicalId}), which a failed deploy created, is already gone; nothing to delete`
        )
      );
    } else {
      this.logger.debug(mask(`Managed policy ${physicalId} does not exist, skipping deletion`));
    }
  }

  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    // `Ref` also returns the ARN. Every other attribute this type's create
    // records (go-to-k/cdkd#6232, #6242) needs a GetPolicy.
    if (attributeName === 'PolicyArn') return physicalId;
    if ((MANAGED_POLICY_READ_BACK_KEYS as readonly string[]).includes(attributeName)) {
      const resp = await this.iamClient.send(new GetPolicyCommand({ PolicyArn: physicalId }));
      return managedPolicyAttributes(physicalId, resp.Policy)[attributeName];
    }
    return undefined;
  }

  /**
   * `Roles` / `Users` / `Groups` are attachment SETS that `ListEntitiesForPolicy`
   * lists in entity-id order (measured for roles, us-east-1, 2026-11-19), not
   * the template's: compared order-insensitively, so a baseline captured right
   * after the write (go-to-k/cdkd#6609), which records a still-unread declared
   * entry at its declared position, compares equal to a later read.
   */
  getDriftUnorderedPaths(resourceType: string): string[] {
    return resourceType === 'AWS::IAM::ManagedPolicy' ? ['Roles', 'Users', 'Groups'] : [];
  }

  readCurrentState(
    physicalId: string,
    logicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: ReadCurrentStateContext
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentState.call(this, physicalId, logicalId, resourceType, properties, context);
  }

  import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importImpl.call(this, input);
  }

  // ── identity (go-to-k/cdkd#4606) ──────────────────────────────────

  /**
   * go-to-k/cdkd#4606: whether the managed policy a failed CREATE journaled is
   * the one the record under the same logical id holds (a fix-forward that
   * created a new one there under another name).
   *
   * Only `AWS::IAM::ManagedPolicy`; both ids must be customer-managed policy
   * ARNs (the physical id this provider records) of one partition and
   * account, else `'unknown'`. Equal ARNs are `'same'` without a read:
   * whatever holds the ARN now is the record's, and deleting by it would
   * delete it. Two whose policy NAMES are equal ignoring case (another case,
   * or another path) are `'unknown'`: a policy name is unique per account
   * regardless of case and path, and this check does not decide on IAM's
   * rules for it. A policy can be neither renamed nor moved. After the region
   * check the record's policy must read back (else `'unknown'`); the
   * journaled one is `'same'` when it reads back under the record's
   * `PolicyId`, `'different'` under another, and `'different'` when IAM
   * reports it gone: the record's policy answers to its own, other, ARN. Any
   * other read failure throws, which the caller reads as `'unknown'`.
   */
  async isSameResource(
    journaledPhysicalId: string,
    record: { physicalId: string },
    resourceType: string,
    context: { expectedRegion: string }
  ): Promise<ResourceIdentityVerdict> {
    if (resourceType !== MANAGED_POLICY_TYPE) return 'unknown';
    const journaled = CUSTOMER_POLICY_ARN_RE.exec(journaledPhysicalId);
    const recorded = CUSTOMER_POLICY_ARN_RE.exec(record.physicalId);
    if (journaled === null || recorded === null) return 'unknown';
    if (journaledPhysicalId === record.physicalId) return 'same';
    if (journaled[1] !== recorded[1]) return 'unknown';
    if (journaled[2]!.toLowerCase() === recorded[2]!.toLowerCase()) return 'unknown';
    const clientRegion = await this.iamClient.config.region();
    if (clientRegion !== context.expectedRegion) return 'unknown';
    const recordId = await this.readPolicyIdIfExists(record.physicalId);
    if (recordId === undefined) return 'unknown';
    const journaledId = await this.readPolicyIdIfExists(journaledPhysicalId);
    if (journaledId === undefined) return 'different';
    // Unreachable as 'same' while the names differ beyond case; kept so the
    // verdict rests on AWS's answer.
    return journaledId === recordId ? 'same' : 'different';
  }

  /**
   * go-to-k/cdkd#4655 / #4606: the policy's `PolicyId`
   * ({@link policyIdentityToken}). One re-created under the ARN answers with
   * another, so the settle keeps it rather than deleting it as the failed
   * CREATE's orphan. A failed CREATE's own token comes from its
   * `CreatePolicy` response, on the failure's mark
   * (`markCreatedBeforeFailure`); this is the live read.
   *
   * `undefined` for another type, an id that is not a customer-managed
   * policy ARN, or a client in another region than `expectedRegion` (IAM is
   * global, but the check keeps every identity read on the stack's own
   * client). `RESOURCE_NOT_FOUND` only on `NoSuchEntityException`; any other
   * failure, a response naming another policy, and one with no id throw.
   */
  async resourceIdentity(
    physicalId: string,
    resourceType: string,
    context: { expectedRegion: string }
  ): Promise<string | ResourceNotFound | undefined> {
    if (resourceType !== MANAGED_POLICY_TYPE || !CUSTOMER_POLICY_ARN_RE.test(physicalId)) {
      return undefined;
    }
    const clientRegion = await this.iamClient.config.region();
    if (clientRegion !== context.expectedRegion) return undefined;
    const id = await this.readPolicyIdIfExists(physicalId);
    return id === undefined ? RESOURCE_NOT_FOUND : id;
  }

  /**
   * The policy's `PolicyId` (`GetPolicy`), or `undefined` when IAM answers
   * `NoSuchEntityException`. Any other failure, a response naming another
   * policy, and one with no id throw: "could not read" never reads as "gone".
   */
  private async readPolicyIdIfExists(policyArn: string): Promise<string | undefined> {
    let answeredArn: string | undefined;
    let id: string | undefined;
    try {
      const response = await this.iamClient.send(new GetPolicyCommand({ PolicyArn: policyArn }));
      answeredArn = response.Policy?.Arn;
      id = response.Policy?.PolicyId;
    } catch (error) {
      if (error instanceof NoSuchEntityException) return undefined;
      throw error;
    }
    if (answeredArn !== policyArn) {
      throw new Error('IAM answered for another managed policy than the one asked for');
    }
    const token = policyIdentityToken(id);
    if (token === undefined) throw new Error('IAM returned no PolicyId');
    return token;
  }

  // ── helpers ───────────────────────────────────────────────────────

  /**
   * go-to-k/cdkd#6722: an attach addresses the principal by name, so each
   * in-stack principal with a recorded identity id that this deploy did not
   * itself create or replace is read and compared; a holder with another id
   * refuses (non-retryable) with nothing written. Called by `create()` before
   * `CreatePolicy`.
   */
  async assertAttachTargets(
    logicalId: string,
    physicalId: string,
    lists: PrincipalLists
  ): Promise<void> {
    await assertInlinePolicyAttachTargets({
      client: this.iamClient,
      principals: principalPairs(lists),
      policyLogicalId: logicalId,
      physicalId,
      owner: MANAGED_POLICY_OWNER,
    });
  }

  /**
   * go-to-k/cdkd#6722: the attach and detach `updatePrincipals` will send, both
   * by name, compared first; called by `update()` before any write. An ADDED
   * principal held by another id refuses the update (see
   * {@link assertAttachTargets}); a LEAVING one is warned about and returned,
   * for `updatePrincipals` to send it no detach, as an inline policy's leaving
   * principal is (go-to-k/cdkd#6655). A rollback replaying an update backwards
   * re-adds what the forward update removed, so a principal it skipped as a
   * mismatch is refused here.
   */
  async comparePrincipalChanges(
    logicalId: string,
    policyArn: string,
    desired: PrincipalLists,
    recorded: PrincipalLists,
    log: MaskedLogSinks
  ): Promise<ReadonlySet<string>> {
    // The same diff `updatePrincipals` sends (go-to-k/cdkd#6774): a name
    // respelled only in case is neither attached nor detached, so neither
    // compared.
    const diffs = {
      Groups: diffPrincipalNames(desired.Groups, recorded.Groups),
      Roles: diffPrincipalNames(desired.Roles, recorded.Roles),
      Users: diffPrincipalNames(desired.Users, recorded.Users),
    };
    const added = principalPairs({
      Groups: diffs.Groups.added,
      Roles: diffs.Roles.added,
      Users: diffs.Users.added,
    });
    const leaving = principalPairs({
      Groups: diffs.Groups.removed,
      Roles: diffs.Roles.removed,
      Users: diffs.Users.removed,
    });
    const verdicts = await verifyInlinePolicyPrincipals({
      client: this.iamClient,
      principals: leaving,
      policyLogicalId: logicalId,
      physicalId: policyArn,
      operation: 'update',
      owner: MANAGED_POLICY_OWNER,
    });
    await assertInlinePolicyAttachTargets({
      client: this.iamClient,
      principals: added,
      policyLogicalId: logicalId,
      physicalId: policyArn,
      owner: MANAGED_POLICY_OWNER,
    });
    const strangers = new Set<string>();
    for (const [key, verdict] of verdicts) {
      if (verdict.kind !== 'mismatch') continue;
      strangers.add(key);
      log.warn(
        `IAM managed policy ${logicalId}: the ${verdict.label} ${verdict.principalLogicalId} ` +
          `leaving its principals is not the one cdkd created (its ${verdict.attribute} differs ` +
          `from the recorded one), so cdkd sent it no detach. Leave that ${verdict.label} alone.`
      );
    }
    return strangers;
  }

  async attachToPrincipals(
    policyArn: string,
    groups: string[] | undefined,
    roles: string[] | undefined,
    users: string[] | undefined,
    log: MaskedLogSinks
  ): Promise<void> {
    const { value: v } = log;
    if (groups && Array.isArray(groups)) {
      for (const groupName of groups) {
        await this.iamClient.send(
          new AttachGroupPolicyCommand({ GroupName: groupName, PolicyArn: policyArn })
        );
        log.debug(`Attached ${v(policyArn)} to group ${v(groupName)}`);
      }
    }
    if (roles && Array.isArray(roles)) {
      for (const roleName of roles) {
        await this.iamClient.send(
          new AttachRolePolicyCommand({ RoleName: roleName, PolicyArn: policyArn })
        );
        log.debug(`Attached ${v(policyArn)} to role ${v(roleName)}`);
      }
    }
    if (users && Array.isArray(users)) {
      for (const userName of users) {
        await this.iamClient.send(
          new AttachUserPolicyCommand({ UserName: userName, PolicyArn: policyArn })
        );
        log.debug(`Attached ${v(policyArn)} to user ${v(userName)}`);
      }
    }
  }

  async updatePrincipals(
    policyArn: string,
    newGroups: string[] | undefined,
    oldGroups: string[] | undefined,
    newRoles: string[] | undefined,
    oldRoles: string[] | undefined,
    newUsers: string[] | undefined,
    oldUsers: string[] | undefined,
    log: MaskedLogSinks,
    /**
     * go-to-k/cdkd#6722: the leaving principals {@link comparePrincipalChanges}
     * found held by another id (`injectiveKey(kind, name)`), sent no detach.
     */
    strangers: ReadonlySet<string> = new Set()
  ): Promise<void> {
    const { value: v } = log;
    // go-to-k/cdkd#6609: each detach is noted once its call succeeds (a
    // tolerated "not found" included), so the capture right after waits for
    // it (`own-write-removals.ts`); a note an earlier update that threw left
    // behind is dropped first. Only this method notes for the type.
    clearOwnWriteRemovals(MANAGED_POLICY_TYPE, policyArn);
    // go-to-k/cdkd#6774: a principal respelled only in case is the one the
    // policy is attached to (IAM names ignore case): neither attached nor
    // detached, as `comparePrincipalChanges` diffs it.
    const groups = diffPrincipalNames(newGroups, oldGroups);
    const roles = diffPrincipalNames(newRoles, oldRoles);
    const users = diffPrincipalNames(newUsers, oldUsers);
    for (const g of groups.added) {
      await this.iamClient.send(
        new AttachGroupPolicyCommand({ GroupName: g, PolicyArn: policyArn })
      );
      log.debug(`Attached ${v(policyArn)} to group ${v(g)}`);
    }
    for (const g of groups.removed) {
      if (strangers.has(injectiveKey('group', g))) continue;
      try {
        await this.iamClient.send(
          new DetachGroupPolicyCommand({ GroupName: g, PolicyArn: policyArn })
        );
        log.debug(`Detached ${v(policyArn)} from group ${v(g)}`);
      } catch (err) {
        if (!(err instanceof NoSuchEntityException)) throw err;
      }
      recordOwnWriteRemoval(MANAGED_POLICY_TYPE, policyArn, 'Groups', g);
    }

    for (const r of roles.added) {
      await this.iamClient.send(new AttachRolePolicyCommand({ RoleName: r, PolicyArn: policyArn }));
      log.debug(`Attached ${v(policyArn)} to role ${v(r)}`);
    }
    for (const r of roles.removed) {
      if (strangers.has(injectiveKey('role', r))) continue;
      try {
        await this.iamClient.send(
          new DetachRolePolicyCommand({ RoleName: r, PolicyArn: policyArn })
        );
        log.debug(`Detached ${v(policyArn)} from role ${v(r)}`);
      } catch (err) {
        if (!(err instanceof NoSuchEntityException)) throw err;
      }
      recordOwnWriteRemoval(MANAGED_POLICY_TYPE, policyArn, 'Roles', r);
    }

    for (const u of users.added) {
      await this.iamClient.send(new AttachUserPolicyCommand({ UserName: u, PolicyArn: policyArn }));
      log.debug(`Attached ${v(policyArn)} to user ${v(u)}`);
    }
    for (const u of users.removed) {
      if (strangers.has(injectiveKey('user', u))) continue;
      try {
        await this.iamClient.send(
          new DetachUserPolicyCommand({ UserName: u, PolicyArn: policyArn })
        );
        log.debug(`Detached ${v(policyArn)} from user ${v(u)}`);
      } catch (err) {
        if (!(err instanceof NoSuchEntityException)) throw err;
      }
      recordOwnWriteRemoval(MANAGED_POLICY_TYPE, policyArn, 'Users', u);
    }
  }

  /** Every group, role and user the policy is attached to, read from IAM. */
  async readLivePrincipals(
    policyArn: string
  ): Promise<{ Groups: string[]; Roles: string[]; Users: string[] }> {
    const live = { Groups: [] as string[], Roles: [] as string[], Users: [] as string[] };
    let marker: string | undefined;
    do {
      const resp = await this.iamClient.send(
        new ListEntitiesForPolicyCommand({
          PolicyArn: policyArn,
          ...(marker && { Marker: marker }),
        })
      );
      for (const g of resp.PolicyGroups ?? []) if (g.GroupName) live.Groups.push(g.GroupName);
      for (const r of resp.PolicyRoles ?? []) if (r.RoleName) live.Roles.push(r.RoleName);
      for (const u of resp.PolicyUsers ?? []) if (u.UserName) live.Users.push(u.UserName);
      marker = resp.IsTruncated ? resp.Marker : undefined;
    } while (marker);
    return live;
  }

  /**
   * Detach the policy from the principals AWS reports attached. With `declared`
   * (go-to-k/cdkd#7117), only those the record names are detached, as
   * CloudFormation's delete handler does; the others are returned, undetached,
   * for the caller to refuse over. Without it, every one is detached.
   */
  async detachAllPrincipals(
    policyArn: string,
    progress?: DeleteProgress,
    declared?: DeclaredPrincipals
  ): Promise<UndeclaredPrincipal[]> {
    const undeclared: UndeclaredPrincipal[] = [];
    const keep = (kind: keyof DeclaredPrincipals, name: string): boolean => {
      if (!declared || declared[kind].has(name.toLowerCase())) return false;
      undeclared.push({ kind, name });
      return true;
    };
    try {
      let marker: string | undefined;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const resp = await this.iamClient.send(
          new ListEntitiesForPolicyCommand({
            PolicyArn: policyArn,
            ...(marker ? { Marker: marker } : {}),
          })
        );
        for (const g of resp.PolicyGroups ?? []) {
          if (!g.GroupName || keep('Groups', g.GroupName)) continue;
          try {
            await this.iamClient.send(
              new DetachGroupPolicyCommand({ GroupName: g.GroupName, PolicyArn: policyArn })
            );
            if (progress) progress.stripped = true;
          } catch (err) {
            if (!(err instanceof NoSuchEntityException)) throw err;
          }
        }
        for (const r of resp.PolicyRoles ?? []) {
          if (!r.RoleName || keep('Roles', r.RoleName)) continue;
          try {
            await this.iamClient.send(
              new DetachRolePolicyCommand({ RoleName: r.RoleName, PolicyArn: policyArn })
            );
            if (progress) progress.stripped = true;
          } catch (err) {
            if (!(err instanceof NoSuchEntityException)) throw err;
          }
        }
        for (const u of resp.PolicyUsers ?? []) {
          if (!u.UserName || keep('Users', u.UserName)) continue;
          try {
            await this.iamClient.send(
              new DetachUserPolicyCommand({ UserName: u.UserName, PolicyArn: policyArn })
            );
            if (progress) progress.stripped = true;
          } catch (err) {
            if (!(err instanceof NoSuchEntityException)) throw err;
          }
        }
        if (!resp.IsTruncated) break;
        marker = resp.Marker;
      }
    } catch (err) {
      if (err instanceof NoSuchEntityException) return undeclared;
      throw err;
    }
    return undeclared;
  }

  /**
   * Delete every non-default version of the policy. Required before
   * `DeletePolicy` — AWS refuses to delete a policy that still has
   * non-default versions.
   */
  async deleteAllNonDefaultVersions(policyArn: string): Promise<void> {
    try {
      let marker: string | undefined;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const resp = await this.iamClient.send(
          new ListPolicyVersionsCommand({
            PolicyArn: policyArn,
            ...(marker ? { Marker: marker } : {}),
          })
        );
        for (const v of resp.Versions ?? []) {
          if (v.IsDefaultVersion) continue;
          if (!v.VersionId) continue;
          try {
            await this.iamClient.send(
              new DeletePolicyVersionCommand({ PolicyArn: policyArn, VersionId: v.VersionId })
            );
          } catch (err) {
            if (!(err instanceof NoSuchEntityException)) throw err;
          }
        }
        if (!resp.IsTruncated) break;
        marker = resp.Marker;
      }
    } catch (err) {
      if (err instanceof NoSuchEntityException) return;
      throw err;
    }
  }

  /**
   * AWS caps managed policies at 5 versions. Before creating a new version,
   * prune the oldest non-default version if at the cap.
   */
  async ensureVersionCapacity(policyArn: string, log: MaskedLogSinks): Promise<void> {
    const { value: v } = log;
    const resp = await this.iamClient.send(new ListPolicyVersionsCommand({ PolicyArn: policyArn }));
    const versions = resp.Versions ?? [];
    if (versions.length < 5) return;
    // Sort by CreateDate ascending; delete oldest non-default.
    const nonDefault = versions
      .filter((v) => !v.IsDefaultVersion && v.VersionId)
      .sort((a, b) => (a.CreateDate?.getTime() ?? 0) - (b.CreateDate?.getTime() ?? 0));
    const victim = nonDefault[0];
    if (!victim?.VersionId) return;
    await this.iamClient.send(
      new DeletePolicyVersionCommand({ PolicyArn: policyArn, VersionId: victim.VersionId })
    );
    log.debug(`Pruned oldest non-default version ${v(victim.VersionId)} of ${v(policyArn)}`);
  }

  /**
   * Diff the policy's tags. Both sides are read through `planTagDiff`
   * (go-to-k/cdkd#3994): an unreadable record untags nothing.
   */
  async updateTags(
    policyArn: string,
    resourceType: string,
    logicalId: string,
    newTags: unknown,
    oldTags: unknown,
    log: MaskedLogSinks
  ): Promise<void> {
    const plan = planTagDiff(oldTags, newTags);
    const tagWarning = tagPlanWarning(plan, resourceType, logicalId);
    if (tagWarning !== undefined) {
      log.warn(tagWarning);
    }
    const tagsToRemove = plan.remove;
    const tagsToAdd = [...plan.set].map(([Key, Value]) => ({ Key, Value }));

    if (tagsToRemove.length > 0) {
      await this.iamClient.send(
        new UntagPolicyCommand({ PolicyArn: policyArn, TagKeys: tagsToRemove })
      );
    }
    if (tagsToAdd.length > 0) {
      await this.iamClient.send(new TagPolicyCommand({ PolicyArn: policyArn, Tags: tagsToAdd }));
    }
  }

  async findPolicyByName(policyName: string): Promise<(Policy & { Arn: string }) | undefined> {
    let marker: string | undefined;
    do {
      const resp = await this.iamClient.send(
        new ListPoliciesCommand({ Scope: 'Local', ...(marker ? { Marker: marker } : {}) })
      );
      for (const p of resp.Policies ?? []) {
        if (p.PolicyName === policyName && p.Arn) return { ...p, Arn: p.Arn };
      }
      marker = resp.IsTruncated ? resp.Marker : undefined;
    } while (marker);
    return undefined;
  }
}
