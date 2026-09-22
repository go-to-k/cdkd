import { readFile } from 'fs/promises';
import { isAbsolute, resolve } from 'path';
import type { AssetManifest, DockerImageAsset, FileAsset } from '../types/assets.js';
import { displaySafe } from '../utils/display-safe.js';
import {
  absoluteAssemblyPathEscape,
  namesTheSameDirectory,
  renderAssemblyPathEscape,
  resolveAssemblyPath,
} from '../utils/assembly-path.js';
import { warnAbsoluteAssetPath, warnWholeAssemblyAsSource } from './absolute-asset-path-warning.js';
import { getLogger } from '../utils/logger.js';

/**
 * THE one spelling of "where does this file asset's source live", shared by
 * {@link AssetManifestLoader.getAssetSourcePath} and `FileAssetPublisher`
 * (issue [#3489](https://github.com/go-to-k/cdkd/issues/3489)).
 *
 * Both used to `join(cdkOutputDir, asset.source.path)` independently. The
 * manifest is chosen by whoever wrote the assembly, `path.join` folds `..`,
 * and the publisher ZIPs whatever it finds and `PutObject`s it to a bucket the
 * same manifest names — so an unchecked `source.path` is an exfiltration
 * primitive with the caller's own credentials, which is the harm the manifest
 * FILE's own containment check cites. One function so the loader and the
 * publisher cannot disagree about which file is published.
 *
 * **An ABSOLUTE `source.path` is HONOURED, and warned about when it leaves
 * `assetOutdir`** (issue
 * [#3532](https://github.com/go-to-k/cdkd/issues/3532)). It used to be neither
 * honoured nor refused: `resolveAssemblyPath` joins with `path.join`, which
 * does not honour a leading separator, so an absolute value was folded INTO
 * the outdir, read as CONTAINED, and died later at `statSync` with an `ENOENT`
 * naming a path that exists nowhere and that the user never wrote. Three
 * things decide the arm:
 *
 * - `cdk synth --no-staging` emits exactly this shape. Under
 *   `aws:cdk:disable-asset-staging` upstream `AssetStaging.relativeStagedPath`
 *   returns the staged path verbatim, so every `files[*].source.path` is the
 *   asset's absolute SOURCE directory, normally outside the outdir. Refusing it
 *   rejects the output of a documented CDK CLI flag.
 * - Upstream `cdk deploy` resolves the field with `path.resolve(manifestDir,
 *   p)`, which honours an absolute value and publishes it. Refusing here would
 *   make cdkd diverge from the CLI it is meant to complement.
 * - So for an ABSOLUTE value the warning is the whole signal, and no
 *   containment boundary is left.
 *
 * **State plainly what that gave up, because the first version of this comment
 * did not and was wrong.** It copied the local twin's line — "the relative arm
 * buys nothing against an adversary, who would write the absolute spelling" —
 * which is TRUE there and FALSE here, and the difference is the whole point.
 * `resolveAssetCodeDirectory` already honoured absolute paths before
 * [#3494](https://github.com/go-to-k/cdkd/issues/3494), so that change only
 * added a warning to an open door. HERE the door was SHUT: measured on
 * `path.resolve(path.join(base, c))`, `/Users/victim/.aws`, `/etc/passwd`,
 * `//etc/passwd` and `/etc/./passwd` all folded INSIDE the outdir and died at
 * `statSync`, `/../etc/passwd` was refused lexically, and a planted symlink
 * was refused by the symlink arm — so NO spelling reached an arbitrary host
 * file. Accidentally, but completely.
 *
 * What this opens, therefore, is real and new: a hand-written manifest can now
 * have any readable directory zipped to a bucket it names, with the operator's
 * credentials, gated only by the warning. It is accepted because upstream
 * `@aws-cdk/cdk-assets-lib` does the same with no containment at all
 * (`path.resolve(this.workDir, source.path)`, `private/handlers/files.js`), so
 * cdkd stays strictly MORE protective than the CLI it complements while still
 * running what `cdk synth --no-staging` emits. The relative arm still catches
 * an accidental or legacy `..` and costs nothing, which is why it stays — but
 * it is no longer a boundary against anyone who chose the value. The docs say
 * this to users in the same words; do not soften either copy.
 */
/**
 * The two values that decide what {@link resolveFileAssetSourcePath} does, as
 * a BAG rather than positionals (issue
 * [#3537](https://github.com/go-to-k/cdkd/issues/3537)).
 *
 * Both are `string`, and making each REQUIRED — which
 * [#3532](https://github.com/go-to-k/cdkd/issues/3532) did — catches a DROP
 * and not a TRANSPOSITION. A caller passing them the other way round compiled
 * and bound a prose clause to the containment bound. The same PR deleted
 * `FileAssetPublisher.publish`'s unused `profile` for that reason; this is the
 * shape that was left.
 */
export interface FileAssetResolveOptions {
  /**
   * The app's outdir, where `cdk synth` stages every asset — the containment
   * bound for a relative value and the warning bound for an absolute one.
   *
   * It used to be a positional that DEFAULTED to `manifestDir`, which is right
   * for a TOP-LEVEL stack and wrong for a Stage: `cdk synth` stages a Stage's
   * assets into the APP's outdir while the Stage's manifest sits in
   * `cdk.out/assembly-<Stage>/`, so upstream emits `source.path` of
   * `../asset.<hash>` by design and binding to the manifest directory refuses
   * every Stage asset (go-to-k/cdkd#3489's own defect). A caller with no
   * better answer passes `manifestDir` explicitly, which NARROWS and never
   * opens past the base.
   */
  assetOutdir: string;
  /**
   * What THIS caller does with the directory next, completing "cdkd will ...".
   * Caller-supplied; the reasoning is on `AbsoluteAssetPathWarning.sink`. Only
   * the ABSOLUTE arm renders it.
   */
  sink: string;
}

export function resolveFileAssetSourcePath(
  manifestDir: string,
  asset: FileAsset,
  opts: FileAssetResolveOptions
): string {
  const { assetOutdir, sink } = opts;
  if (isAbsolute(asset.source.path)) {
    // `path.resolve` only NORMALISES here, the value already being absolute;
    // it is what makes the warning name the directory that is really read
    // rather than an unfolded spelling of it.
    const absolute = resolve(asset.source.path);
    const escape = absoluteAssemblyPathEscape(assetOutdir, absolute);
    if (escape !== undefined) {
      warnAbsoluteAssetPath({
        subject: `File asset '${displaySafe(asset.displayName)}'`,
        field: 'source.path',
        absolute,
        escape,
        sink,
      });
    } else if (namesTheSameDirectory(assetOutdir, absolute)) {
      // Inside the bound, so `absoluteAssemblyPathEscape` says nothing — but
      // it IS the bound, which means the whole assembly is the source.
      // `namesTheSameDirectory`, never `===`: the escape check above
      // EXONERATES a second spelling of the bound as inside, so a lexical
      // equality here answers "not the bound" for exactly the values that
      // most need the line.
      warnWholeAssemblyAsSource({
        subject: `File asset '${displaySafe(asset.displayName)}'`,
        field: 'source.path',
        outdir: absolute,
        sink,
      });
    }
    return absolute;
  }
  // RESOLVE against the manifest's directory, CONTAIN within the app's
  // outdir. The two differ for a Stage: `cdk synth` stages a Stage's assets
  // into the app's outdir while the Stage's manifest sits in
  // `cdk.out/assembly-<Stage>/`, so upstream emits `source.path` of
  // `../asset.<hash>` by design — measured on aws-cdk-lib 2.268, no flags.
  // Containing against the manifest directory refused every Stage asset
  // (issue go-to-k/cdkd#3489).
  const resolved = resolveAssemblyPath(manifestDir, asset.source.path, {
    containWithin: assetOutdir,
  });
  // NAMING THE BOUND ITSELF is not an escape here, and the two arms must agree
  // about that — the absolute arm accepts a value equal to `assetOutdir`, so
  // the relative one cannot refuse the same directory. `resolveAssemblyPath`'s
  // `isInside` is false for an empty `path.relative` and the renderer then
  // says the value "names the directory ... rather than a file inside it",
  // which is true and useful for its other callers, every one of which READS A
  // FILE, and false here, where a file asset's source is a DIRECTORY by
  // design. Accepted HERE rather than by changing the shared helper, whose
  // refusal is right for a file. Mirrors the local twin
  // (`resolveAssetCodeDirectory`, go-to-k/cdkd#3494); no real synth emits `.`.
  //
  // **It WARNS, where the twin is silent, and the difference is the sink.**
  // The twin bind-mounts a directory; this layer zips it and uploads it to a
  // bucket the same manifest names, so accepting `.` silently means the whole
  // `cdk.out` leaves the machine with no line printed. A first revision of
  // this arm did exactly that, in the name of parity with the twin — parity of
  // the VERDICT is right, parity of the SILENCE is not.
  // The test is "IS the bound", not "lands inside it", and that asymmetry is
  // deliberate: with `<parent>/back -> cdk.out`, a value of `../back` is
  // accepted and warned while `../back/asset.abc` is still refused, though it
  // too lands inside the assembly. Fail-closed, and widening it would mean
  // re-deciding containment through links for every value, which is
  // `resolveAssemblyPath`'s job and not this arm's.
  if (!resolved.contained && namesTheSameDirectory(assetOutdir, resolved.path)) {
    warnWholeAssemblyAsSource({
      subject: `File asset '${displaySafe(asset.displayName)}'`,
      field: 'source.path',
      outdir: resolved.path,
      sink,
    });
    return resolved.path;
  }
  if (!resolved.contained) {
    throw new Error(
      `File asset '${displaySafe(asset.displayName)}' has ` +
        `source.path='${displaySafe(asset.source.path)}' which ` +
        `${renderAssemblyPathEscape(resolved, assetOutdir, 'publish it')}`
    );
  }
  return resolved.path;
}

/**
 * Whether a file asset's `source.path` is a CloudFormation template asset
 * (the stack template `<Stack>.template.json` or a nested-stack template
 * `<Stack>.<Nested>.nested.template.json`). cdkd deploys templates itself and
 * never needs them in the bootstrap bucket, so they are the ONLY file assets
 * excluded from publishing.
 *
 * `.template.json` is the reliable discriminator: a plain `.json` exclusion is
 * WRONG because a legitimate user file asset can be a `.json` file (e.g. a Step
 * Functions `DefinitionS3Location` ASL document, or an app config) whose source
 * path is `asset.<hash>.json` — those MUST be published. Shared by both file-
 * asset-selection sites ({@link AssetManifestLoader.getFileAssets} and
 * `AssetPublisher.addAssetsToGraph`) so they cannot drift.
 */
export function isCfnTemplateAssetPath(sourcePath: string): boolean {
  return sourcePath.endsWith('.template.json');
}

/**
 * Asset manifest loader
 *
 * Loads and parses CDK asset manifests from the CDK output directory
 */
export class AssetManifestLoader {
  private logger = getLogger().child('AssetManifestLoader');

  /**
   * Load asset manifest from CDK output directory
   *
   * @param cdkOutputDir CDK output directory (e.g., "cdk.out")
   * @param stackName Stack name
   * @returns Asset manifest or null if not found
   */
  async loadManifest(cdkOutputDir: string, stackName: string): Promise<AssetManifest | null> {
    // `stackName` is the manifest's own `properties.stackName` (falling back to
    // the artifact id), so it is assembly-supplied and becomes a FILENAME here
    // (issue go-to-k/cdkd#3489). A `../../..`-bearing one would read a
    // `.assets.json` from outside the assembly and publish whatever it lists.
    const resolved = resolveAssemblyPath(cdkOutputDir, `${stackName}.assets.json`);
    if (!resolved.contained) {
      throw new Error(
        `Asset manifest for stack '${displaySafe(stackName)}' ` +
          `${renderAssemblyPathEscape(resolved, cdkOutputDir)}`
      );
    }
    const manifestPath = resolved.path;

    try {
      this.logger.debug(`Loading asset manifest from: ${manifestPath}`);
      const content = await readFile(manifestPath, 'utf-8');
      const manifest = JSON.parse(content) as AssetManifest;

      this.logger.debug(
        `Loaded asset manifest: ${Object.keys(manifest.files).length} file assets, ` +
          `${Object.keys(manifest.dockerImages).length} docker image assets`
      );

      return manifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.logger.debug(`Asset manifest not found: ${manifestPath}`);
        return null;
      }

      throw new Error(
        `Failed to load asset manifest from ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get file assets from manifest (excludes CloudFormation templates)
   *
   * @param manifest Asset manifest
   * @returns Map of asset hash to file asset
   */
  getFileAssets(manifest: AssetManifest): Map<string, FileAsset> {
    const fileAssets = new Map<string, FileAsset>();

    for (const [assetHash, asset] of Object.entries(manifest.files)) {
      // Skip ONLY CloudFormation template assets (cdkd deploys templates
      // itself). A plain `.json` exclusion would wrongly drop legitimate user
      // `.json` file assets (e.g. a Step Functions DefinitionS3Location ASL
      // document) — see isCfnTemplateAssetPath.
      if (isCfnTemplateAssetPath(asset.source.path)) {
        this.logger.debug(`Skipping CloudFormation template asset: ${asset.displayName}`);
        continue;
      }

      fileAssets.set(assetHash, asset);
    }

    this.logger.debug(`Found ${fileAssets.size} file assets (excluding templates)`);
    return fileAssets;
  }

  /**
   * Get asset source path (absolute path)
   *
   * Refuses a RELATIVE `source.path` resolving outside `assetOutdir` (issue
   * [#3489](https://github.com/go-to-k/cdkd/issues/3489)); an ABSOLUTE one is
   * honoured and warned about instead (issue
   * [#3532](https://github.com/go-to-k/cdkd/issues/3532)) — see
   * {@link resolveFileAssetSourcePath} for why the two arms differ. The
   * manifest is assembly-supplied and `cdkd deploy -a <dir>` consumes a
   * pre-synthesized one, so a `source.path` of `../../../home/<user>/.aws`
   * would otherwise be packaged and uploaded to a bucket the SAME manifest
   * names.
   *
   * @param cdkOutputDir CDK output directory
   * @param asset File asset
   * @param assetOutdir The app's outdir — the containment / warning bound.
   *   REQUIRED for the reason {@link resolveFileAssetSourcePath}'s own
   *   parameter is: a dropped bound narrows to the manifest directory and
   *   silently refuses every Stage asset.
   * @returns Absolute path to asset source
   */
  getAssetSourcePath(
    cdkOutputDir: string,
    asset: FileAsset,
    opts: FileAssetResolveOptions
  ): string {
    return resolveFileAssetSourcePath(cdkOutputDir, asset, opts);
  }

  /**
   * Resolve asset destination values (replace ${AWS::AccountId}, ${AWS::Region}, etc.)
   *
   * @param value Value with placeholders
   * @param accountId AWS account ID
   * @param region AWS region
   * @param partition AWS partition (default: "aws")
   * @returns Resolved value
   */
  resolveAssetDestinationValue(
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

/**
 * Look up the docker-image asset that backs a Lambda's `Code.ImageUri`.
 *
 * The CDK template synthesizes `Code.ImageUri` as a `Fn::Sub` whose body
 * references the bootstrap ECR repo and ends in `:<hash>` — that hash is
 * the same key used in `manifest.dockerImages[<hash>]`. cdkd extracts the
 * hash by walking known image-URI shapes; on miss, when the manifest has
 * exactly one Docker image, we fall back to it (single-asset heuristic) so
 * locally-built non-bootstrapped images still work. This is documented as
 * a v1 limitation; immutable digest pins (`@sha256:<digest>`) hit the same
 * fallback path.
 *
 * Returns the `(hash, asset)` pair when matched, or `undefined` when both
 * the regex AND the single-asset fallback miss (typically: 0 docker assets,
 * or 2+ docker assets with no hash match — the caller should treat this as
 * "fall through to the ECR-pull path").
 *
 * Exported as a free function (not a method) so the local-invoke modules
 * can reuse it without depending on the `AssetManifestLoader` instance —
 * the manifest itself is a plain JSON shape.
 */
export function getDockerImageBySourceHash(
  manifest: AssetManifest,
  imageUri: string
): { hash: string; asset: DockerImageAsset } | undefined {
  const dockerImages = manifest.dockerImages ?? {};
  const entries = Object.entries(dockerImages);
  if (entries.length === 0) return undefined;

  // Try to extract the hash from the ImageUri tail. Match `:<hash>` (NOT
  // `@sha256:<digest>` — those are immutable digest pins which never carry
  // the source hash; we fall through to the single-asset heuristic for
  // those). The hash itself is hex-only in CDK's bootstrap layout.
  const hash = extractHashFromImageUri(imageUri);
  if (hash !== undefined) {
    const asset = dockerImages[hash];
    if (asset) {
      return { hash, asset };
    }
  }

  // Single-asset fallback: when the user has exactly one Docker image in
  // the stack, it's almost certainly the one being invoked. Avoids
  // hard-failing on hash-extraction misses that would otherwise be common
  // (digest pins, custom Code.fromAssetImage forms, etc.).
  if (entries.length === 1) {
    const [singleHash, singleAsset] = entries[0]!;
    return { hash: singleHash, asset: singleAsset };
  }

  return undefined;
}

/**
 * Extract the source hash from a Lambda `Code.ImageUri` string. CDK's
 * bootstrap layout ends every image URI in `:<hex-hash>`, and that hash
 * is the same key used in the asset manifest's `dockerImages` map.
 *
 * Returns `undefined` for shapes we can't parse (digest pins, missing tag,
 * etc.) — the caller falls back to the single-asset heuristic.
 */
function extractHashFromImageUri(imageUri: string): string | undefined {
  // Reject digest-pinned URIs. `<repo>@sha256:<digest>` carries no hash.
  if (imageUri.includes('@sha256:')) return undefined;

  // Match `:<hex-hash>` at the very end of the URI. `cdk-hnb659fds-container-assets-...:<64-hex>`
  // is the typical shape; we accept any 8+-character hex tail to be lenient.
  const match = /:([a-f0-9]{8,})$/.exec(imageUri);
  return match?.[1];
}
