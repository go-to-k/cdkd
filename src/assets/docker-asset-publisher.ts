import {
  ECRClient,
  GetAuthorizationTokenCommand,
  DescribeImagesCommand,
} from '@aws-sdk/client-ecr';
import type { DockerImageAsset } from '../types/assets.js';
import {
  describeDockerFailure,
  redactedDockerCause,
  formatDockerLoginError,
  runDockerStreaming,
} from '../utils/docker-cmd.js';
import { getLogger } from '../utils/logger.js';
import { AssetError } from '../utils/error-handler.js';
import { displayIdent } from '../utils/display-safe.js';
import { buildDockerImage } from './docker-build.js';
import { derivePartitionAndUrlSuffix } from '../utils/aws-partition.js';
import { ambientClientDefaults } from '../utils/ambient-client-defaults.js';

/**
 * The ECR registry host suffix for a region (issue #1745).
 *
 * Every registry URI here was hardcoded to `amazonaws.com`, so outside the
 * commercial partition cdkd built a hostname that does not resolve —
 * `aws-cn` registries live under `amazonaws.com.cn`, and `us-iso*` under
 * `c2s.ic.gov` / `sc2s.sgov.gov`. Commercial output is byte-identical, which is
 * what makes the change safe to ship without a non-commercial account.
 */
function ecrUrlSuffix(region: string): string {
  return derivePartitionAndUrlSuffix(region).urlSuffix;
}

/** An AWS account id: exactly twelve digits. */
const ACCOUNT_ID = /^\d{12}$/;

/**
 * The DNS-label charset a region id is drawn from (a trailing hyphen is not
 * refused; the host stays under the AWS-owned suffix either way).
 * `src/utils/ecr-uri.ts` holds the same class for the pull side.
 */
const REGION_LABEL = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/**
 * The ECR registry host an asset is pushed to. The push URI AND the
 * `docker login` endpoint are both built from this one value, so the login
 * always targets the host the push uses (issue #3681).
 *
 * The region comes from the asset manifest, and the ECR password is sent to
 * this host, so both halves are charset-gated HERE: a region like
 * `x.example.com/` would otherwise name a host AWS does not own. The suffix is
 * the AWS-owned one `derivePartitionAndUrlSuffix` returns. A known-region
 * check is deliberately absent, so a region cdkd has not heard of yet still
 * publishes.
 */
function ecrRegistryHost(accountId: string, region: string): string {
  if (typeof accountId !== 'string' || !ACCOUNT_ID.test(accountId)) {
    throw new AssetError(
      `Refusing to publish a Docker image asset: ${displayIdent(accountId)} is not a 12-digit AWS account id`
    );
  }
  if (typeof region !== 'string' || region.length > 63 || !REGION_LABEL.test(region)) {
    throw new AssetError(
      `Refusing to publish a Docker image asset: the destination region ${displayIdent(region)} is not a valid AWS region id`
    );
  }
  return `${accountId}.dkr.ecr.${region}.${ecrUrlSuffix(region)}`;
}

/**
 * Whether a `docker push` failure looks like an ECR authentication failure
 * (missing / stale / expired credential) rather than a network / repo / other
 * error. Case-insensitive. Used by the lazy-login path to decide whether to
 * log in and retry — a NON-auth failure is surfaced unchanged, never retried.
 */
export function isDockerAuthFailure(errText: string): boolean {
  return /no basic auth credentials|unauthorized|authentication required|denied|\b401\b|\b403\b/i.test(
    errText
  );
}

/**
 * Publishes Docker image assets to ECR
 *
 * Handles:
 * - Placeholder resolution
 * - Existence check (skip if already pushed)
 * - docker build with Dockerfile, build args, target
 * - lazy ECR authentication (push first, log in only on an auth failure)
 * - docker tag + docker push
 */
export class DockerAssetPublisher {
  private logger = getLogger().child('DockerAssetPublisher');

  /**
   * Publish a Docker image asset to ECR
   */
  async publish(
    assetHash: string,
    asset: DockerImageAsset,
    cdkOutputDir: string,
    accountId: string,
    region: string
  ): Promise<void> {
    for (const [, dest] of Object.entries(asset.destinations)) {
      const repositoryName = this.resolvePlaceholders(dest.repositoryName, accountId, region);
      const imageTag = this.resolvePlaceholders(dest.imageTag, accountId, region);
      const destRegion = dest.region
        ? this.resolvePlaceholders(dest.region, accountId, region)
        : region;

      const registryHost = ecrRegistryHost(accountId, destRegion);
      const ecrUri = `${registryHost}/${repositoryName}:${imageTag}`;

      this.logger.debug(`Publishing Docker image ${asset.displayName || assetHash} → ${ecrUri}`);

      const client = new ECRClient({ ...ambientClientDefaults(), region: destRegion });

      try {
        // Check if image already exists
        if (await this.imageExists(client, repositoryName, imageTag)) {
          this.logger.debug(`Image already exists, skipping: ${ecrUri}`);
          continue;
        }

        // Build Docker image
        const localTag = `cdkd-asset-${assetHash}`;
        // `cdkOutputDir` as the bound, explicitly. This all-in-one `publish`
        // has NO production caller — `AssetPublisher` drives `build` and
        // `push` as separate graph nodes and threads `data.assetOutdir` — so
        // there is no Stage-aware outdir to pass here. The manifest directory
        // NARROWS relative to the app outdir, so this arm is stricter, never
        // looser (go-to-k/cdkd#3532).
        await this.buildImage(asset, cdkOutputDir, localTag, cdkOutputDir);

        // Tag and push (login lazily, only if the push hits an auth failure).
        await this.tagAndPushWithLazyLogin(client, localTag, ecrUri, registryHost);

        this.logger.debug(`✅ Published: ${ecrUri}`);
      } finally {
        client.destroy();
      }
    }
  }

  /**
   * Build a Docker image (public, used by WorkGraph asset-build nodes).
   *
   * For `directory` source mode the build tags the result as `localTag`
   * directly via `docker build -t`. For `executable` source mode the
   * user-supplied script returns its own tag; cdkd re-tags it to `localTag`
   * via `docker tag` so the downstream `push()` step (which is wired to
   * `localTag` at graph-construction time) keeps working unchanged.
   */
  async build(
    asset: DockerImageAsset,
    cdkOutputDir: string,
    localTag: string,
    /**
     * The app's outdir — the containment bound for a relative
     * `source.directory` and the warning bound for an absolute one.
     * REQUIRED, so that omitting it is a type error (go-to-k/cdkd#3532):
     * `DockerBuildNodeData.assetOutdir` is itself required, so the production
     * caller cannot drop it, and leaving this entry point optional kept the
     * drop expressible one layer out.
     */
    assetOutdir: string
  ): Promise<void> {
    await this.buildImage(asset, cdkOutputDir, localTag, assetOutdir);
  }

  /**
   * Push a pre-built Docker image to ECR (public, used by WorkGraph asset-publish nodes)
   */
  async push(
    asset: DockerImageAsset,
    accountId: string,
    region: string,
    localTag: string
  ): Promise<void> {
    for (const [, dest] of Object.entries(asset.destinations)) {
      const repositoryName = this.resolvePlaceholders(dest.repositoryName, accountId, region);
      const imageTag = this.resolvePlaceholders(dest.imageTag, accountId, region);
      const destRegion = dest.region
        ? this.resolvePlaceholders(dest.region, accountId, region)
        : region;

      const registryHost = ecrRegistryHost(accountId, destRegion);
      const ecrUri = `${registryHost}/${repositoryName}:${imageTag}`;

      const client = new ECRClient({ ...ambientClientDefaults(), region: destRegion });

      try {
        if (await this.imageExists(client, repositoryName, imageTag)) {
          this.logger.debug(`Image already exists, skipping: ${ecrUri}`);
          continue;
        }

        await this.tagAndPushWithLazyLogin(client, localTag, ecrUri, registryHost);

        this.logger.debug(`✅ Published: ${ecrUri}`);
      } finally {
        client.destroy();
      }
    }
  }

  /**
   * Check if image exists in ECR
   */
  private async imageExists(
    client: ECRClient,
    repositoryName: string,
    imageTag: string
  ): Promise<boolean> {
    try {
      const response = await client.send(
        new DescribeImagesCommand({
          repositoryName,
          imageIds: [{ imageTag }],
        })
      );
      return (response.imageDetails?.length ?? 0) > 0;
    } catch (error) {
      const err = error as { name?: string };
      if (err.name === 'ImageNotFoundException' || err.name === 'RepositoryNotFoundException') {
        return false;
      }
      throw error;
    }
  }

  /**
   * Build Docker image — delegates to the shared `buildDockerImage`
   * helper so this code path stays in sync with `cdkd local run-task`'s
   * `ContainerImage.fromAsset` build path (the other caller; `cdkd local
   * invoke` moved to `cdk-local`'s own builder). `--platform` is read from the asset
   * manifest's `source.platform` (when set); cdkd does not currently
   * inject a publish-side override.
   *
   * `buildDockerImage` returns the actual local tag. For `directory`
   * source mode that's always `tag`. For `executable` source mode the
   * user's script returns its own tag; we re-tag via `docker tag` so the
   * downstream push step finds the image under the deterministic
   * `cdkd-asset-<hash>` name it expects.
   */
  private async buildImage(
    asset: DockerImageAsset,
    cdkOutputDir: string,
    tag: string,
    /** See {@link DockerAssetPublisher.build}; required for its reason. */
    assetOutdir: string
  ): Promise<void> {
    const actualTag = await buildDockerImage(asset, cdkOutputDir, {
      tag,
      assetOutdir,
      wrapError: (stderr) => new AssetError(`Docker build failed: ${stderr}`),
    });
    if (actualTag !== tag) {
      this.logger.debug(`Re-tagging executable-built image '${actualTag}' → '${tag}'`);
      try {
        await this.tagImage(actualTag, tag);
      } catch (err) {
        // `this.tagImage` ALREADY wrapped the spawn failure in an AssetError
        // carrying a redacted cause, so re-wrapping `err` here would render
        // the message a second time and copy `AssetError`'s own class token
        // into the cause's `code` as a fabricated classification. Adopt the
        // inner cause, which is the one holding docker's exit status.
        const e = err as { message?: string; cause?: unknown };
        throw new AssetError(
          `Docker tag failed re-tagging '${actualTag}' → '${tag}': ${e.message ?? String(err)}`,
          e.cause instanceof Error ? e.cause : redactedDockerCause(err, ['tag', actualTag, tag])
        );
      }
    }
  }

  /**
   * Tag then push an image, logging in to ECR lazily — only if the push fails
   * with an auth-failure signature.
   *
   * cdkd (like `cdk --hotswap`) leans on the developer's persistent docker
   * credential store: a valid ECR credential (`~/.docker/config.json` /
   * keychain; ECR tokens live ~12h) left by an earlier login this session lets
   * a fresh cdkd process push with NO `GetAuthorizationToken` + `docker login`
   * round-trip (~3.3s saved). We attempt the push FIRST and only pay the login
   * when it is actually needed:
   *
   *   1. Push optimistically. A login earlier in this process (or session)
   *      left a credential in docker's store, so a repeat push to the same
   *      registry needs no new login — docker's store is the only login cache.
   *   2. On a NON-auth failure (network, repo-not-found, etc.) surface the
   *      error unchanged. On an auth failure (no pre-existing cred, OR a
   *      stale/expired cred), log in to ECR and retry the push ONCE.
   *
   * A stale cred and a missing cred take the SAME branch, so cdkd never
   * fail-hard on an expired credential — it re-logs in and retries.
   */
  private async tagAndPushWithLazyLogin(
    client: ECRClient,
    localTag: string,
    fullUri: string,
    registryHost: string
  ): Promise<void> {
    await this.tagImage(localTag, fullUri);

    try {
      await this.pushImage(fullUri);
      return;
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      const errText = e.stderr || e.message || String(err);
      if (!isDockerAuthFailure(errText)) {
        // Non-auth failure (network, repo-not-found, ...) — surface unchanged.
        throw err;
      }
      this.logger.debug(
        `Docker push to ${fullUri} failed with an auth error; logging in to ECR and retrying`
      );
    }

    // Auth failure: log in afresh, then retry the push exactly once.
    await this.ecrLogin(client, registryHost);
    await this.pushImage(fullUri);
  }

  /**
   * Authenticate with ECR via `docker login --password-stdin`, against
   * `registryHost` — the host the push targets (`ecrRegistryHost`).
   *
   * Called only after a push failed auth, so it always logs in: a repeat push
   * to a registry already logged in to succeeds on the credential docker
   * stored and never reaches here (#1193).
   */
  private async ecrLogin(client: ECRClient, registryHost: string): Promise<void> {
    const response = await client.send(new GetAuthorizationTokenCommand({}));
    const authData = response.authorizationData?.[0];

    if (!authData?.authorizationToken) {
      throw new AssetError('Failed to get ECR authorization token');
    }

    const token = Buffer.from(authData.authorizationToken, 'base64').toString();
    const [username, password] = token.split(':');
    if (!username || password === undefined) {
      throw new AssetError(
        'ECR authorization token has unexpected shape (missing username/password)'
      );
    }
    // Log in to the host the push targets, never `authData.proxyEndpoint`
    // (issue #3681): the request carries no `registryIds`, so `proxyEndpoint`
    // names the CALLER's default registry, and docker keys credentials on the
    // hostname verbatim. It equals the push host only while the push account is
    // the caller's own; `registryHost` is the push URI's host by construction
    // (both come from `ecrRegistryHost`). Same rule as `src/local/ecr-puller.ts`
    // on the pull side (#3670).
    const endpoint = `https://${registryHost}`;

    const loginArgs = ['login', '--username', username, '--password-stdin', endpoint];
    try {
      await runDockerStreaming(loginArgs, { input: password });
    } catch (err) {
      throw new AssetError(
        `ECR login failed: ${formatDockerLoginError(describeDockerFailure(err, loginArgs), endpoint)}`,
        redactedDockerCause(err, loginArgs)
      );
    }
  }

  /**
   * Tag Docker image
   */
  private async tagImage(source: string, target: string): Promise<void> {
    const tagArgs = ['tag', source, target];
    try {
      await runDockerStreaming(tagArgs);
    } catch (err) {
      throw new AssetError(
        `Docker tag failed: ${describeDockerFailure(err, tagArgs)}`,
        redactedDockerCause(err, tagArgs)
      );
    }
  }

  /**
   * Push Docker image. Streams progress to stdout/stderr (via
   * `runDockerStreaming`) when the logger is at debug level, otherwise
   * captures silently and surfaces stderr on non-zero exit.
   */
  private async pushImage(uri: string): Promise<void> {
    this.logger.debug(`Pushing: ${uri}`);
    const pushArgs = ['push', uri];
    try {
      await runDockerStreaming(pushArgs);
    } catch (err) {
      throw new AssetError(
        `Docker push failed: ${describeDockerFailure(err, pushArgs)}`,
        redactedDockerCause(err, pushArgs)
      );
    }
  }

  /**
   * Replace placeholders in destination values
   */
  private resolvePlaceholders(
    value: string,
    accountId: string,
    region: string,
    partition = 'aws'
  ): string {
    return value
      .replace(/\$\{AWS::AccountId\}/g, accountId)
      .replace(/\$\{AWS::Region\}/g, region)
      .replace(/\$\{AWS::Partition\}/g, partition);
  }
}
