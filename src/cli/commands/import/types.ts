import { ProviderRegistry } from '../../../provisioning/provider-registry.js';
import type { TemplateResource } from '../../../types/resource.js';

export interface ImportOptions {
  app?: string;
  output?: string;
  stateBucket?: string;
  statePrefix: string;
  region?: string;
  profile?: string;
  roleArn?: string;
  resource?: string[];
  resourceMapping?: string;
  resourceMappingInline?: string;
  /**
   * If set, write the resolved `{logicalId: physicalId}` map for every
   * `imported` outcome to this path before the confirmation prompt.
   * Mirrors upstream `cdk import --record-resource-mapping <file>`. The
   * file is written even if the user says "no" to the prompt — the data
   * was resolved either way and is useful for re-runs.
   */
  recordResourceMapping?: string;
  /**
   * When true, resources NOT in `--resource` / `--resource-mapping` still
   * go through auto-resolution. Default is `false` for CDK CLI parity:
   * when explicit overrides are supplied, only those resources are imported
   * and the rest are skipped (left for the next deploy to create). Pass
   * `--auto` to opt back into hybrid mode (current pre-PR behavior).
   *
   * No-flag invocation (`cdkd import MyStack`) always auto-imports
   * everything via tags — this flag only matters once at least one of
   * `--resource` / `--resource-mapping` is also supplied.
   */
  auto: boolean;
  dryRun: boolean;
  yes: boolean;
  force: boolean;
  verbose: boolean;
  context?: string[];
  /**
   * Retire the named CloudFormation stack: inject `DeletionPolicy: Retain` +
   * `UpdateReplacePolicy: Retain` on every resource via UpdateStack, write cdkd state from the physical ids
   * the stack holds once that update completes, then DeleteStack. AWS
   * resources are left intact (now solely managed by cdkd). Pass `true` to use the cdkd
   * stack name as the CFn stack name (the common case for CDK-deployed
   * stacks); pass a string to override when the CFn stack name differs.
   */
  migrateFromCloudformation?: boolean | string;
  /**
   * Issue #1002 PR 2 — pin legacy asset destinations (skip the cdkd
   * asset-storage rewrite) for this invocation. See design §4.2.
   */
  useCdkBootstrapAssets?: boolean;
}

/**
 * Outcome category for one logicalId, used to summarise the run.
 *
 * `imported` — resource found and added to state.
 * `skipped-no-impl` — provider doesn't implement `import`.
 * `skipped-not-found` — provider returned `null` (no matching AWS resource).
 * `skipped-out-of-scope` — explicit-override mode and this resource was not
 *    listed; user opted not to import it. Kept distinct from
 *    `skipped-not-found` because it doesn't reflect AWS state.
 * `failed` — provider threw; logged but lets the rest of the stack proceed.
 */

export type ImportOutcome =
  | 'imported'
  | 'skipped-no-impl'
  | 'skipped-not-found'
  | 'skipped-out-of-scope'
  | 'failed';

export interface ImportRow {
  logicalId: string;
  resourceType: string;
  outcome: ImportOutcome;
  physicalId?: string;
  reason?: string;
  /**
   * Provider-returned attribute snapshot for `Fn::GetAtt` resolution
   * (issue #1098). Populated only on the `imported` outcome, and only when
   * the provider's `import()` returned an `attributes` map — providers that
   * omit it leave this `undefined` and the state row keeps `{}`.
   *
   * Persisting it makes an adopted resource state-shape-identical to one
   * created by `cdkd deploy`, which already stores a create-time attribute
   * snapshot. Same staleness class as deploy, not a new one.
   */
  attributes?: Record<string, unknown>;
  /**
   * The layer whose provider read the resource (go-to-k/cdkd#4706): `cc-api`
   * when Cloud Control imported it (a type with no SDK provider), `sdk`
   * otherwise. Recorded as the state record's `provisionedBy`, so the record
   * says what a fresh deploy of the type would. Absent on a row no provider
   * imported (a nested stack), which records `sdk`.
   */
  provisionedBy?: 'sdk' | 'cc-api';
  /**
   * What the `Import plan:` listing prints for `physicalId` (go-to-k/cdkd#3869):
   * `***` where the id spells a name taken from a secret, as `cdkd destroy`'s
   * listings do (go-to-k/cdkd#4811). Absent when the id prints as it is. Display
   * only: the record and the resource mapping keep `physicalId`.
   */
  physicalIdShown?: string;
}

/**
 * What {@link resolveImportedProperties} refused, as ONE value (issue #3462).
 *
 * It is still the set of logical ids whose observed baseline must not be
 * captured — every existing reader calls `.has()` — and it additionally carries
 * the two facts `captureObservedForImportedResources` needs to write, keep or
 * clear `ResourceState.observedBaselineRefusalReason`. They travel ON the set
 * rather than beside it, and the capture's parameter is THIS type, so a call
 * site that copies the ids into a plain `Set` — dropping both facts, and with
 * them the reason every deploy-side guard keys on — does not compile.
 */
export class ObservedBaselineRefusals extends Set<string> {
  /**
   * The subset ARM 4 named — directly, through an attribute read, or as an
   * unclassifiable bag — whether or not another arm refused it too.
   */
  readonly unverifiableParameter = new Set<string>();
  /**
   * Whether this run HAD deployed parameter values to compare against. Only
   * then does "ARM 4 did not name it" mean the placeholder was PROVEN; without
   * a source it means nothing was judged at all.
   */
  hadDeployedParameterSource = false;
}

export interface ImportTask {
  logicalId: string;
  resource: TemplateResource;
  stackName: string;
  region: string;
  providerRegistry: ProviderRegistry;
  override: string | undefined;
  /**
   * Full overrides map for this import run — used to pre-resolve `{Ref: <X>}`
   * intrinsics in `resource.Properties` against earlier-imported (or
   * CFn-pre-populated) physical IDs before the per-resource `provider.import()`
   * is called. See {@link substituteOverrideRefs} and issue #361 for the
   * canonical case (`AWS::SQS::QueuePolicy` under
   * `--migrate-from-cloudformation`).
   */
  overrides: Map<string, string>;
}

/** Per-filter counts from {@link mergeCfnDerivedOverrides}. */
export interface CfnOverrideMergeStats {
  /** Entries actually seeded into `overrides` by this merge. */
  derived: number;
  /** CFn rows whose logical ID is not an importable template resource (e.g. `AWS::CDK::Metadata`). */
  skippedNonImportable: number;
  /** CFn rows for `AWS::CloudFormation::Stack` resources (handled separately). */
  skippedNestedStackRow: number;
  /** CFn rows that survived both filters but were already in `overrides` (user-supplied wins). */
  overriddenByUser: number;
}
