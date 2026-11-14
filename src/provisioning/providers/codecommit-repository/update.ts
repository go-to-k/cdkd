import {
  GetRepositoryTriggersCommand,
  PutRepositoryTriggersCommand,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateRepositoryDescriptionCommand,
  UpdateRepositoryEncryptionKeyCommand,
  UpdateRepositoryNameCommand,
  RepositoryDoesNotExistException,
  type RepositoryMetadata,
  type RepositoryTrigger,
} from '@aws-sdk/client-codecommit';
import type { CodeCommitRepositoryProvider } from '../codecommit-repository-provider.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { assertRegionMatch } from '../../region-check.js';
import type { ResourceUpdateResult, UpdateContext } from '../../../types/resource.js';
import { cdkdRemedy, pasteableCommand } from '../../../utils/pasteable-command.js';
import { markNonRetryable, markRedactedCause } from '../../../deployment/retryable-errors.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { holdsSecretDerivedEntry } from '../../iam-policy-targets.js';
import { maskerOrIdentity, type MaskerFn } from '../../masked-retry-logger.js';
import {
  REPO_LIST_WHAT,
  readRepoList,
  recordedRepositoryId,
  tagMapsEqual,
  toSdkTagMap,
  toSdkTriggers,
  triggersEqual,
  type CfnTag,
  type CfnTrigger,
  type RepoListKind,
} from './shared.js';

/**
 * Update a CodeCommit Repository
 *
 * Mutable properties: RepositoryName (UpdateRepositoryName — CFn's docs
 * mark the property "Update requires: No interruption" and the registry
 * schema's createOnlyProperties is empty, so CFn parity is an IN-PLACE
 * rename that preserves the repository's git history; the repository ID —
 * CFn's `Ref` value — survives the rename), RepositoryDescription
 * (UpdateRepositoryDescription), KmsKeyId (UpdateRepositoryEncryptionKey),
 * Tags (TagResource / UntagResource — full tag removal handled explicitly,
 * see the ECR Tags regression class in issue #981), Triggers
 * (PutRepositoryTriggers — a full-set replace, so a dropped or fully-removed
 * `Triggers` property is applied by putting the new/empty set; issue #1066).
 * `Code` is create-only seed content (CFn ignores it on update) and is NOT
 * re-applied here.
 *
 * A rename returns the NEW repository name as `physicalId` with
 * `wasReplaced: false`; the deploy engine persists the returned physical
 * id into state unconditionally.
 */
export async function update(
  this: CodeCommitRepositoryProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  this.logger.debug(`Updating CodeCommit Repository ${logicalId} (${physicalId})`);

  // go-to-k/cdkd#3989: a malformed desired list is refused before any call,
  // the rename included.
  const next = this.readDesiredLists(
    logicalId,
    resourceType,
    { Triggers: properties['Triggers'], Tags: properties['Tags'] },
    physicalId
  );
  const prevTriggers = readRepoList('Triggers', previousProperties['Triggers'], 'recorded');
  const prevTags = readRepoList('Tags', previousProperties['Tags'], 'recorded');
  // Every call below is addressed by a state-recorded NAME, so a client in
  // another region would act on a same-named repository cdkd does not manage.
  // The client's region is resolved only when there is one to compare with.
  assertRegionMatch(
    context?.expectedRegion ? await this.getClient().config.region() : undefined,
    context?.expectedRegion,
    resourceType,
    logicalId,
    physicalId,
    'pre-update'
  );
  // The repository id cdkd recorded for this resource (go-to-k/cdkd#4051):
  // the identity every call below is verified against.
  const recordedId = recordedRepositoryId(context?.recordedAttributes);
  const renameTo = properties['RepositoryName'];
  const renaming = typeof renameTo === 'string' && renameTo.length > 0 && renameTo !== physicalId;
  // An update that does not rename addresses the recorded name only, so on
  // that path the repository holding it must be the recorded one before
  // anything is read for, or written to, it (go-to-k/cdkd#4157); the rename
  // path checks the same before renaming. A record with no RepositoryId
  // keeps the historical by-name update: nothing identifies a foreign holder.
  if (!renaming && recordedId !== undefined) {
    await this.assertRecordedHolder(
      logicalId,
      resourceType,
      physicalId,
      recordedId,
      maskerOrIdentity(context?.maskSecrets)
    );
  }
  // A recorded Triggers cdkd cannot read is replaced by the live set, read
  // before the rename so a failed read changes nothing. A retry after a
  // rename that already landed finds the repository under the NEW name.
  const liveTriggers =
    prevTriggers.kind === 'malformed'
      ? await this.readLiveTriggers(
          logicalId,
          physicalId,
          renaming ? renameTo : undefined,
          recordedId,
          resourceType
        )
      : undefined;

  // Rename first so every subsequent call targets the current name.
  // `previousProperties.RepositoryName` is not consulted — the physical id
  // IS the deployed name (a template without an explicit name got a
  // generated one at create time that no longer matches the property).
  let currentName = physicalId;

  try {
    const newName = renaming ? (renameTo as string) : undefined;
    if (newName !== undefined) {
      // Read the repository's id BEFORE renaming, and remember it: a retry
      // then adopts the repository under the new name only when it is the
      // same one (go-to-k/cdkd#4042). A repository under the recorded name
      // whose id is not the recorded one (the recorded repository deleted
      // out of band and the name taken since) is refused before anything is
      // sent to it (go-to-k/cdkd#4051).
      let gone = false;
      try {
        const before = await this.getRepositoryMetadata(physicalId);
        // A read with no id leaves no evidence, never an earlier attempt's.
        this.renamesStarted.delete(physicalId);
        if (
          recordedId !== undefined &&
          before?.repositoryId !== undefined &&
          before.repositoryId !== recordedId
        ) {
          throw this.wrapNotThisRepositoryError(
            logicalId,
            resourceType,
            physicalId,
            'recorded-name'
          );
        }
        if (before?.repositoryId) {
          this.renamesStarted.set(physicalId, before.repositoryId);
        }
      } catch (err) {
        if (!(err instanceof RepositoryDoesNotExistException)) throw err;
        gone = true;
      }
      if (!gone) {
        try {
          await this.getClient().send(
            new UpdateRepositoryNameCommand({ oldName: physicalId, newName })
          );
        } catch (err) {
          if (!(err instanceof RepositoryDoesNotExistException)) throw err;
          gone = true;
        }
      }
      if (gone) {
        // Retry safety: the deploy engine's outer `withRetry` re-invokes
        // update() with the OLD physicalId. If a previous attempt (this run's
        // or an earlier deploy's) already renamed the repository and then
        // failed before recording the new name, the old name is gone. The
        // repository under the NEW name is adopted only when its id is the
        // recorded RepositoryId or the one this instance read before
        // renaming; any other holder is refused, with nothing sent to it.
        await this.verifyRenamedRepository(
          logicalId,
          resourceType,
          physicalId,
          newName,
          recordedId
        );
        this.logger.debug(
          `Rename from ${physicalId} to ${newName} already applied by a previous attempt`
        );
      }
      currentName = newName;
      this.logger.debug(`Renamed CodeCommit Repository from ${physicalId} to ${newName}`);
    }

    // Update RepositoryDescription if changed. An empty string clears the
    // description, matching CFn's behavior when the property is removed.
    const newDescription = properties['RepositoryDescription'] as string | undefined;
    const oldDescription = previousProperties['RepositoryDescription'] as string | undefined;
    if (newDescription !== oldDescription) {
      await this.getClient().send(
        new UpdateRepositoryDescriptionCommand({
          repositoryName: currentName,
          repositoryDescription: newDescription ?? '',
        })
      );
      this.logger.debug(`Updated description for ${currentName}`);
    }

    // Update KmsKeyId if changed. When the property is removed from the
    // template, CFn reverts the repository to the AWS-managed key
    // (`aws/codecommit`) — mirror that by passing the managed-key alias
    // (UpdateRepositoryEncryptionKey requires a kmsKeyId argument).
    const newKmsKeyId = properties['KmsKeyId'] as string | undefined;
    const oldKmsKeyId = previousProperties['KmsKeyId'] as string | undefined;
    if (newKmsKeyId !== oldKmsKeyId) {
      await this.getClient().send(
        new UpdateRepositoryEncryptionKeyCommand({
          repositoryName: currentName,
          kmsKeyId: newKmsKeyId ?? 'alias/aws/codecommit',
        })
      );
      this.logger.debug(`Updated encryption key for ${currentName}`);
    }

    // Update Tags if changed. `TagResource` is additive-only, so a tag
    // dropped from the template (partial removal) — or the entire `Tags`
    // property removed (full removal, `newTags === undefined`) — would
    // survive on AWS unless we explicitly `UntagResource` the removed keys.
    // The diff compares the SDK-shaped tag MAPS (key-sorted by
    // construction order-independence) so a pure re-order of the CFn
    // `Tags` list does not trigger needless API churn.
    //
    // A recorded `Tags` cdkd cannot read is applied ADD-only
    // (go-to-k/cdkd#3989): nothing is untagged, and the desired map is
    // tagged whenever it is non-empty. A recorded Key holding a dynamic
    // reference or its mask is left out of the untag set.
    const newTagMap = toSdkTagMap(next.Tags as CfnTag[]) ?? {};
    const oldTagMap =
      prevTags.kind === 'list'
        ? (toSdkTagMap(
            prevTags.items.filter((t) => !holdsSecretDerivedEntry(t['Key'])) as CfnTag[]
          ) ?? {})
        : {};
    if (prevTags.kind === 'malformed') {
      this.logger.warn(
        safeMsg`The recorded Tags of CodeCommit Repository ${logicalId} is not a list cdkd can read, so cdkd removed no tag and only applied the desired ones. Untag any key the template no longer names yourself.`
      );
    }
    let metadata: RepositoryMetadata | undefined;
    if (
      prevTags.kind === 'malformed'
        ? Object.keys(newTagMap).length > 0
        : !tagMapsEqual(newTagMap, oldTagMap)
    ) {
      metadata = await this.getRepositoryMetadata(currentName);
      const repoArn = metadata?.Arn;
      if (repoArn) {
        // Untag keys present in the old set but absent from the new set.
        // `newTags === undefined` is treated as "remove all old tags".
        const removedKeys = Object.keys(oldTagMap).filter((k) => !Object.hasOwn(newTagMap, k));
        if (removedKeys.length > 0) {
          await this.getClient().send(
            new UntagResourceCommand({ resourceArn: repoArn, tagKeys: removedKeys })
          );
        }
        // Apply added / changed tags. Skip the call when the new set is
        // empty (a pure removal has nothing left to add).
        if (Object.keys(newTagMap).length > 0) {
          await this.getClient().send(
            new TagResourceCommand({ resourceArn: repoArn, tags: newTagMap })
          );
        }
        this.logger.debug(`Updated tags for ${currentName}`);
      } else {
        // GetRepository returning metadata without an Arn is unexpected;
        // surface it instead of silently dropping the tag reconcile.
        this.logger.warn(
          `Could not resolve ARN for CodeCommit Repository ${currentName}; tag update skipped`
        );
      }
    }

    // Update Triggers if changed. `PutRepositoryTriggers` REPLACES the full
    // trigger set, so a template that dropped an entry — or removed the
    // `Triggers` property entirely (`newTriggers === undefined`) — is
    // handled by putting the new set (empty array = clear all). `Code` is
    // create-only seed content and is intentionally NOT re-applied here
    // (CFn ignores `Code` on update).
    //
    // A recorded `Triggers` cdkd cannot read is applied ADD-only
    // (go-to-k/cdkd#3989): the set put is the desired triggers plus every
    // live trigger whose name the desired side does not use, so nothing is
    // cleared on the strength of a record cdkd could not read.
    let newSdkTriggers = toSdkTriggers(next.Triggers as CfnTrigger[]);
    let oldSdkTriggers: RepositoryTrigger[] | undefined;
    let retainedCount = 0;
    if (liveTriggers === undefined) {
      oldSdkTriggers = toSdkTriggers(
        (prevTriggers.kind === 'list' ? prevTriggers.items : []) as CfnTrigger[]
      );
    } else {
      const names = new Set(newSdkTriggers.map((t) => t.name));
      const retained = liveTriggers.filter((t) => !names.has(t.name));
      if (retained.length > 0) {
        this.logger.warn(
          safeMsg`The recorded Triggers of CodeCommit Repository ${logicalId} is not a list cdkd can read, so cdkd read the triggers from CodeCommit; the repository holds ${retained.length} trigger(s) the desired Triggers does not name, and cdkd kept them. They stay only until the next change to Triggers, which replaces the whole set; list them with \`aws codecommit get-repository-triggers --repository-name\` and this repository's name, and remove any that are no longer wanted.`
        );
      }
      retainedCount = retained.length;
      newSdkTriggers = [...newSdkTriggers, ...retained];
      oldSdkTriggers = liveTriggers;
    }
    if (!triggersEqual(newSdkTriggers, oldSdkTriggers)) {
      try {
        await this.getClient().send(
          new PutRepositoryTriggersCommand({
            repositoryName: currentName,
            triggers: newSdkTriggers,
          })
        );
      } catch (error) {
        if (retainedCount === 0) throw error;
        // The kept live triggers count toward CodeCommit's per-repository
        // limit (10), so name them: removing them is the way out. A plain
        // Error carrying the AWS one as `cause`: the catch below wraps it,
        // and the retry classifies through the chain. AWS's failure is named
        // by its class, its text at `debug` (go-to-k/cdkd#2319), and the
        // stamp points the classifiers at the chain.
        const failure = describeAwsFailure(error);
        if (failure.redacted) {
          this.logger.debug(
            maskerOrIdentity(context?.maskSecrets)(
              `PutRepositoryTriggers failed for CodeCommit Repository ${logicalId}: ${failure.detail}`
            )
          );
        }
        const triggersError = new Error(
          `PutRepositoryTriggers failed with ${retainedCount} live trigger(s) the desired ` +
            `Triggers does not name kept beside the desired ones (the recorded Triggers is ` +
            `not a list cdkd can read; CodeCommit allows at most 10 triggers per ` +
            `repository): ${failure.summary}`,
          { cause: error }
        );
        throw failure.redacted ? markRedactedCause(triggersError) : triggersError;
      }
      this.logger.debug(
        `Updated triggers for ${currentName} (${newSdkTriggers.length} trigger(s))`
      );
    }

    // Get current attributes (re-read so rename / description / key
    // updates above are reflected).
    metadata = await this.getRepositoryMetadata(currentName);
    this.renamesStarted.delete(physicalId);

    return {
      physicalId: currentName,
      wasReplaced: false,
      attributes: this.toAttributes(metadata),
    };
  } catch (error) {
    // A refusal (go-to-k/cdkd#4042) already names the resource and carries
    // its non-retryable mark.
    if (error instanceof ProvisioningError) throw error;
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update CodeCommit Repository ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

/**
 * Read the DESIRED lists of a create or update, refusing a malformed one
 * before any call (go-to-k/cdkd#3989). The caller passes its own literal read
 * of each property so the call site shows (and a grep finds) which property
 * feeds the calls. `physicalId` is set on the update path.
 */
export function readDesiredLists(
  this: CodeCommitRepositoryProvider,
  logicalId: string,
  resourceType: string,
  values: Record<RepoListKind, unknown>,
  physicalId: string | undefined
): Record<RepoListKind, Record<string, unknown>[]> {
  const kinds: RepoListKind[] = ['Triggers', 'Tags'];
  const out = {} as Record<RepoListKind, Record<string, unknown>[]>;
  const bad: RepoListKind[] = [];
  const secret: RepoListKind[] = [];
  for (const kind of kinds) {
    const read = readRepoList(kind, values[kind], 'desired');
    if (read.kind === 'list') {
      out[kind] = read.items;
    } else {
      bad.push(kind);
      if (read.onlySecret) secret.push(kind);
    }
  }
  if (bad.length === 0) return out;
  const updating = physicalId !== undefined;
  throw markNonRetryable(
    new ProvisioningError(
      `${updating ? 'desired ' : ''}${bad.join(' / ')} of CodeCommit Repository ${logicalId} ` +
        `is not a list of ${bad.map((k) => REPO_LIST_WHAT[k]).join(' / ')}` +
        (secret.length > 0
          ? ` (${secret.join(' / ')} holds a dynamic reference or its mask where a name ` +
            `belongs, which names nothing CodeCommit holds)`
          : '') +
        ` — the repository was not ${updating ? 'updated' : 'created'}`,
      resourceType,
      logicalId,
      physicalId
    )
  );
}

/**
 * Refuse an update whose recorded name is now held by a repository that is
 * not the recorded one (go-to-k/cdkd#4157): nothing is sent to it. Any other
 * failure to read it fails the update as before, retryable.
 */
export async function assertRecordedHolder(
  this: CodeCommitRepositoryProvider,
  logicalId: string,
  resourceType: string,
  physicalId: string,
  recordedId: string,
  mask: MaskerFn
): Promise<void> {
  let holder: RepositoryMetadata | undefined;
  try {
    holder = await this.getRepositoryMetadata(physicalId);
  } catch (error) {
    throw this.wrapHolderReadError(logicalId, resourceType, physicalId, error, mask);
  }
  if (holder?.repositoryId !== undefined && holder.repositoryId !== recordedId) {
    throw this.wrapNotThisRepositoryError(logicalId, resourceType, physicalId, 'recorded-name');
  }
}

/**
 * The update's failed identity read, wrapped. The class, never AWS's text
 * (it quotes the caller's role and session); a redacted message is stamped
 * so the retry classifier still reads the cause's text (an IAM grant still
 * propagating, go-to-k/cdkd#2302). AWS's text goes to `debug`, and the class
 * is masked too: it is AWS-authored text (go-to-k/cdkd#2319).
 */
export function wrapHolderReadError(
  this: CodeCommitRepositoryProvider,
  logicalId: string,
  resourceType: string,
  physicalId: string,
  error: unknown,
  mask: MaskerFn
): ProvisioningError {
  const failure = describeAwsFailure(error);
  if (failure.redacted) {
    this.logger.debug(
      mask(
        `GetRepository failed while checking the holder of CodeCommit Repository ${logicalId}: ${failure.detail}`
      )
    );
  }
  const wrapped = new ProvisioningError(
    `Failed to update CodeCommit Repository ${logicalId}: ${mask(failure.summary)}`,
    resourceType,
    logicalId,
    physicalId,
    error instanceof Error ? error : undefined
  );
  return failure.redacted ? markRedactedCause(wrapped) : wrapped;
}

/**
 * The live trigger set, for a recorded `Triggers` cdkd cannot read
 * (go-to-k/cdkd#3989). A failed read throws before any write; it is not
 * marked non-retryable, since a throttled read is worth the retry.
 */
export async function readLiveTriggers(
  this: CodeCommitRepositoryProvider,
  logicalId: string,
  repositoryName: string,
  renamedTo: string | undefined,
  recordedId: string | undefined,
  resourceType: string
): Promise<RepositoryTrigger[]> {
  try {
    // A retry after the rename already landed finds the old name gone
    // (`undefined` here), so it reads under the new one.
    const first = await this.getClient()
      .send(new GetRepositoryTriggersCommand({ repositoryName }))
      .catch((error: unknown) => {
        if (renamedTo === undefined || !(error instanceof RepositoryDoesNotExistException)) {
          throw error;
        }
        return undefined;
      });
    if (first === undefined) {
      // Only this resource's own repository is read under the new name.
      await this.verifyRenamedRepository(
        logicalId,
        resourceType,
        repositoryName,
        renamedTo as string,
        recordedId
      );
    }
    const resp =
      first ??
      (await this.getClient().send(
        new GetRepositoryTriggersCommand({ repositoryName: renamedTo as string })
      ));
    return resp.triggers ?? [];
  } catch (error) {
    if (error instanceof ProvisioningError) throw error;
    throw new ProvisioningError(
      `the recorded Triggers of CodeCommit Repository ${logicalId} is not a list cdkd can ` +
        `read, and the triggers could not be read from CodeCommit instead — the repository ` +
        `was not updated`,
      resourceType,
      logicalId,
      repositoryName,
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * The rename-retry probe's identity check (go-to-k/cdkd#4042,
 * go-to-k/cdkd#4051). The old name is gone; accept the repository holding
 * `newName` only when its id is one this resource is KNOWN to have: the
 * `RepositoryId` cdkd recorded for it (`UpdateContext.recordedAttributes`),
 * or the id this instance read just before starting the rename. A holder
 * with any other id is refused with nothing sent to it: adopting it would
 * overwrite its description, key, tags and triggers and record it as this
 * resource, which a later destroy deletes. With NO known id (a record from
 * before the attribute existed, and no rename started by this run) the
 * holder cannot be verified, so it is refused too, naming the manual
 * re-adoption.
 */
export async function verifyRenamedRepository(
  this: CodeCommitRepositoryProvider,
  logicalId: string,
  resourceType: string,
  oldName: string,
  newName: string,
  recordedId: string | undefined
): Promise<void> {
  const known = [recordedId, this.renamesStarted.get(oldName)].filter(
    (id): id is string => id !== undefined
  );
  const holder = await this.getRepositoryMetadata(newName);
  // The id alone identifies the repository, whatever name it now holds.
  if (holder?.repositoryId !== undefined && known.includes(holder.repositoryId)) return;
  const intro =
    safeMsg`CodeCommit Repository ${logicalId} no longer exists under the name cdkd recorded, and ` +
    `the repository holding the desired RepositoryName is not this resource's`;
  if (known.length > 0) {
    throw this.wrapNotThisRepositoryError(logicalId, resourceType, oldName, 'desired-name');
  }
  throw markNonRetryable(
    new ProvisioningError(
      `${intro} as far as cdkd can verify (its record holds no RepositoryId, and this run ` +
        `started no rename of this resource) — nothing was sent to that repository. If it is ` +
        `this resource's repository (an earlier deploy renamed it and stopped before ` +
        `recording the new name), first confirm it is yours (\`aws codecommit get-repository\` ` +
        `shows its id, ARN, description and creation date), and re-adopt it only then; ` +
        `otherwise choose a RepositoryName no other repository holds.\nRe-adopt with:\n` +
        // Unwrapped, on its own line, last; every value through the shared
        // gate (a hole when it cannot be printed exactly, or is not inert
        // with its quotes stripped, go-to-k/cdkd#4205). The joining `=` is
        // mid-word, which the measured predicate admits.
        pasteableCommand('cdkd import', [
          { hole: 'stack' },
          {
            flag: '--resource',
            value: `${logicalId}=${newName}`,
            hole: 'logicalId=repositoryName',
          },
          { literal: '--force' },
        ]).command,
      resourceType,
      logicalId,
      oldName
    )
  );
}

/**
 * The refusal for a repository whose id is KNOWN not to be this resource's
 * (go-to-k/cdkd#4042, go-to-k/cdkd#4051): nothing is sent to it, and no
 * re-adoption is offered. `which` names the repository by role, never by
 * name.
 */
export function wrapNotThisRepositoryError(
  this: CodeCommitRepositoryProvider,
  logicalId: string,
  resourceType: string,
  physicalId: string,
  which: 'recorded-name' | 'desired-name'
): ProvisioningError {
  // The remedy depends on WHICH name a foreign repository holds: a new
  // RepositoryName clears a collision on the desired name, but not one on the
  // recorded name, which every later update is addressed to.
  const remedy =
    which === 'desired-name'
      ? `The repository holding the desired RepositoryName is not this resource's (its ` +
        `repository id is not the one cdkd holds for this resource) — nothing was sent to ` +
        `that repository. If this resource's repository was renamed outside cdkd and you ` +
        `can find it, set RepositoryName to its current name: cdkd adopts it by the ` +
        `repository id it holds. If it was deleted outside cdkd, drop ` +
        `this resource's record and set RepositoryName to a name no repository holds, so the ` +
        `next deploy creates a new repository (fill in the resource's construct path):\n` +
        pasteableCommand('cdkd orphan', [{ hole: 'constructPath' }]).command
      : `The repository cdkd recorded for this resource no longer holds its recorded name ` +
        `(it was deleted or renamed outside cdkd), and the repository now holding that name ` +
        `is not this resource's (its repository id is not the one cdkd holds) — nothing was ` +
        `sent to that repository. Changing RepositoryName does not clear this. Leave that ` +
        `repository alone. If the recorded repository was renamed and you can find it, ` +
        `re-adopt it under its new name with ${cdkdRemedy('cdkd import')} (--resource, --force) instead; ` +
        `otherwise drop this resource's record and set RepositoryName to a name no ` +
        `repository holds, so the next deploy creates a new repository (fill in the ` +
        `resource's construct path):\n` +
        pasteableCommand('cdkd orphan', [{ hole: 'constructPath' }]).command;
  return markNonRetryable(
    new ProvisioningError(
      safeMsg`CodeCommit Repository ${logicalId}: ` + remedy,
      resourceType,
      logicalId,
      physicalId
    )
  );
}
