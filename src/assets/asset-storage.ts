import { S3Client } from '@aws-sdk/client-s3';
import { ECRClient } from '@aws-sdk/client-ecr';
import { getLogger } from '../utils/logger.js';
import { awsClientDefaults } from '../utils/aws-client-defaults.js';
import { CdkdError } from '../utils/error-handler.js';
import { describeAwsFailure } from '../utils/aws-failure-text.js';
import type { S3StateBackend } from '../state/s3-state-backend.js';
import { canonicalizeRegion } from '../utils/aws-partition.js';
import { pasteableCommand } from '../utils/pasteable-command.js';
import { s3ClientDefaults } from '../utils/s3-client-defaults.js';
import {
  getBootstrapMarkerKey,
  readBootstrapMarkerBody,
  type AssetMode,
  quotedIfPlain,
  parseBootstrapMarker,
} from './asset-storage/marker.js';
import { verifyAssetStorageExists } from './asset-storage/verify.js';
import { ensureAssetStorage } from './asset-storage/ensure.js';

/**
 * cdkd-owned asset storage — naming, bootstrap marker, and deploy-time
 * asset-mode detection (issue #1002, design at
 * docs/design/1002-cdkd-asset-storage.md).
 *
 * Why this exists: cdkd publishes assets to the CDK bootstrap bucket / ECR
 * repo, but `cdk gc` decides "in use" by scanning CloudFormation stack
 * templates — cdkd-deployed stacks have no CFn stack, so every cdkd-published
 * asset looks isolated and gets deleted. The fix is cdkd-owned asset storage
 * created by `cdkd bootstrap` (structurally out of `cdk gc`'s reach because
 * gc only discovers storage from the CDK bootstrap stack's outputs).
 *
 * The upgrade is strictly transparent: deploys behave byte-identically to
 * before until the user re-runs `cdkd bootstrap` for a region, which writes a
 * per-region marker object into the state bucket. Deploy reads the marker to
 * pick the mode; PR 2 of the phasing wires the actual publish redirection +
 * template rewrite onto the `cdkd-assets` mode resolved here.
 */

export {
  ASSET_SUPPORT_VERSION,
  BOOTSTRAP_MARKER_PREFIX,
  getCdkdAssetBucketName,
  getCdkdContainerRepoName,
} from './asset-storage/names.js';
export { isCrossRegionRedirect, assertAssetBucketRegion } from './asset-storage/bucket-region.js';
export {
  getBootstrapMarkerKey,
  readBootstrapMarkerBody,
  validateAssetBucketName,
  validateContainerRepoName,
  parseBootstrapMarker,
} from './asset-storage/marker.js';
export type { BootstrapMarkerRead, BootstrapMarker, AssetMode } from './asset-storage/marker.js';
export { verifyAssetStorageExists } from './asset-storage/verify.js';
export { ensureAssetStorage } from './asset-storage/ensure.js';
export type { EnsureAssetStorageOptions } from './asset-storage/ensure.js';

/**
 * Deploy-time asset-mode resolver. One instance per CLI invocation; results
 * are cached per region for the process lifetime (the marker read is one
 * GetObject against a bucket every deploy already reads — design §4.1).
 *
 * In legacy mode, one `logger.info` line per legacy region per invocation
 * mentions the `cdk gc` hazard and the exact `cdkd bootstrap --region <r>`
 * opt-in command (info, not warn — existing users are not doing anything
 * wrong; design §12.2). Per-region because opt-in is keyed by each stack's
 * deploy region: a multi-region app can be opted in for one region and
 * legacy for another, and a region-less notice reads as a false negative to
 * a user who just bootstrapped a different region.
 */
export class AssetModeResolver {
  private logger = getLogger().child('AssetMode');
  private cache = new Map<string, Promise<AssetMode>>();
  /**
   * NOT load-bearing today — defense-in-depth only. `resolve` sets `cache`
   * synchronously before the first await, so `doResolve` runs at most once per
   * canonical region, and the notice arm always returns successfully so the
   * failure-eviction path cannot re-enter it. This Set was already ineffective
   * BEFORE the issue #2021 fold (two spellings simply made two entries), so it
   * is not a regression that fold introduced. Kept so removing or bypassing the
   * cache cannot silently turn the notice into one line per resolve.
   */
  private legacyNoticeShownRegions = new Set<string>();
  private stateBackend: S3StateBackend;
  private accountId: string;
  private profile: string | undefined;
  private useCdkBootstrapAssets: boolean;
  private suppressLegacyNotice: boolean;
  private autoCreate: { confirm: (region: string) => Promise<boolean> } | undefined;

  constructor(
    stateBackend: S3StateBackend,
    accountId: string,
    opts: {
      profile?: string;
      /**
       * `--use-cdk-bootstrap-assets` / `cdk.json context.cdkd.useCdkBootstrapAssets`
       * (design §4.2): pin legacy mode for this invocation even when the
       * region's bootstrap marker exists — for apps deployed via both CFn
       * and cdkd during a migration window. Skips the marker read entirely
       * and also suppresses the legacy-mode `cdk gc` notice (the user made
       * an explicit storage choice — design §12.2).
       */
      useCdkBootstrapAssets?: boolean;
      /**
       * Skip the legacy-mode `cdk gc` info line. Used by commands whose
       * invocation publishes nothing (`diff`, `import`) — the notice's
       * "assets are published to..." wording only fits `deploy` /
       * `publish-assets`.
       */
      suppressLegacyNotice?: boolean;
      /**
       * Issue #1007 — auto-create the per-region asset storage on the first
       * deploy into a region with no bootstrap marker, instead of falling
       * back to legacy mode. Restores the "bootstrap once per account" UX:
       * asset storage is inherently regional (Lambda requires same-region
       * S3/ECR), but the per-region step no longer leaks into the workflow.
       * `confirm` gates creation (interactive prompt; `--yes` / non-TTY
       * callers log-and-return-true). A declined confirm or a failed
       * creation falls back to legacy mode + the gc notice — a deploy that
       * used to work must never start hard-failing because S3/ECR create
       * was denied. Only `deploy` passes this (and not under `--dry-run` /
       * `--skip-assets` — the latter would rewrite already-published legacy
       * references to a freshly created EMPTY bucket/repo);
       * `diff` / `import` / `publish-assets` never create resources.
       */
      autoCreate?: { confirm: (region: string) => Promise<boolean> };
    } = {}
  ) {
    this.stateBackend = stateBackend;
    this.accountId = accountId;
    this.profile = opts.profile;
    this.useCdkBootstrapAssets = opts.useCdkBootstrapAssets ?? false;
    this.suppressLegacyNotice = opts.suppressLegacyNotice ?? false;
    this.autoCreate = opts.autoCreate;
  }

  /**
   * Resolve the asset mode for a deploy region. Concurrent callers for the
   * same region share one in-flight resolution.
   *
   * The region arrives UNFOLDED (issue #2021): both deploy-time callers derive
   * it as `options.region || AWS_REGION || 'us-east-1'` and then
   * `stack.region || baseRegion`, so an env-agnostic stack under
   * `--region US-EAST-1` (or `AWS_REGION=US-EAST-1`) hands an upper-cased
   * spelling straight through. A stack whose `env.region` is pinned in CDK is
   * unaffected — `stack.region` comes from the Cloud Assembly and is canonical.
   *
   * Folding at THIS boundary rather than at each caller fixes two things at
   * once: the marker read below (which used to miss `cdkd-bootstrap/
   * us-east-1.json` and silently downgrade the whole region to LEGACY —
   * `cdk gc`-collectable — storage), and the CACHE, where `us-east-1` and
   * `US-EAST-1` occupied two slots and each re-probed S3.
   */
  resolve(rawRegion: string): Promise<AssetMode> {
    if (this.useCdkBootstrapAssets) {
      // Explicit per-app / per-invocation legacy pin: no marker read, no
      // notice — byte-identical to pre-#1002 behavior (design §4.2).
      return Promise.resolve({ mode: 'legacy' });
    }
    const region = canonicalizeRegion(rawRegion);
    // ASYMMETRY this fold introduces, stated rather than left to be found: the
    // cache is keyed by the CANONICAL region, so the first spelling resolved in
    // a run decides whether the raw key is ever probed. A canonical-region stack
    // resolving first caches `legacy`, and a later `--region US-EAST-1` stack
    // reuses that entry without ever probing `cdkd-bootstrap/US-EAST-1.json`.
    // Accepted deliberately over probing per RAW spelling: that would restore
    // the double-slot S3 re-probe this fold exists to remove, and it would buy
    // a key reachable only under the narrow conditions enumerated on
    // `readBootstrapMarkerBody`. The cheaper and permanent fix is #1820 aligning
    // the write side, after which no raw key is written at all.
    const cached = this.cache.get(region);
    if (cached) return cached;
    // The RAW spelling still travels to `doResolve` — it is what the marker's
    // second probe needs (see `readBootstrapMarkerBody`). Everything else,
    // including every AWS client this resolver builds, uses the canonical one.
    const inFlight = this.doResolve(region, rawRegion).catch((error: unknown) => {
      // Do not cache failures — a transient S3 error on the marker read
      // should not poison every later stack in the same run.
      this.cache.delete(region);
      throw error;
    });
    this.cache.set(region, inFlight);
    return inFlight;
  }

  private async doResolve(region: string, rawRegion: string): Promise<AssetMode> {
    const { body, resolvedKey } = await readBootstrapMarkerBody(this.stateBackend, rawRegion);

    if (body === null) {
      if (this.autoCreate) {
        // The auto-create WRITES through `ensureAssetStorage` with the
        // CANONICAL region, so its post-create read-back must use the canonical
        // key — not `resolvedKey`, which on a miss is the same value but is
        // reported by the reader rather than chosen by the writer.
        const created = await this.tryAutoCreate(region, getBootstrapMarkerKey(region));
        if (created) return created;
        // Declined or failed — fall through to legacy mode + the notice.
      }
      if (!this.legacyNoticeShownRegions.has(region) && !this.suppressLegacyNotice) {
        this.legacyNoticeShownRegions.add(region);
        // Name the exact region so users who already ran `cdkd bootstrap` in
        // another region (e.g. their CLI default) see WHY the notice still
        // fires — opt-in is per deploy region, keyed by each stack's
        // env.region, not the shell's default region.
        this.logger.info(
          `Assets for region ${quotedIfPlain(region, 'that is not a plain identifier')} are published to the CDK bootstrap bucket/repo, which 'cdk gc' may ` +
            `garbage-collect (cdkd-deployed stacks have no CloudFormation stack for gc to scan). ` +
            `Create cdkd-owned asset storage that 'cdk gc' never touches:` +
            `\nBootstrap with: ${
              pasteableCommand('cdkd bootstrap', [
                { flag: '--region', value: region, hole: 'region' },
              ]).command
            }`
        );
      }
      return { mode: 'legacy' };
    }

    const marker = parseBootstrapMarker(body, resolvedKey);
    await verifyAssetStorageExists(marker, this.accountId, region, {
      ...(this.profile && { profile: this.profile }),
    });
    this.logger.debug(
      `cdkd asset storage active for region '${region}': ` +
        `${marker.assetBucket} / ${marker.containerRepo}`
    );
    return { mode: 'cdkd-assets', marker };
  }

  /**
   * Issue #1007 — first deploy into an un-opted-in region: confirm, then
   * create the asset bucket + container repo + marker via the same
   * {@link ensureAssetStorage} `cdkd bootstrap` uses (squatting defense,
   * idempotent creation, marker-written-last all included). Returns `null`
   * (= stay legacy) when the user declines or creation fails — the caller
   * then shows the legacy notice, so the user still learns the exact
   * `cdkd bootstrap --region <r>` remediation.
   */
  private async tryAutoCreate(region: string, markerKey: string): Promise<AssetMode | null> {
    let confirmed: boolean;
    try {
      confirmed = await this.autoCreate!.confirm(region);
    } catch {
      // A broken prompt (closed stdin, readline error) must not fail the
      // deploy — treat it as a decline.
      confirmed = false;
    }
    if (!confirmed) {
      return null;
    }
    // Constructed inside the try so even a throwing client constructor
    // lands in the fail-open catch below instead of escaping to the deploy.
    let s3Client: S3Client | undefined;
    let ecrClient: ECRClient | undefined;
    try {
      s3Client = new S3Client({
        ...awsClientDefaults({ profile: this.profile }),
        ...s3ClientDefaults(),
        region,
        ...(this.profile && { profile: this.profile }),
      });
      ecrClient = new ECRClient({
        ...awsClientDefaults({ profile: this.profile }),
        region,
        ...(this.profile && { profile: this.profile }),
      });
      await ensureAssetStorage({
        s3Client,
        ecrClient,
        stateBackend: this.stateBackend,
        accountId: this.accountId,
        region,
        force: false,
      });
      const body = await this.stateBackend.getRawObject(markerKey);
      if (body === null) {
        throw new CdkdError(
          `bootstrap marker missing at '${markerKey}' right after creation`,
          'ASSET_STORAGE_MARKER_MISSING'
        );
      }
      const marker = parseBootstrapMarker(body, markerKey);
      this.logger.debug(
        `cdkd asset storage auto-created for region '${region}': ` +
          `${marker.assetBucket} / ${marker.containerRepo}`
      );
      return { mode: 'cdkd-assets', marker };
    } catch (error) {
      // Never hard-fail the deploy over a denied/failed storage creation —
      // legacy mode is exactly the pre-#1007 behavior and still works
      // wherever it worked before.
      const message = describeAwsFailure(error).detail;
      this.logger.warn(
        `Failed to auto-create cdkd asset storage for region ${quotedIfPlain(region, 'that is not a plain identifier')}: ${message} ` +
          `Falling back to the CDK bootstrap destinations for this run — opt the region ` +
          `in with S3/ECR create permissions.` +
          `\nBootstrap with: ${
            pasteableCommand('cdkd bootstrap', [
              { flag: '--region', value: region, hole: 'region' },
            ]).command
          }`
      );
      return null;
    } finally {
      s3Client?.destroy();
      ecrClient?.destroy();
    }
  }
}
