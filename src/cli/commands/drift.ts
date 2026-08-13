import * as readline from 'node:readline/promises';
import { Command, Option } from 'commander';
import { GetRoleCommand, GetUserCommand } from '@aws-sdk/client-iam';
import {
  commonOptions,
  deprecatedRegionOption,
  stateOptions,
  warnIfDeprecatedRegion,
} from '../options.js';
import { getLogger } from '../../utils/logger.js';
import {
  CdkdError,
  PartialFailureError,
  ResourceUpdateNotSupportedError,
  withErrorHandling,
} from '../../utils/error-handler.js';
import { S3StateBackend, type StackStateRef } from '../../state/s3-state-backend.js';
import { LockManager } from '../../state/lock-manager.js';
import { setAwsClients, AwsClients } from '../../utils/aws-clients.js';
import { resolveStateBucketWithDefault } from '../config-loader.js';
import { ProviderRegistry } from '../../provisioning/provider-registry.js';
import { registerAllProviders } from '../../provisioning/register-providers.js';
import {
  calculateResourceDrift,
  undeclaredEmptyObservedKeys,
  type PropertyDrift,
} from '../../analyzer/drift-calculator.js';
import {
  canonicalizePrincipalUniqueIds,
  parseIamPrincipalArn,
  type PrincipalUniqueIdResolver,
} from '../../analyzer/drift-principal-normalize.js';
import { canonicalizeIpProtocols } from '../../analyzer/drift-protocol-normalize.js';
import { CC_API_FALLBACK_DENY_LIST } from '../../analyzer/drift-cc-api-deny-list.js';
import { stripCcApiAwsManagedFields } from '../../analyzer/cc-api-strip.js';
import { CloudControlProvider } from '../../provisioning/cloud-control-provider.js';
import { withStackName } from '../../provisioning/resource-name.js';
import { applyRoleArnIfSet } from '../../utils/role-arn.js';
import { withRetry } from '../../deployment/retry.js';
import { isThrottlingError } from '../../deployment/retryable-errors.js';
import type { ReadCurrentStateContext, ResourceProvider } from '../../types/resource.js';
import type { ResourceState, StackState } from '../../types/state.js';

/**
 * Per-resource drift outcome surfaced by the drift command.
 *
 * The three terminal states are:
 *   - `drifted` — at least one property differs between state and AWS.
 *   - `clean` — every state-recorded property matches AWS.
 *   - `unsupported` — the provider does not implement `readCurrentState`
 *     yet (the optional method returned `undefined`). Reported separately
 *     so users see what's still uncovered.
 */
type DriftOutcome =
  | {
      kind: 'drifted';
      logicalId: string;
      resourceType: string;
      changes: PropertyDrift[];
      /**
       * Snapshot of AWS-current properties returned by the provider's
       * `readCurrentState`. Captured here so `--revert` can pass it to
       * `provider.update` as the `previousProperties` argument without
       * re-issuing the read.
       */
      awsProperties: Record<string, unknown>;
    }
  | { kind: 'clean'; logicalId: string; resourceType: string }
  | { kind: 'unsupported'; logicalId: string; resourceType: string }
  /**
   * `skipped` is reserved for resource types where drift detection is not
   * conceptually applicable (currently: `Custom::*`). Unlike `unsupported`
   * (= "provider does not YET implement drift detection — user might want
   * to know"), `skipped` is silent in the human report so it doesn't
   * generate noise on every drift run for stacks that contain Custom
   * Resources (the CDK-built-in `Custom::S3AutoDeleteObjects` helper is
   * by far the most common case).
   */
  | { kind: 'skipped'; logicalId: string; resourceType: string };

/**
 * Aggregated drift report for one stack — what gets printed (or emitted as
 * JSON) for that stack. Aggregation across multiple stacks happens in the
 * top-level command driver.
 *
 * `state` and `etag` are kept on the report so the resolution paths
 * (`--accept`, `--revert`) can reuse the already-loaded state without
 * re-reading from S3 — and `etag` is required for the optimistic-lock
 * `IfMatch` write on `--accept`.
 */
interface StackDriftReport {
  stackName: string;
  region: string;
  outcomes: DriftOutcome[];
  /** State that drift was computed against. Populated on every report. */
  state: StackState;
  /** S3 ETag of the state read; needed for `--accept`'s conditional write. */
  etag: string;
  /** When the state was loaded from the legacy v1 key — forwarded to saveState. */
  migrationPending: boolean;
}

/**
 * Distinguish "drift detected" (exit 1) from "command crashed" (exit 1
 * via the default handler) so the drift command can fail fast and the
 * top-level handler doesn't add a stack trace for the expected case.
 *
 * Carries no message of its own — the command body printed the report
 * before throwing, so the handler suppresses the duplicate `error()`.
 */
class DriftDetectedError extends CdkdError {
  readonly silent: boolean = true;

  constructor() {
    super('drift detected', 'DRIFT_DETECTED');
    this.name = 'DriftDetectedError';
    Object.setPrototypeOf(this, DriftDetectedError.prototype);
  }
}

/**
 * `cdkd drift [<stack>...]` command implementation.
 *
 * Three operating modes (mutually exclusive):
 *
 *   1. **Detection only** (default) — reads each named stack's state from
 *      S3, asks every resource's provider for its `readCurrentState`
 *      snapshot, and compares against the state-recorded `properties`.
 *      Outputs a per-stack report and exits with `0` when no drift, `1`
 *      when drift is detected (rich human report is the only output).
 *
 *   2. **`--accept`** — state ← AWS. For each drifted property, write
 *      the AWS-current value back into cdkd state. Use this when the
 *      user manually changed something in the AWS console and wants
 *      cdkd state to "catch up" without re-deploying. Requires a stack
 *      lock. Confirms with the user unless `-y/--yes`.
 *
 *   3. **`--revert`** — AWS ← state. For each drifted resource, call
 *      `provider.update` with the cdkd-state values to push them back
 *      into AWS. Use this to undo a manual AWS console change. Requires
 *      a stack lock. Per-resource failures are collected and surface as
 *      `PartialFailureError` (exit 2) at the end of the run; one
 *      resource's failure does not abort the rest.
 *
 * `--accept` and `--revert` are mutually exclusive. Both honor `--dry-run`
 * (print the planned mutations, exit 0 without acquiring a lock).
 */
async function driftCommand(
  stacks: string[],
  options: {
    all?: boolean;
    json: boolean;
    stateBucket?: string;
    statePrefix: string;
    region?: string;
    stackRegion?: string;
    profile?: string;
    verbose: boolean;
    yes?: boolean;
    roleArn?: string;
    accept?: boolean;
    revert?: boolean;
    dryRun?: boolean;
    concurrency?: number;
  }
): Promise<void> {
  const logger = getLogger();
  if (options.verbose) {
    logger.setLevel('debug');
  }

  warnIfDeprecatedRegion(options);

  if (options.accept && options.revert) {
    throw new Error(
      '--accept and --revert are mutually exclusive. ' +
        'Use --accept to update cdkd state from AWS, or --revert to push cdkd state values back into AWS.'
    );
  }

  // Resolve --role-arn / CDKD_ROLE_ARN before any AWS call.
  await applyRoleArnIfSet({ roleArn: options.roleArn, region: options.region });

  const awsClients = new AwsClients({
    ...(options.region && { region: options.region }),
    ...(options.profile && { profile: options.profile }),
  });
  setAwsClients(awsClients);

  try {
    const region = options.region || process.env['AWS_REGION'] || 'us-east-1';
    const bucket = await resolveStateBucketWithDefault(options.stateBucket, region);
    const prefix = options.statePrefix;
    const stateConfig = { bucket, prefix };

    const stateBackend = new S3StateBackend(awsClients.s3, stateConfig, {
      region,
      ...(options.profile && { profile: options.profile }),
    });
    await stateBackend.verifyBucketExists();

    const providerRegistry = new ProviderRegistry();
    registerAllProviders(providerRegistry);
    providerRegistry.setCustomResourceResponseBucket(bucket);

    // PR J: shared CC API fallback used when an SDK provider doesn't
    // implement readCurrentState yet. Constructed once per command so we
    // don't re-instantiate the underlying CloudControl client per stack.
    const ccApiFallback = new CloudControlProvider();

    // Issue #1515: one resolver (and one cache) per command, so a stack whose
    // resources reference the same role only pays a single `iam:GetRole`.
    const resolvePrincipalUniqueId = createIamPrincipalUniqueIdResolver(awsClients);

    const stateRefs = await stateBackend.listStacks();
    const targetRefs = resolveTargetRefs(stacks, stateRefs, options);

    const reports: StackDriftReport[] = [];
    for (const ref of targetRefs) {
      if (!ref.region) {
        // Legacy `version: 1` records have no region in their key — same
        // gap surfaced by `state show`. Tell the user how to migrate.
        throw new Error(
          `Stack '${ref.stackName}' has only a legacy state record without a region. ` +
            `Run 'cdkd deploy ${ref.stackName}' (or any cdkd write) to migrate it to the region-scoped layout, ` +
            `then re-run drift detection.`
        );
      }
      const report = await runDriftForStack(
        ref.stackName,
        ref.region,
        stateBackend,
        providerRegistry,
        ccApiFallback,
        resolvePrincipalUniqueId
      );
      reports.push(report);
    }

    if (options.json) {
      writeJsonReport(reports);
    } else {
      writeHumanReport(reports);
    }

    // Detection-only path: exit 0 / 1 based on whether drift was found,
    // regardless of subsequent flags. `--accept` / `--revert` take over
    // below if requested.
    const drifted = reports.some((r) => r.outcomes.some((o) => o.kind === 'drifted'));

    if (!options.accept && !options.revert) {
      if (drifted) {
        throw new DriftDetectedError();
      }
      return;
    }

    // Resolution path. Both flags share the prompt + lock + state-loaded
    // reports; the per-resource action differs.
    if (!drifted) {
      logger.info(
        options.accept
          ? 'No drift detected — nothing to accept.'
          : 'No drift detected — nothing to revert.'
      );
      return;
    }

    if (options.accept) {
      await runAccept(reports, stateBackend, stateConfig, awsClients, options);
    } else {
      await runRevert(reports, providerRegistry, stateBackend, stateConfig, awsClients, options);
    }
  } finally {
    awsClients.destroy();
  }
}

/**
 * Resolve the set of `(stackName, region)` pairs the command should
 * inspect. With `--all`, every state record qualifies; without `--all`,
 * each positional pattern is matched against the state index using the
 * same exact-name + region disambiguation rules as `state destroy`.
 */
function resolveTargetRefs(
  stacks: string[],
  stateRefs: StackStateRef[],
  options: { all?: boolean; stackRegion?: string }
): StackStateRef[] {
  if (options.all) {
    if (stateRefs.length === 0) {
      throw new Error('No stacks found in state bucket.');
    }
    if (options.stackRegion) {
      return stateRefs.filter((r) => r.region === options.stackRegion);
    }
    return stateRefs;
  }

  // No positional args and no --all: mirror `cdkd deploy` / `cdkd destroy`'s
  // single-stack auto-detect. Use state as the source of truth (drift is
  // state-driven, no synth involved).
  if (stacks.length === 0) {
    const candidates = options.stackRegion
      ? stateRefs.filter((r) => r.region === options.stackRegion)
      : stateRefs;
    if (candidates.length === 0) {
      throw new Error(
        'No stacks found in state bucket. Run `cdkd deploy` first, or pass --all explicitly.'
      );
    }
    if (candidates.length === 1) {
      return [candidates[0]!];
    }
    const listing = candidates
      .map((r) => `${r.stackName}${r.region ? ` (${r.region})` : ''}`)
      .join(', ');
    throw new Error(
      `Multiple stacks found in state: ${listing}. Specify stack name(s) or use --all.`
    );
  }

  const out: StackStateRef[] = [];
  for (const stackName of stacks) {
    const matches = stateRefs.filter((r) => r.stackName === stackName);
    if (matches.length === 0) {
      throw new Error(
        `No state found for stack '${stackName}'. Run 'cdkd state list' to see available stacks.`
      );
    }
    if (options.stackRegion) {
      const ref = matches.find((r) => r.region === options.stackRegion);
      if (!ref) {
        const seen = matches.map((r) => r.region ?? '(legacy)').join(', ');
        throw new Error(
          `No state found for stack '${stackName}' in region '${options.stackRegion}'. ` +
            `Available regions: ${seen}.`
        );
      }
      out.push(ref);
      continue;
    }
    if (matches.length === 1) {
      out.push(matches[0]!);
      continue;
    }
    const regions = matches.map((r) => r.region ?? '(legacy)').join(', ');
    throw new Error(
      `Stack '${stackName}' has state in multiple regions: ${regions}. ` +
        `Re-run with --stack-region <region> to disambiguate.`
    );
  }
  return out;
}

/**
 * The live half of the #1515 principal canonicalization: resolve an IAM role /
 * user ARN to that principal's unique id (`AROA…` / `AIDA…`).
 *
 * Results are cached per ARN for the whole command — INCLUDING the failures, so
 * a deleted role (the case where AWS keeps the unique id forever, and therefore
 * the likeliest one to appear here) costs exactly one API call rather than one
 * per resource that references it.
 *
 * Every failure resolves to `undefined` rather than throwing: a missing
 * `iam:GetRole` permission, a cross-account principal, or a deleted role must
 * leave the comparison exactly as it was — the drift is then reported, which is
 * the safe direction. Drift detection must never fail because a cosmetic
 * normalization could not run.
 *
 * **The response ARN is compared back to the requested one, and that check is
 * what makes the "never hides a real change" claim true rather than aspirational.**
 * `GetRole` / `GetUser` are account-local and take a NAME, not an ARN, so the
 * lookup silently answers about the CALLER's account and about the wrong IAM
 * path: `arn:aws:iam::<other-acct>:role/Foo` and
 * `arn:aws:iam::<self>:role/prod/Foo` would both come back as this account's
 * root-path `Foo`, and the pass would then "prove" two DIFFERENT principals
 * equal and collapse a genuine drift. Round-tripping the ARN costs nothing and
 * turns both cases into an unresolved lookup, i.e. drift reported.
 */
function createIamPrincipalUniqueIdResolver(awsClients: AwsClients): PrincipalUniqueIdResolver {
  const cache = new Map<string, string | undefined>();
  let warnedOnDenied = false;
  return async (arn: string): Promise<string | undefined> => {
    if (cache.has(arn)) return cache.get(arn);
    let uniqueId: string | undefined;
    const principal = parseIamPrincipalArn(arn);
    if (principal) {
      try {
        let entityArn: string | undefined;
        let entityId: string | undefined;
        if (principal.kind === 'role') {
          const role = (await awsClients.iam.send(new GetRoleCommand({ RoleName: principal.name })))
            .Role;
          entityArn = role?.Arn;
          entityId = role?.RoleId;
        } else {
          const user = (await awsClients.iam.send(new GetUserCommand({ UserName: principal.name })))
            .User;
          entityArn = user?.Arn;
          entityId = user?.UserId;
        }
        // Same principal, not merely the same NAME — see the note above.
        // Compared case-INSENSITIVELY on the name-bearing tail: `GetRole` is
        // case-insensitive on the name, so `…:role/MyRole` legitimately comes
        // back as the ARN AWS stored, and treating that as "a different
        // entity" would refuse a principal that is provably the same one.
        if (entityArn !== undefined && entityArn.toLowerCase() === arn.toLowerCase()) {
          uniqueId = entityId;
        } else {
          getLogger().debug(
            `Principal ${arn} resolved to ${entityArn ?? 'no entity'} — ` +
              `same name in this account or under another IAM path; ` +
              `leaving the policy principal comparison untouched.`
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Classified on the ERROR NAME, never on the message: IAM's
        // `NoSuchEntity` text embeds the ROLE NAME ("The role with name
        // AccessDeniedHandlerRole cannot be found"), so a message match turns
        // an ordinary deleted role into the scary permission warning — the
        // exact swallow this classification exists to avoid.
        const name = error instanceof Error ? error.name : '';
        const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata
          ?.httpStatusCode;
        const denied = /^AccessDenied|^NotAuthorized/i.test(name) || status === 403;
        if (!warnedOnDenied && denied) {
          warnedOnDenied = true;
          // The AWS message names the CALLER's principal ARN + account id, so
          // it stays at debug (below) rather than riding a warn line into a
          // screenshot or a public CI log — same reason the state-bucket
          // banner was demoted.
          getLogger().warn(
            `Cannot read IAM principals (${name || 'access denied'}). A resource policy whose ` +
              `principal AWS rendered as a unique id (AROA…/AIDA…) may therefore report drift ` +
              `that is only a spelling difference; grant iam:GetRole / iam:GetUser to resolve ` +
              `it, or re-run with --verbose for the full error.`
          );
        }
        getLogger().debug(
          `Could not resolve the unique id of principal ${arn} (${message}); ` +
            `leaving the policy principal comparison untouched.`
        );
        // A THROTTLE is transient, and caching it would poison the rest of the
        // run: every later resource sharing this principal would inherit the
        // phantom drift, and `--revert` would then push the `AROA…` form at
        // S3, which rejects it outright. Mirrors `write-only-properties.ts`,
        // which likewise caches only conclusive answers.
        if (isThrottlingError(error)) return undefined;
      }
    }
    cache.set(arn, uniqueId);
    return uniqueId;
  };
}

/**
 * Run drift detection for one stack and shape the per-resource outcomes
 * into a {@link StackDriftReport}. The state object + etag are stored on
 * the report so `--accept` can write back without a re-read, and
 * `--revert` can pass the captured AWS-current snapshot to
 * `provider.update` as the `previousProperties` argument.
 */
async function runDriftForStack(
  stackName: string,
  region: string,
  stateBackend: S3StateBackend,
  providerRegistry: ProviderRegistry,
  ccApiFallback: CloudControlProvider,
  resolvePrincipalUniqueId: PrincipalUniqueIdResolver
): Promise<StackDriftReport> {
  const result = await stateBackend.getState(stackName, region);
  if (!result) {
    throw new Error(
      `No state found for stack '${stackName}' (${region}). Run 'cdkd state list' to see available stacks.`
    );
  }

  return await withStackName(stackName, async () => {
    const outcomes: DriftOutcome[] = [];
    const state: StackState = result.state;
    const entries = Object.entries(state.resources ?? {}).sort(([a], [b]) => a.localeCompare(b));

    for (const [logicalId, resource] of entries) {
      if (providerRegistry.shouldSkipResource(resource.resourceType)) {
        continue;
      }

      // Issue #323: route Custom Resources to 'skipped' (silent) BEFORE
      // looking up the provider, since the lookup falls through to the
      // CC API path which would short-circuit them to 'unsupported'
      // (= "drift unknown" noise in the human report). Custom Resource
      // drift would require re-invoking the handler Lambda, which is
      // out of scope for `cdkd drift`. Both Lambda-backed CR types are
      // covered: `Custom::*` (the user-named form) AND
      // `AWS::CloudFormation::CustomResource` (what CDK emits for
      // `new cdk.CustomResource(...)` without an explicit `resourceType`).
      if (
        resource.resourceType.startsWith('Custom::') ||
        resource.resourceType === 'AWS::CloudFormation::CustomResource'
      ) {
        outcomes.push({
          kind: 'skipped',
          logicalId,
          resourceType: resource.resourceType,
        });
        continue;
      }

      let provider;
      try {
        // Schema v7+ (#614): route reads via state-recorded
        // `provisionedBy` so a CC-managed resource is read through Cloud
        // Control's `readCurrentState`. Pre-v7 state has
        // `provisionedBy: undefined` which preserves legacy SDK routing.
        provider = providerRegistry.getProviderFor({
          resourceType: resource.resourceType,
          provisionedBy: resource.provisionedBy,
        }).provider;
      } catch {
        outcomes.push({
          kind: 'unsupported',
          logicalId,
          resourceType: resource.resourceType,
        });
        continue;
      }

      // First try the SDK provider's first-class readCurrentState (PR G's
      // 4-arg signature). When the SDK Provider hasn't shipped its own
      // readCurrentState yet, fall back to the Cloud Control API provider
      // (PR F). The fallback is gated by two false-drift guards (PR J):
      //
      //   1. Deny-list (`CC_API_FALLBACK_DENY_LIST`) — types with verified
      //      structural divergence between CC API response shape and the
      //      CFn-template shape cdkd state stores (e.g.
      //      `AWS::IAM::ManagedPolicy`'s URL-encoded `PolicyDocument`)
      //      short-circuit to "drift unknown" so they don't fire false
      //      positives every run.
      //   2. Strip (`stripCcApiAwsManagedFields`) — generic AWS-managed
      //      fields (timestamps, generated identifiers, runtime status)
      //      are removed from CC API responses before the comparator sees
      //      them.
      let aws: Record<string, unknown> | undefined;
      if (provider.readCurrentState) {
        aws = await provider.readCurrentState(
          resource.physicalId,
          logicalId,
          resource.resourceType,
          resource.properties ?? {},
          buildReadCurrentStateContext(state, logicalId)
        );
      } else {
        if (CC_API_FALLBACK_DENY_LIST[resource.resourceType]) {
          outcomes.push({
            kind: 'unsupported',
            logicalId,
            resourceType: resource.resourceType,
          });
          continue;
        }
        const ccApiAws = await ccApiFallback.readCurrentState(
          resource.physicalId,
          logicalId,
          resource.resourceType,
          resource.properties ?? {}
        );
        if (ccApiAws === undefined) {
          outcomes.push({
            kind: 'unsupported',
            logicalId,
            resourceType: resource.resourceType,
          });
          continue;
        }
        aws = stripCcApiAwsManagedFields(resource.resourceType, ccApiAws);
      }

      if (aws === undefined) {
        outcomes.push({
          kind: 'unsupported',
          logicalId,
          resourceType: resource.resourceType,
        });
        continue;
      }

      // Providers can declare state property paths they cannot read back
      // from AWS (e.g. Lambda `Code`, Secrets Manager `SecretString`). The
      // CC-API fallback has no provider-specific intuition here — only the
      // SDK provider's getDriftUnknownPaths is consulted. The recorded
      // properties are passed so a provider can scope a path to the subset
      // of resources it is actually unreadable for (API Gateway V2
      // `TlsConfig` on a non-private integration, issue #1602).
      const ignorePaths = provider.getDriftUnknownPaths
        ? provider.getDriftUnknownPaths(resource.resourceType, resource.properties ?? {})
        : [];
      // Providers can also declare plain-string array paths that are
      // semantically UNORDERED sets (FSx `WindowsConfiguration.Aliases`, ...).
      // The comparator sorts those on BOTH sides, so an AWS-side reorder is
      // not phantom drift. Same CC-API-fallback caveat as ignorePaths above.
      const unorderedPaths = provider.getDriftUnorderedPaths
        ? provider.getDriftUnorderedPaths(resource.resourceType)
        : [];
      // Prefer the observedProperties baseline (deploy-time AWS snapshot)
      // when present — this is what makes "console-side change to a key
      // the user did not template" surface as drift, instead of being
      // silently ignored because the key is absent from `properties`.
      // Resources written by an older binary (or by a provider without
      // readCurrentState) lack observedProperties; falling back to
      // `properties` preserves the pre-v3 behavior for those.
      // The observed baseline is "what AWS actually had at deploy time"
      // (already includes AWS-managed defaults), so it is safe — and
      // strictly more powerful — to walk the union of baseline+aws keys
      // when descending into nested objects. This is what lets a
      // console-side **key add** to a map-shaped property (Lambda
      // `Environment.Variables.EXTRA`, etc.) surface as drift. The
      // properties fallback (`observedProperties` undefined) keeps the
      // state-keys-only walk so AWS-side defaults the user did not
      // template don't fire false positives on every run.
      const useObserved = resource.observedProperties !== undefined;
      const baseline = useObserved ? resource.observedProperties! : (resource.properties ?? {});
      // Observed-baseline blind spot (issue #1498): the snapshot is captured
      // per-resource BEFORE dependent sibling resources run, so a parent key
      // that a sibling resource type materializes later (ECS
      // ClusterCapacityProviderAssociations -> Cluster.CapacityProviders,
      // AutoScaling::LifecycleHook -> the ASG's hook list, standalone SG
      // ingress/egress rules) is captured empty and later populated —
      // permanent phantom drift that `--revert` would then destructively
      // strip from AWS. Skip top-level keys the template never declared
      // whose captured value was empty; CFn drift only compares
      // template-declared properties, so this restores parity for exactly
      // that class while keeping detection on undeclared keys captured with
      // a real value (AWS-side defaults a console edit could change).
      const observedIgnorePaths = useObserved
        ? undeclaredEmptyObservedKeys(resource.observedProperties!, resource.properties ?? {})
        : [];
      // Issue #1515: AWS renders an IAM principal inside a resource policy as
      // either its ARN or its `AROA…` / `AIDA…` unique id, choosing on its own
      // schedule — so the deploy-time capture and this read can hold two
      // spellings of ONE principal, which is permanent phantom drift `--revert`
      // cannot clear (it writes the recorded form back and AWS re-canonicalizes
      // on write). Canonicalized on BOTH sides, and only for a pair PROVEN
      // equal by an `iam:GetRole` / `GetUser` lookup; anything unresolvable is
      // left alone and still reported. No AWS call unless a unique id is
      // actually present.
      const normalized = await canonicalizePrincipalUniqueIds(
        baseline,
        aws,
        resolvePrincipalUniqueId
      );
      // Issue #1643: EC2 owns the spelling of a security-group rule's
      // `IpProtocol` — it renames the four protocol NUMBERS it has a name for
      // (`1` -> `icmp`, `6` -> `tcp`, `17` -> `udp`, `58` -> `icmpv6`; measured
      // us-east-1 2026-08-12, ingress AND egress) and lower-cases a name it is
      // given. cdkd records what it SENT, so the baseline and this read are two
      // spellings of ONE protocol — permanent phantom drift `--revert` cannot
      // clear, since it revokes and re-authorizes into the same state. Pure and
      // path-scoped to the security-group types (a blanket rewrite would turn an
      // unrelated `'6'` into `'tcp'`), and applied to BOTH sides so the
      // `properties`-fallback baseline (the user's raw template) normalizes too.
      const protocolNormalized = canonicalizeIpProtocols(
        normalized.baseline,
        normalized.aws,
        resource.resourceType
      );
      // Issue #1784: the provider's own BOTH-SIDES canonicalizer, for a
      // difference no ignore-path can express — a member of an ARRAY ELEMENT.
      // `calculateResourceDrift` compares arrays wholesale, so the only
      // expressible suppression is the whole array; stripping the AWS-managed
      // member from BOTH bags instead converges an OLD observedProperties
      // record with a NEW readback while keeping the array compared.
      //
      // Position: after the principal (#1515) and IpProtocol (#1643) passes,
      // and necessarily BEFORE the tag-list / id-array / unordered-path passes,
      // which run INSIDE `calculateResourceDrift` — an element strip has to
      // precede the unordered sort or the two sides' canonical sort keys are
      // computed over different member sets and diverge.
      //
      // It rewrites the COMPARISON copies only, so `outcome.awsProperties` —
      // the raw bag `--revert` diffs against — keeps the stripped member. Note
      // `--accept` is NOT symmetric with that: it writes each change's
      // `awsValue`, which comes from these canonicalized bags, so a stripping
      // canonicalizer means `--accept` persists the stripped shape on a path
      // that still drifts. That is the intended direction (state should stop
      // carrying a member the readback no longer reports), but a provider
      // author must know it is a WRITE, not just a comparison filter.
      const canonicalized = provider.canonicalizeDriftProperties
        ? {
            baseline: provider.canonicalizeDriftProperties(
              resource.resourceType,
              protocolNormalized.baseline
            ),
            aws: provider.canonicalizeDriftProperties(
              resource.resourceType,
              protocolNormalized.aws
            ),
          }
        : protocolNormalized;
      const changes = calculateResourceDrift(canonicalized.baseline, canonicalized.aws, {
        ignorePaths: observedIgnorePaths.length
          ? [...ignorePaths, ...observedIgnorePaths]
          : ignorePaths,
        unionWalkObjects: useObserved,
        unorderedPaths,
      });
      if (changes.length === 0) {
        outcomes.push({ kind: 'clean', logicalId, resourceType: resource.resourceType });
      } else {
        outcomes.push({
          kind: 'drifted',
          logicalId,
          resourceType: resource.resourceType,
          changes,
          awsProperties: aws,
        });
      }
    }

    return {
      stackName,
      region,
      outcomes,
      state,
      etag: result.etag,
      migrationPending: result.migrationPending ?? false,
    };
  });
}

/**
 * Set a value at a dotted path inside a plain object, creating intermediate
 * objects as needed. Mirrors `lodash.set` for the subset of paths the drift
 * comparator actually emits — dotted nested keys, no array indices.
 *
 * The drift comparator (`src/analyzer/drift-calculator.ts`) only synthesizes
 * paths through plain objects; arrays and scalars surface as a single drift
 * entry on the parent path. So we do not need to parse `[i]` segments.
 */
/**
 * Issue #323: build the cross-resource context passed to
 * `provider.readCurrentState` so IAM Role / User / Group readers can
 * filter out inline policies managed by a sibling `AWS::IAM::Policy`
 * resource. `excludedLogicalId` is the resource being read — it's
 * omitted from the siblings map so a self-reference can never collide.
 */
export function buildReadCurrentStateContext(
  state: StackState,
  excludedLogicalId: string
): ReadCurrentStateContext {
  const siblings: NonNullable<ReadCurrentStateContext['siblings']> = {};
  for (const [lid, res] of Object.entries(state.resources ?? {})) {
    if (lid === excludedLogicalId) continue;
    siblings[lid] = {
      resourceType: res.resourceType,
      physicalId: res.physicalId,
      properties: res.properties ?? {},
      attributes: res.attributes ?? {},
    };
  }
  return { siblings };
}

function setAtPath(target: Record<string, unknown>, path: string, value: unknown): void {
  if (path.length === 0) {
    return;
  }
  const segments = path.split('.');
  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i]!;
    const next = cursor[key];
    if (next === undefined || next === null || typeof next !== 'object' || Array.isArray(next)) {
      const fresh: Record<string, unknown> = {};
      cursor[key] = fresh;
      cursor = fresh;
    } else {
      cursor = next as Record<string, unknown>;
    }
  }
  cursor[segments[segments.length - 1]!] = value;
}

/**
 * `--accept`: state ← AWS.
 *
 * For each drifted resource, walk every property drift and write the
 * AWS-current value into the state-side `properties` map. Then, under a
 * stack lock, persist the updated state via `S3StateBackend.saveState`
 * with the captured etag (optimistic locking).
 *
 * `--dry-run` short-circuits before the lock and the write.
 */
async function runAccept(
  reports: StackDriftReport[],
  stateBackend: S3StateBackend,
  stateConfig: { bucket: string; prefix: string },
  awsClients: AwsClients,
  options: { yes?: boolean; dryRun?: boolean }
): Promise<void> {
  const logger = getLogger();

  // Print a per-resource summary of the planned state mutations BEFORE we
  // ask for confirmation (or short-circuit on --dry-run). Mirrors `cdkd
  // import`'s confirm-then-write flow.
  printAcceptPlan(reports);

  if (options.dryRun) {
    logger.info('--dry-run: state will NOT be written. Re-run without --dry-run to apply.');
    return;
  }

  if (!options.yes) {
    const ok = await confirmPrompt(`Update cdkd state with the AWS-current values shown above?`);
    if (!ok) {
      logger.info('Aborted.');
      return;
    }
  }

  const lockManager = new LockManager(awsClients.s3, stateConfig);
  const owner = `${process.env['USER'] || 'unknown'}@${process.env['HOSTNAME'] || 'host'}:${process.pid}`;

  for (const report of reports) {
    const driftedOutcomes = report.outcomes.filter(
      (o): o is Extract<DriftOutcome, { kind: 'drifted' }> => o.kind === 'drifted'
    );
    if (driftedOutcomes.length === 0) {
      continue;
    }

    await lockManager.acquireLock(report.stackName, report.region, owner, 'drift-accept');
    try {
      // Build the mutated resources map. The drift comparator's baseline
      // is `observedProperties ?? properties` (see runDriftForStack), so
      // `--accept` mutates `observedProperties` to match AWS-current and
      // leaves `properties` (= the user's last-deployed template intent)
      // untouched. For resources that have no observedProperties yet
      // (older binary's state, or providers without readCurrentState),
      // `--accept` falls back to mutating `properties` — which matches
      // the pre-v3 behavior for those resources.
      const resources: Record<string, ResourceState> = { ...report.state.resources };
      for (const outcome of driftedOutcomes) {
        const existing = resources[outcome.logicalId];
        if (!existing) continue;
        const hasObserved = existing.observedProperties !== undefined;
        const baselineSource = hasObserved
          ? existing.observedProperties
          : (existing.properties ?? {});
        const newBaseline = JSON.parse(JSON.stringify(baselineSource)) as Record<string, unknown>;
        for (const change of outcome.changes) {
          setAtPath(newBaseline, change.path, change.awsValue);
        }
        resources[outcome.logicalId] = hasObserved
          ? { ...existing, observedProperties: newBaseline }
          : { ...existing, properties: newBaseline };
      }

      const newState: StackState = {
        ...report.state,
        resources,
        lastModified: Date.now(),
      };

      const saveOptions: { expectedEtag?: string; migrateLegacy?: boolean } = {
        expectedEtag: report.etag,
      };
      if (report.migrationPending) {
        saveOptions.migrateLegacy = true;
      }
      await stateBackend.saveState(report.stackName, report.region, newState, saveOptions);
      logger.info(
        `✓ State updated for ${report.stackName} (${report.region}): ` +
          `accepted drift on ${driftedOutcomes.length} resource(s).`
      );
    } finally {
      await lockManager.releaseLock(report.stackName, report.region).catch((err) => {
        logger.warn(
          `Failed to release lock for ${report.stackName} (${report.region}): ` +
            (err instanceof Error ? err.message : String(err))
        );
      });
    }
  }
}

/**
 * A top-level property NAME that carries tags.
 *
 * The shape test below is deliberately NOT sufficient on its own: a top-level
 * `[{ Key, Value }]` list is not tag-exclusive — `LoadBalancerAttributes`,
 * `TargetGroupAttributes` and SSM `Association.Targets` all match it. No such
 * property can carry an `aws:`-prefixed or `AmazonECSManaged` key today, so the
 * carve-out would degrade to the identity of the old wholesale overwrite there
 * — but borrowing `canonicalizeTagListsDeep`'s heuristic for a WRITE decision
 * is not justified by its use for a SORT: a sort false positive is harmless, an
 * append is not.
 */
function isTagListKey(key: string): boolean {
  return key === 'Tags' || key.endsWith('Tags');
}

/** A CFn-shaped tag list: a non-empty array whose every element has a string `Key`. */
function isCfnTagList(value: unknown): value is Array<Record<string, unknown>> {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((t) => isPlainRecord(t) && typeof (t as { Key?: unknown }).Key === 'string')
  );
}

/** The `Key` of every entry in a CFn tag list, in list order. */
function tagKeys(tags: ReadonlyArray<Record<string, unknown>>): string[] {
  return tags.map((t) => t['Key'] as string);
}

/**
 * AWS-SERVICE-authored tag keys a `--revert` must not strip (issue #1501).
 *
 * `AmazonECSManaged` is attached by ECS when a capacity provider binds an Auto
 * Scaling group, and managed scaling stops working without it. That entry is
 * the load-bearing one.
 *
 * The `aws:` prefix is DEFENSIVE rather than load-bearing, and the distinction
 * is worth stating: AWS reserves the prefix and rejects a write of one, and the
 * 45 providers that route reads through `normalizeAwsTagsToCfn` strip such keys
 * on the way in — so an `aws:` key can only reach the AWS side of a comparison
 * via the Cloud Control `readCurrentState` path, which returns the raw model.
 * It costs nothing to honor and cdkd can never have authored one.
 */
const SERVICE_MANAGED_TAG_KEYS: ReadonlySet<string> = new Set(['AmazonECSManaged']);

/** Whether a tag key is AWS-service-authored, per {@link SERVICE_MANAGED_TAG_KEYS}. */
function isServiceManagedTagKey(key: string): boolean {
  return SERVICE_MANAGED_TAG_KEYS.has(key) || key.startsWith('aws:');
}

/**
 * Revert a TAG LIST, preserving AWS-SERVICE-authored entries (issue #1501).
 *
 * Everything in {@link buildRevertNewProperties} overwrites a drifted top-level
 * key wholesale, which for `Tags` means "AWS ends up with exactly the tags cdkd
 * state recorded" — so a service-authored tag added after deploy is stripped.
 * The concrete case: ECS attaches `AmazonECSManaged` to an ASG when a capacity
 * provider binds it, and that tag is REQUIRED for managed scaling. Because any
 * CDK ASG declares at least a `Name` tag, `Tags` is template-DECLARED, so the
 * #1498 carve-out (undeclared + captured-empty) correctly does not apply — and
 * the tag list is an ARRAY, which {@link findRevertUnbaselinedAwsKeys}'s walk
 * compares wholesale and never descends into. Post-revert the ASG kept the
 * capacity provider with its managed scaling silently broken (verified live
 * 2026-08-10).
 *
 * The semantic: the baseline still WINS for every ordinary tag — one it has and
 * AWS lost is re-added, one whose value differs is reset, and a
 * user/console-added tag AWS alone has is still REMOVED. Only a
 * {@link isServiceManagedTagKey} entry survives.
 *
 * **This is the issue's option 2, not its option 1, and the choice was settled
 * by a live test rather than by taste.** Option 1 (revert the whole tag list as
 * a diff, so ANY out-of-band add survives) was implemented first and failed the
 * `drift-revert` integ at its final assertion: that fixture injects an
 * `IntegInjected` tag and requires `--revert` to strip it, i.e. "revert removes
 * a console-added tag" is an established contract with a test behind it.
 * Option 1 would redefine revert semantics for a whole property class — which
 * is exactly the design pass the issue said it needed — so the narrow safeguard
 * ships instead, fixing the reported breakage while leaving ordinary tag revert
 * untouched.
 *
 * Scope: TOP-LEVEL tag lists, which is where `buildRevertNewProperties`
 * operates. A tag list nested inside another property (an EC2 launch template's
 * `TagSpecifications`) still reverts wholesale.
 *
 * Order: baseline entries first in baseline order, then the preserved
 * service-managed entries. Providers apply tags as a set and the drift
 * comparator canonicalizes tag-list order on both sides
 * (`drift-normalize.ts`), so the order is for readability / determinism only.
 */
export function mergeTagListForRevert(
  baselineTags: ReadonlyArray<Record<string, unknown>>,
  awsTags: ReadonlyArray<Record<string, unknown>>
): Array<Record<string, unknown>> {
  const baselineKeys = new Set(tagKeys(baselineTags));
  const seen = new Set<string>();
  const preserved = awsTags.filter((t) => {
    const key = t['Key'] as string;
    if (baselineKeys.has(key) || !isServiceManagedTagKey(key) || seen.has(key)) return false;
    // Deduped so the merge and `findRevertPreservedTagKeys` (which reports a
    // SET) cannot disagree when AWS returns the same key twice.
    seen.add(key);
    return true;
  });
  return [...baselineTags, ...preserved];
}

/**
 * The AWS-service-authored tag keys a `--revert` will PRESERVE rather than
 * strip, i.e. those present on the AWS side of a drifted top-level tag list,
 * absent from the revert baseline, and {@link isServiceManagedTagKey} (issue
 * #1501).
 *
 * Reported in the plan so the carve-out of {@link mergeTagListForRevert} is
 * visible BEFORE the confirmation prompt: a user who did want the tag gone
 * learns here that the revert will not do it.
 *
 * @returns dotted `<Key>.<TagKey>` paths, sorted, e.g. `['Tags.AmazonECSManaged']`.
 */
export function findRevertPreservedTagKeys(
  drifts: readonly PropertyDrift[],
  desiredProperties: Record<string, unknown>,
  awsProperties: Record<string, unknown>
): string[] {
  const preserved = new Set<string>();
  const driftedTopLevelKeys = new Set<string>();
  for (const d of drifts) {
    const topLevelKey = d.path.split('.', 1)[0];
    if (topLevelKey) driftedTopLevelKeys.add(topLevelKey);
  }

  for (const key of driftedTopLevelKeys) {
    if (!(key in desiredProperties)) continue;
    if (!isTagListKey(key)) continue;
    const desiredValue = desiredProperties[key];
    const awsValue = awsProperties[key];
    const baselineIsTagList =
      isCfnTagList(desiredValue) || (Array.isArray(desiredValue) && desiredValue.length === 0);
    if (!baselineIsTagList || !isCfnTagList(awsValue)) continue;
    const baselineKeys = new Set(tagKeys(desiredValue as Array<Record<string, unknown>>));
    for (const tagKey of tagKeys(awsValue)) {
      if (!baselineKeys.has(tagKey) && isServiceManagedTagKey(tagKey)) {
        preserved.add(`${key}.${tagKey}`);
      }
    }
  }

  return [...preserved].sort();
}

/**
 * The AWS-authored property paths a `--revert` LEAVES UNTOUCHED, for a
 * resource whose state predates observed-capture (issue #1478, semantics
 * settled by issue #1626).
 *
 * The mechanism: `runRevert` picks the revert baseline as
 * `observedProperties ?? properties`. When `observedProperties` is absent, the
 * desired side is the raw TEMPLATE while the previous side is the AWS-CURRENT
 * snapshot — so {@link buildRevertNewProperties}, which overwrites each drifted
 * top-level key with the desired sub-shape wholesale, has no value to carry for
 * any AWS-authored key inside that subtree. For a Glue Iceberg table that
 * reaches `table_type` / `metadata_location`, the same exposure as issue #1461
 * by a different trigger; the general case is ANY resource where AWS writes
 * into a bag the template does not fully declare, on state written before
 * observed-capture.
 *
 * #1478 shipped the **warn and proceed** semantic — the values were still
 * erased, the user was merely told first — while explicitly leaving the door
 * open to "treat 'no observedProperties' as 'previous is unknown' so the merge
 * preserves". Issue #1626 walked through that door for the reasons in
 * {@link mergeUntemplatedValue}: on this baseline cdkd cannot tell an
 * AWS-authored value from an out-of-band change, and resetting on a coin flip
 * is the worse error. So the paths below are now REPORTED AS PRESERVED, and
 * `mergeUntemplatedValue` is what makes that true by merging them into the bag
 * `--revert` actually SENDS — which is the only side a wholesale-replace
 * provider consults. This function is unchanged in what it computes — only in
 * what the caller does about it.
 *
 * Scoped deliberately:
 *
 * - **Only drifted top-level keys.** Non-drifted keys keep their AWS-current
 *   value in `buildRevertNewProperties`, so nothing under them is at stake.
 * - **Only when `observedProperties` is absent.** With it present the desired
 *   side is the deploy-time AWS snapshot, which already carries AWS-authored
 *   fields — removing one there is a legitimate revert of a real console
 *   change, and reporting it would be noise on every run.
 * - **Only keys that vanish.** A key present on both sides with a different
 *   VALUE is the drift the user asked to revert, and it reverts normally.
 *
 * @returns dotted paths, sorted, e.g. `['Parameters.metadata_location']`.
 */
export function findRevertUnbaselinedAwsKeys(
  drifts: readonly PropertyDrift[],
  desiredProperties: Record<string, unknown>,
  awsProperties: Record<string, unknown>
): string[] {
  const missing = new Set<string>();
  const driftedTopLevelKeys = new Set<string>();
  for (const d of drifts) {
    const topLevelKey = d.path.split('.', 1)[0];
    if (topLevelKey) driftedTopLevelKeys.add(topLevelKey);
  }

  for (const key of driftedTopLevelKeys) {
    // `buildRevertNewProperties` only overwrites a key the desired side
    // actually has; otherwise the AWS-current value survives untouched.
    if (!(key in desiredProperties)) continue;
    // A top-level TAG LIST is reverted through `mergeTagListForRevert`, which
    // PRESERVES service-authored entries (issue #1501) — so those are not
    // at stake and must not be reported here, while an ordinary console-added
    // tag still is stripped and still counts.
    collectMissingPaths(
      awsProperties[key],
      desiredProperties[key],
      key,
      missing,
      isTagListKey(key) ? isServiceManagedTagKey : undefined
    );
  }

  return [...missing].sort();
}

/**
 * Walk the AWS-side value against the desired-side value, recording every path
 * present on the AWS side and absent on the desired side.
 *
 * Plain objects are descended into. A POSITIONAL array is compared wholesale —
 * the drift comparator itself treats arrays as single values (its paths never
 * carry an index), so an element-wise walk here would report positions the
 * rest of the revert path cannot reason about.
 *
 * A KEYED list is the exception, and it is the shape with the most to drop
 * (issue [#1626](https://github.com/go-to-k/cdkd/issues/1626)). An
 * `[{Key, Value}]` list is semantically a MAP that CFn spells as an array —
 * ELBv2 `LoadBalancerAttributes`, `ListenerAttributes`, `TargetGroupAttributes`
 * and every `Tags` list are this shape — so its entries have stable identities,
 * not positions, and `Key` is exactly what the user would act on. Skipping it
 * left the pass blind precisely where `readCurrentState` returns AWS's FULL
 * attribute set (~20 entries) against a template that declares one or two: the
 * plan warned about nothing while the revert was about to touch eighteen keys.
 *
 * Keyed-list entries are reported in BRACKET form (`LoadBalancerAttributes
 * [deletion_protection.enabled]`) rather than dotted, because attribute keys
 * contain dots themselves and a dotted path would be ambiguous with a nested
 * object.
 *
 * `isPreservedKey` exempts entries the revert does NOT actually drop — the
 * caller passes {@link isServiceManagedTagKey} for a top-level TAG LIST, whose
 * revert goes through {@link mergeTagListForRevert} and keeps `aws:`-prefixed /
 * `AmazonECSManaged` entries (issue #1501). Reporting those would be a warning
 * about a loss that cannot happen.
 */
function collectMissingPaths(
  awsValue: unknown,
  desiredValue: unknown,
  path: string,
  out: Set<string>,
  isPreservedKey?: (key: string) => boolean
): void {
  if (isKeyedList(awsValue)) {
    // An EMPTY desired array is a keyed list carrying no identities, NOT a
    // wholesale replacement — every AWS entry is unbaselined. This arm has to
    // mirror {@link mergeUntemplatedValue}'s `desiredIsEmptyArray` case exactly:
    // without it the merge preserves every entry of a `Tags: []` baseline while
    // this walk reports none, and the plan silently under-claims what survives.
    const desiredIsEmptyArray = Array.isArray(desiredValue) && desiredValue.length === 0;
    if (!isKeyedList(desiredValue) && !desiredIsEmptyArray) {
      // A scalar / object / absent desired side replaces the whole list.
      if (desiredValue === undefined) out.add(path);
      return;
    }
    const desiredKeys = new Set(isKeyedList(desiredValue) ? desiredValue.map((e) => e.Key) : []);
    for (const entry of awsValue) {
      if (desiredKeys.has(entry.Key)) continue;
      if (isPreservedKey?.(entry.Key)) continue;
      out.add(`${path}[${entry.Key}]`);
    }
    return;
  }
  if (!isPlainRecord(awsValue)) return;
  if (!isPlainRecord(desiredValue)) {
    // The desired side is a scalar / array / absent where AWS has an object:
    // the whole AWS subtree goes. Report the containing path rather than
    // enumerating leaves the user cannot act on individually.
    if (desiredValue === undefined) out.add(path);
    return;
  }
  for (const [key, value] of Object.entries(awsValue)) {
    const childPath = `${path}.${key}`;
    if (!(key in desiredValue)) {
      out.add(childPath);
      continue;
    }
    collectMissingPaths(value, desiredValue[key], childPath, out);
  }
}

/**
 * A NON-EMPTY array whose every element is an object carrying a string `Key`.
 *
 * Emptiness is excluded on the AWS side: `[]` carries no identities, so there
 * is nothing to report. It is NOT excluded on the DESIRED side any more
 * (issue #1626) — an empty baseline list means every AWS entry is unbaselined,
 * and since the only caller runs on the template-only baseline where
 * {@link mergeUntemplatedValue} PRESERVES all of them, reporting nothing would
 * leave the plan under-claiming what survives.
 */
function isKeyedList(value: unknown): value is Array<{ Key: string }> {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (e) => typeof e === 'object' && e !== null && typeof (e as { Key?: unknown }).Key === 'string'
    )
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Merge the AWS-current value with the revert baseline, KEEPING every path the
 * baseline does not declare (issue
 * [#1626](https://github.com/go-to-k/cdkd/issues/1626) items 2 + 3).
 *
 * ## The contract this settles
 *
 * `provider.update(logicalId, physicalId, type, newProperties,
 * previousProperties)` has ONE parameter list and TWO callers:
 *
 * - the deploy engine passes the state-recorded `properties` — the
 *   LAST-DEPLOYED TEMPLATE — so a path present on the previous side and absent
 *   from the desired side means exactly one thing: **the user removed it from
 *   the template**;
 * - `runRevert` passes the FULL `readCurrentState` snapshot, so the same
 *   absence ALSO covers **a path the template never declared at all**.
 *
 * Both provider shapes then destroy that path, by different routes. One that
 * KEY-DIFFS a collection reads the absence as a REMOVAL — ELBv2's
 * `LoadBalancerAttributes`, where `readCurrentState` deliberately emits every
 * attribute AWS reports, puts ~18 untemplated attributes on the removal path
 * against a template declaring one or two. One that REPLACES a bag wholesale
 * (`PutBucketTagging` is documented full-replace; the same holds for every
 * `Put*Configuration`) never consults the previous side at all and simply
 * sends a bag the untemplated path is missing from.
 *
 * That second shape is why the fix lands on the DESIRED side rather than by
 * trimming `previousProperties`: trimming stops the key-diffing removal but
 * leaves the wholesale-replace drop untouched, so half the reported paths
 * would still be erased while the plan claimed otherwise. Merging into the bag
 * cdkd actually SENDS covers both, and is what makes the plan's "left
 * untouched" line true rather than aspirational.
 *
 * ## Scoped to the baseline that cannot tell the two apart
 *
 * Applied ONLY when `observedProperties` is absent — the same gate as
 * {@link findRevertUnbaselinedAwsKeys}'s notice, and for the same reason. With
 * observed-capture present the baseline IS a deploy-time AWS snapshot, so a
 * path AWS reports and the baseline lacks was genuinely added out-of-band and
 * removing it is the revert the user asked for (the `drift-revert` integ
 * fixture requires exactly that for an injected tag). Without it the baseline
 * is the raw TEMPLATE, and "AWS has it, the template does not" is
 * indistinguishable from "AWS authored it" — so the honest answer is to leave
 * it alone. `findRevertUnbaselinedAwsKeys`'s docstring already named this as
 * one of the stricter options #1478 did not foreclose ("treat 'no
 * observedProperties' as 'previous is unknown' so the merge preserves"); this
 * is that option.
 *
 * The structural rules mirror {@link collectMissingPaths} case for case —
 * plain records descend, KEYED `[{Key, Value}]` lists merge by `Key`,
 * positional arrays and scalars are taken from the baseline wholesale — so
 * every path the plan names as preserved IS kept, and a unit test pins that
 * correspondence by diffing the flag-on and flag-off outputs.
 *
 * A service-authored tag is absent from both sides of that comparison and
 * stays consistent: `findRevertUnbaselinedAwsKeys` omits it
 * (`isServiceManagedTagKey`) because the #1501 carve-out already preserves it
 * on the DEFAULT path, so it is not something this flag rescues and reporting
 * it would warn about a loss that cannot happen. The test pins that it
 * survives under BOTH settings.
 *
 * A path the baseline DOES declare always wins, which is what keeps the revert
 * a revert: a drifted value is reset, and one AWS dropped is re-added.
 */
function mergeUntemplatedValue(awsValue: unknown, desiredValue: unknown): unknown {
  // An EMPTY baseline array is accepted alongside a populated keyed list.
  // `isKeyedList` requires a NON-empty array (an `[]` carries no identities),
  // but a DECLARED-but-empty list — `Tags: []` from a condition-collapsed
  // template — is precisely the shape the #1501 carve-out exists for, and
  // falling through to the wholesale arm would hand AWS `[]` and strip every
  // tag including `AmazonECSManaged`. Under this flag an empty baseline simply
  // contributes no overrides and no re-adds, so every AWS entry is untemplated
  // and every one is preserved — which is what keeps the SUPERSET claim over
  // `mergeTagListForRevert` true for this shape too.
  const desiredIsEmptyArray = Array.isArray(desiredValue) && desiredValue.length === 0;
  if (isKeyedList(awsValue) && (isKeyedList(desiredValue) || desiredIsEmptyArray)) {
    const desiredEntries: ReadonlyArray<{ Key: string }> = isKeyedList(desiredValue)
      ? desiredValue
      : [];
    const desiredByKey = new Map(desiredEntries.map((e) => [e.Key, e]));
    const merged: Array<{ Key: string }> = [];
    // AWS can report the same key twice; `mergeTagListForRevert` dedupes for
    // the same reason. Emitting a duplicate would be REJECTED by
    // `PutBucketTagging` / `ModifyLoadBalancerAttributes`, so first wins.
    const emitted = new Set<string>();
    for (const entry of awsValue) {
      if (emitted.has(entry.Key)) continue;
      emitted.add(entry.Key);
      merged.push(desiredByKey.get(entry.Key) ?? entry);
    }
    // A baseline entry AWS no longer reports is a removal to UNDO, so re-add it.
    for (const entry of desiredEntries) {
      if (emitted.has(entry.Key)) continue;
      emitted.add(entry.Key);
      merged.push(entry);
    }
    return merged;
  }
  if (!isPlainRecord(awsValue) || !isPlainRecord(desiredValue)) {
    // Positional array, scalar, or a shape mismatch: the drift comparator
    // treats these wholesale, so merging would invent a value no other code
    // path can reason about. The baseline wins, exactly as before.
    return desiredValue;
  }
  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(awsValue)) {
    merged[key] = key in desiredValue ? mergeUntemplatedValue(value, desiredValue[key]) : value;
  }
  for (const [key, value] of Object.entries(desiredValue)) {
    if (!(key in awsValue)) merged[key] = value;
  }
  return merged;
}

/**
 * Build the `newProperties` object passed to `provider.update` during
 * `--revert`. Strategy:
 *
 *   1. Start from `awsProperties` (the AWS-current snapshot returned
 *      by `readCurrentState`, which `runRevert` already passes as the
 *      `previousProperties` argument to `provider.update`).
 *   2. For every top-level key whose subtree contains a drifted path,
 *      overwrite it with the corresponding sub-shape from
 *      `desiredProperties` (the state-recorded `observedProperties`).
 *
 * Why "AWS-current base + drifted overlay" instead of "drifted-only
 * partial":
 *
 *   Several providers' `update()` implementations diff
 *   `newProperties[K]` against `previousProperties[K]` and treat
 *   `newVal === undefined` as "remove K from AWS" (e.g.
 *   `SNSTopicProvider` calls `SetTopicAttributes(K, '')`,
 *   `IAMRoleProvider.updateManagedPolicies` detaches every previously
 *   attached policy when the new arg is undefined). Passing a
 *   drifted-only partial would silently clear non-drifted attributes
 *   on those providers. Sending the AWS-current value back as the
 *   "new" value for non-drifted keys keeps `JSON.stringify(newVal) ===
 *   JSON.stringify(oldVal)` so the diff is a no-op — no provider
 *   changes required.
 *
 *   For non-diff providers (e.g. `SQSQueueProvider` blindly pushes
 *   every defined key via `SetQueueAttributes`), the AWS-current
 *   value still gets serialised back to the same string AWS already
 *   has, so the round-trip is a no-op for the AWS resource state.
 *   The one exception is `readCurrentState`'s always-emit
 *   placeholder values — e.g. SQS `RedrivePolicy: {}` — which AWS
 *   rejects as invalid input even though they're round-tripped. That
 *   class of value (Class 2 / structurally-incomplete-when-empty) is
 *   handled by per-provider sanitize at the wire-layer; see the SQS
 *   provider's `serializeRedrivePolicy` helper for the canonical
 *   pattern.
 *
 * The drift comparator never produces array-index segments
 * (`Tags[0].Value`) — array drifts surface as a single entry on the
 * parent path — so `path.split('.', 1)` is always safe to extract the
 * top-level key.
 *
 * `preserveUntemplated` (issue #1626) switches the overlay from WHOLESALE to a
 * deep merge for the drifted subtrees, keeping every path the baseline does
 * not declare. `runRevert` sets it exactly when the resource has no
 * `observedProperties` — see {@link mergeUntemplatedValue} for why that is the
 * only baseline on which it is correct, and why the fix has to live on this
 * side rather than on `previousProperties`.
 */
export function buildRevertNewProperties(
  drifts: readonly PropertyDrift[],
  desiredProperties: Record<string, unknown>,
  awsProperties: Record<string, unknown>,
  options: { preserveUntemplated?: boolean } = {}
): Record<string, unknown> {
  const preserveUntemplated = options.preserveUntemplated === true;
  const result: Record<string, unknown> = { ...awsProperties };
  for (const d of drifts) {
    const topLevelKey = d.path.split('.', 1)[0];
    if (!topLevelKey) continue;
    if (topLevelKey in desiredProperties) {
      const desiredValue = desiredProperties[topLevelKey];
      const awsValue = awsProperties[topLevelKey];
      // A TAG LIST keeps its AWS-service-authored entries instead of being
      // overwritten wholesale (issue #1501). See `mergeTagListForRevert`.
      //
      // The baseline side accepts an EMPTY array as well as a populated tag
      // list: a template that DECLARES `Tags` with a condition-collapsed or
      // empty list still has an AWS side worth diffing against, and treating
      // that as "nothing to diff" would strip `AmazonECSManaged` — the exact
      // failure this carve-out exists to prevent. (The #1498 rule covers the
      // commoner UNDECLARED + captured-empty shape by ignoring the key
      // outright, so it never reaches here.)
      if (preserveUntemplated) {
        // Issue #1626: on a raw-TEMPLATE baseline every untemplated path is
        // kept, which is a strict SUPERSET of the #1501 tag carve-out (that
        // one keeps only service-authored entries), so it subsumes the branch
        // below rather than competing with it. The superset holds for a
        // DECLARED-but-EMPTY baseline list too — see the note in
        // `mergeUntemplatedValue`, which is where that shape is handled.
        result[topLevelKey] = mergeUntemplatedValue(awsValue, desiredValue);
      } else {
        const baselineIsTagList =
          isCfnTagList(desiredValue) || (Array.isArray(desiredValue) && desiredValue.length === 0);
        result[topLevelKey] =
          isTagListKey(topLevelKey) && baselineIsTagList && isCfnTagList(awsValue)
            ? mergeTagListForRevert(desiredValue as Array<Record<string, unknown>>, awsValue)
            : desiredValue;
      }
    } else {
      // Drift surfaced on a key that's no longer in `desiredProperties`
      // (defensive — drift was computed against `desiredProperties`, so
      // this only happens if state mutated between drift read and now).
      // Fall through to whatever `awsProperties[topLevelKey]` was.
    }
  }
  return result;
}

/**
 * The top-level keys a provider NARROWED on the revert path (issue #1644).
 *
 * `provider.update()` may answer with `effectiveProperties` — the bag it
 * ACTUALLY delivered, which is what AWS now holds. `DeployEngine` records that
 * in place of the desired bag (`propertiesToRecord`), and `--revert` used to
 * throw the return value away: state kept the un-narrowed value, so the very
 * next `cdkd drift` reported the same difference and `--revert` re-issued the
 * same call — the loop `effectiveProperties` exists to break, still live on
 * this one command.
 *
 * Returns a per-key DELTA rather than the whole bag, and that is the load-
 * bearing part. The bag handed to `update()` here is
 * {@link buildRevertNewProperties}'s output — AWS-current values for every
 * non-drifted key merged with the state baseline for the drifted ones — so
 * writing it back wholesale would import AWS-authored values into state for
 * keys nobody reverted, quietly turning `--revert` into `--accept`. Only the
 * keys the PROVIDER changed between what it was handed and what it delivered
 * belong in state.
 *
 * A key present in `sent` but absent from `effective` is a DROP: the provider
 * did not deliver it, so AWS does not hold it, and the baseline must lose it
 * too. That is represented by an explicit `undefined` value, which the caller
 * turns into a `delete` — a plain `{...baseline, ...delta}` spread would leave
 * an `undefined`-valued key in the JSON instead. Presence is decided by
 * `key in effective`, NOT by comparing against `undefined`: a provider that
 * delivers an explicit `undefined` and one that omits the key both mean "AWS
 * does not hold it", while a key whose value genuinely IS `null` on both sides
 * must not read as a drop.
 *
 * The comparison is a key-order-INDEPENDENT deep equality rather than
 * `JSON.stringify`. A provider that rebuilds a nested object while delivering
 * the same members would otherwise register as a change, and the value written
 * back for such a key is the one that was SENT — for a non-drifted key that is
 * the AWS-current value, i.e. the `--accept` behavior this delta exists to
 * prevent.
 */
export function collectNarrowedTopLevelKeys(
  sent: Record<string, unknown>,
  effective: Record<string, unknown>
): Record<string, unknown> {
  const delta: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(sent), ...Object.keys(effective)])) {
    const inSent = key in sent;
    const inEffective = key in effective;
    if (inSent && inEffective && deepEqualUnordered(sent[key], effective[key])) continue;
    if (!inSent && !inEffective) continue;
    delta[key] = inEffective ? effective[key] : undefined;
  }
  return delta;
}

/** Deep equality that does not depend on object key ORDER. */
function deepEqualUnordered(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqualUnordered(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  if (ak.length !== Object.keys(bo).length) return false;
  return ak.every(
    (k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqualUnordered(ao[k], bo[k])
  );
}

/**
 * `--revert`: AWS ← state.
 *
 * For each drifted resource, call `provider.update(logicalId, physicalId,
 * resourceType, properties /*new*\/, previousProperties /*old*\/)` with:
 *   - `properties` = `buildRevertNewProperties(...)` — the AWS-current
 *     snapshot with the drifted top-level subtrees overlaid by the
 *     state-recorded `observedProperties`. Non-drifted keys carry their
 *     AWS-current values, so a diff-based provider's update sees
 *     `newVal === oldVal` and produces no AWS-side mutation for them
 *     (load-bearing — see helper docstring for why "drifted-only
 *     partial" is not safe).
 *   - `previousProperties` = AWS-current properties (the previous-known
 *     truth, captured during the drift read so we don't re-issue it).
 *
 * Per-resource failures are collected and surface as `PartialFailureError`
 * (exit 2) at the end. State is otherwise NOT updated by `--revert` — once the
 * update succeeds, AWS values match state by definition. The ONE exception is
 * a provider-reported NARROWING (issue #1644): see
 * {@link collectNarrowedTopLevelKeys}.
 *
 * The per-stack lock is acquired before any update so a concurrent
 * `cdkd deploy` cannot race the in-flight property changes.
 */
async function runRevert(
  reports: StackDriftReport[],
  providerRegistry: ProviderRegistry,
  stateBackend: S3StateBackend,
  stateConfig: { bucket: string; prefix: string },
  awsClients: AwsClients,
  options: { yes?: boolean; dryRun?: boolean; concurrency?: number }
): Promise<void> {
  const logger = getLogger();

  printRevertPlan(reports);

  if (options.dryRun) {
    logger.info('--dry-run: AWS will NOT be modified. Re-run without --dry-run to apply.');
    return;
  }

  if (!options.yes) {
    const ok = await confirmPrompt(
      `Push cdkd state values back into AWS for the resources shown above?`
    );
    if (!ok) {
      logger.info('Aborted.');
      return;
    }
  }

  const lockManager = new LockManager(awsClients.s3, stateConfig);
  const owner = `${process.env['USER'] || 'unknown'}@${process.env['HOSTNAME'] || 'host'}:${process.pid}`;
  const concurrency = Math.max(1, options.concurrency ?? 4);

  let totalFailed = 0;
  let totalUnsupported = 0;
  let totalSucceeded = 0;

  for (const report of reports) {
    const driftedOutcomes = report.outcomes.filter(
      (o): o is Extract<DriftOutcome, { kind: 'drifted' }> => o.kind === 'drifted'
    );
    if (driftedOutcomes.length === 0) {
      continue;
    }

    await lockManager.acquireLock(report.stackName, report.region, owner, 'drift-revert');
    // Provider-reported narrowings, keyed by logical id (issue #1644).
    // Collected inside the concurrent tasks and applied to state ONCE, under
    // the same lock, after they all settle.
    const narrowedByLogicalId = new Map<string, Record<string, unknown>>();
    try {
      const tasks = driftedOutcomes.map((outcome) => async () => {
        const stateResource = report.state.resources[outcome.logicalId];
        if (!stateResource) {
          // Defensive: drift detection saw the resource in state earlier,
          // but if something racey happened between read and now treat it
          // as a per-resource failure rather than aborting the whole run.
          totalFailed++;
          logger.error(
            `  ✗ ${report.stackName}/${outcome.logicalId} (${outcome.resourceType}): ` +
              `resource missing from state; skipped.`
          );
          return;
        }
        // Schema v7+ (#614): route the revert update through the
        // state-recorded layer so a CC-managed resource is reverted via
        // Cloud Control.
        const provider: ResourceProvider = providerRegistry.getProviderFor({
          resourceType: outcome.resourceType,
          provisionedBy: stateResource.provisionedBy,
        }).provider;
        // The baseline drift was computed against — `observedProperties`
        // when present, else `properties` — is the right "desired" value
        // to push back to AWS. Using `properties` alone would push the
        // last-deployed template intent and miss any AWS-side defaults
        // we captured at deploy time but never wrote into the template.
        const desiredProperties =
          stateResource.observedProperties ?? stateResource.properties ?? {};
        // AWS-current values for non-drifted top-level keys + desired
        // values for drifted top-level subtrees. See
        // `buildRevertNewProperties` docstring for why we don't pass a
        // drifted-only partial.
        //
        // Issue #1626 items 2 + 3: with NO observed-capture baseline the
        // desired side is the raw TEMPLATE, so a path AWS reports and the
        // template never declared is indistinguishable from one AWS authored
        // itself. Merge those paths into the bag being SENT rather than
        // overlaying the drifted subtree wholesale — a wholesale-replace
        // provider (`PutBucketTagging` and every `Put*Configuration`) never
        // consults the previous side, so this is the only side that can save
        // them. With observed-capture present the baseline IS authoritative
        // and the overlay is unchanged, so an out-of-band addition is still
        // stripped. See `mergeUntemplatedValue`.
        const newProperties = buildRevertNewProperties(
          outcome.changes,
          desiredProperties,
          outcome.awsProperties,
          { preserveUntemplated: stateResource.observedProperties === undefined }
        );
        try {
          const updateResult = await withRetry(
            () =>
              provider.update(
                outcome.logicalId,
                stateResource.physicalId,
                outcome.resourceType,
                newProperties,
                outcome.awsProperties,
                // The desired bag here is `observedProperties ?? properties`
                // overlaid onto the AWS-current snapshot — an AWS READBACK, not
                // a template (issue #1732). Several `readCurrentState`
                // implementations spell "this feature is not set" as an EMPTY
                // collection rather than an absent key, so without this flag a
                // provider cannot tell "restore the unset state" (delete) from
                // a template's condition-collapsed array (leave the live value
                // alone), and picking either arm breaks the other caller.
                { desiredFromAwsReadback: true }
              ),
            outcome.logicalId,
            { logger: { debug: (msg) => logger.debug(msg) } }
          );
          totalSucceeded++;
          logger.info(
            `  ✓ ${report.stackName}/${outcome.logicalId} (${outcome.resourceType}): reverted.`
          );
          // Issue #1644: keep whatever the provider says it ACTUALLY delivered,
          // so a narrowing does not re-surface as drift on the next run.
          //
          // AFTER the success accounting, and in its OWN try: the AWS update
          // has already landed, so a throw in here (a provider handing back a
          // cyclic / non-comparable bag) must not be caught by the outer
          // handler and re-reported as `AWS update failed`, flipping a
          // succeeded revert to exit 2.
          try {
            if (updateResult?.effectiveProperties) {
              const delta = collectNarrowedTopLevelKeys(
                newProperties,
                updateResult.effectiveProperties
              );
              if (Object.keys(delta).length > 0) {
                narrowedByLogicalId.set(outcome.logicalId, delta);
              }
            }
          } catch (captureErr) {
            logger.warn(
              `  ${report.stackName}/${outcome.logicalId} (${outcome.resourceType}): reverted, but ` +
                `the provider's reported effective properties could not be read — ` +
                `${captureErr instanceof Error ? captureErr.message : String(captureErr)}`
            );
          }
        } catch (err) {
          // Distinguish "the AWS update failed" from "this resource type
          // does not support in-place update at all". The latter cannot be
          // fixed by retrying; the user has to redeploy with --replace.
          if (err instanceof ResourceUpdateNotSupportedError) {
            totalUnsupported++;
            logger.warn(
              `  ⊘ ${report.stackName}/${outcome.logicalId} (${outcome.resourceType}): could not revert — ${err.message}`
            );
            return;
          }
          totalFailed++;
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(
            `  ✗ ${report.stackName}/${outcome.logicalId} (${outcome.resourceType}): AWS update failed — ${msg}`
          );
        }
      });

      await runWithConcurrency(tasks, concurrency);

      // Persist the provider-reported narrowings (issue #1644), still under
      // the stack lock. Written to the SAME field the drift comparator uses as
      // its baseline — `observedProperties` when the resource has one, else
      // `properties` — exactly as `--accept` does, so the next `cdkd drift`
      // compares AWS against what the provider said it delivered. `properties`
      // is left alone when an observed capture exists: it is the user's
      // last-deployed TEMPLATE intent, and a narrowing is an AWS-side fact,
      // not a template edit.
      if (narrowedByLogicalId.size > 0) {
        const resources: Record<string, ResourceState> = { ...report.state.resources };
        let recordedCount = 0;
        for (const [logicalId, delta] of narrowedByLogicalId) {
          const existing = resources[logicalId];
          if (!existing) continue;
          const hasObserved = existing.observedProperties !== undefined;
          const baselineSource = hasObserved ? existing.observedProperties : existing.properties;
          const newBaseline = JSON.parse(JSON.stringify(baselineSource ?? {})) as Record<
            string,
            unknown
          >;
          let changed = false;
          for (const [key, value] of Object.entries(delta)) {
            // ONLY a key the baseline already declares may move. The bag sent
            // to `update()` starts as the AWS-CURRENT snapshot, so it carries
            // keys the baseline never had (an out-of-band tag, an AWS-computed
            // field); a provider that echoes one back in a changed shape would
            // otherwise INSERT it into state — `--revert` behaving like
            // `--accept`, the thing the per-key delta exists to prevent.
            if (!Object.prototype.hasOwnProperty.call(newBaseline, key)) continue;
            if (value === undefined) {
              delete newBaseline[key];
              changed = true;
              continue;
            }
            // A VALUE is recorded only against an `observedProperties`
            // baseline. Without one the baseline is the raw TEMPLATE, and
            // `buildRevertNewProperties` ran in `preserveUntemplated` mode —
            // so the value that was sent deliberately carries every AWS-
            // authored path the template never declared. Writing it into
            // `properties` would make the DESIRED baseline describe AWS-side
            // values and silently disable the #1160 absent-field removal
            // derivation, which reads that side (`.claude/rules/providers.md`:
            // what you return is what you SENT, AWS-side defaults belong in
            // `observedProperties`). A DROP is still safe there — it removes,
            // never imports — so the loop this fix exists to break still
            // closes for the shape that actually produces it.
            if (!hasObserved) continue;
            newBaseline[key] = value;
            changed = true;
          }
          if (!changed) continue;
          recordedCount++;
          resources[logicalId] = hasObserved
            ? { ...existing, observedProperties: newBaseline }
            : { ...existing, properties: newBaseline };
        }

        if (recordedCount === 0) {
          // Every reported narrowing was on a key state does not track, or was
          // a value on a template-only baseline — nothing to persist.
          continue;
        }

        const newState: StackState = {
          ...report.state,
          resources,
          lastModified: Date.now(),
        };
        const saveOptions: { expectedEtag?: string; migrateLegacy?: boolean } = {
          expectedEtag: report.etag,
        };
        if (report.migrationPending) {
          saveOptions.migrateLegacy = true;
        }
        // BEST-EFFORT, unlike `--accept`'s write. There the state write IS the
        // operation; here AWS has ALREADY been reverted and this is a secondary
        // convergence step, so a failure must not abort the command — under
        // `--all` a throw here would skip every later stack's revert entirely,
        // which is a regression against the pre-#1644 behavior of not writing
        // at all. The cost of the warn path is only that the narrowing
        // re-surfaces on the next `cdkd drift`, i.e. exactly the pre-fix state.
        try {
          await stateBackend.saveState(report.stackName, report.region, newState, saveOptions);
          logger.info(
            `✓ State updated for ${report.stackName} (${report.region}): recorded the value the ` +
              `provider actually applied on ${recordedCount} resource(s).`
          );
        } catch (err) {
          logger.warn(
            `Reverted ${report.stackName} (${report.region}), but could not record the value the ` +
              `provider actually applied: ${err instanceof Error ? err.message : String(err)}. ` +
              `The next 'cdkd drift' will report the same difference — re-run ` +
              `'cdkd drift ${report.stackName} --revert' once the state write can succeed.`
          );
        }
      }
    } finally {
      await lockManager.releaseLock(report.stackName, report.region).catch((err) => {
        logger.warn(
          `Failed to release lock for ${report.stackName} (${report.region}): ` +
            (err instanceof Error ? err.message : String(err))
        );
      });
    }
  }

  const summaryParts = [`${totalSucceeded} reverted`];
  if (totalUnsupported > 0) summaryParts.push(`${totalUnsupported} update-not-supported`);
  if (totalFailed > 0) summaryParts.push(`${totalFailed} failed`);
  logger.info(`\nRevert summary: ${summaryParts.join(', ')}.`);

  if (totalUnsupported > 0) {
    logger.warn(
      `${totalUnsupported} resource(s) cannot be reverted in place — re-deploy the stack with cdkd deploy --replace, ` +
        `or destroy + redeploy to push the cdkd-state values back into AWS.`
    );
  }

  if (totalFailed > 0 || totalUnsupported > 0) {
    throw new PartialFailureError(
      `Revert completed with ${totalFailed + totalUnsupported} resource error(s) ` +
        `(${totalFailed} AWS update failure(s), ${totalUnsupported} update-not-supported). ` +
        `Re-run 'cdkd drift <stack>' to see the remaining drift, then 'cdkd drift <stack> --revert' to retry.`
    );
  }
}

/**
 * Print the planned state mutations for `--accept` (no AWS calls). One
 * line per resource per property path, mirroring the human report's
 * +/- diff format but flipped: the value on disk after this command
 * runs is the `+` side.
 */
function printAcceptPlan(reports: StackDriftReport[]): void {
  for (const report of reports) {
    const drifted = report.outcomes.filter(
      (o): o is Extract<DriftOutcome, { kind: 'drifted' }> => o.kind === 'drifted'
    );
    if (drifted.length === 0) continue;
    process.stdout.write(
      `\nPlan (--accept): update cdkd state for ${report.stackName} (${report.region}):\n`
    );
    for (const o of drifted) {
      process.stdout.write(`  ~ ${o.logicalId} (${o.resourceType})\n`);
      for (const change of o.changes) {
        process.stdout.write(
          `    ${change.path}: ${formatScalar(change.stateValue)} -> ${formatScalar(change.awsValue)}\n`
        );
      }
    }
  }
}

/**
 * Print the planned `provider.update` calls for `--revert` (no AWS calls).
 * One line per resource summarising how many property paths will be
 * overwritten on the AWS side.
 */
function printRevertPlan(reports: StackDriftReport[]): void {
  for (const report of reports) {
    const drifted = report.outcomes.filter(
      (o): o is Extract<DriftOutcome, { kind: 'drifted' }> => o.kind === 'drifted'
    );
    if (drifted.length === 0) continue;
    process.stdout.write(
      `\nPlan (--revert): push cdkd state values back into AWS for ${report.stackName} (${report.region}):\n`
    );
    for (const o of drifted) {
      const word = o.changes.length === 1 ? 'property path' : 'property paths';
      process.stdout.write(
        `  → provider.update on ${o.logicalId} (${o.resourceType}): revert ${o.changes.length} ${word}\n`
      );
      for (const change of o.changes) {
        process.stdout.write(
          `    ${change.path}: ${formatScalar(change.awsValue)} -> ${formatScalar(change.stateValue)}\n`
        );
      }
      // Issue #1478. Printed as part of the PLAN, not at update time, so it
      // is visible before the confirmation prompt AND under `--dry-run` —
      // a warning the user only sees after the writes have happened is not
      // a warning.
      const stateResource = report.state.resources[o.logicalId];
      // Issue #1501, printed for the same reason: a tag AWS added
      // out-of-band SURVIVES the revert, so say so before the user confirms.
      // Not gated on the observed-capture baseline — the diff semantic
      // applies on both baselines.
      if (stateResource) {
        const preserved = findRevertPreservedTagKeys(
          o.changes,
          stateResource.observedProperties ?? stateResource.properties ?? {},
          o.awsProperties
        );
        if (preserved.length > 0) {
          const tagWord = preserved.length === 1 ? 'tag' : 'tags';
          process.stdout.write(
            `    ! reverting this tag list KEEPS ${preserved.length} AWS-authored ` +
              `${tagWord} the baseline does not carry:\n`
          );
          for (const path of preserved) {
            process.stdout.write(`        ${path}\n`);
          }
          // "Every other tag reverts normally" is only true on the
          // observed-capture baseline. Under #1626's raw-TEMPLATE baseline
          // EVERY untemplated tag is preserved, and the block printed just
          // below says so — leaving this sentence unconditional made the plan
          // contradict itself two lines apart.
          const othersRevert =
            stateResource.observedProperties === undefined
              ? ''
              : `Every other tag reverts normally. `;
          process.stdout.write(
            `      ${othersRevert}A service may require these ` +
              `(ECS needs AmazonECSManaged for managed scaling); 'aws:'-prefixed keys are ` +
              `AWS-reserved and cannot be removed by hand.\n`
          );
        }
      }
      if (stateResource && stateResource.observedProperties === undefined) {
        const unbaselined = findRevertUnbaselinedAwsKeys(
          o.changes,
          stateResource.properties ?? {},
          o.awsProperties
        );
        if (unbaselined.length > 0) {
          const word = unbaselined.length === 1 ? 'value' : 'values';
          process.stdout.write(
            `    ! this resource has no observed-capture baseline, so the revert ` +
              `pushes the raw TEMPLATE and LEAVES ${unbaselined.length} AWS-authored ${word} ` +
              `untouched:\n`
          );
          for (const path of unbaselined) {
            process.stdout.write(`        ${path}\n`);
          }
          process.stdout.write(
            `      The template does not declare these, so cdkd cannot tell an AWS-authored ` +
              `value from an out-of-band change and will not reset either (issue #1626). ` +
              `Run 'cdkd state refresh-observed ${report.stackName}' (or re-deploy) to populate ` +
              `observedProperties if you want them reverted too.\n`
          );
        }
      }
    }
  }
}

/**
 * Run a list of zero-arg async tasks with a concurrency cap. Tasks are
 * allowed to throw; failure handling is the caller's responsibility (the
 * revert path catches per-task errors inside the task body).
 */
async function runWithConcurrency(
  tasks: Array<() => Promise<void>>,
  concurrency: number
): Promise<void> {
  const queue = [...tasks];
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(concurrency, queue.length); i++) {
    workers.push(
      (async (): Promise<void> => {
        while (queue.length > 0) {
          const task = queue.shift();
          if (!task) break;
          await task();
        }
      })()
    );
  }
  await Promise.all(workers);
}

async function confirmPrompt(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = await rl.question(`${prompt} [y/N] `);
    return /^y(es)?$/i.test(ans.trim());
  } finally {
    rl.close();
  }
}

/**
 * JSON output shape — stable contract for tooling. Each stack carries
 * separate `drifted` / `notSupported` arrays so consumers don't have to
 * filter by `kind`.
 */
interface StackDriftJson {
  stack: string;
  region: string;
  drifted: Array<{
    logicalId: string;
    type: string;
    changes: Array<{ path: string; stateValue: unknown; awsValue: unknown }>;
  }>;
  clean: Array<{ logicalId: string; type: string }>;
  notSupported: Array<{ logicalId: string; type: string }>;
  /** Issue #323: Custom Resources (drift not applicable). */
  skipped: Array<{ logicalId: string; type: string }>;
}

function writeJsonReport(reports: StackDriftReport[]): void {
  const payload: StackDriftJson[] = reports.map((r) => {
    const drifted = r.outcomes
      .filter((o): o is Extract<DriftOutcome, { kind: 'drifted' }> => o.kind === 'drifted')
      .map((o) => ({ logicalId: o.logicalId, type: o.resourceType, changes: o.changes }));
    const clean = r.outcomes
      .filter((o): o is Extract<DriftOutcome, { kind: 'clean' }> => o.kind === 'clean')
      .map((o) => ({ logicalId: o.logicalId, type: o.resourceType }));
    const notSupported = r.outcomes
      .filter((o): o is Extract<DriftOutcome, { kind: 'unsupported' }> => o.kind === 'unsupported')
      .map((o) => ({ logicalId: o.logicalId, type: o.resourceType }));
    const skipped = r.outcomes
      .filter((o): o is Extract<DriftOutcome, { kind: 'skipped' }> => o.kind === 'skipped')
      .map((o) => ({ logicalId: o.logicalId, type: o.resourceType }));
    return { stack: r.stackName, region: r.region, drifted, clean, notSupported, skipped };
  });
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function writeHumanReport(reports: StackDriftReport[]): void {
  for (const report of reports) {
    const drifted = report.outcomes.filter(
      (o): o is Extract<DriftOutcome, { kind: 'drifted' }> => o.kind === 'drifted'
    );
    const unsupported = report.outcomes.filter(
      (o): o is Extract<DriftOutcome, { kind: 'unsupported' }> => o.kind === 'unsupported'
    );
    // Issue #323: `skipped` (currently only `Custom::*`) is intentionally
    // NOT counted as "checked" — drift on Custom Resources is not
    // actionable from `cdkd drift` (no read happens). Excluded from the
    // human-report count so "N resources checked" matches the user's
    // mental model. Skipped entries are still present in the outcomes
    // array and surface in `--json` output (as `skipped: [...]`).
    const skippedCount = report.outcomes.filter((o) => o.kind === 'skipped').length;
    const checked = report.outcomes.length - skippedCount;

    if (drifted.length === 0) {
      process.stdout.write(
        `✓ ${report.stackName} (${report.region}): no drift detected ` +
          `(${checked} resource${checked === 1 ? '' : 's'} checked, ${unsupported.length} unsupported)\n`
      );
    } else {
      const word = drifted.length === 1 ? 'resource' : 'resources';
      process.stdout.write(
        `\n⚠ ${report.stackName} (${report.region}): drift detected on ${drifted.length} ${word}\n\n`
      );
      for (const o of drifted) {
        process.stdout.write(`  ~ ${o.logicalId} (${o.resourceType})\n`);
        for (const change of o.changes) {
          process.stdout.write(`    - ${change.path}: ${formatScalar(change.stateValue)}\n`);
          process.stdout.write(`    + ${change.path}: ${formatScalar(change.awsValue)}\n`);
        }
        process.stdout.write('\n');
      }
    }

    if (unsupported.length > 0) {
      process.stdout.write(
        `\n  ${unsupported.length} resource(s) reported as drift unknown — ` +
          `provider does not yet support drift detection:\n`
      );
      for (const o of unsupported) {
        process.stdout.write(`    ? ${o.logicalId} (${o.resourceType})\n`);
      }
    }
  }
}

/**
 * Render a value for the `+/-` lines in the human-readable diff. Scalars
 * pass through; structured values are JSON-encoded inline so a multi-line
 * value doesn't break the visual alignment.
 */
function formatScalar(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/**
 * Reusable `--stack-region <region>` option (mirrors `state show`).
 */
function stackRegionOption(): Option {
  return new Option(
    '--stack-region <region>',
    'Region of the stack record to inspect. Required when the same stack name has state in multiple regions.'
  );
}

/**
 * Create the `drift` command.
 */
export function createDriftCommand(): Command {
  const cmd = new Command('drift')
    .description(
      'Detect drift between cdkd state and AWS reality. Exits 0 when no drift, 1 when drift is detected. ' +
        'Pass --accept to update cdkd state from AWS, or --revert to push cdkd state values back into AWS.'
    )
    .argument('[stacks...]', 'Stack name(s) to check (physical CloudFormation names)')
    .option('--all', 'Check every stack in the state bucket', false)
    .option('--json', 'Output as JSON', false)
    .option(
      '--accept',
      'Update cdkd state with the AWS-current values for every drifted property (state ← AWS). ' +
        'Mutually exclusive with --revert.',
      false
    )
    .option(
      '--revert',
      'Push cdkd state values back into AWS via provider.update for every drifted resource (AWS ← state). ' +
        'Mutually exclusive with --accept.',
      false
    )
    .option(
      '--dry-run',
      'Print the planned mutations without acquiring a lock or hitting AWS / S3. ' +
        'Honored by --accept and --revert.',
      false
    )
    .option(
      '--concurrency <number>',
      'Maximum concurrent provider.update calls during --revert',
      (value) => parseInt(value, 10),
      4
    )
    .addOption(stackRegionOption())
    .action(withErrorHandling(driftCommand));

  [...commonOptions, ...stateOptions].forEach((opt) => cmd.addOption(opt));

  cmd.addOption(deprecatedRegionOption);

  return cmd;
}
