import {
  CreateCommitCommand,
  CreateRepositoryCommand,
  DeleteRepositoryCommand,
  PutRepositoryTriggersCommand,
  type PutFileEntry,
} from '@aws-sdk/client-codecommit';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import type { CodeCommitRepositoryProvider } from '../codecommit-repository-provider.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { generatedNameFor } from '../../resource-name.js';
import type { CreateContext, ResourceCreateResult } from '../../../types/resource.js';
import { markAuxiliaryFailure, markCreatedBeforeFailure } from '../../auxiliary-failure.js';
import { reportCreatedResource, retractCreatedResource } from '../../created-resource-sink.js';
import { maskerOrIdentity, type MaskerFn } from '../../masked-retry-logger.js';
import {
  DEFAULT_SEED_BRANCH,
  toSdkTagMap,
  toSdkTriggers,
  type CfnCode,
  type CfnTag,
  type CfnTrigger,
} from './shared.js';

/**
 * Create a CodeCommit Repository
 */
export async function create(
  this: CodeCommitRepositoryProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  this.logger.debug(`Creating CodeCommit Repository ${logicalId}`);

  // `RepositoryName` is required by the CFn schema, but generate a
  // defensive default for hand-written templates that omit it.
  // CodeCommit allows [A-Za-z0-9._-]{1,100}.
  const repositoryName =
    (properties['RepositoryName'] as string | undefined) ||
    generatedNameFor('AWS::CodeCommit::Repository', logicalId);

  // go-to-k/cdkd#3989: refused before CreateRepository, so a malformed list
  // never creates a repository missing the triggers or tags it declares.
  const lists = this.readDesiredLists(
    logicalId,
    resourceType,
    { Triggers: properties['Triggers'], Tags: properties['Tags'] },
    undefined
  );

  // go-to-k/cdkd#4583: the created repository's name while it is left live
  // (set on create, cleared once the post-create self-clean deleted it).
  let leftLiveName: string | undefined;
  try {
    const tags = toSdkTagMap(lists.Tags as CfnTag[]);
    const description = properties['RepositoryDescription'] as string | undefined;
    const kmsKeyId = properties['KmsKeyId'] as string | undefined;

    const response = await this.getCreateClient().send(
      new CreateRepositoryCommand({
        repositoryName,
        ...(description !== undefined ? { repositoryDescription: description } : {}),
        ...(kmsKeyId !== undefined ? { kmsKeyId } : {}),
        ...(tags ? { tags } : {}),
      })
    );

    const metadata = response.repositoryMetadata;
    if (!metadata?.repositoryName) {
      throw new Error('CreateRepository did not return repository metadata');
    }
    const createdName = metadata.repositoryName;
    leftLiveName = createdName;
    // go-to-k/cdkd#5511: report before the Code seed and triggers.
    reportCreatedResource(logicalId, resourceType, createdName);

    // Post-create orchestration (`Code` seed + `Triggers`). If either
    // fails, the repository already exists on AWS but the deploy engine's
    // rollback cannot delete it — `create()` throwing before returning a
    // physicalId means the engine never recorded one to roll back. So
    // self-clean: delete the just-created repository before re-throwing,
    // mirroring CloudFormation's rollback-deletes-the-repo behavior.
    try {
      const code = properties['Code'] as CfnCode | undefined;
      if (code) {
        await this.seedInitialCommit(createdName, code);
      }
      const triggers = lists.Triggers as CfnTrigger[];
      if (triggers.length > 0) {
        await this.getClient().send(
          new PutRepositoryTriggersCommand({
            repositoryName: createdName,
            triggers: toSdkTriggers(triggers),
          })
        );
        this.logger.debug(`Applied ${triggers.length} trigger(s) to ${createdName}`);
      }
    } catch (postCreateError) {
      this.logger.warn(
        `Post-create step failed for CodeCommit Repository ${logicalId}; deleting the ` +
          `just-created repository ${createdName} to avoid an orphan`
      );
      if (await this.bestEffortDelete(createdName, maskerOrIdentity(context?.maskSecrets))) {
        retractCreatedResource(logicalId, resourceType, leftLiveName);
        leftLiveName = undefined;
      }
      // The repository itself was created: an "already exists" from here is
      // an auxiliary object's, not this repository's name collision (#3826).
      throw markAuxiliaryFailure(postCreateError, logicalId);
    }

    this.logger.debug(`Successfully created CodeCommit Repository ${logicalId}: ${createdName}`);

    return {
      physicalId: createdName,
      attributes: this.toAttributes(metadata),
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapCaughtError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create CodeCommit Repository ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          repositoryName,
          cause
        )
    );
    // go-to-k/cdkd#4583: the self-clean delete failed, so the repository is
    // live with no state record; name it for the failed-CREATE journal.
    if (leftLiveName !== undefined) {
      markCreatedBeforeFailure(thrown, logicalId, resourceType, leftLiveName);
    }
    throw thrown;
  }
}

/**
 * Seed the repository's initial commit from the CFn `Code` property.
 *
 * CFn's `Code` orchestration downloads the S3 ZIP, unpacks it, and creates
 * the repository's first commit on `BranchName` (default `main`). cdkd
 * reproduces that here: `GetObject` the ZIP, unpack every file entry
 * (directories are implied by file paths — CodeCommit has no empty-dir
 * concept), and issue a single `CreateCommit` carrying all files as
 * `putFiles`. This is create-only: CFn ignores `Code` on update, and so
 * does cdkd (`update()` never calls this).
 *
 * A ZIP with no file entries is a no-op (warn + skip) rather than a hard
 * failure — CodeCommit rejects a `CreateCommit` with an empty `putFiles`.
 */
export async function seedInitialCommit(
  this: CodeCommitRepositoryProvider,
  repositoryName: string,
  code: CfnCode
): Promise<void> {
  const bucket = code.S3?.Bucket;
  const key = code.S3?.Key;
  if (typeof bucket !== 'string' || typeof key !== 'string' || !bucket || !key) {
    throw new Error('Code.S3 requires string Bucket and Key');
  }
  const versionId = typeof code.S3?.ObjectVersion === 'string' ? code.S3.ObjectVersion : undefined;
  const branchName =
    typeof code.BranchName === 'string' && code.BranchName ? code.BranchName : DEFAULT_SEED_BRANCH;

  // The S3 client is bound to the deploy region (`AWS_REGION`). CDK always
  // uploads a `Code` asset to the same-region bootstrap bucket, so a
  // cross-region `Code.S3.Bucket` (PermanentRedirect) is not expected here.
  const obj = await this.getS3Client().send(
    new GetObjectCommand({ Bucket: bucket, Key: key, ...(versionId && { VersionId: versionId }) })
  );
  if (!obj.Body) {
    throw new Error(`Code.S3 object s3://${bucket}/${key} returned an empty body`);
  }
  const zipBytes = await obj.Body.transformToByteArray();

  // Imported on use: every provider module is evaluated whenever a command
  // registers providers, and only a `Code`-seeded repository create needs a
  // zip reader.
  const { default: AdmZip } = await import('adm-zip');
  const zip = new AdmZip(Buffer.from(zipBytes));
  const putFiles: PutFileEntry[] = [];
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    putFiles.push({ filePath: entry.entryName, fileContent: entry.getData() });
  }
  if (putFiles.length === 0) {
    this.logger.warn(
      `Code.S3 object s3://${bucket}/${key} contained no files; skipping seed commit for ${repositoryName}`
    );
    return;
  }

  await this.getCreateClient().send(
    new CreateCommitCommand({
      repositoryName,
      branchName,
      commitMessage: 'Initial commit',
      putFiles,
    })
  );
  this.logger.debug(
    `Seeded ${repositoryName} with ${putFiles.length} file(s) on branch ${branchName}`
  );
}

/**
 * Best-effort delete used to roll back a just-created repository when a
 * post-create step (`Code` seed / `Triggers`) fails. Never throws — the
 * original post-create error is what the caller re-throws; a cleanup
 * failure is logged so the orphan is surfaced. Returns whether the delete
 * succeeded (go-to-k/cdkd#4583 marks a repository it left live).
 */
export async function bestEffortDelete(
  this: CodeCommitRepositoryProvider,
  repositoryName: string,
  mask: MaskerFn
): Promise<boolean> {
  try {
    await this.getClient().send(new DeleteRepositoryCommand({ repositoryName }));
    return true;
  } catch (cleanupError) {
    // An AWS-authored failure is named by its class at warn, and AWS's text
    // (a denied `DeleteRepository` names the caller) goes to `debug` under
    // the same head, both through the create's masker (go-to-k/cdkd#2319).
    const cleanupFailure = describeAwsFailure(cleanupError);
    const cleanupHead = `Failed to clean up CodeCommit Repository ${repositoryName} after a post-create failure: `;
    if (cleanupFailure.redacted) {
      this.logger.debug(mask(`${cleanupHead}${cleanupFailure.detail}`));
    }
    this.logger.warn(
      mask(
        `${cleanupHead}${cleanupFailure.redacted ? cleanupFailure.summary : cleanupFailure.detail}`
      )
    );
    return false;
  }
}
