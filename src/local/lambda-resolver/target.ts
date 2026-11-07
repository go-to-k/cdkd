import type { StackInfo } from '../../synthesis/assembly-reader.js';
import type { TemplateResource } from '../../types/resource.js';
import { buildCdkPathIndex, resolveCdkPathToLogicalIds } from '../../cli/cdk-path.js';
import {
  describeStack,
  renderAmbiguousTargetStack,
  selectTargetStack,
} from '../../cli/stack-matcher.js';
import { LocalInvokeResolutionError, type ResolvedLambda } from './types.js';
import { extractLambdaProperties } from './properties.js';

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
  const stack = pickStack(parsed, stacks, target);

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

  return extractLambdaProperties(stack, logicalId, resource, resources);
}

/**
 * Single-stack auto-detect (D4): if the app has exactly one stack, the
 * user may omit the stack prefix. Otherwise an explicit stack pattern is
 * required.
 */
function pickStack(parsed: ParsedTarget, stacks: StackInfo[], target: string): StackInfo {
  // A path-form target's stack is the LONGEST display-path prefix, not the
  // first segment, which is the Stage id for a Stage stack
  // (go-to-k/cdkd#3953); a wildcard head such as `My*` and the colon form go
  // through matchStacks. Two stacks sharing a physical name (a Stage deployed
  // twice) are refused as ambiguous, never resolved to the first (#5175).
  const selection = selectTargetStack(parsed, target, stacks);
  switch (selection.kind) {
    case 'found':
      return selection.stack;
    case 'no-prefix':
      throw new LocalInvokeResolutionError(
        `Multiple stacks in app, target '${parsed.pathOrId}' is missing a stack prefix. ` +
          `Use 'StackName:${parsed.pathOrId}' or 'StackName/...' (path form). ` +
          `Available stacks: ${stacks.map(describeStack).join(', ')}.`
      );
    case 'not-found':
      throw new LocalInvokeResolutionError(
        `Stack '${selection.pattern}' not found. ` +
          `Available stacks: ${stacks.map(describeStack).join(', ')}.`
      );
    case 'ambiguous':
      throw new LocalInvokeResolutionError(
        renderAmbiguousTargetStack(selection.pattern, selection.matched)
      );
  }
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
