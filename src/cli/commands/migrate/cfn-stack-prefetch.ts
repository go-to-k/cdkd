import {
  CloudFormationClient,
  DescribeStacksCommand,
  DescribeStackResourcesCommand,
  GetTemplateCommand,
} from '@aws-sdk/client-cloudformation';
import { LocalMigrateError } from '../../../utils/error-handler.js';
import { parseCfnTemplate } from '../../yaml-cfn.js';

/**
 * Stable terminal CFn stack states. Anything else (`*_IN_PROGRESS`,
 * `*_FAILED`, `REVIEW_IN_PROGRESS`) means the source stack is mid-
 * operation or in an unhealthy state — `cdkd migrate` aborts pre-flight
 * so the user can settle the source before paying for codegen + synth.
 *
 * Kept in sync with the same-named set in retire-cfn-stack.ts — the two
 * lists serve the same purpose (gate AWS-side mutations behind a stable
 * source-stack state).
 */
const STABLE_TERMINAL_STATUSES = new Set([
  'CREATE_COMPLETE',
  'UPDATE_COMPLETE',
  'UPDATE_ROLLBACK_COMPLETE',
  'IMPORT_COMPLETE',
  'IMPORT_ROLLBACK_COMPLETE',
]);

/**
 * Resource types that `cdkd migrate` refuses to adopt under any
 * circumstances. The rationale per type:
 *
 *  - `AWS::CloudFormation::CustomResource` — Lambda-backed Custom
 *    Resources whose response protocol (cfn-response over a
 *    pre-signed S3 URL) is incompatible with cdkd's import flow. The
 *    backing Lambda's onCreate handler would need to be re-invoked
 *    for a cdkd-side adoption to make sense, and that's structurally
 *    different from the metadata-transfer migration this command
 *    provides.
 *
 *  - `AWS::CloudFormation::Stack` — nested stacks. cdkd has no
 *    provider for this type, and the matching `cdk migrate` output
 *    flattens nested stacks into separate generated apps in a way
 *    that doesn't round-trip cleanly. Out of scope for #465.
 *
 *  - `Custom::*` — any user-defined Custom Resource type prefix.
 *    Same rationale as `AWS::CloudFormation::CustomResource`.
 */
const HARD_REJECT_RESOURCE_TYPES = new Set([
  'AWS::CloudFormation::CustomResource',
  'AWS::CloudFormation::Stack',
]);

/**
 * Result of {@link prefetchCfnStack}.
 *
 * Surfaces the source CFn stack's current state + every resource the
 * stack contains (logical id, physical id, type), plus a transform-
 * detection summary used by the caller to emit informational logs
 * (SAM / Include transforms are NOT rejected, just surfaced).
 */
export interface PrefetchResult {
  /** Current `StackStatus` from `DescribeStacks`. */
  stackStatus: string;
  /** Every resource in the source CFn stack. */
  resources: PrefetchedResource[];
  /** Transform-block detection — used for INFO logs, never to block. */
  transformInfo: TransformInfo;
}

/**
 * One resource entry from `DescribeStackResources`. The fields cdkd
 * cares about for migration are the logical id (matches the
 * `aws:cdk:path` last segment after `cdk migrate` codegen), the
 * physical id (threaded into the import override map by PR B), and
 * the AWS resource type (for the hard-reject check).
 */
export interface PrefetchedResource {
  LogicalResourceId: string;
  PhysicalResourceId: string;
  ResourceType: string;
}

/**
 * Whether the source CFn template uses SAM (`AWS::Serverless`) or
 * `AWS::Include` transforms. cdkd surfaces these as INFO logs because
 * `cdk migrate` expands them client-side, so the resulting CDK code
 * will use plain Lambda + API Gateway L1 constructs (not SAM
 * abstractions) — users should know up front to avoid surprise.
 */
export interface TransformInfo {
  hasSamTransform: boolean;
  hasIncludeTransform: boolean;
}

/**
 * Fetch the source CFn stack's current state + resources + transform
 * info. Issues 3 read-only AWS API calls (`DescribeStacks`,
 * `DescribeStackResources`, `GetTemplate(Stage=Original)`); none of
 * them mutate AWS state. The result is fed into
 * {@link validatePrefetchResult} for the hard-reject check and
 * surfaced to {@link runMigrateLibrary}'s caller (PR B) as part of
 * `RunMigrateLibraryResult`.
 *
 * `DescribeStackResources` is preferred over `ListStackResources`
 * because the response is unpaginated up to 500 resources (CFn's hard
 * stack cap) — no pagination loop needed for the migration use case.
 */
export async function prefetchCfnStack(
  stackName: string,
  cfnClient: CloudFormationClient
): Promise<PrefetchResult> {
  // DescribeStacks — verify the stack exists and is in a stable state.
  const stacksResp = await cfnClient.send(new DescribeStacksCommand({ StackName: stackName }));
  const stack = stacksResp.Stacks?.[0];
  if (!stack) {
    throw new LocalMigrateError(`CloudFormation stack '${stackName}' not found.`);
  }
  const stackStatus = stack.StackStatus ?? '';

  // DescribeStackResources — pull the (logical, physical, type) tuples
  // that PR B's mapping layer needs and the hard-reject check consumes.
  const resourcesResp = await cfnClient.send(
    new DescribeStackResourcesCommand({ StackName: stackName })
  );
  const resources: PrefetchedResource[] = [];
  for (const r of resourcesResp.StackResources ?? []) {
    if (!r.LogicalResourceId || !r.PhysicalResourceId || !r.ResourceType) {
      // CFn occasionally returns half-populated entries for resources
      // mid-create or for `AWS::CDK::Metadata`-style sentinels. Skip
      // them — the hard-reject check operates on resource types we
      // actually need to migrate, and PR B's mapping layer will report
      // any missing physical id as `out of scope` separately.
      continue;
    }
    resources.push({
      LogicalResourceId: r.LogicalResourceId,
      PhysicalResourceId: r.PhysicalResourceId,
      ResourceType: r.ResourceType,
    });
  }

  // GetTemplate (Original stage) — read the user-submitted template
  // so we can detect Transform blocks. `DescribeStackResources` does
  // NOT return transform info, and stack-level transforms drive
  // whether the upstream `cdk migrate` codegen has to expand SAM /
  // Include shapes client-side.
  let transformInfo: TransformInfo = { hasSamTransform: false, hasIncludeTransform: false };
  try {
    const tplResp = await cfnClient.send(
      new GetTemplateCommand({ StackName: stackName, TemplateStage: 'Original' })
    );
    if (tplResp.TemplateBody) {
      transformInfo = detectTransforms(tplResp.TemplateBody);
    }
  } catch (err) {
    // GetTemplate failure is best-effort — the transform info is a
    // UX nice-to-have, not load-bearing. The reject check below
    // operates on resource types, which we already have.
    const detail = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.warn(
      `[migrate] GetTemplate failed for '${stackName}': ${detail}. Skipping transform detection.`
    );
  }

  return { stackStatus, resources, transformInfo };
}

/**
 * Pre-flight reject when the source CFn stack contains any
 * un-migratable resource type OR is in a non-terminal state. Surfaces
 * SAM / Include transforms via the result's `transformInfo` instead —
 * the caller is responsible for emitting INFO logs.
 *
 * Per #465 Q2 (parent-session decision): every hard-reject case
 * routes the user to the standalone `cdk migrate --from-stack <name>
 * --output-dir ./tmp` flow so they can manually inspect the generated
 * code and decide how to proceed (e.g. delete the Custom Resource
 * from the source CFn stack before re-running cdkd migrate).
 */
export function validatePrefetchResult(result: PrefetchResult): void {
  // Non-terminal CFn stack state — refuse before any codegen.
  if (!STABLE_TERMINAL_STATUSES.has(result.stackStatus)) {
    throw new LocalMigrateError(
      `CloudFormation stack is in status '${result.stackStatus}', ` +
        `which is not a stable terminal state. Wait for the stack to settle ` +
        `(or roll back) before running 'cdkd migrate'.`
    );
  }

  // Collect every unsupported resource so the error message lists them
  // all at once — partial reports force the user into a hunt-and-fix
  // loop where they fix one and re-run only to discover another.
  const offenders: Array<{ LogicalResourceId: string; ResourceType: string }> = [];
  for (const r of result.resources) {
    if (isHardRejectType(r.ResourceType)) {
      offenders.push({
        LogicalResourceId: r.LogicalResourceId,
        ResourceType: r.ResourceType,
      });
    }
  }
  if (offenders.length === 0) {
    return;
  }

  const lines = offenders.map((o) => `  - ${o.LogicalResourceId} (${o.ResourceType})`);
  throw new LocalMigrateError(
    `Source CloudFormation stack contains resource types that 'cdkd migrate' cannot adopt:\n` +
      `${lines.join('\n')}\n\n` +
      `Lambda-backed Custom Resources and nested CloudFormation stacks are out of scope for #465.\n` +
      `To migrate the rest of the stack, either:\n` +
      `  1. Delete the unsupported resources from the source CFn stack first, OR\n` +
      `  2. Run upstream 'cdk migrate' standalone to inspect the generated code:\n` +
      `       cdk migrate --from-stack --stack-name <source-stack> --output-path ./tmp\n` +
      `     then hand-author CDK constructs to replace the Custom Resource semantics.`
  );
}

/**
 * Whether the given resource type is in the hard-reject set. Matches
 * literal types from {@link HARD_REJECT_RESOURCE_TYPES} AND the
 * `Custom::*` prefix pattern (user-defined Custom Resource types).
 */
function isHardRejectType(resourceType: string): boolean {
  if (HARD_REJECT_RESOURCE_TYPES.has(resourceType)) return true;
  if (resourceType.startsWith('Custom::')) return true;
  return false;
}

/**
 * Scan a parsed CFn template body for stack-level Transform blocks.
 * Accepts both the scalar form (`Transform: AWS::Serverless-2016-10-31`)
 * and the array form (`Transform: [AWS::Serverless-2016-10-31, ...]`).
 *
 * Tolerant of either JSON or YAML input — the codec at `yaml-cfn.ts`
 * already normalizes to the same parsed shape.
 */
function detectTransforms(templateBody: string): TransformInfo {
  let parsed: unknown;
  try {
    parsed = parseCfnTemplate(templateBody);
  } catch {
    // Malformed template — surface a default ("no transforms") so the
    // migration proceeds; if the template is structurally broken,
    // `cdk migrate` will surface a clearer error than cdkd's pre-flight.
    return { hasSamTransform: false, hasIncludeTransform: false };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { hasSamTransform: false, hasIncludeTransform: false };
  }
  const transformRaw = (parsed as Record<string, unknown>)['Transform'];
  const transforms: string[] = Array.isArray(transformRaw)
    ? transformRaw.map((t) => String(t))
    : typeof transformRaw === 'string'
      ? [transformRaw]
      : [];

  return {
    hasSamTransform: transforms.some((t) => t.startsWith('AWS::Serverless')),
    hasIncludeTransform: transforms.some(
      (t) => t === 'AWS::Include' || t.startsWith('AWS::Include')
    ),
  };
}
