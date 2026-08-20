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
import { updatePartialMessage, updatePartialReason } from '../../deployment/update-outcome.js';
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
import { maskingRetryLogger } from '../../deployment/masking-retry-logger.js';
import { isThrottlingError } from '../../deployment/retryable-errors.js';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
} from '../../deployment/intrinsic-function-resolver.js';
import {
  createSecretMasker,
  DYNAMIC_REFERENCE_INNER,
  isSingleDynamicReferenceToken as isWholeDynamicReference,
  maskSecretsInText,
  MIN_NEEDLE_LENGTH,
  redactSecretsForState,
  SECRET_MASK,
  STATE_SOURCED_READBACK_RULES,
  type RecordedSecretValues,
} from '../../deployment/secret-redaction.js';
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
       *
       * Deliberately UNREDACTED (issue #1914): this bag is handed to
       * `provider.update` as the AWS-current side, so a `{{resolve:...}}`
       * expression written over a secret leaf would tell the provider AWS
       * currently holds the literal token.
       *
       * So it must not be printed or persisted RAW, which is not the same as
       * never reaching either. It reaches state on one path — `--revert` sends
       * `buildRevertNewProperties`'s merge of it with the desired subtrees, and
       * the provider's echo of that becomes the #1644 narrowing delta — and
       * that path redacts it before the write. It reaches stdout on one path
       * too: the revert PLAN derives tag / untemplated-key PATH names from it,
       * and those are masked where they are PRINTED — the lists themselves stay
       * unmasked because their callers use them as KEY SETS. Everything else reads
       * `changes`, which is redacted as the outcome is constructed.
       */
      awsProperties: Record<string, unknown>;
      /**
       * `plaintext -> {{resolve:...}}` for every SECRET dynamic reference the
       * drift comparison re-resolved out of this resource's baseline and its
       * `properties` (issue #1914). Empty for the overwhelming majority of
       * resources, which carry no dynamic reference at all.
       *
       * Read by `runAccept`, which redacts the baseline it is about to persist
       * with the same map the comparison built — the `--accept` write is fed by
       * a live AWS readback and is therefore a disclosure surface of its own.
       * `runRevert` deliberately does NOT read it: a revert needs the
       * resolution direction (expression -> today's plaintext) against AWS as
       * it is NOW, so it re-derives its own map rather than inverting this one.
       */
      secrets: RecordedSecretValues;
      /**
       * The `changes[].path` values whose reported value cdkd could not
       * identify — a masked VALUE at a known-secret path, or a masked PATH
       * (issue #1914).
       *
       * Carried rather than re-derived by comparing against `SECRET_MASK`,
       * which would false-refuse a property whose real value is the string
       * `***` and cannot see a masked path at all. Read by
       * `acceptRefusalReason` (shared by the `--accept` write and its plan) and
       * by `runRevert`, which cannot overlay a subtree whose TOP-LEVEL segment
       * it can no longer name.
       */
      maskedPaths: SecretPathSet;
      /**
       * Whether cdkd failed to fully resolve this resource's dynamic
       * references — the lookup threw, OR a `{{resolve:...}}` token survived
       * the pass (issue #1914).
       *
       * Read by `printRevertPlan`, which derives its tag / untemplated-key
       * lists from the deliberately-unredacted `awsProperties` and masks them
       * with `secrets`. `secrets.size === 0` is NOT the same question: a
       * resource with one resolvable `secretsmanager` reference AND one
       * `ssm-secure` survivor has a non-empty map that still cannot mask what
       * the survivor's position holds.
       */
      referencesUnresolved: boolean;
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
 * Does any string anywhere in `value` carry a `{{resolve:...}}` dynamic
 * reference?
 *
 * Cheap pre-check so the overwhelming majority of resources — which reference
 * no secret at all — never build a resolver context and never pay a deep clone
 * of their property bag.
 */
function containsDynamicReference(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('{{resolve:');
  if (Array.isArray(value)) return value.some(containsDynamicReference);
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(containsDynamicReference);
  }
  return false;
}

/**
 * The dotted property paths at which a resource is KNOWN to carry a secret,
 * learned while re-resolving its state bags (issue #1914).
 *
 * Recorded at the leaf's OWN dotted path. That is a finer coordinate space than
 * the one `calculateResourceDrift` reports in — it never descends an array, so
 * a secret at `Tags.0.Value` surfaces as a drift on `Tags` — which is what
 * {@link isSecretBearingPath}'s prefix test exists to bridge, in both
 * directions at once.
 */
type SecretPathSet = Set<string>;

/**
 * The threshold `secret-redaction.ts` applies when it builds its substring
 * needles. IMPORTED rather than copied since issue #2005 exported it (`cdkd
 * scrub` needed the same constant to bound its cross-resource union), so the
 * two can no longer disagree — and they must not, or this function would call a
 * leaf secret-bearing that `redactSecretsForState` will not redact. The local
 * alias is kept so the call sites below read unchanged.
 */
const MIN_SECRET_NEEDLE_LENGTH = MIN_NEEDLE_LENGTH;

/**
 * Does `value` hold a plaintext this pass has recorded as a secret?
 *
 * Two branches with deliberately different strictness, and the asymmetry is the
 * point. A WHOLE-value match is exact evidence at any length, so it is accepted
 * unconditionally. A SUBSTRING match is only evidence when the plaintext is
 * long enough to be distinctive: a 1-3 character secret (a JSON key holding
 * `"0"`) occurs inside unrelated values constantly, and accepting it would mark
 * half the resource's paths secret-bearing — masking values that are not
 * secrets and, worse, making `--accept` refuse them.
 *
 * So this errs toward NOT marking on the substring branch, and that direction
 * is chosen rather than inherited: `redactSecretsForState` applies the same
 * threshold when it builds needles, so a sub-threshold plaintext is not
 * substituted there either. Marking a path this function's caller cannot
 * actually redact would produce a `***` with no mechanism behind it.
 */
function carriesRecordedSecret(value: string, secrets: RecordedSecretValues): boolean {
  if (value === '') return false;
  if (secrets.has(value)) return true;
  for (const plaintext of secrets.keys()) {
    if (plaintext.length >= MIN_SECRET_NEEDLE_LENGTH && value.includes(plaintext)) return true;
  }
  return false;
}

/**
 * Is this unresolvable token one whose value is a SECRET by definition?
 *
 * `ssm-secure` is the only such spelling, and it is decidable with no lookup:
 * CloudFormation defines exactly three dynamic-reference services (`ssm`,
 * `ssm-secure`, `secretsmanager`), cdkd resolves the other two, and
 * `ssm-secure` is the encrypted one.
 *
 * Anything else reaching the survivor arm is not a CloudFormation dynamic
 * reference at all — it is text that merely looks like one — and treating it as
 * secret is not the safe direction it appears to be: the path would be masked
 * to `***`, refused by `--accept`, and pinned to the live value by
 * {@link preserveLiveValuesAtUnresolvedTokens}, which is permanently stuck
 * drift with no remedy the user can apply. Such a token is still REPORTED; it
 * just does not claim to be a secret.
 */
function isSecretBySpelling(token: string): boolean {
  return token.startsWith('{{resolve:ssm-secure:');
}

/**
 * Every `{{resolve:...}}` token still present in `value`.
 *
 * Used to NAME an unresolvable reference without quoting the string it sits in.
 * That string is a partially substituted leaf: `resolveDynamicReferences`
 * substitutes token by token, so a leaf holding two references comes back with
 * the resolvable one already replaced by its PLAINTEXT. Interpolating it into a
 * log line prints the secret — from the command whose purpose is not to. A
 * token is a reference NAME and carries no value, so it is always safe to show.
 */
function survivingDynamicReferences(value: string): string[] {
  // Built from `secret-redaction.ts`'s `DYNAMIC_REFERENCE_INNER`, which is
  // byte-identical to `intrinsic-function-resolver.ts`'s own
  // `/\{\{resolve:([^}]+)\}\}/` scan capture — the AUTHORITY on what cdkd will
  // try to resolve. The two MUST agree or a token the resolver tried and left
  // behind is reported by neither; a `{` inside a token
  // (`{{resolve:ssm:/a{b}}`) is the shape that separates them.
  //
  // This used to be the ONLY one of cdkd's four spellings that agreed with the
  // resolver, and its own comment argued the split with
  // `isWholeDynamicReference` was principled ("they answer different questions
  // against different modules"). Issue #1936 measured that: the questions
  // differ, the CHARACTER CLASS does not, and the disagreement persisted
  // plaintext at the strict sibling. A fresh `RegExp` per call, since a shared
  // global instance carries `lastIndex` between callers.
  return value.match(new RegExp(`\\{\\{resolve:${DYNAMIC_REFERENCE_INNER}\\}\\}`, 'g')) ?? [];
}

/**
 * Record the dotted path of every leaf holding a `{{resolve:...}}` string.
 *
 * The OFFLINE seed for {@link SecretPathSet}: it needs no AWS call, so it is
 * what remains when resolution fails. Issue #1900's mechanism applied to
 * positions instead of values — the record's own bags already say WHERE the
 * references are, and that is the half of the answer a failed lookup does not
 * take away.
 *
 * Necessarily coarser than the resolved answer, because a `{{resolve:ssm:...}}`
 * naming a plain `String` parameter is PUBLIC config and only the resolver's
 * TYPE verdict can say so. Marking such a path secret-bearing over-masks it,
 * which is why the seed is used ONLY on the failure path, where the alternative
 * is not masking at all.
 */
function collectDynamicReferencePaths(value: unknown, into: SecretPathSet, path = ''): void {
  if (typeof value === 'string') {
    if (value.includes('{{resolve:')) into.add(path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) =>
      collectDynamicReferencePaths(item, into, path === '' ? String(i) : `${path}.${i}`)
    );
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      collectDynamicReferencePaths(v, into, path === '' ? k : `${path}.${k}`);
    }
  }
}

/**
 * Re-resolve the SECRET dynamic references (`{{resolve:secretsmanager:...}}`,
 * and an `{{resolve:ssm:...}}` naming a `SecureString`) held by a bag read back
 * out of cdkd STATE (issue #1914).
 *
 * State stores the unresolved EXPRESSION — that is the GHSA-p5qg-v9gv-hc7w
 * redaction — while a provider's `readCurrentState` snapshot necessarily holds
 * the resolved PLAINTEXT, because that is what AWS was given at deploy time.
 * Nothing in `cdkd drift` reconciled the two, and all three of the command's
 * modes broke on it: the comparison reported permanent phantom drift and
 * printed the plaintext as the AWS-current side, `--accept` persisted that
 * plaintext back into `state.json`, and `--revert` shipped the literal
 * `{{resolve:...}}` string to the live resource.
 *
 * The counterpart of the rollback replay's `resolveReplayProps`
 * (`src/deployment/rollback-executor.ts`), and for the same reason: both
 * commands are synth-free, so the expression string in the persisted record is
 * the only thing there is to resolve from. Every plaintext is recorded into
 * `secrets` so the caller can redact it back out of anything it PRINTS or
 * PERSISTS, and every path that produced one into `secretPaths` so the caller
 * can act on a value it does NOT recognise there — see {@link redactDriftChanges}.
 *
 * A `{{resolve:...}}` token that SURVIVES the pass is reported through
 * `onUnresolved` and left in place — it is not an error. The resolver's
 * unsupported-service arm (`ssm-secure:` is the live example) warns and returns
 * the literal, and `cdkd deploy` resolves through the very same code, so AWS is
 * ALREADY holding that literal string and state records it. Replaying it is
 * therefore a correct no-op, and failing the resource over it would take every
 * other drifted property on that resource down with it (plus exit 2). The
 * report exists so the user learns cdkd is shipping a token it cannot resolve,
 * which is a real thing to know and not a reason to stop.
 *
 * Only the TOKENS are reported, never the leaf that held them: the leaf is
 * partially substituted by this point, so a mixed `secretsmanager` +
 * `ssm-secure` string comes back carrying real plaintext.
 *
 * Returns the input by identity when it holds no dynamic reference, so the
 * non-secret path is unchanged down to object identity.
 */
async function resolveStateSecretExpressions(
  props: Record<string, unknown>,
  resolver: IntrinsicFunctionResolver,
  secrets: RecordedSecretValues,
  options: {
    secretPaths?: SecretPathSet;
    onUnresolved?: (tokens: string[], path: string) => void;
  } = {}
): Promise<Record<string, unknown>> {
  if (!containsDynamicReference(props)) return props;
  const { secretPaths, onUnresolved } = options;
  const ctx: ResolverContext = {
    template: { Resources: {} },
    resources: {},
    recordedSecretValues: secrets,
  };
  const walk = async (v: unknown, path: string): Promise<unknown> => {
    if (typeof v === 'string') {
      if (!v.includes('{{resolve:')) return v;
      const resolved = await resolver.resolveDynamicReferences(v, ctx);
      // Only tokens that were in the INPUT. The scan runs over the RESOLVED
      // string, so a secret whose plaintext happens to contain
      // `{{resolve:...}}`-shaped text would otherwise be reported verbatim by
      // the very warning that exists to avoid printing values.
      const survivors = survivingDynamicReferences(resolved).filter((t) => v.includes(t));
      if (survivors.length > 0) {
        // The position is secret-bearing even though nothing was recorded for
        // it — but only for a spelling that IS a secret. `ssm-secure` is, by
        // definition, and the value at such a path is emphatically not safe to
        // print: CloudFormation resolves it SERVER-side, so a record adopted by
        // `cdkd import --migrate-from-cloudformation` has the literal token in
        // state while AWS holds the PLAINTEXT. Without this the report, the
        // `--json` payload and `--accept` all see it unmasked.
        if (survivors.some(isSecretBySpelling)) secretPaths?.add(path);
        onUnresolved?.(survivors, path);
      }
      // A recorded plaintext at this leaf means the leaf is secret-bearing —
      // permanently, not only for the value it holds right now. That is the
      // fact `redactDriftChanges` needs when AWS answers with something the
      // secrets map does NOT contain (a rotated-away previous version, an
      // out-of-band edit): the value is unrecognisable but the POSITION is
      // still known to hold a secret.
      if (carriesRecordedSecret(resolved, secrets)) secretPaths?.add(path);
      return resolved;
    }
    if (Array.isArray(v)) {
      const out: unknown[] = new Array(v.length) as unknown[];
      // Indexed like any other segment — this is the plain walk, with no
      // array-specific rule at all. Bridging it to the coordinate space the
      // comparator reports in (which never descends an array, so a secret at
      // `Tags.0.Value` surfaces as a drift on `Tags`) is entirely
      // {@link isSecretBearingPath}'s prefix test, and that test is what a
      // mutation probe reds. Collapsing the index here would ALSO work, which
      // is exactly why nothing here argues for one over the other: the choice
      // is unobservable, so the code takes the form with no special case.
      for (let i = 0; i < v.length; i++) {
        out[i] = await walk(v[i], path === '' ? String(i) : `${path}.${i}`);
      }
      return out;
    }
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) {
        out[k] = await walk(val, path === '' ? k : `${path}.${k}`);
      }
      return out;
    }
    return v;
  };
  return (await walk(props, '')) as Record<string, unknown>;
}

/**
 * Is a drift reported at `path` positioned on, or above, a known secret?
 *
 * The PREFIX direction is the one that matters: a secret sits at a leaf (or at
 * an array the comparator never descends), while a drift can be reported at any
 * ancestor of it — `Environment` rather than
 * `Environment.Variables.SECRET_PASSWORD` — whenever the two sides disagree
 * about the shape rather than the value. The reverse containment is checked too
 * and costs nothing.
 */
function isSecretBearingPath(path: string, secretPaths: SecretPathSet): boolean {
  if (secretPaths.size === 0) return false;
  for (const secretPath of secretPaths) {
    if (
      secretPath === path ||
      secretPath.startsWith(`${path}.`) ||
      path.startsWith(`${secretPath}.`)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Redact one side of a drift entry.
 *
 * Two passes, and the second is the one issue #1914's review turned up. The
 * VALUE pass rewrites any recorded plaintext back onto its own
 * `{{resolve:...}}` expression, which is exact and is all that is needed while
 * the secret AWS holds is the secret the reference resolves to today.
 *
 * It stops being enough the moment those two differ, and they differ for the
 * most ordinary reason there is: a Secrets Manager ROTATION. The deployed
 * resource then still holds the PREVIOUS secret while the re-resolved baseline
 * holds the new one, so the path drifts and the AWS side matches no key in a
 * map built from today's value — it is a real secret that would be printed
 * verbatim and persisted by `--accept`. An out-of-band edit is
 * indistinguishable from it at this layer, so the POSITION decides: at a path
 * known to carry a secret, the only value ever shown is the expression itself,
 * and anything else becomes {@link SECRET_MASK}.
 *
 * `undefined` and `null` are exempt — an absent or null key discloses nothing,
 * and masking them would turn "AWS does not have this key" into "AWS has
 * something secret here", which is both wrong and less useful.
 */
function redactDriftValue(
  value: unknown,
  secrets: RecordedSecretValues,
  secretBearing: boolean
): unknown {
  const redacted = redactSecretsForState(value, secrets);
  if (!secretBearing) return redacted;
  if (redacted === undefined || redacted === null) return redacted;
  if (typeof redacted === 'string' && isWholeDynamicReference(redacted)) return redacted;
  return SECRET_MASK;
}

// `isWholeDynamicReference` — "is the WHOLE string a single `{{resolve:...}}`
// token and nothing else?" — lived HERE as a hand-copied twin of
// `secret-redaction.ts`'s `isSingleDynamicReferenceToken` until issue #1936. It
// is now that function, imported under this file's own name at the top.
//
// The copy spelled the inner class `[^{}]*` to match its sibling
// "byte-for-byte", and the two DID stay byte-identical — which is precisely why
// the copy was not the problem: both were stricter than the RESOLVER, so a
// reference whose inner text contains a `{` was resolved by cdkd and then
// classified as not-a-token by every predicate downstream. Being identical to
// the wrong answer is not agreement, and duplicating it made the disagreement
// with the authority twice as expensive to notice.
//
// A plain comment rather than a JSDoc block so nothing attaches it to the
// function below. Sharing one definition matters here for the same reason the
// copy did: this predicate decides whether a value may be shown INSTEAD of
// `SECRET_MASK`, and `redactByPath` uses it to decide whether a leaf is already
// an expression, so a disagreement lets one of them treat as a token what the
// other treats as data.

/**
 * Why `--accept` must not persist this drift, or `undefined` when it may.
 *
 * Shared by the WRITE (`runAccept`) and the PLAN (`printAcceptPlan`) so the two
 * cannot disagree — a `--dry-run` that promises a write the real run refuses is
 * worse than either behaviour on its own.
 *
 * Two refusals, both about a value cdkd could not identify rather than about
 * secrecy as such:
 *
 * - A masked VALUE says AWS holds something at a known-secret path that is not
 *   what the reference resolves to. Writing `***` would corrupt the baseline
 *   and make the next deploy push the literal mask at AWS.
 * - A masked PATH says the readback answered with a map KEYED by a secret.
 *   `setAtPath` would then create a key literally named `***` — and when
 *   `awsValue` is `undefined` it would INSERT that key rather than removing the
 *   real one, so the value check alone does not cover it.
 *
 * The path check is what makes the value exemptions safe: `redactDriftValue`
 * lets `undefined` / `null` / a whole expression through unmasked, which is
 * right for a value and says nothing about the path it sits at.
 */
function acceptRefusalReason(
  change: PropertyDrift,
  maskedPaths: SecretPathSet
): string | undefined {
  if (!maskedPaths.has(change.path)) return undefined;
  if (change.path.includes(SECRET_MASK)) {
    return (
      'its property NAME came back carrying a secret value, so cdkd cannot name the key to ' +
      'write — and no redaction pass can clear it either, since they all walk values and never ' +
      'keys. ROTATE the secret; that is the only remedy'
    );
  }
  if (change.awsValue === undefined) {
    return (
      'AWS no longer reports it, and accepting an absence DELETES the key — which at or above ' +
      'a secret dynamic reference would erase the reference out of cdkd state. Use --revert to ' +
      'push it back, or re-deploy'
    );
  }
  return (
    'it carries a secret dynamic reference and the value AWS currently holds is not the one ' +
    'the reference resolves to'
  );
}

/**
 * Redact resolved secret plaintext out of the drift entries that get REPORTED
 * (issue #1914).
 *
 * Both sides need it, for different reasons. `stateValue` comes from the
 * re-resolved comparison baseline, so at a secret leaf it now holds the
 * plaintext the state record deliberately does not store. `awsValue` is the
 * live readback, which holds that plaintext by construction. Either one
 * reaching `writeHumanReport` / `writeJsonReport` / the `--accept` and
 * `--revert` plans is the disclosure the redaction exists to prevent.
 *
 * Redacting `awsValue` also settles what `--accept` PERSISTS: that is the value
 * it writes into the baseline, so a secret one arrives at the state write
 * already carrying its expression — or, when it could not be recognised, as
 * {@link SECRET_MASK}, which `runAccept` refuses to persist.
 *
 * The PATH is redacted too. `redactSecretsForState` walks values and never
 * object KEYS, so a readback that answers with a map keyed by a secret (a
 * Lambda env var NAMED with one) renders as
 * `Environment.Variables.<plaintext>` in every printer. It is masked here
 * rather than assumed impossible, and a masked path also marks the change
 * secret-bearing, so `--accept` will not write a key it can no longer name.
 *
 * Returns the input array by identity when there is nothing to act on.
 */
function redactDriftChanges(
  changes: PropertyDrift[],
  secrets: RecordedSecretValues,
  secretPaths: SecretPathSet
): { changes: PropertyDrift[]; maskedPaths: SecretPathSet } {
  if (secrets.size === 0 && secretPaths.size === 0) {
    return { changes, maskedPaths: new Set<string>() };
  }
  // The paths whose reported value cdkd could not identify. Returned rather
  // than re-derived downstream by comparing against `SECRET_MASK`: a property
  // whose real value happens to BE the string `***` would otherwise be refused
  // by `--accept` for no reason, and a masked PATH is not detectable from the
  // value at all.
  const maskedPaths = new Set<string>();
  const redacted: PropertyDrift[] = [];
  for (const change of changes) {
    // NOTE the asymmetry with `printRevertPlan`, which loudly WITHHOLDS its
    // key lists when a resource's references could not be resolved: here the
    // path is simply left as it is, because on that path `secrets` is empty and
    // `maskSecretsInText` has nothing to match. Both are the same limit — a
    // value cdkd never resolved cannot be recognised inside a KEY — but only
    // the plan can withhold, since a drift entry without its path says nothing
    // at all.
    const maskedPath = maskSecretsInText(change.path, secrets);
    // Two independent reasons a change is secret-bearing, and they are kept
    // apart because only one of them licenses the DROP below: the POSITION is
    // known to hold a secret, or the property NAME turned out to carry one.
    const positionIsSecret = isSecretBearingPath(change.path, secretPaths);
    const nameCarriesSecret = maskedPath !== change.path;
    const secretBearing = positionIsSecret || nameCarriesSecret;
    // EXACT, not the prefix match above. `isSecretBearingPath` deliberately
    // matches ANCESTORS so a drift reported above a secret is masked — but that
    // is the wrong granularity for the drop below, which claims a property
    // cannot be READ BACK. That is a fact about a leaf. A whole `Environment`
    // block disappearing from AWS (the console's "remove all environment
    // variables") is real drift the user wants to see, and pre-#1914 it WAS
    // reported, because the `{{resolve:` skip only ever covered leaf strings.
    const positionIsSecretLeaf = secretPaths.has(change.path);
    // An ABSENT AWS value at a secret-bearing path is "AWS cannot read this
    // back", not "AWS changed it" — a write-only credential (RDS / DocDB /
    // Neptune / ElastiCache / Cognito all declare no `getDriftUnknownPaths`)
    // simply is not returned by any readback. Dropping it RESTORES the
    // pre-#1914 behaviour exactly: `calculateResourceDrift`'s `{{resolve:`
    // skip used to cover this, and it stopped covering it precisely because
    // this PR makes the baseline arrive RESOLVED, so the state side is no
    // longer a `{{resolve:` string.
    //
    // Reporting it instead is not a smaller change, it is three bugs: `cdkd
    // drift` exits 1 forever on any stack with a templated credential;
    // `--accept` writes `undefined` at the path, which `setAtPath` turns into a
    // DELETED key — erasing the `{{resolve:...}}` reference from `properties`
    // altogether; and `--revert` re-pushes the credential to AWS on every run.
    // Masking-and-refusing instead of dropping fixes only the second.
    // Scoped to `positionIsSecretLeaf`, NOT to `secretBearing` and NOT to the
    // prefix match: the rationale is that a write-only credential is not
    // readable, which is a fact about ONE LEAF. A key whose NAME carries a
    // secret and that AWS no longer has is ordinary drift; so is a whole
    // subtree vanishing.
    if (positionIsSecretLeaf && change.awsValue === undefined) continue;
    const stateValue = redactDriftValue(change.stateValue, secrets, secretBearing);
    const awsValue = redactDriftValue(change.awsValue, secrets, secretBearing);
    // `secretBearing &&` is load-bearing: without it a property whose REAL
    // value is the string `***` at an ordinary path lands here and `--accept`
    // refuses it forever. At a secret-bearing path the two are genuinely
    // indistinguishable, so refusing is right there.
    if (
      maskedPath !== change.path ||
      (secretBearing && awsValue === SECRET_MASK) ||
      // An ABSENT value that survived the drop above — a subtree that vanished
      // from AWS, or an ancestor of a secret. It IS real drift and is reported,
      // but `--accept` must not persist it: `setAtPath(bag, path, undefined)`
      // DELETES the key, which at or above a secret position erases the
      // `{{resolve:...}}` reference out of `properties` altogether. `--revert`
      // is the operation that fixes this shape.
      (secretBearing && change.awsValue === undefined)
    ) {
      maskedPaths.add(maskedPath);
    }
    redacted.push({ path: maskedPath, stateValue, awsValue });
  }
  return { changes: redacted, maskedPaths };
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
    const logger = getLogger();
    // Issue #1914: the resolver used to re-resolve the secret expressions this
    // stack's records store. Only ever CALLED for a bag that actually holds a
    // `{{resolve:...}}` string, so a stack with no dynamic reference makes no
    // AWS call here.
    //
    // One instance per stack, and since issue
    // [#1933](https://github.com/go-to-k/cdkd/issues/1933) that instance IS the
    // dedup scope: `cachedDynamicReferences` moved off module scope onto the
    // resolver, so an expression is fetched once per STACK (it used to be once
    // per process) and one stack's resolved value can no longer be handed to
    // another stack's — or another region's — records.
    //
    // The other half — the LOOKUP reaching for the ambient `getAwsClients()`
    // singleton rather than the `region` handed to this constructor — was the
    // surviving hazard for a cross-region `--all` run, because this command
    // installs its clients ONCE (see the `setAwsClients` call at the top of
    // `runDrift`) while looping over stacks in several regions. Issue
    // [#1957](https://github.com/go-to-k/cdkd/issues/1957) CLOSED it, and
    // deliberately not here: the resolver now derives region-scoped lookup
    // clients from the region it is CONSTRUCTED with, carrying the ambient
    // profile / assume-role credentials while overriding only the region.
    // (Constructed-with, not `resolverRegion` — the two differ only when no
    // region was passed, where the seam declines to override; this command
    // always passes one.) That is a credentials decision, so it belongs where
    // every caller inherits it rather than in one command's private
    // workaround — which is why the `region` passed just below is now
    // load-bearing for VALUE correctness and not only for cache scoping. Do
    // not reintroduce a `setAwsClients` dance here to compensate for the
    // LOOKUP.
    //
    // Scope note, because the paragraph above is easy to over-read: #1957
    // fixed what this resolver READS. It did NOT fix what `--revert` WRITES.
    // The `providerRegistry` handed to `runRevert` is built once from the
    // ambient clients at the top of `runDrift`, so a cross-region
    // `--all --revert` still issues its write through the CLI region's
    // clients. That is the provisioning half of the same ambient-singleton
    // problem, filed as issue
    // [#1981](https://github.com/go-to-k/cdkd/issues/1981).
    const secretResolver = new IntrinsicFunctionResolver(region);
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
      // Issue #1914: the baseline comes out of STATE, where a secret dynamic
      // reference is stored as its unresolved `{{resolve:...}}` expression
      // (GHSA-p5qg-v9gv-hc7w), while `aws` is a live readback holding the
      // resolved plaintext. An expression never equals a plaintext, so without
      // this the two sides could not agree and every dynamic-ref stack reported
      // permanent phantom drift — with the plaintext printed as the AWS-current
      // side of the diff.
      //
      // Resolved for COMPARISON ONLY: `resource.observedProperties` /
      // `resource.properties` are untouched, so nothing here can widen what
      // state holds. What the resolution DOES leak forward is the plaintext now
      // sitting in `changes[].stateValue`, which `redactDriftChanges` puts back
      // on its expression before the outcome is built.
      const secrets: RecordedSecretValues = new Map();
      // PROVEN secret paths — filled by resolution, so a `{{resolve:ssm:...}}`
      // naming a plain `String` parameter correctly stays out of it.
      const secretPaths: SecretPathSet = new Set<string>();
      // ...and the OFFLINE fallback, computed with no AWS call from where the
      // `{{resolve:` strings simply ARE. Only used when resolution fails, where
      // the alternative is no positional masking at all — and that is not a
      // theoretical gap: the likeliest failure is a least-privilege role, and
      // the comparator's `{{resolve:` skip only re-arms for a LEAF whose state
      // side is a string. A resource whose `observedProperties` lack the secret
      // key while `properties` have it drifts at the ANCESTOR, with the whole
      // AWS subtree — plaintext included — as `awsValue`. Coarser than the
      // proven set (it cannot tell a public ssm reference from a secret one),
      // so it over-masks; that is the direction to err in when the choice is
      // against printing a secret.
      const seededSecretPaths: SecretPathSet = new Set<string>();
      collectDynamicReferencePaths(baseline, seededSecretPaths);
      if (useObserved) collectDynamicReferencePaths(resource.properties ?? {}, seededSecretPaths);
      const unresolvedTokens = new Set<string>();
      const noteUnresolved = (tokens: string[]): void => {
        for (const token of tokens) unresolvedTokens.add(token);
      };
      let comparisonBaseline = baseline;
      let secretResolutionFailed = false;
      try {
        comparisonBaseline = await resolveStateSecretExpressions(
          baseline,
          secretResolver,
          secrets,
          { secretPaths, onUnresolved: noteUnresolved }
        );
        // The record's `properties` are resolved into the SAME map and path set
        // (the resolved bag is thrown away — only those two are wanted) so a
        // leaf the observed baseline never captured is still redactable.
        // Without it, a resource whose readback omitted a secret-bearing key at
        // deploy time has no map entry for that secret, and the live value AWS
        // returns for it now would reach both the report and `--accept`'s state
        // write in plaintext. Issue #1900's shape, arriving here through the
        // observed capture instead of an UNCHANGED resource. Free unless the
        // template side names a reference the baseline does not, since resolved
        // values are cached.
        if (useObserved) {
          await resolveStateSecretExpressions(resource.properties ?? {}, secretResolver, secrets, {
            secretPaths,
            onUnresolved: noteUnresolved,
          });
        }
      } catch (err) {
        // Before this issue `cdkd drift` made no secret lookups at all, so
        // every way one can fail is a failure mode this change INTRODUCED: a
        // deleted secret, a version rotated out from under a pinned reference,
        // or — the likeliest — a least-privilege role that was never granted
        // `secretsmanager:GetSecretValue` / `ssm:GetParameter` because drift
        // never needed them. Letting it propagate would abort the whole
        // command: every remaining resource, and under `--all` every remaining
        // STACK, over one unreadable reference on one resource.
        //
        // Degrade to the pre-issue behaviour for THIS resource instead. The
        // unresolved baseline still carries its `{{resolve:...}}` strings, so
        // `calculateResourceDrift`'s skip suppresses the phantom drift exactly
        // as it did before — the resource's secret-bearing paths are simply not
        // compared, which is what the command already did and is strictly
        // better than not running at all.
        //
        // The VALUE map is cleared: a partial one would redact some leaves and
        // not others, unevenly and for a reason no reader could see. The PATH
        // answer is not lost with it — `seededSecretPaths` was computed offline
        // and takes over below, because the skip does not cover a drift
        // reported ABOVE a secret leaf.
        secretResolutionFailed = true;
        comparisonBaseline = baseline;
        logger.warn(
          `${logicalId} (${resource.resourceType}): could not resolve the dynamic reference(s) ` +
            `this resource's state records, so its secret-bearing properties are NOT compared — ` +
            // Masked BEFORE the map is cleared, and that ordering is the whole
            // reason the clear is below rather than above. The message comes
            // from an external system whose wording cdkd does not control, and
            // a partially completed pass can already hold a plaintext.
            `${maskSecretsInText(err instanceof Error ? err.message : String(err), secrets)}`
        );
        secrets.clear();
      }
      if (unresolvedTokens.size > 0) {
        // Not a failure: `cdkd deploy` resolves through this same code, so AWS
        // already holds these literals and state records them. Worth saying
        // once per resource, and safe to say — a token names a reference, not a
        // value.
        //
        // The revert clause is deliberately conditional. Preservation only
        // applies where the property's WHOLE value is the token; a token
        // EMBEDDED in a larger string (`"jdbc:...password={{resolve:ssm-secure:/pw}}"`)
        // is not preserved, and this is the message the user reads immediately
        // before the confirmation prompt — promising an untouched live value
        // there would misinform someone about to authorise a destructive write.
        logger.warn(
          `${logicalId} (${resource.resourceType}): cdkd cannot resolve ` +
            `${maskSecretsInText([...unresolvedTokens].join(', '), secrets)} — those properties ` +
            `are NOT compared. A revert leaves a property whose WHOLE value is one of these ` +
            `tokens untouched; where a token is EMBEDDED in a longer string, the revert writes ` +
            `that string with the token literal, exactly as 'cdkd deploy' does — so a resolved ` +
            `value AWS holds there WOULD be overwritten. cdkd resolves 'secretsmanager' and ` +
            `'ssm' references only.`
        );
      }
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
        comparisonBaseline,
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
      // Issue #1914: redacted BEFORE the outcome exists, so no reader can be
      // added later that sees the plaintext. Every consumer of a drifted
      // outcome — the human report, the `--json` payload, both plans, and the
      // value `--accept` writes into state — reads `changes`.
      //
      // The PROVEN path set when resolution succeeded, the offline seed when it
      // did not — never a half-populated mixture of the two.
      //
      // Run BEFORE the clean/drifted decision, not inside the drifted arm: this
      // pass can DROP a change (an absent AWS value at a secret-bearing path is
      // unknown, not drift), and deciding on the raw list first produced a
      // `drifted` outcome with an empty change list — a report that says drift
      // was detected and then shows nothing.
      const reported = redactDriftChanges(
        changes,
        secrets,
        secretResolutionFailed ? seededSecretPaths : secretPaths
      );
      if (reported.changes.length === 0) {
        outcomes.push({ kind: 'clean', logicalId, resourceType: resource.resourceType });
      } else {
        outcomes.push({
          kind: 'drifted',
          logicalId,
          resourceType: resource.resourceType,
          ...reported,
          awsProperties: aws,
          secrets,
          referencesUnresolved: secretResolutionFailed || unresolvedTokens.size > 0,
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

/**
 * Read the value at a dotted path, or `undefined` when any segment is missing.
 * The read counterpart of {@link setAtPath}, and it parses the same subset:
 * the drift comparator only synthesizes paths through plain objects.
 */
function getAtPath(source: unknown, path: string): unknown {
  if (path.length === 0) return source;
  let cursor: unknown = source;
  for (const segment of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
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
        const accepted: PropertyDrift[] = [];
        for (const change of outcome.changes) {
          // Issue #1914: anything the report had to MASK is not a value — it
          // is the statement that cdkd could not identify what AWS holds. The
          // path is left as state has it and the user is told which one and
          // why; the drift keeps being reported, which is the honest outcome
          // (`--revert` can fix it, `--accept` cannot).
          const refusal = acceptRefusalReason(change, outcome.maskedPaths);
          if (refusal !== undefined) {
            logger.warn(
              `  ! ${report.stackName}/${outcome.logicalId} (${outcome.resourceType}): ` +
                `not accepting '${change.path}' — ${refusal}, so cdkd will not write it to ` +
                `state. Run 'cdkd drift ${report.stackName} --revert' to push the referenced ` +
                `value back to AWS, or re-deploy if the reference changed.`
            );
            continue;
          }
          setAtPath(newBaseline, change.path, change.awsValue);
          accepted.push(change);
        }
        // Issue #1914: `--accept` is a WRITE-TO-STATE surface fed by a live AWS
        // readback, so it is exactly the shape GHSA-p5qg-v9gv-hc7w covers — a
        // resolved secret reaching `state.json` re-introduces the disclosure
        // for anyone with read access to the state bucket.
        //
        // `redactDriftChanges` has already redacted every value written just
        // above, so this pass is NOT a duplicate of it: what it reaches is the
        // rest of the bag, i.e. the untouched clone of the record's own
        // baseline. That clone is exactly where a plaintext survives today —
        // any user who ran `--accept` on a pre-fix binary has an
        // `observedProperties` holding the resolved secret while `properties`
        // still holds the expression, and re-accepting for an unrelated key
        // would re-persist it verbatim. Measured: without this line that state
        // round-trips the plaintext.
        //
        // The POSITIONED form, and the two arms differ for a reason. Normally
        // the record's own `properties` are the source: they hold no PUBLIC
        // expression — a `String` ssm reference is stored resolved — so any
        // `{{resolve:...}}` leaf in them is by construction a secret and may be
        // copied over verbatim (`trustAnyExpression`), while array descent
        // stays OFF because this bag came back from AWS and may be reordered.
        // That is what catches a stored plaintext the VALUE map cannot: after a
        // rotation the map holds today's secret and the stored one is last
        // week's, so only position can name it.
        //
        // The same call covers the resolution-FAILED resource with no extra arm,
        // which is why there is no flag for it: the map is empty there, so
        // `redactSecretsForState` runs its path pass alone — the #1900 offline
        // mechanism, which works precisely because it needs no secret fetch.
        //
        // Positioning cannot mis-pin a drifted SECRET leaf: the masked values
        // above remove that input entirely, since such a path is refused before
        // it can reach `newBaseline`.
        //
        // It can still overwrite an accepted value at a PUBLIC reference,
        // though, and that is a real hole rather than a hypothetical one: a
        // public `{{resolve:ssm:...}}` CAN sit in `properties` (the `cdkd
        // import` warn path, documented in `secret-redaction.ts`), such a path
        // is not secret-bearing so the change is accepted normally, and
        // `trustAnyExpression` then copies the source expression straight over
        // it. Rather than claim it cannot happen, the write is CHECKED below
        // and the user is told — a silent permanent no-op is the failure mode
        // worth naming, and the check catches any future cause of it too.
        const redactedBaseline = redactSecretsForState(
          newBaseline,
          outcome.secrets,
          existing.properties ?? {},
          STATE_SOURCED_READBACK_RULES
        );
        for (const change of accepted) {
          if (deepEqualUnordered(getAtPath(redactedBaseline, change.path), change.awsValue)) {
            continue;
          }
          logger.warn(
            `  ! ${report.stackName}/${outcome.logicalId} (${outcome.resourceType}): ` +
              `'${change.path}' was NOT recorded — cdkd state holds an unresolved ` +
              `'{{resolve:...}}' reference at that property, and the reference wins over an ` +
              `accepted value. Change the template if that reference is wrong.`
          );
        }
        resources[outcome.logicalId] = hasObserved
          ? { ...existing, observedProperties: redactedBaseline }
          : { ...existing, properties: redactedBaseline };
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
 * Replace every leaf of a revert payload that still holds a `{{resolve:...}}`
 * token with the value AWS currently has at that position (issue #1914,
 * round-3 review).
 *
 * The round-3 change downgraded an unresolvable reference from a per-resource
 * failure to a warning, on the premise that `cdkd deploy` resolves through the
 * resolver's same unsupported-service arm — so AWS already holds the literal
 * and replaying it is a no-op. **That premise holds only for records cdkd
 * deployed.** CloudFormation resolves `ssm-secure` SERVER-side, so a record
 * adopted by `cdkd import --migrate-from-cloudformation` has the literal token
 * in state while the live resource holds the PLAINTEXT. `diffAt` skips such a
 * leaf, so it never drifts — but `buildRevertNewProperties` overlays the whole
 * top-level subtree when any SIBLING key drifts, which would push the literal
 * token over a resolved value. That is defect 1 of this issue surviving in a
 * narrower case, on a live AWS write.
 *
 * Deciding by PROVENANCE would need a flag state does not carry. Deciding by
 * what AWS actually holds needs nothing and is exact in both directions: for a
 * cdkd-deployed record AWS holds the token, so copying it back is the same
 * no-op the premise described; for a migrated record AWS holds the resolved
 * value, which is left untouched.
 *
 * Falls back to KEEPING the token wherever AWS has nothing at that position —
 * that is what `cdkd deploy` sends, so it is the safe residual rather than
 * dropping a property the resource may require. Array descent is positional
 * and bails to that same residual on any length mismatch, since a reordered
 * readback cannot be positioned against.
 */
export function preserveLiveValuesAtUnresolvedTokens(
  send: Record<string, unknown>,
  awsProperties: Record<string, unknown>,
  secrets: RecordedSecretValues
): Record<string, unknown> {
  const walk = (value: unknown, live: unknown): unknown => {
    if (typeof value === 'string' && value.includes('{{resolve:')) {
      // ONLY a whole token is preserved, and this gate is a disclosure boundary
      // rather than a tidiness rule (issue #1914 round-6 review).
      //
      // A MIXED leaf (`{{ssm-secure:/host}}:{{secretsmanager:db}}`) arrives here
      // already PARTIALLY resolved. Copying the live value in would move the
      // ssm-secure plaintext into the payload — and the registration below
      // correctly declines to register it, because the send string is not a
      // token and would substitute the secretsmanager half's plaintext into
      // state if it were. So the mechanism would CREATE an exposure it then
      // cannot mask: unmaskable in the #1644 narrowing delta, the retry log and
      // the AWS error text alike.
      //
      // Returning the send string unchanged restores the pre-#1914 behaviour
      // for that shape — the literal token ships, which is what `cdkd deploy`
      // does — and gives up the live-value preservation there. That trade is
      // deliberate: a NEW disclosure is worse than a preserved pre-existing
      // breakage.
      //
      // The shape is ANY leaf whose whole value is not the token, which is
      // wider than the two-reference case: a single token embedded in a longer
      // string (`"jdbc:...password={{resolve:ssm-secure:/pw}}"`) is not
      // preserved either, so a revert triggered by a sibling key writes that
      // string over whatever AWS holds. Both user-facing warnings say so,
      // because the detection one is read immediately before the confirmation
      // prompt. Masking by SPAN, which is what would let these cases be both
      // preserved and safe, is issue #1935.
      if (!isWholeDynamicReference(value)) return value;
      if (live === undefined) return value;
      // REGISTER what was just moved. Nothing was recorded FOR THIS LEAF —
      // that is what made the token a survivor — so copying the live value in
      // and leaving the mask sets untouched hands a plaintext to three readers
      // that would each have masked it: the retry logger, the AWS-error report,
      // and the #1644 narrowing delta (whose `descendArrays: false` rules
      // cannot position an array-nested leaf and rely on the value scan finding
      // it).
      //
      // (`secrets` itself is NOT necessarily empty here: a resource can hold
      // one resolvable `secretsmanager` reference AND one `ssm-secure`
      // survivor, which is exactly the shape `referencesUnresolved` describes.
      // Reading the sentence above as "the map is empty" would make the guards
      // below look unreachable, and they are not.)
      //
      // The rule this is an instance of: a mechanism that deliberately moves
      // plaintext into a bag must also register that plaintext with everything
      // that masks. Moving the value and not the metadata is its own defect
      // class.
      //
      // THREE conditions, each removing a different way of being wrong:
      //
      //  - `isWholeDynamicReference(value)` — the map's VALUE is what
      //    `redactSecretsForState` substitutes IN, so it must be an expression
      //    and nothing else. On a MIXED leaf
      //    (`user:{{secretsmanager:...}}@{{ssm-secure:...}}`) the send string is
      //    already PARTIALLY RESOLVED, so registering it whole would write the
      //    secretsmanager half's plaintext into state — the GHSA class, through
      //    the mechanism that exists to prevent it. That half is already
      //    covered by its own map entry from the value scan.
      //  - `isSecretBySpelling(value)` — the same rule the path marking uses
      //    one function up. Registering a look-alike spelling's live value
      //    makes a redaction NEEDLE out of ordinary data.
      //  - the needle floor — `redactSecretsForState`'s whole-value branch
      //    matches at ANY length, so a live `"1"` or `"prod"` would rewrite
      //    every unrelated delta leaf equal to it into this token: the #1904
      //    wrong-reference corruption, after which the next deploy ships the
      //    literal token to AWS.
      //
      // A non-string live value is NOT registered, and is NOT reachable by the
      // position pass either — `redactByPath`'s expression arm requires a
      // string on both sides, so an object or a number lands in the value scan
      // with no entry. It is still copied, because the alternative is sending
      // the token over a live value; it is a stated residual, unmaskable if the
      // provider later echoes it CHANGED.
      // The whole-token condition is NOT repeated here: the gate above already
      // returned for anything else, so a second copy would be a line no
      // mutation can red.
      //
      // Two degenerate cases, both left alone deliberately. For a
      // cdkd-DEPLOYED record `live === value`, so the entry is `token -> token`
      // and every substitution it can drive is the identity. And `set`
      // overwrites when a secretsmanager secret and an ssm-secure parameter
      // share a value — in which case both expressions resolve to that same
      // value, so either substitution is correct.
      if (
        typeof live === 'string' &&
        live.length >= MIN_SECRET_NEEDLE_LENGTH &&
        isSecretBySpelling(value)
      ) {
        secrets.set(live, value);
      }
      return live;
    }
    if (Array.isArray(value)) {
      const liveItems = Array.isArray(live) && live.length === value.length ? live : undefined;
      return value.map((item, i) => walk(item, liveItems?.[i]));
    }
    if (value !== null && typeof value === 'object') {
      const liveObject = isPlainRecord(live) ? live : undefined;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = walk(v, liveObject?.[k]);
      }
      return out;
    }
    return value;
  };
  return walk(send, awsProperties) as Record<string, unknown>;
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
  // Issue #1914 (minor): counted apart from `totalFailed`, whose summary line
  // calls every entry an "AWS update failure". A resource cdkd could not
  // re-resolve never reached `provider.update` at all, and telling the user to
  // look at an update that did not happen sends them to the wrong place.
  let totalUnresolvable = 0;

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
    // Issue #1914: one resolver per stack, re-resolving the secret expressions
    // the state baseline stores so the provider is handed the concrete value.
    // Deliberately NOT the drift-detection run's map: that one is keyed
    // plaintext -> expression (the redaction direction), and a revert needs the
    // resolution direction, against AWS as it is NOW rather than as it was when
    // the report was built.
    const revertSecretResolver = new IntrinsicFunctionResolver(report.region);
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
        //
        // NOT guarded, deliberately (issue #1914 review): a registry lookup
        // that throws here cannot happen, because DETECTION performs the same
        // lookup with the same inputs and routes a failure to an `unsupported`
        // outcome — such a resource never becomes `drifted` and never reaches
        // this loop. A catch here would be an arm no mutation can red, which is
        // worse than none. The payload build below IS guarded, because that one
        // is reachable: `readCurrentState` is provider-authored and its output
        // is not vetted.
        const provider: ResourceProvider = providerRegistry.getProviderFor({
          resourceType: outcome.resourceType,
          provisionedBy: stateResource.provisionedBy,
        }).provider;
        // The baseline drift was computed against — `observedProperties`
        // when present, else `properties` — is the right "desired" value
        // to push back to AWS. Using `properties` alone would push the
        // last-deployed template intent and miss any AWS-side defaults
        // we captured at deploy time but never wrote into the template.
        //
        // Issue #1914: RE-RESOLVED before it is handed to the provider. State
        // stores a secret dynamic reference as its unresolved
        // `{{resolve:...}}` expression (GHSA-p5qg-v9gv-hc7w), so the bag as
        // read is not something AWS can be given — pushing it back set the
        // live property to the literal token, corrupting whatever consumes it
        // (a Lambda env var, a Cognito `client_secret`). This is the rollback
        // replay's `resolveReplayProps` on the second synth-free write path.
        // A bag with no dynamic reference resolves to itself by identity.
        const secrets: RecordedSecretValues = new Map();
        const revertBaseline = stateResource.observedProperties ?? stateResource.properties ?? {};
        // No `secretPaths` here, deliberately: nothing on this path masks by
        // position. What a revert PRINTS comes from `outcome.changes`, redacted
        // once at detection, and what it WRITES is redacted by value + position
        // against `revertBaseline` below.
        const unresolvedTokens = new Set<string>();
        const noteUnresolved = (tokens: string[]): void => {
          for (const token of tokens) unresolvedTokens.add(token);
        };
        let desiredProperties: Record<string, unknown>;
        try {
          desiredProperties = await resolveStateSecretExpressions(
            revertBaseline,
            revertSecretResolver,
            secrets,
            { onUnresolved: noteUnresolved }
          );
          // Mirrors the detection pass: `properties` are resolved into the same
          // map so a secret the OBSERVED baseline never captured is still a key
          // in it. Revert needs that for the narrowing write below, whose
          // position source can only reach leaves the two bags share.
          if (stateResource.observedProperties !== undefined) {
            await resolveStateSecretExpressions(
              stateResource.properties ?? {},
              revertSecretResolver,
              secrets,
              { onUnresolved: noteUnresolved }
            );
          }
        } catch (err) {
          // Reported per-resource rather than aborting the run, and with its
          // OWN message: 'AWS update failed' would be a lie — no update was
          // attempted, the reference the state record names could not be read.
          totalUnresolvable++;
          logger.error(
            `  ✗ ${report.stackName}/${outcome.logicalId} (${outcome.resourceType}): ` +
              `could not re-resolve the dynamic reference(s) this resource's state records — ` +
              `${maskSecretsInText(err instanceof Error ? err.message : String(err), secrets)}`
          );
          return;
        }
        // Issue #1914 (minor): `buildRevertNewProperties` keys the overlay on
        // each change's TOP-LEVEL segment, so a path whose first segment is
        // itself the mask matches nothing in the desired bag and the subtree is
        // silently not reverted — while the plan promised it and `--accept`'s
        // refusal pointed the user here. Say it instead.
        const unrevertablePaths = outcome.changes
          .map((c) => c.path)
          .filter((path) => (path.split('.', 1)[0] ?? '').includes(SECRET_MASK));
        if (unrevertablePaths.length > 0) {
          logger.warn(
            `  ! ${report.stackName}/${outcome.logicalId} (${outcome.resourceType}): cannot ` +
              `revert ${unrevertablePaths.join(', ')} — cdkd cannot name the property, so it is ` +
              `left as AWS has it. ROTATE the secret that leaked into the property name.`
          );
        }
        if (unresolvedTokens.size > 0) {
          // A warning, not a failure — failing would abandon every OTHER
          // drifted property on the resource and exit 2. The wording claims
          // neither that replaying the token is a no-op (true only for a record
          // cdkd deployed, false for a CFn-migrated one where CloudFormation
          // resolved the reference server-side) NOR that the live value is
          // always preserved: `preserveLiveValuesAtUnresolvedTokens` preserves
          // it only where the property's WHOLE value is the token, and declines
          // for an embedded one.
          logger.warn(
            // Deliberately worded so it cannot be confused with the
            // DETECTION-side warning, which names the same tokens: a test that
            // greps for the token alone is satisfied by either, so the two
            // messages must differ in more than punctuation.
            `  ! [revert] ${report.stackName}/${outcome.logicalId} (${outcome.resourceType}): ` +
              `cdkd cannot resolve ` +
              `${maskSecretsInText([...unresolvedTokens].join(', '), secrets)} — a property ` +
              `whose WHOLE value is one of these tokens is left UNCHANGED by this revert. Where ` +
              `a token is EMBEDDED in a longer string, that string is written with the token ` +
              `literal, exactly as 'cdkd deploy' does, so a resolved value AWS holds there is ` +
              `overwritten.`
          );
        }
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
        let newProperties: Record<string, unknown>;
        try {
          const overlaid = buildRevertNewProperties(
            outcome.changes,
            desiredProperties,
            outcome.awsProperties,
            { preserveUntemplated: stateResource.observedProperties === undefined }
          );
          // Issue #1914: a token cdkd could not resolve must never be WRITTEN
          // over whatever AWS holds — see the helper for why the "it is already
          // there" premise is false on a CFn-migrated record. Skipped entirely
          // when nothing survived, so the ordinary revert is byte-identical.
          newProperties =
            unresolvedTokens.size > 0
              ? preserveLiveValuesAtUnresolvedTokens(overlaid, outcome.awsProperties, secrets)
              : overlaid;
        } catch (err) {
          // Reachability note (issue #1914 review): this arm is narrower than
          // it looks, and is kept only because it is cheap. A bag so malformed
          // that `buildRevertNewProperties` cannot walk it — a self-referential
          // `readCurrentState` result, say — throws in DETECTION first, where
          // `calculateResourceDrift` walks the same bags, so the resource never
          // reaches this loop. What is left for it to catch is a provider whose
          // output the comparator tolerates and the merge does not. The
          // detection-side equivalent is NOT per-resource and aborts the run;
          // that is pre-existing and out of scope here.
          totalFailed++;
          logger.error(
            `  ✗ ${report.stackName}/${outcome.logicalId} (${outcome.resourceType}): ` +
              `could not build the revert payload — ` +
              `${maskSecretsInText(err instanceof Error ? err.message : String(err), secrets)}`
          );
          return;
        }
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
                //
                // `maskSecrets` (issue #1932 item 3) is the THIRD caller of the
                // provider masking contract, alongside `deploy-engine.ts` and
                // `rollback-executor.ts`, and it is not optional here: the bag
                // this call carries was re-resolved from state back to
                // PLAINTEXT a few hundred lines up (`resolveStateSecretExpressions`,
                // the counterpart of the rollback replay's `resolveReplayProps`),
                // so it provably holds the concrete secret whenever the resource
                // has one. Without it, a provider warning that names a
                // mis-shaped property value — e.g. a state record holding
                // `EnabledMfas: "{{resolve:secretsmanager:...}}"`, which
                // re-resolves to a plaintext string and so is `not a list` —
                // prints that plaintext on `cdkd drift --revert`.
                //
                // Bound to `secrets`, the SAME map `resolveStateSecretExpressions`
                // resolved into and the retry logger below masks with, so the
                // masker and that logger can never disagree about what this call
                // considers secret.
                { desiredFromAwsReadback: true, maskSecrets: createSecretMasker(secrets) }
              ),
            outcome.logicalId,
            // Issue #1914: the retry logger echoes the failing call's AWS error
            // verbatim, and this call's payload now carries RESOLVED secrets —
            // an AWS validation error routinely quotes the offending property
            // value. Same fence `deploy-engine.ts` puts on its own provider
            // calls. No-op when the op resolved no secret.
            // `warn` is threaded too (issue #2018): without it the
            // give-up summary for an exhausted IAM-propagation retry is
            // dropped on THIS path only, so `cdkd drift --revert` would keep
            // the pre-fix behavior of rethrowing the raw AWS error with no
            // sign that cdkd had retried for ~48s. It goes through the SAME
            // mask as `debug` rather than straight to `logger.warn` -- the
            // summary interpolates the AWS message verbatim, so an unmasked
            // forward would defeat the #1914 fence at a HIGHER log level than
            // the one that fence was written for.
            //
            // The object itself now comes from `masking-retry-logger.ts` — this
            // was one of three byte-identical eager copies (issue #2038).
            { logger: maskingRetryLogger(logger, secrets) }
          );
          totalSucceeded++;
          // Issue #1819: the revert landed, but the provider may have left
          // something behind (a replacement whose old resource survives). The
          // revert still counts as succeeded — the resource IS at the desired
          // state — so this annotates the line rather than failing it; dropping
          // the reason would put `drift --revert` back where the deploy path
          // was before the channel existed.
          const revertPartial = updatePartialReason(updateResult);
          if (revertPartial !== undefined) {
            logger.warn(
              `  ✓ ${report.stackName}/${outcome.logicalId} (${outcome.resourceType}): reverted, ` +
                `${maskSecretsInText(updatePartialMessage(revertPartial), secrets)}`
            );
          } else {
            logger.info(
              `  ✓ ${report.stackName}/${outcome.logicalId} (${outcome.resourceType}): reverted.`
            );
          }
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
                // Issue #1914: the delta is the provider's echo of a bag we
                // just resolved secrets INTO, and it is persisted below — so
                // this is a state-write surface, and fixing the revert without
                // it would have moved the disclosure rather than closed it.
                //
                // RESIDUAL, stated here because this is where it lands: cdkd
                // cannot mask a value for a reference it never RESOLVED. For an
                // unresolvable one (`ssm-secure`) the provider can echo its own
                // readback in `effectiveProperties`, and this write persists
                // that echo — with no map entry to match and, on a MIXED leaf,
                // no single token on the source side to position against
                // either. It is not created by this command's own bags (the
                // report masks by PATH, and the payload declines to copy a live
                // value into a mixed leaf), and before this pass existed the
                // delta was persisted with no redaction at all. Masking by SPAN
                // is issue #1935.
                //
                // Positioned against `revertBaseline` — the SAME bag
                // `desiredProperties` was resolved from — and not against
                // `properties`, which is a different bag whenever an observed
                // capture exists.
                //
                // `STATE_SOURCED_READBACK_RULES`, NOT the `STATE_DERIVED_RULES`
                // that `redactRollbackRecord` uses on its own echo. Both grant
                // `trustAnyExpression`, which is right here for the same reason
                // it is right there: a persisted record holds no PUBLIC
                // expression, so any `{{resolve:...}}` leaf in the source is by
                // construction a secret. They differ on ARRAY descent, and the
                // rollback's justification for it does not carry over. There
                // the whole bag descends from resolving the journaled one, so
                // the two have identical structure; here `collectNarrowedTopLevelKeys`
                // derives the delta from `newProperties`, which is
                // `buildRevertNewProperties`'s merge of the AWS-CURRENT
                // snapshot with the resolved desired subtrees — so a top-level
                // key that did not drift comes from AWS and may be reordered.
                // Positional descent over an equal-length, differently-ordered
                // array would write a sibling's expression onto the wrong
                // element: the #1904 wrong-reference class, on a write path.
                // Those leaves fall to the value scan instead, and TWO things
                // keep that scan complete rather than one: the
                // `properties`-side map completion above, and
                // `preserveLiveValuesAtUnresolvedTokens` registering every live
                // value it copied in. Without the second, a token nested in an
                // array — ECS `ContainerDefinitions[].Environment[]`, the shape
                // this advisory keeps landing in — reached neither pass and
                // landed in `state.json` as plaintext.
                narrowedByLogicalId.set(
                  outcome.logicalId,
                  // Since issue #1926 this rules constant ALSO runs the
                  // module's readback refusal, which substitutes a MIXED source
                  // leaf (a reference embedded in surrounding text) over the
                  // value this payload was about to persist. That is the right
                  // default here for the same reason it is elsewhere — the
                  // alternative is persisting a decrypted secret — but note
                  // this site has no equivalent of the `--accept` arm's
                  // post-write re-check above, so a leaf that a PUBLIC
                  // reference reached through `cdkd import`'s warn path is
                  // corrected silently rather than warned about. That case is
                  // NOT narrow here: the decline for an unrecorded plain `ssm:`
                  // token only holds with a POPULATED map, and `secrets` at this
                  // site stays empty for a resource carrying no secret
                  // reference -- which is the common shape. With an empty map
                  // the source expression silently wins (issue #2036).
                  redactSecretsForState(
                    delta,
                    secrets,
                    revertBaseline,
                    STATE_SOURCED_READBACK_RULES
                  )
                );
              }
            }
          } catch (captureErr) {
            logger.warn(
              `  ${report.stackName}/${outcome.logicalId} (${outcome.resourceType}): reverted, but ` +
                `the provider's reported effective properties could not be read — ` +
                `${maskSecretsInText(captureErr instanceof Error ? captureErr.message : String(captureErr), secrets)}`
            );
          }
        } catch (err) {
          // Distinguish "the AWS update failed" from "this resource type
          // does not support in-place update at all". The latter cannot be
          // fixed by retrying; the user has to redeploy with --replace.
          if (err instanceof ResourceUpdateNotSupportedError) {
            totalUnsupported++;
            logger.warn(
              `  ⊘ ${report.stackName}/${outcome.logicalId} (${outcome.resourceType}): could not revert — ${maskSecretsInText(err.message, secrets)}`
            );
            return;
          }
          totalFailed++;
          // Masked (issue #1914): this is the error from a call whose payload
          // carried resolved secrets, and AWS quotes the offending value.
          const msg = maskSecretsInText(err instanceof Error ? err.message : String(err), secrets);
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
  if (totalUnresolvable > 0) summaryParts.push(`${totalUnresolvable} reference-unresolvable`);
  if (totalFailed > 0) summaryParts.push(`${totalFailed} failed`);
  logger.info(`\nRevert summary: ${summaryParts.join(', ')}.`);

  if (totalUnsupported > 0) {
    logger.warn(
      `${totalUnsupported} resource(s) cannot be reverted in place — re-deploy the stack with cdkd deploy --replace, ` +
        `or destroy + redeploy to push the cdkd-state values back into AWS.`
    );
  }

  if (totalFailed > 0 || totalUnsupported > 0 || totalUnresolvable > 0) {
    throw new PartialFailureError(
      `Revert completed with ${totalFailed + totalUnsupported + totalUnresolvable} resource ` +
        `error(s) (${totalFailed} AWS update failure(s), ${totalUnsupported} ` +
        `update-not-supported, ${totalUnresolvable} whose dynamic reference(s) could not be ` +
        `resolved — those never reached provider.update; grant the caller ` +
        `secretsmanager:GetSecretValue / ssm:GetParameter, or fix the reference). ` +
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
        // Issue #1914: a `--dry-run` that promises a write the real run will
        // refuse is worse than either behaviour alone, so the plan asks the
        // same predicate `runAccept` does.
        const refusal = acceptRefusalReason(change, o.maskedPaths);
        if (refusal !== undefined) {
          process.stdout.write(`    ${change.path}: SKIPPED — ${refusal}\n`);
          continue;
        }
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
        // Issue #1914 (minor): these lists are masked with `o.secrets`, which
        // cannot answer for a reference cdkd never resolved — so a
        // secret-carrying key would print unmasked, exactly the case the
        // masking exists for. The offline path seed cannot help either: it
        // locates positions, and masking a KEY needs the VALUE. Suppress the
        // lists instead and say why.
        //
        // Keyed on `referencesUnresolved` rather than on an empty map: a
        // resource with one resolvable reference and one survivor has a
        // non-empty map that still cannot mask the survivor's position.
        const cannotMaskKeys = o.referencesUnresolved;
        if (cannotMaskKeys && preserved.length > 0) {
          process.stdout.write(
            `    ! ${preserved.length} AWS-authored tag(s) will be preserved, but cdkd could not ` +
              `resolve this resource's dynamic reference(s), so their names are withheld — they ` +
              `come from the live readback and cannot be checked for secrets without them.\n`
          );
        }
        if (!cannotMaskKeys && preserved.length > 0) {
          const tagWord = preserved.length === 1 ? 'tag' : 'tags';
          process.stdout.write(
            `    ! reverting this tag list KEEPS ${preserved.length} AWS-authored ` +
              `${tagWord} the baseline does not carry:\n`
          );
          for (const path of preserved) {
            // Issue #1914: these names are built from `o.awsProperties`, the
            // one bag on this path that is deliberately unredacted — so a
            // readback answering with a map KEYED by a secret would print the
            // plaintext here, the exact case `redactDriftChanges` masks for the
            // diff lines. Masked at the point of printing rather than at the
            // point of building, so the callers that use these lists as
            // KEY SETS keep the real keys.
            process.stdout.write(`        ${maskSecretsInText(path, o.secrets)}\n`);
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
        if (o.referencesUnresolved && unbaselined.length > 0) {
          // Same withholding as the tag list above, and it must say something:
          // silently skipping the block left the user with no signal at all.
          process.stdout.write(
            `    ! ${unbaselined.length} AWS-authored value(s) will be left untouched, but cdkd ` +
              `could not resolve this resource's dynamic reference(s), so their paths are ` +
              `withheld — they come from the live readback and cannot be checked for secrets ` +
              `without them.\n`
          );
        } else if (unbaselined.length > 0) {
          const word = unbaselined.length === 1 ? 'value' : 'values';
          process.stdout.write(
            `    ! this resource has no observed-capture baseline, so the revert ` +
              `pushes the raw TEMPLATE and LEAVES ${unbaselined.length} AWS-authored ${word} ` +
              `untouched:\n`
          );
          for (const path of unbaselined) {
            // Masked for the same reason as the preserved-tag list above.
            process.stdout.write(`        ${maskSecretsInText(path, o.secrets)}\n`);
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
