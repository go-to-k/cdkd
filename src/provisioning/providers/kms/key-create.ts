import type { KMSProvider } from '../kms-provider.js';
import { cdkdRemedy, proseQuoted } from '../../../utils/pasteable-command.js';
import {
  createKeyLatch,
  keysCreatedByThisProcess,
  pendingKeys,
  supersededAttempts,
  RESUMABLE_KEY_STATES,
  MAX_ORPHAN_DESCRIBES,
  MAX_LIST_KEYS_PAGES,
  MAX_REPORTED_ORPHANS,
  templateBool,
} from './shared.js';
import {
  CreateKeyCommand,
  DescribeKeyCommand,
  EnableKeyRotationCommand,
  DisableKeyCommand,
  ListKeysCommand,
  type CreateKeyCommandInput,
  type CreateKeyCommandOutput,
  type KeyMetadata,
  type KeyUsageType,
  type KeySpec,
  type OriginType,
} from '@aws-sdk/client-kms';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import type { ResourceCreateResult } from '../../../types/resource.js';
import {
  markAuxiliaryFailure,
  markCreatedBeforeFailure,
  markSupersedesEarlierCreate,
} from '../../auxiliary-failure.js';
import { reportCreatedResource } from '../../created-resource-sink.js';
import { createHash } from 'node:crypto';
import {
  AMBIGUOUS_LATCH_TTL_MS,
  ambiguousAttemptLead,
  createAttemptKey,
  isInsideWindow,
  replayedSendWindow,
  setBounded,
  type AmbiguousCreateWindow,
} from '../ambiguous-create.js';
import { pasteableAwsCommand } from '../../replacement-protection-advice.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { isThrottlingError, isTransientServerError } from '../../../deployment/retryable-errors.js';

export async function createKey(
  this: KMSProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  mask: ((text: string) => string) | undefined
): Promise<ResourceCreateResult> {
  this.logger.debug(`Creating KMS Key ${logicalId}`);
  // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
  const tags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

  const description = properties['Description'] as string | undefined;
  const keyPolicy = properties['KeyPolicy'];
  const keySpec = properties['KeySpec'] as string | undefined;
  const keyUsage = properties['KeyUsage'] as string | undefined;
  const enableKeyRotation = templateBool(properties['EnableKeyRotation']);
  const multiRegion = templateBool(properties['MultiRegion']);
  const origin = properties['Origin'] as string | undefined;
  const bypassPolicyLockoutSafetyCheck = templateBool(properties['BypassPolicyLockoutSafetyCheck']);

  const input: CreateKeyCommandInput = {
    Description: description,
    KeySpec: keySpec as KeySpec,
    KeyUsage: keyUsage as KeyUsageType,
    Policy: keyPolicy
      ? typeof keyPolicy === 'string'
        ? keyPolicy
        : JSON.stringify(keyPolicy)
      : undefined,
    Tags:
      properties['Tags'] !== undefined && properties['Tags'] !== null
        ? tags.map((t) => ({ TagKey: t.Key, TagValue: t.Value }))
        : undefined,
    MultiRegion: multiRegion,
    Origin: origin as OriginType | undefined,
    BypassPolicyLockoutSafetyCheck: bypassPolicyLockoutSafetyCheck,
  };
  const attemptKey = createAttemptKey('CreateKey', logicalId);
  // A digest, not the input: the input carries the resolved key policy and
  // tags, which may hold secret-derived values, and this memo outlives the
  // create. It covers the follow-up switches too (rotation, `Enabled`): a
  // resumed key keeps whatever an earlier attempt applied, and the resume
  // path only ever turns rotation ON and the key OFF, so a later create
  // asking for less must not inherit it. The rotation PERIOD is left out on
  // purpose: a resume re-sends `EnableKeyRotation` with the current period.
  // Built from literals, so the key order is fixed.
  const inputDigest = createHash('sha256')
    .update(
      JSON.stringify({
        input,
        enableKeyRotation: enableKeyRotation === true,
        enabled: templateBool(properties['Enabled']) !== false,
      })
    )
    .digest('hex');

  // Set once the key exists: a later failure is an auxiliary call's, not
  // this key's collision (#3826).
  let createdKeyId: string | undefined;
  let supersededPending = false;
  try {
    const resumed = await this.resumeKeyFromFailedAttempt(logicalId, attemptKey, inputDigest);
    let keyId: string;
    let keyArn: string;
    if (resumed && resumed !== 'superseded') {
      ({ keyId, keyArn } = resumed);
    } else {
      const orphanWindow = createKeyLatch.take(logicalId);
      if (orphanWindow !== undefined) {
        await this.reportPossibleOrphanKeys(logicalId, input, orphanWindow);
      }
      const attemptStartMs = Date.now();
      let result: CreateKeyCommandOutput;
      try {
        result = await this.getCreateClient().send(new CreateKeyCommand(input));
      } catch (error) {
        createKeyLatch.noteFailure(logicalId, error, attemptStartMs, orphanWindow);
        throw error;
      }
      keyId = result.KeyMetadata!.KeyId!;
      keyArn = result.KeyMetadata!.Arn!;
      // Remembered BEFORE the follow-up calls below, so a failure in any of
      // them hands the retry this key rather than a second CreateKey.
      setBounded(pendingKeys, attemptKey, { keyId, keyArn, inputDigest, heldAtMs: Date.now() });
      // Before the lookup below, so a throw in it still marks the key created.
      createdKeyId = keyId;
      reportCreatedResource(logicalId, resourceType, keyId);
      // go-to-k/cdkd#4945: this key replaces a held one a retry declined.
      // Same age limit as the held key it replaced.
      const declinedAtMs = supersededAttempts.get(attemptKey);
      supersededAttempts.delete(attemptKey);
      supersededPending =
        declinedAtMs !== undefined && Date.now() - declinedAtMs <= AMBIGUOUS_LATCH_TTL_MS;
      // Issue #4687: the SDK replayed this CreateKey, so an earlier attempt
      // may have made a key too. Report only; the held key above is excluded.
      const replayWindow = replayedSendWindow(result, attemptStartMs);
      if (replayWindow !== undefined) {
        await this.reportPossibleOrphanKeys(logicalId, input, replayWindow);
      }
    }

    createdKeyId = keyId;
    reportCreatedResource(logicalId, resourceType, keyId);

    // EnableKeyRotation must be called separately after key creation
    if (enableKeyRotation === true) {
      const rotationPeriodInDays = properties['RotationPeriodInDays'] as number | undefined;
      this.logger.debug(`Enabling key rotation for KMS Key ${logicalId}`);
      await this.getClient().send(
        new EnableKeyRotationCommand({
          KeyId: keyId,
          ...(rotationPeriodInDays !== undefined && {
            RotationPeriodInDays: rotationPeriodInDays,
          }),
        })
      );
    }

    // Disable key if Enabled is explicitly false
    const enabled = templateBool(properties['Enabled']);
    if (enabled === false) {
      this.logger.debug(`Disabling KMS Key ${logicalId}`);
      await this.getClient().send(new DisableKeyCommand({ KeyId: keyId }));
    }

    this.logger.debug(`Successfully created KMS Key ${logicalId}: ${keyId}`);
    pendingKeys.delete(attemptKey);
    keysCreatedByThisProcess.add(keyId);

    return {
      physicalId: keyId,
      attributes: {
        Arn: keyArn,
        KeyId: keyId,
      },
    };
  } catch (error) {
    if (createdKeyId !== undefined) {
      markAuxiliaryFailure(error, logicalId);
      // The key stays remembered in `pendingKeys`, so the engine's retry of
      // this create resumes it rather than minting another. Said at warn
      // because if the retries run out, it is a live, billed key that no
      // cdkd state records.
      const aws = pasteableAwsCommand();
      const region = await this.regionArg(aws);
      this.logger.warn(
        safeMsg`KMS key ${createdKeyId} was created for ${logicalId}, but a follow-up call failed. A retry of this create reuses that key instead of creating another, so do not delete it while the deploy is still retrying. If the deploy then FAILS (outside a rollback's re-create), its rollback journal records the key for ${proseQuoted(cdkdRemedy('cdkd rollback', '--revert-failed'), '`')} to schedule its deletion; otherwise schedule it yourself with: ${aws`aws kms schedule-key-deletion --key-id ${createdKeyId}${region} --pending-window-in-days 7`.render()}`
      );
    }
    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapCaughtError(
      mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create KMS Key ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
    // go-to-k/cdkd#4583: the key (this create's own, or one an earlier attempt
    // of it minted and this one resumed) is left behind; name it for the journal.
    if (createdKeyId !== undefined) {
      markCreatedBeforeFailure(thrown, logicalId, resourceType, createdKeyId);
      // The retry resumes THIS key, so `withRetry` must not read it as a
      // second key minted over the one an earlier attempt marked.
      if (supersededPending) markSupersedesEarlierCreate(thrown);
    }
    throw thrown;
  }
}

/**
 * The ` --region <r>` fragment for a pasteable command, from the client that
 * made or listed the key (issue #4307): without it the command runs in the
 * user's shell-default region, where a describe answers NotFound and reads as
 * "no orphan". An unreadable region renders no fragment rather than failing
 * the warning. Built with the caller's `aws` tag, since a fragment from
 * another tag withholds the command.
 */
export async function regionArg(
  this: KMSProvider,
  aws: ReturnType<typeof pasteableAwsCommand>
): Promise<ReturnType<ReturnType<typeof pasteableAwsCommand>>> {
  let region: string | undefined;
  try {
    region = await this.getClient().config.region();
  } catch {
    region = undefined;
  }
  return region ? aws` --region ${region}` : aws``;
}

/**
 * Hand back the key an earlier attempt at this create already made, when its
 * `CreateKey` succeeded and a follow-up call then failed (issue #2080).
 *
 * Without this the engine's retry re-ran `CreateKey` from the top: a
 * transient 5xx, a throttle or an IAM-propagation denial on
 * `EnableKeyRotation` minted a SECOND key and left the first live, billed and
 * in no state record. That was the likeliest duplicate in this provider,
 * since the follow-up calls fail in the ordinary, unambiguous way.
 *
 * Adoption is sound here where it is not after an ambiguous `CreateKey`
 * (see {@link KMSProvider.reportPossibleOrphanKeys}): the key id came back in
 * this process's own response, so there is nothing to infer. Three things
 * still gate it, each falling through to a fresh `CreateKey` with the old key
 * named at warn: the inputs must be the ones that made it, `DescribeKey` must
 * read it, and it must be in a usable state (a key somebody scheduled for
 * deletion meanwhile is not one to record). A TRANSIENT `DescribeKey` failure
 * instead rethrows with the key still remembered, so the engine's next retry
 * asks again rather than giving up on a key that is very likely fine.
 */
export async function resumeKeyFromFailedAttempt(
  this: KMSProvider,
  logicalId: string,
  attemptKey: string,
  inputDigest: string
): Promise<{ keyId: string; keyArn: string } | 'superseded' | undefined> {
  const pending = pendingKeys.get(attemptKey);
  if (!pending) return undefined;
  pendingKeys.delete(attemptKey);
  // Same age limit as the latch: a hold from a deploy that gave up long ago
  // in this process is not this create's retry.
  if (Date.now() - pending.heldAtMs > AMBIGUOUS_LATCH_TTL_MS) return undefined;
  const aws = pasteableAwsCommand();
  const region = await this.regionArg(aws);
  const deletion =
    aws`aws kms schedule-key-deletion --key-id ${pending.keyId}${region} --pending-window-in-days 7`.render();
  const notReused = (reason: string): 'superseded' => {
    this.logger.warn(
      safeMsg`KMS key ${pending.keyId} was created for ${logicalId} by an earlier attempt of this deploy, but ${reason}, so this attempt creates a new key and that one is not recorded in cdkd state. If it is unused, schedule its deletion with: ${deletion}`
    );
    setBounded(supersededAttempts, attemptKey, Date.now());
    return 'superseded';
  };
  if (pending.inputDigest !== inputDigest) {
    return notReused('this attempt was asked for a key with different inputs');
  }
  let metadata: KeyMetadata | undefined;
  try {
    metadata = (await this.getClient().send(new DescribeKeyCommand({ KeyId: pending.keyId })))
      .KeyMetadata;
  } catch (error) {
    if (isTransientServerError(error) || isThrottlingError(error)) {
      setBounded(pendingKeys, attemptKey, pending);
      throw error;
    }
    const failure = describeAwsFailure(error);
    this.logger.debug(safeMsg`DescribeKey ${pending.keyId} failed with: ${failure.detail}`);
    return notReused(`reading it back failed (${failure.summary})`);
  }
  if (!metadata?.KeyState || !RESUMABLE_KEY_STATES.has(metadata.KeyState)) {
    return notReused(`it is ${metadata?.KeyState ?? 'in an unreadable state'}`);
  }
  setBounded(pendingKeys, attemptKey, pending);
  this.logger.debug(
    safeMsg`Reusing KMS key ${pending.keyId}, which an earlier attempt at ${logicalId} created before a follow-up call failed`
  );
  return { keyId: pending.keyId, keyArn: metadata.Arn ?? pending.keyArn };
}

/**
 * After a `CreateKey` whose outcome was AMBIGUOUS (in practice a 5xx, the
 * only ambiguous failure the engine retries -- AWS may have made the key
 * and lost the answer) -- or one that succeeded only after the SDK replayed
 * it inside the same `send` (issue #4687) -- name the keys that could be
 * its orphan. Detection only: this never adopts and never deletes (issue
 * #2080).
 *
 * Why not adopt: a KMS key has no name and `CreateKey` has no token, so the
 * only evidence is circumstantial -- a customer-managed key, created inside
 * the window, with the same spec, usage, origin, multi-Region flag and
 * description. Two `AWS::KMS::Key` resources with default settings in one
 * stack (or a concurrent deploy, or a console user) match each other
 * exactly, and binding the wrong one to this logical id means cdkd later
 * UPDATEs its policy and SCHEDULES ITS DELETION. An orphaned key costs a
 * monthly fee; a wrongly adopted one can cost the data it encrypts. The one
 * exact channel, tagging the key with a cdkd token on `CreateKey`, was
 * rejected: it would make `kms:TagResource` a requirement of EVERY key
 * create, collide with tag policies, and leave a cdkd tag on every key that
 * each read path then has to strip.
 *
 * Every failure here WARNS and returns: the lookup is a courtesy, and must
 * never be what fails a deploy.
 */
export async function reportPossibleOrphanKeys(
  this: KMSProvider,
  logicalId: string,
  input: CreateKeyCommandInput,
  window: AmbiguousCreateWindow
): Promise<void> {
  const since = new Date(window.floorMs).toISOString();
  const until = new Date(window.ceilingMs).toISOString();
  const lead = ambiguousAttemptLead('CreateKey', logicalId, window);
  const pendingIds = new Set([...pendingKeys.values()].map((entry) => entry.keyId));
  const ids: string[] = [];
  let listTruncated = false;
  try {
    let marker: string | undefined;
    let pages = 0;
    do {
      const page = await this.getClient().send(
        new ListKeysCommand({ Limit: 1000, ...(marker && { Marker: marker }) })
      );
      for (const key of page.Keys ?? []) {
        if (key.KeyId && !keysCreatedByThisProcess.has(key.KeyId) && !pendingIds.has(key.KeyId)) {
          ids.push(key.KeyId);
        }
      }
      marker = page.Truncated ? page.NextMarker : undefined;
      pages++;
    } while (marker && pages < MAX_LIST_KEYS_PAGES);
    listTruncated = marker !== undefined;
  } catch (error) {
    const failure = describeAwsFailure(error);
    this.logger.debug(safeMsg`ListKeys failed with: ${failure.detail}`);
    this.logger.warn(
      safeMsg`${lead}, so KMS may have created a key that no cdkd state records, and cdkd could not list keys to look for it (${failure.summary}). Check the account's customer managed keys created between ${since} and ${until}.`
    );
    return;
  }

  // `ListKeys` documents no order. Newest-LAST is what it has been seen to
  // return, so the tail is described first; nothing depends on that being
  // true, since a key the cap leaves out makes the report say it is
  // incomplete rather than claim there is none.
  const describable = ids.slice(-MAX_ORPHAN_DESCRIBES).reverse();
  let unreadable = 0;
  const candidates: string[] = [];
  const wanted = {
    keySpec: input.KeySpec ?? 'SYMMETRIC_DEFAULT',
    keyUsage: input.KeyUsage ?? 'ENCRYPT_DECRYPT',
    origin: input.Origin ?? 'AWS_KMS',
    multiRegion: input.MultiRegion === true,
    description: input.Description ?? '',
  };
  // Small batches: this runs on a deploy's critical path, and KMS's
  // DescribeKey quota is shared with every other caller in the account.
  for (let i = 0; i < describable.length; i += 10) {
    const batch = describable.slice(i, i + 10);
    const results = await Promise.all(
      batch.map(async (keyId) => {
        try {
          return (await this.getClient().send(new DescribeKeyCommand({ KeyId: keyId })))
            .KeyMetadata;
        } catch {
          unreadable++;
          return undefined;
        }
      })
    );
    for (const md of results) {
      if (
        md?.KeyId &&
        md.KeyManager === 'CUSTOMER' &&
        isInsideWindow(md.CreationDate, window) &&
        md.KeyState !== 'PendingDeletion' &&
        md.KeyState !== 'PendingReplicaDeletion' &&
        (md.KeySpec ?? 'SYMMETRIC_DEFAULT') === wanted.keySpec &&
        (md.KeyUsage ?? 'ENCRYPT_DECRYPT') === wanted.keyUsage &&
        (md.Origin ?? 'AWS_KMS') === wanted.origin &&
        (md.MultiRegion === true) === wanted.multiRegion &&
        (md.Description ?? '') === wanted.description
      ) {
        candidates.push(md.KeyId);
      }
    }
  }

  const gaps = [
    ...(listTruncated ? [`the key list was cut at ${MAX_LIST_KEYS_PAGES} pages`] : []),
    ...(ids.length > describable.length
      ? [
          `${ids.length - describable.length} key(s) were beyond its ${MAX_ORPHAN_DESCRIBES}-key limit`,
        ]
      : []),
    ...(unreadable > 0 ? [`${unreadable} could not be read`] : []),
  ];
  const incomplete = gaps.length > 0 ? ` The search was incomplete: ${gaps.join(', ')}.` : '';
  if (candidates.length === 0) {
    // Said only of what was LISTED: `ListKeys` is eventually consistent, so
    // a key made moments ago can be missing from it.
    const line = safeMsg`${lead}; no listed customer managed key matching it was created between ${since} and ${until}.${incomplete}`;
    if (incomplete) {
      this.logger.warn(line);
    } else {
      this.logger.debug(line);
    }
    return;
  }
  const aws = pasteableAwsCommand();
  const region = await this.regionArg(aws);
  const shown = candidates.slice(0, MAX_REPORTED_ORPHANS);
  // READ commands first. A candidate may be another stack's key with the
  // same settings, so a deletion command leading the line would hand the
  // user exactly the wrong-resource mistake cdkd declines to make itself.
  const inspect = shown
    .map((keyId) => aws`aws kms describe-key --key-id ${keyId}${region}`.render())
    .join(' ; ');
  const deletion = shown
    .map((keyId) =>
      aws`aws kms schedule-key-deletion --key-id ${keyId}${region} --pending-window-in-days 7`.render()
    )
    .join(' ; ');
  this.logger.warn(
    safeMsg`${lead}, and KMS may have created a key then that no cdkd state records. ${candidates.length} customer managed key(s) created between ${since} and ${until} match this key's settings: ${shown.join(', ')}${candidates.length > shown.length ? ', ...' : ''}. cdkd does not adopt or delete them, because a key has no name or token that ties it to ${logicalId} -- another key with the same settings is indistinguishable. ${window.replayedInSend === true ? 'cdkd recorded the key the create returned, so the orphan (if any) and that key both exist.' : 'Creating a new key now, so the orphan (if any) and the new key will both exist.'} First inspect each candidate: ${inspect}. Only after confirming a key is this deploy's orphan and no other deploy uses it, schedule its deletion: ${deletion}.${incomplete}`
  );
}
