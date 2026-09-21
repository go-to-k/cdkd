import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type {
  AssemblyManifest,
  ArtifactManifest,
  StackArtifactProperties,
  AssetManifestArtifactProperties,
  ArtifactEnvironment,
} from '../types/assembly.js';
import { parseEnvironment } from '../types/assembly.js';
import type { CloudFormationTemplate } from '../types/resource.js';
import { getLogger } from '../utils/logger.js';
import { displaySafe } from '../utils/display-safe.js';
import { renderAssemblyPathEscape, resolveAssemblyPath } from '../utils/assembly-path.js';
import { SynthesisError } from '../utils/error-handler.js';
import { collectStackMessages, type StackMessage } from './stack-messages.js';
import { failedStageNote, stageScopedError, type FailedStage } from './failed-stages.js';

/**
 * Stack information extracted from cloud assembly
 */
export interface StackInfo {
  /** Physical CloudFormation stack name (e.g., "MyStage-MyStack") */
  stackName: string;

  /**
   * Hierarchical display name from CDK synth (e.g., "MyStage/MyStack" for stacks
   * under a Stage, or "MyStack" at the top level). Falls back to `stackName` when
   * the assembly does not carry one.
   */
  displayName: string;

  /** Artifact ID in manifest */
  artifactId: string;

  /** CloudFormation template */
  template: CloudFormationTemplate;

  /** Asset manifest file path (absolute) */
  assetManifestPath?: string | undefined;

  /**
   * The TOP-LEVEL assembly directory — the app's `outdir`, which is where
   * `cdk synth` STAGES every asset, whatever depth of Stage declares it.
   *
   * It is NOT `dirname(assetManifestPath)`, and the difference is the whole
   * reason this field exists. A Stage's manifest lives in
   * `cdk.out/assembly-<Stage>/` while its assets are staged into `cdk.out`,
   * because upstream `AssetStaging` writes under `Stage.assetOutdir` (which
   * resolves up to the App) and records
   * `path.relative(stage.outdir, stagedPath)`. So a Stage's
   * `source.path` is `../asset.<hash>` BY DESIGN, and Stages nest, so it can
   * be `../../asset.<hash>`.
   *
   * Asset paths therefore RESOLVE against the manifest's own directory but
   * must be CONTAINED within this one (issue
   * [#3489](https://github.com/go-to-k/cdkd/issues/3489)). Using the manifest
   * directory as the containment base refused every Stage asset.
   *
   * Optional so hand-built `StackInfo` literals (tests, tooling) stay valid;
   * `AssemblyReader` always sets it, and a caller without one falls back to
   * the manifest's directory, which is correct for a top-level stack.
   */
  assetOutdir?: string | undefined;

  /** Stack dependency names (other stacks this stack depends on) */
  dependencyNames: string[];

  /** Target region from CDK environment */
  region?: string | undefined;

  /** Target account from CDK environment */
  account?: string | undefined;

  /**
   * Stack-level termination protection (CDK `Stack.terminationProtection`).
   *
   * When `true`, `cdkd destroy <stack>` and `cdkd destroy --all` refuse to
   * destroy this stack and surface a `StackTerminationProtectionError` so
   * the CLI exits via the partial-failure path (exit 2) without invoking
   * the per-resource delete loop. The bypass workflow is to set
   * `terminationProtection: false` in the CDK code, redeploy, then retry.
   *
   * Read-only `cdkd diff` and forward-only `cdkd deploy` are unaffected.
   * `cdkd state destroy` (state-only, no synth) cannot honor this — the
   * flag is a CDK property not stored in cdkd state.json.
   */
  terminationProtection?: boolean | undefined;

  /**
   * Per-logical-id absolute file paths of nested templates one level below
   * this stack — populated by walking this stack's template for
   * `AWS::CloudFormation::Stack` resources whose `Metadata['aws:asset:path']`
   * points at the child's `<file>.nested.template.json` sibling in the
   * same `cdk.out` directory. Consumed by `NestedStackProvider.create` /
   * `update` to load the child template at provider invocation time.
   *
   * Only one level is extracted here — grandchildren and deeper levels are
   * resolved recursively by `NestedStackProvider` itself when it reads
   * a child template (children's templates live next to the parent
   * template in `cdk.out`, so the same `path.dirname(parentPath) + assetPath`
   * trick keeps working at any depth). Undefined when the stack has no
   * `AWS::CloudFormation::Stack` resources.
   */
  nestedTemplates?: Record<string, string> | undefined;

  /**
   * CDK annotation messages (`Annotations.addError` / `addWarning` /
   * `addInfo`) attached to this stack's construct tree, collected from the
   * artifact's inline `metadata` AND its `additionalMetadataFile` side file
   * (issue #1228). Consumed by `processStackMessages` in
   * `stack-messages.ts` — `synth` / `deploy` print warnings + infos and
   * refuse to proceed when any selected stack carries an error.
   * Optional so hand-built StackInfo literals (tests, tooling) stay valid;
   * absent is equivalent to "no messages".
   */
  messages?: StackMessage[];
}

/**
 * Everything one assembly read yields: the stacks, plus the Stages that could
 * not be read at all (issue
 * [#3482](https://github.com/go-to-k/cdkd/issues/3482)). A caller that only
 * wants the stacks uses `getAllStacks`.
 */
export interface AssemblyContents {
  /** Stacks from this assembly and every Stage under it that loaded. */
  stacks: StackInfo[];

  /**
   * Stages whose own `manifest.json` could not be read, in traversal order and
   * at any depth. Empty on every healthy assembly.
   */
  failedStages: FailedStage[];
}

/**
 * Reads and parses Cloud Assembly from cdk.out directory
 *
 * EVERY value this class renders into a message or a log line goes through
 * `displaySafe` (issue [#3277](https://github.com/go-to-k/cdkd/issues/3277)).
 * The reason is the one its absolute-`aws:asset:path` refusal states in its own
 * text: a manifest key, a template key, a `Metadata` string, a
 * `directoryName`-derived path and the `JSON.parse` failure quoting a hand-fed
 * file are all chosen by whoever wrote the assembly, and this is the FIRST
 * layer the CLI reaches, so on a hostile assembly its output is what a user is
 * asked to trust. C1 bytes and the bidi overrides survive ordinary string
 * building, and `formatError` sanitizes only an error's `cause`, never its own
 * `message` — so a crafted value otherwise appends what reads as a second,
 * cdkd-authored line. `displaySafe` is the identity on every well-formed
 * assembly: it neither truncates nor quotes, so a legitimate long asset path
 * still renders in full and byte-identically. The same rule, for the same
 * reason, guards the twin refusals in `src/cli/commands/diff-recursive.ts`
 * (go-to-k/cdkd#3243).
 *
 * ONE value leaves this class UNSANITIZED: a failed Stage's path
 * ([#3482](https://github.com/go-to-k/cdkd/issues/3482)), which is a match key
 * as well as the subject of a sentence. `failed-stages.ts` renders it at each
 * display site with `displayIdent` — it is an IDENTIFIER interpolated into
 * prose rather than free-form text quoted as a value, so the denylist's
 * tolerance of quotes and spaces is a spoof surface there. See
 * `FailedStage.stagePath`.
 */
export class AssemblyReader {
  private logger = getLogger().child('AssemblyReader');

  /**
   * Read manifest.json from assembly directory
   */
  readManifest(assemblyDir: string): AssemblyManifest {
    const manifestPath = join(assemblyDir, 'manifest.json');

    try {
      const content = readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(content) as AssemblyManifest;
      this.logger.debug(`Loaded manifest: version=${displaySafe(manifest.version)}`);
      return manifest;
    } catch (error) {
      throw new SynthesisError(
        `Failed to read cloud assembly manifest from ${displaySafe(manifestPath)}: ${displaySafe(error instanceof Error ? error.message : String(error))}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Read an assembly: all its stacks (recursing into nested assemblies /
   * Stages) plus the Stages that could not be read at all.
   *
   * Only ONE failure is tolerated while walking a Stage — the read of the
   * Stage's own `manifest.json`, which is the legitimate "this Stage
   * references a directory that was never synthesized" case. Every REFUSAL
   * raised while reading a Stage's contents propagates out of the recursion
   * exactly as it does at the top level (issue
   * [#3482](https://github.com/go-to-k/cdkd/issues/3482)).
   */
  readAssembly(
    assemblyDir: string,
    manifest: AssemblyManifest,
    assetOutdir: string = assemblyDir
  ): AssemblyContents {
    const failedStages: FailedStage[] = [];
    const stacks = this.collectStacks(assemblyDir, manifest, assetOutdir, failedStages);
    return { stacks, failedStages };
  }

  /**
   * Get all stacks from assembly (recursively traverses nested assemblies / Stages)
   *
   * Discards the failed-Stage records `readAssembly` returns; a caller that
   * reports on a selection failure wants that method instead.
   */
  getAllStacks(
    assemblyDir: string,
    manifest: AssemblyManifest,
    /**
     * The app's outdir, where assets are staged. Defaults to `assemblyDir` at
     * the top level and is passed through UNCHANGED into a Stage, because a
     * Stage's assets are staged into the app's outdir, not the Stage's own
     * directory (see `StackInfo.assetOutdir`).
     */
    assetOutdir: string = assemblyDir
  ): StackInfo[] {
    return this.readAssembly(assemblyDir, manifest, assetOutdir).stacks;
  }

  /**
   * The recursive half of `readAssembly`. `failedStages` is the accumulator
   * shared by every level, so a Stage that fails three levels down is still
   * reported to the top-level caller.
   */
  private collectStacks(
    assemblyDir: string,
    manifest: AssemblyManifest,
    assetOutdir: string,
    failedStages: FailedStage[]
  ): StackInfo[] {
    if (!manifest.artifacts) {
      this.logger.warn('No artifacts found in manifest');
      return [];
    }

    // Build map of artifact ID → asset manifest path
    const assetManifestMap = this.buildAssetManifestMap(assemblyDir, manifest);

    const stacks: StackInfo[] = [];

    for (const [artifactId, artifact] of Object.entries(manifest.artifacts)) {
      if (artifact.type === 'aws:cloudformation:stack') {
        const stackInfo = this.extractStackInfo(
          assemblyDir,
          artifactId,
          artifact,
          manifest,
          assetManifestMap,
          assetOutdir
        );
        stacks.push(stackInfo);
      } else if (artifact.type === 'cdk:cloud-assembly') {
        // Nested assembly (Stage) — recurse into subdirectory
        const props = artifact.properties as
          | { directoryName?: string; displayName?: unknown }
          | undefined;
        if (props?.directoryName) {
          // Containment BEFORE the tolerant read, and a THROW (issue
          // go-to-k/cdkd#3489). A nested assembly whose `directoryName` escapes
          // would otherwise be swallowed into a warning that silently drops
          // every stack under the Stage.
          const resolved = resolveAssemblyPath(assemblyDir, props.directoryName);
          if (!resolved.contained) {
            throw new SynthesisError(
              `Nested assembly '${displaySafe(props.directoryName)}' ` +
                `${renderAssemblyPathEscape(resolved, assemblyDir)}`
            );
          }
          const nestedDir = resolved.path;
          // CDK writes the Stage's construct path as the nested assembly's
          // `properties.displayName`; the artifact id is the fallback.
          //
          // RAW, deliberately: this value is a MATCH KEY as well as the
          // subject of a message, and `failed-stages.ts` renders it at each
          // display site instead. Sanitizing it here made the stored form
          // disagree with the user's pattern. See `FailedStage.stagePath`.
          const stagePath =
            typeof props.displayName === 'string' && props.displayName.length > 0
              ? props.displayName
              : artifactId;

          // THE SCOPE OF THIS `try` IS THE CLASSIFIER (issue
          // go-to-k/cdkd#3482). Exactly one failure is tolerated — the read of
          // the Stage's OWN manifest.json — because a Stage referencing a
          // directory that was never synthesized must not abort a run
          // targeting unrelated top-level stacks. Everything else raised while
          // reading a Stage is a deliberate REFUSAL (`buildAssetManifestMap`'s
          // escaping asset manifest, `extractStackInfo`'s missing / escaping
          // `templateFile`, its unreadable template, its absolute
          // `Metadata['aws:asset:path']` tripwire, a deeper Stage's escaping
          // `directoryName`), and a refusal that is fatal at the top level must
          // be fatal here too — otherwise a hardened check degrades to advice
          // the moment the same stack sits inside a Stage. So the recursive
          // call sits OUTSIDE the try rather than being classified by error
          // type or message: a wider try is what downgraded them before.
          //
          // `displaySafe` on the caught text is DEFENCE IN DEPTH and is today
          // the identity, stated because a mutation probe on it finds no
          // discrimination and the next reader deserves the reason rather than
          // the puzzle: `readManifest` already sanitizes its own message. It
          // stays because the guard belongs to the CATCH, not to today's set of
          // throws inside the `try`.
          let nestedManifest: AssemblyManifest;
          try {
            nestedManifest = this.readManifest(nestedDir);
          } catch (error) {
            const reason = displaySafe(error instanceof Error ? error.message : String(error));
            this.logger.warn(
              `Failed to read nested assembly '${displaySafe(props.directoryName)}': ${reason}`
            );
            // Recorded so stack SELECTION can name this Stage instead of
            // answering "not found" for a stack that may well exist under it.
            failedStages.push({ stagePath, reason });
            continue;
          }

          // `assetOutdir` unchanged: a Stage's assets live in the APP's
          // outdir, never in the Stage's own directory. `failedStages` is
          // threaded through so a Stage failing at any depth reaches the
          // top-level caller.
          //
          // This catch RE-THROWS, always — it adds the Stage's name to a
          // refusal whose text names only the stack, and is not a second
          // tolerance point.
          try {
            stacks.push(
              ...this.collectStacks(nestedDir, nestedManifest, assetOutdir, failedStages)
            );
          } catch (error) {
            throw stageScopedError(stagePath, error);
          }
        }
      }
    }

    this.logger.debug(`Found ${stacks.length} stack(s) in assembly`);
    return stacks;
  }

  /**
   * Get a specific stack by name
   */
  getStack(assemblyDir: string, manifest: AssemblyManifest, stackName: string): StackInfo {
    const { stacks, failedStages } = this.readAssembly(assemblyDir, manifest);
    const stack = stacks.find((s) => s.stackName === stackName);

    if (!stack) {
      throw new SynthesisError(
        `Stack '${displaySafe(stackName)}' not found in assembly. ` +
          // `Available: ` with nothing after it says less than the plain
          // sentence, and an empty assembly is exactly what a failed Stage
          // produces. Same choice as `renderNoStackMatch`.
          (stacks.length > 0
            ? `Available: ${stacks.map((s) => displaySafe(s.stackName)).join(', ')}`
            : 'The assembly has no stacks.') +
          // "not found" is a lie while a Stage failed to load: its stacks were
          // dropped from `stacks` above (issue go-to-k/cdkd#3482).
          failedStageNote([stackName], failedStages)
      );
    }

    return stack;
  }

  /**
   * Get template for a specific stack
   */
  getTemplate(
    assemblyDir: string,
    manifest: AssemblyManifest,
    stackName: string
  ): CloudFormationTemplate {
    return this.getStack(assemblyDir, manifest, stackName).template;
  }

  /**
   * Build map: stack artifact ID → asset manifest absolute path
   */
  private buildAssetManifestMap(
    assemblyDir: string,
    manifest: AssemblyManifest
  ): Map<string, string> {
    const map = new Map<string, string>();

    if (!manifest.artifacts) return map;

    for (const [artifactId, artifact] of Object.entries(manifest.artifacts)) {
      if (artifact.type !== 'cdk:asset-manifest') continue;

      const props = artifact.properties as AssetManifestArtifactProperties | undefined;
      if (props?.file) {
        // The asset manifest is read and its `source.path` entries are packaged
        // and uploaded, so an escaping `file` puts a file from outside the
        // assembly into the user's account (issue go-to-k/cdkd#3489).
        const resolved = resolveAssemblyPath(assemblyDir, props.file);
        if (!resolved.contained) {
          throw new SynthesisError(
            `Asset manifest artifact '${displaySafe(artifactId)}' has ` +
              `file='${displaySafe(props.file)}' which ` +
              `${renderAssemblyPathEscape(resolved, assemblyDir)}`
          );
        }
        map.set(artifactId, resolved.path);
      }
    }

    return map;
  }

  /**
   * Extract stack info from artifact
   */
  private extractStackInfo(
    assemblyDir: string,
    artifactId: string,
    artifact: ArtifactManifest,
    manifest: AssemblyManifest,
    assetManifestMap: Map<string, string>,
    assetOutdir: string
  ): StackInfo {
    const props = artifact.properties as StackArtifactProperties | undefined;
    const stackName = props?.stackName || artifactId;

    // Load template
    const templateFile = props?.templateFile;
    if (!templateFile) {
      throw new SynthesisError(`Stack '${displaySafe(stackName)}' has no templateFile property`);
    }

    // Containment (issue go-to-k/cdkd#3489) BEFORE the read: a `templateFile`
    // of `../../../home/user/.aws/credentials` is read from outside the
    // assembly and, where it parses, becomes the template cdkd deploys.
    const resolvedTemplate = resolveAssemblyPath(assemblyDir, templateFile);
    if (!resolvedTemplate.contained) {
      throw new SynthesisError(
        `Stack '${displaySafe(stackName)}' has templateFile='${displaySafe(templateFile)}' ` +
          `which ${renderAssemblyPathEscape(resolvedTemplate, assemblyDir)}`
      );
    }
    const templatePath = resolvedTemplate.path;
    let template: CloudFormationTemplate;
    try {
      const content = readFileSync(templatePath, 'utf-8');
      template = JSON.parse(content) as CloudFormationTemplate;
    } catch (error) {
      throw new SynthesisError(
        `Failed to read template for stack '${displaySafe(stackName)}': ${displaySafe(error instanceof Error ? error.message : String(error))}`,
        error instanceof Error ? error : undefined
      );
    }

    this.logger.debug(
      `Stack: ${displaySafe(stackName)}, Resources: ${Object.keys(template.Resources ?? {}).length}`
    );

    // Find asset manifest for this stack
    let assetManifestPath: string | undefined;
    if (artifact.dependencies) {
      for (const depId of artifact.dependencies) {
        if (assetManifestMap.has(depId)) {
          assetManifestPath = assetManifestMap.get(depId);
          this.logger.debug(
            `Found asset manifest for ${displaySafe(stackName)}: ${displaySafe(depId)}`
          );
          break;
        }
      }
    }

    // Extract stack dependencies (other stacks, not asset manifests)
    const dependencyNames: string[] = [];
    if (artifact.dependencies && manifest.artifacts) {
      for (const depId of artifact.dependencies) {
        const depArtifact = manifest.artifacts[depId];
        if (depArtifact?.type === 'aws:cloudformation:stack') {
          const depProps = depArtifact.properties as StackArtifactProperties | undefined;
          const depName = depProps?.stackName || depId;
          if (depName !== stackName) {
            dependencyNames.push(depName);
          }
        }
      }
    }

    if (dependencyNames.length > 0) {
      this.logger.debug(
        `Stack '${displaySafe(stackName)}' depends on: ` +
          `[${dependencyNames.map((n) => displaySafe(n)).join(', ')}]`
      );
    }

    // Parse environment
    let env: ArtifactEnvironment | undefined;
    if (artifact.environment) {
      env = parseEnvironment(artifact.environment);
    }

    // Index nested templates by logical id. CDK encodes the child template's
    // sibling path under `Metadata['aws:asset:path']` on each
    // `AWS::CloudFormation::Stack` resource (verified against `cdk synth` of
    // CDK 2.x `cdk.NestedStack` on 2026-05-22; see docs/design/459-nested-stacks.md §4).
    const nestedTemplates: Record<string, string> = {};
    for (const [logicalId, resource] of Object.entries(template.Resources ?? {})) {
      if (resource?.Type !== 'AWS::CloudFormation::Stack') continue;
      const meta = resource.Metadata as Record<string, unknown> | undefined;
      const assetPath = meta?.['aws:asset:path'];
      if (typeof assetPath !== 'string' || assetPath.length === 0) continue;
      // CDK emits relative asset paths for nested templates (siblings of the
      // parent template in the same `cdk.out` directory). An absolute path
      // indicates the synth output was hand-modified or generated by a
      // non-CDK toolchain, so this is a TRIPWIRE for "not CDK-generated",
      // NOT a containment check: `join` does not honour a leading separator
      // (`join('/tmp/cdk.out', '/abs/foo')` is `/tmp/cdk.out/abs/foo`, which
      // is `resolve`'s behaviour, not `join`'s), and the shape that does
      // leave the directory is `..`, which nothing here rejects. Mirrors the deeper
      // guard `isAbsoluteCrossPlatform` in `src/cli/commands/diff-recursive.ts`
      // (which recurses into grandchild templates) so the top-level and
      // recursive walks share the same hardened contract.
      if (
        isAbsolute(assetPath) ||
        /^[a-zA-Z]:[\\/]/.test(assetPath) ||
        assetPath.startsWith('\\\\')
      ) {
        throw new SynthesisError(
          `Stack '${displaySafe(stackName)}' nested-stack '${displaySafe(logicalId)}' has ` +
            `Metadata['aws:asset:path']='${displaySafe(assetPath)}' which is absolute. ` +
            `CDK emits relative asset paths for nested templates; an absolute ` +
            `path indicates the synth output was hand-modified or generated by a ` +
            `non-CDK toolchain. Refusing to load.`
        );
      }
      // The containment check the tripwire above is NOT (issue
      // go-to-k/cdkd#3489). Both refusals stay, and word themselves
      // differently: an absolute path cannot actually leave the directory
      // under `join`, and `..` — which does — is invisible to the tripwire.
      const resolvedNested = resolveAssemblyPath(assemblyDir, assetPath);
      if (!resolvedNested.contained) {
        throw new SynthesisError(
          `Stack '${displaySafe(stackName)}' nested-stack '${displaySafe(logicalId)}' has ` +
            `Metadata['aws:asset:path']='${displaySafe(assetPath)}' which ` +
            `${renderAssemblyPathEscape(resolvedNested, assemblyDir)}`
        );
      }
      nestedTemplates[logicalId] = resolvedNested.path;
    }

    return {
      stackName,
      displayName: artifact.displayName ?? stackName,
      artifactId,
      template,
      assetManifestPath,
      assetOutdir,
      dependencyNames,
      region: env?.region !== 'unknown-region' ? env?.region : undefined,
      account: env?.account !== 'unknown-account' ? env?.account : undefined,
      ...(props?.terminationProtection !== undefined && {
        terminationProtection: props.terminationProtection,
      }),
      ...(Object.keys(nestedTemplates).length > 0 && { nestedTemplates }),
      messages: collectStackMessages(assemblyDir, artifact),
    };
  }

  /**
   * Check if stack has assets
   */
  hasAssets(stackInfo: StackInfo): boolean {
    return stackInfo.assetManifestPath !== undefined;
  }
}
