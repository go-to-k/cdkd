export interface ExportOptions {
  app?: string;
  output?: string;
  template?: string;
  cfnStackName?: string;
  /**
   * Per-nested-child CFn stack-name override. Each entry is
   * `<cdkdStackName>=<cfnStackName>`. The cdkd stack name for a nested
   * child is `<parent>~<childLogicalId>` (v6 state-key form). Without an
   * override, cdkd derives the CFn stack name via {@link cdkd2cfnStackName}
   * (replaces `~` with `-` since CFn stack names reject `~`). Repeatable.
   * See issue #464 design §9 Q8 for the rationale.
   *
   * Only consulted when the exported stack tree contains nested children;
   * for flat stacks the flag is ignored.
   */
  cfnChildStackName?: string[];
  stateBucket?: string;
  statePrefix: string;
  stackRegion?: string;
  region?: string;
  profile?: string;
  roleArn?: string;
  dryRun: boolean;
  yes: boolean;
  verbose: boolean;
  context?: string[];
  /**
   * Allow proceeding when the user passed CLI `-c key=value` overrides
   * that are not persisted to cdk.json / cdk.context.json. The default
   * is to refuse, because those CLI values are visible to cdkd's synth
   * but invisible to subsequent `cdk deploy` invocations — a different
   * template gets synthesized post-migration, which causes spurious
   * drift or replacement on the first `cdk deploy`.
   */
  acceptTransientContext: boolean;
  /**
   * When true and the stack contains resources that cannot be CFn-imported
   * (currently only `Custom::*` qualifies), run a 2-phase migration:
   *   Phase 1: IMPORT changeset for importable resources.
   *   Phase 2: UPDATE changeset for the full template — CFn CREATEs the
   *            non-importable resources fresh, invoking each
   *            `Custom::*`'s backing Lambda's onCreate handler.
   *
   * Default false: the command aborts with a clear error if any
   * non-importable resource is present, so users opt in to the
   * potential side effects (CR onCreate is re-run, which may not be
   * idempotent).
   */
  includeNonImportable: boolean;
  /**
   * `Key=Value` overrides for CFn template Parameters, repeatable. Used
   * when the synthesized template's Parameters section has entries
   * without `Default` values, or when the user wants to override a
   * default for the export.
   */
  parameter?: string[];
  /**
   * Refuse to export when another cdkd stack in the same CDK app
   * references the exporting stack via `Fn::GetStackOutput`. The default
   * is to warn but proceed (the user might be migrating consumer stacks
   * in a follow-up). With this flag set, any such reference aborts.
   */
  strictCrossStack: boolean;
  /**
   * Auto-handle `AWS::IAM::Policy` and any other resource type AWS does
   * NOT support in IMPORT changesets (no `read` handler in the CFn
   * schema) but DOES support normal CREATE for. Default true: cdkd
   * skips these from phase 1, deletes the AWS-side resource between
   * phases, and lets CFn re-CREATE in phase 2 — brief window in which
   * the resource is absent. When false, cdkd blocks the export with a
   * clear error instead.
   *
   * Commander parses `--no-recreate-import-unsupported` into
   * `recreateImportUnsupported: false`; the default (no flag) leaves
   * it `true`. See cdkd issue #307 for the design discussion.
   */
  recreateImportUnsupported: boolean;
  /**
   * Skip the registry-derived IMPORT-support pre-flight (issue
   * [#1659](https://github.com/go-to-k/cdkd/issues/1659)).
   *
   * The pre-flight refuses a type whose schema declares no `read` handler AND
   * reports `ProvisioningType: NON_PROVISIONABLE`. That is a HEURISTIC over the
   * registry, not AWS's actual supported-for-import list — it matched every
   * type measured (2026-08-13), but a type AWS later makes importable would be
   * hard-blocked by cdkd on an export that CloudFormation would accept, with
   * `blocked` aborting the whole run. The sibling
   * `IMPORT_UNSUPPORTED_RECREATABLE_TYPES` refusal has
   * `--no-recreate-import-unsupported`; this is its counterpart, so a wrong
   * heuristic costs a flag rather than a cdkd release.
   */
  skipImportSupportPreflight: boolean;
}

/**
 * Resource types that are known to be incompatible with CloudFormation
 * `ChangeSetType=IMPORT`:
 *
 *   - `AWS::CDK::Metadata` is a CDK sentinel; not a real AWS resource and
 *     CFn refuses to import it.
 *   - `AWS::CloudFormation::CustomResource` is the CFn resource type CDK
 *     emits for `new cdk.CustomResource(...)` when no `resourceType` is
 *     passed. Functionally identical to `Custom::*` — Lambda-backed,
 *     no AWS resource state to adopt — and AWS rejects it from IMPORT
 *     changesets with the same error.
 *   - `Custom::*` are Lambda-backed Custom Resources. CFn cannot adopt the
 *     custom-resource state — invocation history lives in the provider
 *     Lambda, not in AWS resource state, so there is nothing to import.
 *
 * `AWS::CloudFormation::Stack` is **intentionally NOT in this set** — it is
 * handled by a dedicated branch in {@link buildImportPlan} that routes the
 * row through the nested-stack tree walker (issue
 * [#464](https://github.com/go-to-k/cdkd/issues/464) PR B1). The CFn-side
 * `--include-nested-stacks` IMPORT changeset submission is tracked under
 * PR B2 — until that lands, the orchestrator hard-errors at submission
 * time with a clear pointer.
 *
 * The list is intentionally narrow, and stays hand-written because each member
 * is a cdkd / CDK construct rather than something the registry describes.
 *
 * It is NOT the only refusal, though — the "defer to the CreateChangeSet
 * error" note this comment used to end on was revisited in issue
 * [#1659](https://github.com/go-to-k/cdkd/issues/1659). Types AWS refuses for
 * IMPORT because their registry schema declares no `read` handler are now
 * caught by {@link buildImportPlan}'s pre-flight instead, which needs no
 * hand-maintained list (the signal is derived from the schema cdkd already
 * fetches for the identifier) and names every offender in one pass — AWS's own
 * error names only some of them.
 */
const NEVER_IMPORTABLE_TYPES = new Set<string>(['AWS::CDK::Metadata']);

/**
 * Per-non-root-child lock-acquisition retry budget for the nested-stack
 * export loop (`runPerStackImportLoop`). `acquireLockWithRetry` retries
 * `maxRetries` times with `retryDelay` between attempts, so the total wait
 * ceiling is `maxRetries * retryDelay` ≈ 30s. A genuinely-active concurrent
 * cdkd run on a child is awaited briefly instead of failing instantly;
 * `acquireLock`'s own expired-lock auto-cleanup (30-min TTL) covers the
 * crashed-previous-run case. 30s keeps an interactive `cdkd export` snappy
 * even across a multi-level tree (each child waits at most this ceiling).
 */
export const CHILD_LOCK_RETRY_MAX_ATTEMPTS = 6;
export const CHILD_LOCK_RETRY_DELAY_MS = 5000;

export function isNeverImportableType(resourceType: string): boolean {
  if (NEVER_IMPORTABLE_TYPES.has(resourceType)) return true;
  if (isCustomResourceType(resourceType)) return true;
  return false;
}

/**
 * Both `Custom::*` and `AWS::CloudFormation::CustomResource` denote
 * Lambda-backed Custom Resources. CDK emits the latter when
 * `new cdk.CustomResource(...)` is constructed without a `resourceType`;
 * users who supply one get `Custom::<Name>`. Both go through the
 * phase-2 CREATE path in `cdkd export`.
 */
function isCustomResourceType(resourceType: string): boolean {
  return (
    resourceType === 'AWS::CloudFormation::CustomResource' || resourceType.startsWith('Custom::')
  );
}

export interface ImportPlanEntry {
  logicalId: string;
  resourceType: string;
  physicalId: string;
  /**
   * The `ResourceIdentifier` map CFn IMPORT expects in `ResourcesToImport[].ResourceIdentifier`.
   * Single-key types have a one-entry object (`{ BucketName: 'my-bucket' }`); composite types
   * have one entry per `primaryIdentifier` field (`{ RestApiId: '...', ResourceId: '...' }`).
   */
  resourceIdentifier: Record<string, string>;
  /**
   * Subset of `resourceIdentifier` to also write into the synth template's
   * `Properties` block (so CFn IMPORT's identifier-match check passes
   * against the cdkd-prefixed physical id). When omitted, defaults to the
   * full `resourceIdentifier` map at the overlay site. Sub-resource types
   * whose primaryIdentifier includes an AWS-generated, `readOnlyProperties`
   * field (e.g. `AWS::ApiGatewayV2::Integration.IntegrationId`) narrow
   * this to just the writable subset, so CFn IMPORT doesn't reject the
   * changeset on a read-only-property write.
   */
  propertiesOverlay?: Record<string, string>;
}

/**
 * Entry in the "delete from AWS before phase-2 UPDATE so CFn can re-CREATE
 * fresh" list. Used for resource types AWS does NOT support in IMPORT
 * changesets but DOES support normal CREATE for — currently just
 * `AWS::IAM::Policy` (no `read` handler), which CDK auto-emits for L2
 * grants.
 *
 * The flow: phase-1 IMPORT skips these resources entirely. Between
 * phase 1 and phase 2, cdkd issues a per-type SDK delete call against
 * the AWS-side resource. Phase 2 then sees the resource in the full
 * synth template and CFn CREATEs it fresh. There IS a brief window
 * between the SDK delete and CFn's CREATE in which the resource is
 * absent.
 *
 * Tracked design discussion: cdkd issue #307.
 */
export interface RecreateBeforePhase2Entry {
  logicalId: string;
  resourceType: string;
  physicalId: string;
  /** cdkd state's recorded properties — supplies parent identifiers (ApiId, etc.) to the SDK delete call. */
  properties: Record<string, unknown>;
  /**
   * For an `AWS::IAM::Policy`: the recorded principals the pre-delete detaches
   * that the template names only through a value cdkd cannot resolve, so it
   * cannot confirm phase 2 re-attaches them (go-to-k/cdkd#3910). Every other
   * recorded principal IS a template principal: `buildImportPlan` blocks one
   * that is not.
   */
  unconfirmedPrincipals?: Array<{ kind: 'role' | 'user' | 'group'; name: string }>;
  /**
   * For an `AWS::IAM::Policy`: the template's `PolicyName` is not a literal,
   * so cdkd cannot confirm phase 2 re-creates the policy under the recorded
   * name (go-to-k/cdkd#3910).
   */
  policyNameUnconfirmed?: boolean;
}

/**
 * Resource types AWS does NOT support in IMPORT changesets but DOES
 * support normal CREATE for. cdkd handles these via a pre-delete + phase-2
 * CREATE dance (see {@link RecreateBeforePhase2Entry}). When the user
 * passes `--no-recreate-import-unsupported`, resources of these types
 * are hard-blocked instead with a clear error message.
 *
 * Verified via `aws cloudformation describe-type --type RESOURCE
 * --type-name <T> | jq .handlers` — types with `handlers: []` (or a
 * missing `read` / `list` handler that prevents CFn from looking the
 * resource up by identifier) are candidates. Currently registered:
 * `AWS::IAM::Policy` (no `read` / `list` — inline policy attachments have
 * no first-class AWS resource id). See the per-entry comment for each
 * addition. A type leaves this list once CloudFormation imports it:
 * `AWS::ApiGatewayV2::Stage` did, and is now an ordinary
 * `COMPOSITE_ID_SPLITTERS` import (issue #1772).
 */
export const IMPORT_UNSUPPORTED_RECREATABLE_TYPES: ReadonlySet<string> = new Set([
  // AWS::IAM::Policy — `handlers: ['create', 'delete', 'update']` (no `read`/
  // `list`). Inline policies attached to roles / users / groups don't have a
  // first-class AWS resource id, so CFn IMPORT can't look them up. cdkd's
  // own IAMPolicyProvider issues `iam:PutRolePolicy` / `PutUserPolicy` /
  // `PutGroupPolicy` per attachment target; CFn phase-2 CREATE uses the
  // exact same APIs, so pre-delete + phase-2-CREATE round-trips cleanly.
  // CDK auto-emits this type for L2 grants (ECS Task Execution Role
  // ECR pull policy, Lambda execution role inline policies, etc.).
  'AWS::IAM::Policy',
]);

/**
 * Returns true if cdkd treats the resource type as "AWS doesn't support
 * IMPORT but does support CREATE" — handled via pre-delete + phase-2-CREATE
 * (see {@link IMPORT_UNSUPPORTED_RECREATABLE_TYPES}). Exported for unit tests
 * and for ad-hoc inspection.
 */
export function isImportUnsupportedRecreatableType(resourceType: string): boolean {
  return IMPORT_UNSUPPORTED_RECREATABLE_TYPES.has(resourceType);
}

export interface BlockedResource {
  logicalId: string;
  resourceType: string;
  reason: string;
  /**
   * The gated command a `Repair with:` line runs, built only by
   * `importRepairCommand` or `deployRepairCommand`. It travels OUTSIDE `reason` because
   * `groupBlockedReasons` folds every control character out of a reason, so
   * no NEWLINE in an interpolated value can start a line; the one labelled
   * line a row may carry is the renderer's own (go-to-k/cdkd#3736). Padding
   * that wraps on screen inside a reason is go-to-k/cdkd#3760's.
   */
  repair?: string;
  /**
   * The reason names its own check and NO command is safe to suggest: the
   * generic "destroy them first, or remove them from the CDK app" must not be
   * said of this row either, since a destroy or a removal deploy performs the
   * very operation the row refuses (go-to-k/cdkd#3910). Rendered by
   * {@link blockedMigrationTail}.
   */
  manual?: true;
  /**
   * A read-only command to run BEFORE `repair`, rendered as its own labelled
   * `Check first with:` line ahead of `Repair with:` (go-to-k/cdkd#3910): the
   * deploy repair performs the same detach the row refuses, so the diff that
   * shows it comes first.
   */
  checkFirst?: string;
}

/**
 * A resolver refusal that carries a repair command, so the `buildImportPlan`
 * catch can move it into {@link BlockedResource.repair} instead of the
 * message text.
 */
export class RepairableRefusal extends Error {
  readonly repair: string;

  constructor(message: string, repair: string) {
    super(message);
    this.name = 'RepairableRefusal';
    this.repair = repair;
  }
}

/**
 * A resource that the 2-phase flow will CREATE in phase 2 (not import in
 * phase 1). Currently only `Custom::*` qualifies — CFn cannot adopt
 * custom-resource state, so the only way to make CFn aware of them is to
 * have it CREATE the resource fresh (which re-invokes the backing Lambda's
 * onCreate handler).
 */
export interface Phase2CreateEntry {
  logicalId: string;
  resourceType: string;
}

/**
 * Returns true when a resource type is non-importable BUT can be handled
 * by the phase-2 CREATE path. Today this is exactly `Custom::*` and the
 * untyped CDK form `AWS::CloudFormation::CustomResource` (both are
 * Lambda-backed Custom Resources whose backing Lambda is itself in the
 * same stack and gets imported in phase 1).
 *
 * `AWS::CloudFormation::Stack` (nested stacks) is intentionally NOT in
 * this set: CFn would CREATE a duplicate nested stack rather than adopt
 * the existing one, which would conflict with whatever the cdkd state
 * thought it owned. Nested-stack rows are handled by a dedicated branch
 * in {@link buildImportPlan} (issue
 * [#464](https://github.com/go-to-k/cdkd/issues/464) PR B1) that routes
 * the row to the cdkd-state-side tree walker. The CFn-side
 * `--include-nested-stacks` IMPORT changeset submission lands in PR B2.
 *
 * Exported for unit testing.
 */
export function isPhase2CreatableType(resourceType: string): boolean {
  return isCustomResourceType(resourceType);
}
