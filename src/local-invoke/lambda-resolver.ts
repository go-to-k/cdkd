import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { StackInfo } from '../synthesis/assembly-reader.js';
import type { TemplateResource } from '../types/resource.js';
import { buildCdkPathIndex, resolveCdkPathToLogicalIds } from '../cli/cdk-path.js';
import { matchStacks } from '../cli/stack-matcher.js';

/**
 * Result of resolving an `cdkd local invoke <target>` argument back to a
 * concrete Lambda function in the synthesized assembly. Carries everything
 * the docker-runner needs in one shot.
 */
export interface ResolvedLambda {
  /** Stack the function belongs to. */
  stack: StackInfo;
  /** CloudFormation logical ID of the function. */
  logicalId: string;
  /** Raw template entry (for property reads beyond what's surfaced here). */
  resource: TemplateResource;
  /** Lambda runtime string (e.g. `nodejs20.x`). */
  runtime: string;
  /** Lambda handler string (e.g. `index.handler`). */
  handler: string;
  /** `MemorySize` from the template, or 128 when omitted (Lambda default). */
  memoryMb: number;
  /** `Timeout` (seconds) from the template, or 3 when omitted (Lambda default). */
  timeoutSec: number;
  /**
   * Resolved local code path. For asset-backed functions, this is the
   * absolute directory under `cdk.out` named by the resource's
   * `Metadata['aws:asset:path']`. For inline `Code.ZipFile` functions,
   * this is `null` and the caller is expected to materialize a temp dir
   * before bind-mounting (handled in the command layer to keep this
   * module side-effect-free).
   */
  codePath: string | null;
  /**
   * For inline Lambdas only: the inline source body. The command layer
   * writes this into a temp dir at the path implied by `handler`.
   */
  inlineCode?: string;
}

export class LocalInvokeResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalInvokeResolutionError';
    Object.setPrototypeOf(this, LocalInvokeResolutionError.prototype);
  }
}

/**
 * Parse a `target` argument into (optional stack pattern, path-or-id).
 *
 * Two accepted forms:
 *   - `Stack:LogicalId` — colon delimits stack from logical ID. Logical
 *     IDs cannot contain `/` or `:`, so the parse is unambiguous.
 *   - `Stack/Path/...` — display-path form. The stack prefix is the first
 *     `/`-delimited segment; everything after is the construct path
 *     (which itself starts with the same stack name in CDK output, e.g.
 *     `MyStack/MyApi/Handler`).
 *
 * For single-stack apps the stack prefix may be omitted entirely:
 *   - Bare `Handler` is treated as a logical ID in the only stack.
 *   - Bare `MyApi/Handler` is treated as a construct path; the only
 *     stack's name is prepended at lookup time.
 *
 * Returns the raw split. The actual stack-resolution + auto-detect logic
 * lives in `resolveLambdaTarget` so `parseTarget` stays a pure string
 * splitter.
 */
export interface ParsedTarget {
  /**
   * Stack pattern if explicit, else `null`. When `null` the resolver
   * auto-detects the single stack in the app.
   */
  stackPattern: string | null;
  /** Path-or-id portion of the target. */
  pathOrId: string;
  /** `true` iff `pathOrId` looks like a construct path (contains `/`). */
  isPath: boolean;
}

export function parseTarget(target: string): ParsedTarget {
  if (typeof target !== 'string' || target.length === 0) {
    throw new LocalInvokeResolutionError(
      "Empty target. Pass a CDK display path (e.g. 'MyStack/MyApi/Handler') or stack-qualified logical ID (e.g. 'MyStack:MyApiHandler1234ABCD')."
    );
  }

  // Stack:LogicalId form. The colon must precede every slash for this to
  // be the colon form (otherwise `Stack:Foo/bar` is ambiguous and we
  // prefer the path form).
  const colonIdx = target.indexOf(':');
  const slashIdx = target.indexOf('/');
  if (colonIdx > 0 && (slashIdx === -1 || colonIdx < slashIdx)) {
    const stackPattern = target.substring(0, colonIdx);
    const pathOrId = target.substring(colonIdx + 1);
    if (pathOrId.length === 0) {
      throw new LocalInvokeResolutionError(`Target '${target}' has no logical ID after ':'.`);
    }
    return { stackPattern, pathOrId, isPath: pathOrId.includes('/') };
  }

  // Path form with explicit stack: stack is the first segment.
  if (slashIdx > 0) {
    return { stackPattern: target.substring(0, slashIdx), pathOrId: target, isPath: true };
  }

  // Bare logical ID — single-stack auto-detect path.
  return { stackPattern: null, pathOrId: target, isPath: false };
}

/**
 * Resolve a parsed target against the synthesized stacks. Throws
 * {@link LocalInvokeResolutionError} with an actionable message (listing
 * available Lambdas) on any miss.
 */
export function resolveLambdaTarget(target: string, stacks: StackInfo[]): ResolvedLambda {
  if (stacks.length === 0) {
    throw new LocalInvokeResolutionError('No stacks found in the synthesized assembly.');
  }

  const parsed = parseTarget(target);
  const stack = pickStack(parsed, stacks);

  const template = stack.template;
  const resources = template.Resources ?? {};

  let match: { logicalId: string; resource: TemplateResource } | undefined;

  if (parsed.isPath) {
    // Build the path index once so we can list every available Lambda
    // when the lookup misses.
    const index = buildCdkPathIndex(template);
    const resolvedPaths = resolveCdkPathToLogicalIds(parsed.pathOrId, index);

    // Filter to Lambda functions; keep the rest for an error path.
    const lambdaMatches = resolvedPaths.filter(
      ({ logicalId }) => resources[logicalId]?.Type === 'AWS::Lambda::Function'
    );

    if (lambdaMatches.length === 0) {
      throw notFoundError(target, stack, resources);
    }
    if (lambdaMatches.length > 1) {
      throw new LocalInvokeResolutionError(
        `Target '${target}' matches ${lambdaMatches.length} Lambda functions in ${stack.stackName}: ` +
          lambdaMatches.map((m) => m.logicalId).join(', ') +
          '. Refine the path or use the stack:LogicalId form.'
      );
    }
    const m = lambdaMatches[0]!;
    match = { logicalId: m.logicalId, resource: resources[m.logicalId]! };
  } else {
    const resource = resources[parsed.pathOrId];
    if (!resource) {
      throw notFoundError(target, stack, resources);
    }
    match = { logicalId: parsed.pathOrId, resource };
  }

  const { logicalId, resource } = match;

  if (resource.Type !== 'AWS::Lambda::Function') {
    if (resource.Type.startsWith('Custom::')) {
      throw new LocalInvokeResolutionError(
        `Resource '${logicalId}' in ${stack.stackName} is a Custom Resource (${resource.Type}), not a Lambda function. ` +
          `Custom Resources are invoked by the deploy framework, not by users. ` +
          `If you want to test the underlying handler, target the ServiceToken Lambda directly.`
      );
    }
    throw new LocalInvokeResolutionError(
      `Resource '${logicalId}' in ${stack.stackName} is ${resource.Type}, not a Lambda function. ` +
        `cdkd local invoke only works on AWS::Lambda::Function resources in v1.`
    );
  }

  return extractLambdaProperties(stack, logicalId, resource);
}

/**
 * Single-stack auto-detect (D4): if the app has exactly one stack, the
 * user may omit the stack prefix. Otherwise an explicit stack pattern is
 * required.
 */
function pickStack(parsed: ParsedTarget, stacks: StackInfo[]): StackInfo {
  if (parsed.stackPattern === null) {
    if (stacks.length === 1) return stacks[0]!;
    throw new LocalInvokeResolutionError(
      `Multiple stacks in app, target '${parsed.pathOrId}' is missing a stack prefix. ` +
        `Use 'StackName:${parsed.pathOrId}' or 'StackName/...' (path form). ` +
        `Available stacks: ${stacks.map((s) => s.stackName).join(', ')}.`
    );
  }

  // Reuse the shared stack-matcher so display-path / wildcard semantics
  // line up with deploy / diff / destroy.
  const matched = matchStacks(stacks, [parsed.stackPattern]);
  if (matched.length === 0) {
    throw new LocalInvokeResolutionError(
      `Stack '${parsed.stackPattern}' not found. ` +
        `Available stacks: ${stacks.map((s) => s.stackName).join(', ')}.`
    );
  }
  if (matched.length > 1) {
    throw new LocalInvokeResolutionError(
      `Stack pattern '${parsed.stackPattern}' matched ${matched.length} stacks: ` +
        matched.map((s) => s.stackName).join(', ') +
        '. Use a more specific pattern.'
    );
  }
  return matched[0]!;
}

/**
 * Pull the Lambda properties this command cares about out of the
 * template. Validates required fields up front so the docker-runner can
 * assume a fully-typed `ResolvedLambda`.
 */
function extractLambdaProperties(
  stack: StackInfo,
  logicalId: string,
  resource: TemplateResource
): ResolvedLambda {
  const props = resource.Properties ?? {};
  const runtime = typeof props['Runtime'] === 'string' ? props['Runtime'] : '';
  const handler = typeof props['Handler'] === 'string' ? props['Handler'] : '';
  const memoryMb = typeof props['MemorySize'] === 'number' ? props['MemorySize'] : 128;
  const timeoutSec = typeof props['Timeout'] === 'number' ? props['Timeout'] : 3;

  if (!runtime) {
    throw new LocalInvokeResolutionError(
      `Lambda '${logicalId}' has no Runtime property. ` +
        'Container-image Lambdas (Code.ImageUri) are not supported in cdkd local invoke v1.'
    );
  }
  if (!handler) {
    throw new LocalInvokeResolutionError(`Lambda '${logicalId}' has no Handler property.`);
  }

  const code = (props['Code'] ?? {}) as Record<string, unknown>;
  const inlineCode = typeof code['ZipFile'] === 'string' ? code['ZipFile'] : undefined;

  let codePath: string | null = null;
  if (!inlineCode) {
    codePath = resolveAssetCodePath(stack, logicalId, resource);
  }

  return {
    stack,
    logicalId,
    resource,
    runtime,
    handler,
    memoryMb,
    timeoutSec,
    codePath,
    ...(inlineCode !== undefined && { inlineCode }),
  };
}

/**
 * Resolve the local directory that corresponds to a function's deployed
 * asset, using the CDK-blessed `Metadata['aws:asset:path']` hint (D2). The
 * value is a directory path relative to `cdk.out` (e.g. `asset.abc123def`)
 * and CDK has already unzipped it for us — we bind-mount the directory
 * directly, no re-zipping.
 *
 * Falls back to a clear error when the metadata is missing OR the resolved
 * directory does not exist (CDK should always emit it for asset-backed
 * Lambdas; absence usually means the user pre-synthesized with a different
 * cdk.out and pointed `--output` at a stale one).
 */
function resolveAssetCodePath(
  stack: StackInfo,
  logicalId: string,
  resource: TemplateResource
): string {
  const meta = resource.Metadata;
  const assetPath = meta?.['aws:asset:path'];
  if (typeof assetPath !== 'string' || assetPath.length === 0) {
    throw new LocalInvokeResolutionError(
      `Lambda '${logicalId}' has no Metadata['aws:asset:path']. ` +
        'cdkd local invoke needs this hint to find the local asset directory. ' +
        'Re-synthesize the app (without `--output <stale-dir>`) and retry.'
    );
  }

  // Asset paths are typically relative to cdk.out. The stack's
  // `assetManifestPath` is `<cdk.out>/<stack>.assets.json`; we strip the
  // filename to get the assembly directory. As a fallback (e.g. for
  // stacks with no asset manifest), use the dirname of the template
  // path implicit in the stack info — but in v1 every Lambda-bearing
  // stack has an asset manifest, so the fallback is mostly defensive.
  const cdkOutDir = stack.assetManifestPath ? dirname(stack.assetManifestPath) : process.cwd();

  const abs = isAbsolute(assetPath) ? assetPath : resolve(cdkOutDir, assetPath);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new LocalInvokeResolutionError(
      `Lambda '${logicalId}' asset directory '${abs}' does not exist or is not a directory. ` +
        'Re-synthesize the app and retry.'
    );
  }
  return abs;
}

/**
 * Build a "target not found" error that lists every Lambda function in
 * the resolved stack so the user can copy/paste a valid target. Mirrors
 * the format the issue spec calls out.
 */
function notFoundError(
  target: string,
  stack: StackInfo,
  resources: Record<string, TemplateResource>
): LocalInvokeResolutionError {
  const lambdas: { displayPath: string; logicalId: string }[] = [];
  for (const [logicalId, resource] of Object.entries(resources)) {
    if (resource.Type !== 'AWS::Lambda::Function') continue;
    const meta = resource.Metadata;
    const cdkPath = typeof meta?.['aws:cdk:path'] === 'string' ? meta['aws:cdk:path'] : '';
    lambdas.push({ displayPath: cdkPath || logicalId, logicalId });
  }

  let msg = `target '${target}' did not match any Lambda function in ${stack.stackName}.\n\n`;
  if (lambdas.length === 0) {
    msg += `Stack ${stack.stackName} has no Lambda functions.`;
  } else {
    const width = Math.max(...lambdas.map((l) => l.displayPath.length));
    msg += `Available Lambda functions in ${stack.stackName}:\n`;
    for (const l of lambdas) {
      msg += `  ${l.displayPath.padEnd(width)}  (${l.logicalId})\n`;
    }
  }
  return new LocalInvokeResolutionError(msg.trimEnd());
}
