/**
 * `CfnLocalStateProvider` — implementation of {@link LocalStateProvider}
 * backed by a deployed CloudFormation stack. Powers `cdkd local *
 * --from-cfn-stack` (issue #606).
 *
 * The shape mirrors the SAM CLI's `sam local invoke --stack-name X`
 * behavior: reach into a deployed CFn stack via `DescribeStackResources`
 * to look up physical IDs of every same-stack resource, then make those
 * IDs available to the existing `state-resolver.ts` substitution engine.
 * This lets `cdkd local *` substitute env vars / secrets / images that
 * reference deployed resources in a CDK app deployed via the upstream
 * CDK CLI (`cdk deploy` → CloudFormation) WITHOUT first migrating the
 * stack to cdkd.
 *
 * Wire-format mapping:
 *
 *   - `Ref: <LogicalId>` → resolved via the synthetic `ResourceState`
 *     map built from `DescribeStackResources.StackResources[]` (one
 *     entry per `(LogicalResourceId, PhysicalResourceId, ResourceType)`
 *     tuple).
 *   - `Fn::GetAtt: [<LogicalId>, <Attr>]` → **warn-and-drop**. CFn's
 *     `DescribeStackResources` does NOT return per-attribute values
 *     and the v1 policy (issue #606 recommendation (a)) is to surface
 *     a per-key warn instead of pulling in the full provisioning layer
 *     to call provider-specific describe APIs (e.g. `GetQueueAttributes`
 *     for SQS, `GetFunction` for Lambda). Users override the affected
 *     env var via `--env-vars` if the value is critical.
 *   - `Fn::ImportValue: <exportName>` → resolved via `ListExports`
 *     (paginated). Same-region only — CFn exports are region-scoped.
 *   - `Fn::GetStackOutput` → rejected with a clear pointer that the
 *     intrinsic is cdkd-specific (CFn has no equivalent — exports +
 *     outputs are the only cross-stack vocabulary CFn understands).
 *   - Stack outputs (consumed by both `Fn::GetStackOutput` and the
 *     cross-stack-resolver's index-miss fallback) → sourced from
 *     `DescribeStacks.Outputs[]`.
 *
 * Region handling: the provider takes a single region at construction
 * time (the `cdkd local *` commands resolve this from
 * `--stack-region` > `--region` > `AWS_REGION` > the synth-derived
 * region per the existing `--from-state` precedence). Cross-region
 * `Fn::ImportValue` is out of scope for v1 (CFn's `ListExports` is
 * region-scoped; a future PR can add a multi-region scan if real
 * usage justifies it).
 *
 * AWS API contract notes:
 *
 *   - `DescribeStackResources` is unpaginated up to 500 resources (CFn's
 *     hard stack cap). One call suffices for the entire stack.
 *   - `DescribeStacks` is unpaginated when called with `StackName`.
 *   - `ListExports` is paginated; the provider walks `NextToken` until
 *     the page set is exhausted.
 */

import {
  CloudFormationClient,
  DescribeStackResourcesCommand,
  DescribeStacksCommand,
  ListExportsCommand,
} from '@aws-sdk/client-cloudformation';
import { getLogger } from '../utils/logger.js';
import type { ResourceState } from '../types/state.js';
import type { CrossStackResolver } from './state-resolver.js';
import type { LocalStateProvider, LocalStateRecord } from './local-state-provider.js';

export interface CfnLocalStateProviderOptions {
  /**
   * CFn stack name to read physical IDs / outputs from. Required; the
   * CLI layer resolves the bare-vs-explicit form (`--from-cfn-stack`
   * with no value → uses the cdkd stack name) before calling the
   * provider.
   */
  cfnStackName: string;
  /**
   * AWS region the CFn stack lives in. Reused from `--stack-region`
   * per issue #606 recommendation (no separate `--cfn-stack-region` flag).
   */
  region: string;
  /**
   * Optional AWS profile name. When set, threaded through to the
   * `CloudFormationClient` config so the SDK reads credentials from the
   * named profile in `~/.aws/credentials` / `~/.aws/config`. When unset,
   * the SDK's default credential chain (env vars / `AWS_PROFILE` /
   * shared config / IAM role) picks the credentials.
   *
   * Issue #628: an earlier revision captured this option but did NOT
   * pass it to the client, so `cdkd local start-api --from-cfn-stack
   * <stack> --profile <profile>` silently queried the default account
   * and failed with "Stack does not exist" when the stack lived
   * elsewhere. Matches the threading pattern in
   * `S3LocalStateProvider` / `S3StateBackend` /
   * `src/utils/aws-region-resolver.ts` — every other cdkd command
   * already passes `profile` straight to the SDK client.
   */
  profile?: string;
}

export class CfnLocalStateProvider implements LocalStateProvider {
  // erasableSyntaxOnly forbids parameter-property shorthand; declare
  // fields explicitly + assign in the body.
  public readonly label = '--from-cfn-stack';
  private readonly cfnStackName: string;
  private readonly region: string;
  // The CFn client is constructed lazily on the first `load` /
  // `buildCrossStackResolver` call so a CLI invocation that never
  // exercises the provider (e.g. when the synth template has no
  // intrinsic-valued env vars) doesn't open a needless client.
  private client: CloudFormationClient | undefined;
  private readonly clientOptions: { region: string; profile?: string };
  // Issue #611 NIT 2: `dispose()` is terminal. The lazy `getClient()`
  // path would otherwise resurrect the client on a post-dispose
  // `load()` / `buildCrossStackResolver()` call, which violates the
  // interface contract (the CLI calls `dispose()` in its outer
  // `finally`, so any subsequent provider use is a programming bug).
  // Flip the flag in `dispose()` and throw on any operational entry
  // point so the bug surfaces loudly.
  private disposed = false;

  constructor(opts: CfnLocalStateProviderOptions) {
    this.cfnStackName = opts.cfnStackName;
    this.region = opts.region;
    this.clientOptions = { region: opts.region };
    if (opts.profile !== undefined) this.clientOptions.profile = opts.profile;
  }

  private getClient(): CloudFormationClient {
    if (this.disposed) {
      throw new Error('CfnLocalStateProvider used after dispose()');
    }
    if (!this.client) {
      // Profile threading matches `S3LocalStateProvider` /
      // `S3StateBackend` / `src/utils/aws-region-resolver.ts` — every
      // other cdkd command already passes the CLI's `--profile` through
      // to the SDK client constructor so the SDK's profile-aware
      // credential resolution picks up the named profile from
      // `~/.aws/credentials` / `~/.aws/config`. Issue #628.
      this.client = new CloudFormationClient({
        region: this.region,
        ...(this.clientOptions.profile !== undefined && { profile: this.clientOptions.profile }),
      });
    }
    return this.client;
  }

  /**
   * Load the deployed CFn stack's resources + outputs and return them
   * as a synthetic `LocalStateRecord` (matching the shape the existing
   * S3-state-driven path produces). `synthRegion` is accepted for
   * interface parity with the S3 provider but ignored here — the
   * provider is region-bound at construction time.
   *
   * Best-effort: on any CFn API failure (stack not found, access
   * denied, throttling) the provider logs a warn and returns
   * `undefined`. The caller then falls back to the PR 1 warn-and-drop
   * behavior on every intrinsic-valued env var.
   */
  public async load(
    _stackName: string,
    _synthRegion: string | undefined
  ): Promise<LocalStateRecord | undefined> {
    if (this.disposed) {
      throw new Error('CfnLocalStateProvider used after dispose()');
    }
    const logger = getLogger();
    const client = this.getClient();

    let resourceMap: Record<string, ResourceState>;
    try {
      const resp = await client.send(
        new DescribeStackResourcesCommand({ StackName: this.cfnStackName })
      );
      resourceMap = buildResourceStateMap(resp.StackResources ?? []);
    } catch (err) {
      logger.warn(
        `${this.label}: DescribeStackResources(${this.cfnStackName}) failed: ${formatAwsErrorForWarn(err)}. ` +
          `Was the stack deployed in region '${this.region}'? Falling back.`
      );
      return undefined;
    }

    let outputs: Record<string, string>;
    try {
      const resp = await client.send(new DescribeStacksCommand({ StackName: this.cfnStackName }));
      const stack = resp.Stacks?.[0];
      if (!stack) {
        logger.warn(
          `${this.label}: DescribeStacks(${this.cfnStackName}) returned no stack; outputs will be empty.`
        );
        outputs = {};
      } else {
        outputs = buildOutputsMap(stack.Outputs ?? []);
      }
    } catch (err) {
      logger.warn(
        `${this.label}: DescribeStacks(${this.cfnStackName}) failed: ${formatAwsErrorForWarn(err)}. ` +
          `Outputs will be empty (Fn::GetStackOutput cannot resolve).`
      );
      outputs = {};
    }

    return {
      resources: resourceMap,
      outputs,
      region: this.region,
    };
  }

  /**
   * Build a `CrossStackResolver` that resolves `Fn::ImportValue` via
   * `cloudformation:ListExports`. `Fn::GetStackOutput` is rejected here
   * — it's a cdkd-specific intrinsic with no CFn-side equivalent, and
   * the user-visible error message names the right intrinsic
   * (`Fn::ImportValue`) for that use case.
   *
   * `consumerRegion` is accepted for interface parity with the S3
   * provider but the `CfnLocalStateProvider` only resolves exports in
   * the region the stack lives in (which is the same region the
   * consumer Lambda runs in for the common single-region use case).
   * A future PR can extend this to multi-region by walking the SDK's
   * partition-aware region list.
   */
  public async buildCrossStackResolver(
    _consumerRegion: string
  ): Promise<CrossStackResolver | undefined> {
    if (this.disposed) {
      throw new Error('CfnLocalStateProvider used after dispose()');
    }
    const logger = getLogger();
    const client = this.getClient();
    const label = this.label;
    const region = this.region;
    // Memoize the exports map across multiple `Fn::ImportValue` lookups
    // in one substitution pass so a multi-import env block doesn't pay
    // N round-trips to ListExports.
    //
    // Issue #611 fix: cache the in-flight Promise (not just the
    // resolved value) so parallel `resolveImport` callers single-flight
    // through ONE `ListExports` walk. Without this, two awaiting
    // callers both see `cachedExports === undefined` at entry, both
    // fire `fetchAllExports`, and the cache only "saves" later
    // sequential callers. The parallel race is realistic: a single
    // env block with two `Fn::ImportValue`s drives the substitution
    // engine through `Promise.all`-shaped concurrent resolver calls.
    let exportsPromise: Promise<Map<string, string> | undefined> | undefined;

    const ensureExports = (): Promise<Map<string, string> | undefined> => {
      if (exportsPromise) return exportsPromise;
      exportsPromise = fetchAllExports(client).catch((err: unknown) => {
        logger.warn(
          `${label}: ListExports (${region}) failed: ${formatAwsErrorForWarn(err)}. ` +
            `Fn::ImportValue intrinsics will warn-and-drop.`
        );
        return undefined;
      });
      return exportsPromise;
    };

    return {
      async resolveImport(exportName: string): Promise<string | undefined> {
        const map = await ensureExports();
        if (!map) return undefined;
        return map.get(exportName);
      },
      async resolveGetStackOutput(
        producerStack: string,
        producerRegion: string,
        outputName: string
      ): Promise<string | undefined> {
        // `Fn::GetStackOutput` is a cdkd-specific intrinsic that reads
        // the producer stack's state.json directly from S3. There is
        // no CFn-side equivalent (CFn templates use `Fn::ImportValue`
        // + an explicit `Outputs.<name>.Export`); rather than silently
        // returning undefined we surface a logger.warn naming the
        // intrinsic and the producer so the user sees why the env var
        // dropped. The `state-resolver.ts` async path turns the
        // `undefined` into its own per-key warn with the standard
        // "output not found in producer stack state" message, so
        // skipping the warn here would mask the cdkd-vs-CFn nature
        // of the gap.
        logger.warn(
          `${label}: Fn::GetStackOutput '${producerStack}.${outputName}' (${producerRegion}) is a cdkd-specific intrinsic with no CloudFormation equivalent. ` +
            `Use Fn::ImportValue against an exported output instead, or deploy the producer stack via cdkd deploy and use --from-state.`
        );
        return undefined;
      },
    };
  }

  public dispose(): void {
    this.disposed = true;
    if (this.client) {
      this.client.destroy();
      this.client = undefined;
    }
  }
}

/**
 * Build the synthetic per-logical-id resource map from
 * `DescribeStackResources` output. Each `ResourceState` carries the
 * physical id (covers `Ref`) and the resource type; `attributes` is
 * left empty per issue #606's (a) recommendation — the warn-and-drop
 * policy on unresolvable `Fn::GetAtt` is the v1 contract. The other
 * `ResourceState` fields (`properties`, `dependencies`, etc.) are
 * also left empty since the substituter doesn't read them.
 *
 * Exported for unit testing.
 */
export function buildResourceStateMap(
  stackResources: Array<{
    LogicalResourceId?: string | undefined;
    PhysicalResourceId?: string | undefined;
    ResourceType?: string | undefined;
  }>
): Record<string, ResourceState> {
  const out: Record<string, ResourceState> = {};
  for (const r of stackResources) {
    // CFn occasionally returns half-populated entries for mid-create
    // resources or sentinels like `AWS::CDK::Metadata`. Skip them —
    // they have no usable physical id, and the substituter would
    // report `Ref: <id>` as unresolved with a clearer error.
    if (!r.LogicalResourceId || !r.PhysicalResourceId || !r.ResourceType) {
      continue;
    }
    out[r.LogicalResourceId] = {
      physicalId: r.PhysicalResourceId,
      resourceType: r.ResourceType,
      properties: {},
      attributes: {},
      dependencies: [],
    };
  }
  return out;
}

/**
 * Build the outputs map from `DescribeStacks.Outputs[]`. CFn outputs
 * are stringly typed at the wire level (key + value, with the value
 * always a string), so the cast is safe.
 *
 * Exported for unit testing.
 */
export function buildOutputsMap(
  outputs: Array<{ OutputKey?: string | undefined; OutputValue?: string | undefined }>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const o of outputs) {
    if (o.OutputKey === undefined || o.OutputValue === undefined) continue;
    out[o.OutputKey] = o.OutputValue;
  }
  return out;
}

/**
 * Walk `ListExports` until every page is consumed and return the
 * `Name -> Value` map. Same-region only (CFn exports are
 * region-scoped); the caller picks the region at provider
 * construction time.
 *
 * Exported for unit testing.
 */
export async function fetchAllExports(client: CloudFormationClient): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let nextToken: string | undefined;
  // Safety bound — CFn allows at most ~200 exports per account/region,
  // so 50 pages of 100 each is well above the realistic ceiling.
  // Defends against a hypothetical pagination bug returning the same
  // NextToken in a loop.
  let pages = 0;
  do {
    const resp = await client.send(
      new ListExportsCommand({ ...(nextToken !== undefined && { NextToken: nextToken }) })
    );
    for (const exp of resp.Exports ?? []) {
      if (exp.Name === undefined || exp.Value === undefined) continue;
      out.set(exp.Name, exp.Value);
    }
    nextToken = resp.NextToken;
    pages += 1;
    if (pages > 50) {
      throw new Error(
        'ListExports pagination exceeded 50 pages — likely a malformed NextToken loop.'
      );
    }
    // Issue #611 NIT 3: defend against an empty-string `NextToken`. The
    // SDK type allows `string | undefined`; AWS shouldn't return `''`
    // in practice, but if it ever does the loop would keep firing
    // `ListExports({ NextToken: '' })` until the 50-page bound — wasted
    // round-trips on an empty result page. Treat `''` as terminal.
  } while (nextToken !== undefined && nextToken !== '');
  return out;
}

/**
 * Format an AWS SDK error as `<name> (HTTP <status>): <message>` so the
 * surfaced warn name the error class (e.g. `ThrottlingException`,
 * `AccessDeniedException`, `ValidationError`) and HTTP status alongside
 * the human-readable message. Falls back to the bare message for
 * non-SDK errors (the existing pre-issue-#611 behavior) so non-AWS
 * thrown values still surface meaningfully. Exported for unit testing.
 *
 * Issue #611 NIT 4 — `normalizeAwsError` in `utils/error-handler.ts` is
 * S3-bucket-specific (it rewrites the synthetic `Unknown`/`UnknownError`
 * with bucket / region context), so the CFn provider extracts the
 * pieces directly here.
 */
export function formatAwsErrorForWarn(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const name = err.name && err.name !== 'Error' ? err.name : undefined;
  const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  const prefixParts: string[] = [];
  if (name !== undefined) prefixParts.push(name);
  if (status !== undefined) prefixParts.push(`HTTP ${status}`);
  if (prefixParts.length === 0) return err.message;
  return `${prefixParts.join(' ')}: ${err.message}`;
}
