import type { MovedTo, RefactorSides } from '../../../analyzer/refactor-hints.js';
import type { NoEchoMacCache } from './noecho-macs.js';
import type { MacWriteOnlyLookups } from '../../../deployment/deploy-engine/update/noecho-macs.js';
import type { CloudFormationTemplate } from '../../../types/resource.js';
import type { ResourceChange, ResourceState, StackState } from '../../../types/state.js';
import type { CanonicalizePropertiesFn } from '../../../analyzer/diff-calculator.js';
import type { ProducerLookup } from '../../../deployment/intrinsic-resolver/cdk-cross-account-ref.js';
import type { OutputChange } from '../../../analyzer/outputs-diff.js';
import type { RecordedSecretValues } from '../../../deployment/secret-redaction.js';
import type { StateNamingSecrets } from '../../../deployment/secret-name-needles.js';
import type { StaleAttributeHealer } from '../../../deployment/stale-attribute-heal.js';
import type { DestructiveChange } from '../../../analyzer/destructive-changes.js';
import type { SecurityDiff } from '../../../analyzer/security-diff.js';
import type { LockRecoveryContext } from '../../../state/lock-contention-message.js';
import type { ReferenceProvenance } from '../../../types/state.js';

/**
 * One node in the recursive `cdkd diff --recursive` tree (issue
 * [#555](https://github.com/go-to-k/cdkd/issues/555) A5).
 *
 * The root is the user-named top-level stack; every nested
 * `AWS::CloudFormation::Stack` row becomes a child node whose own diff is
 * computed against its deployed cdkd state file at
 * `cdkd/<parent>~<childLogicalId>/<region>/state.json`. Grandchildren
 * recurse the same way. Children are ordered DFS (template order first,
 * then state-only DELETE branches) so deep trees stay scannable top-down.
 */
export interface DiffTreeNode {
  /**
   * cdkd state stack name. For the root this is the physical CloudFormation
   * stack name; for a nested child it is the v6 state-key form
   * `<parent>~<childLogicalId>` (matching what `NestedStackProvider.create`
   * and the recursive `cdkd import` walk write).
   */
  stackName: string;
  /**
   * Header label rendered as `Nested stack: <displayName>`. Mirrors the A4
   * `state show --show-nested` convention of showing the full `~`-joined
   * state name so the parentage is unambiguous. Equal to `stackName`.
   */
  displayName: string;
  /** Region of this node's state record (children inherit the parent's region). */
  region: string;
  /** Per-resource changes for this node (includes `NO_CHANGE` entries — filter with {@link nodeHasChanges}). */
  changes: Map<string, ResourceChange>;
  /**
   * {@link StackDiffResult.securityDiff}: `--fail-on=broadening` only. Every
   * node `buildDiffTree` makes carries it; optional only for hand-built nodes.
   */
  securityDiff?: () => Promise<SecurityDiff>;
  /**
   * Per-resource Cloud Control API auto-route hits (issue [#614]). Maps each
   * logical ID that #614's auto-fallback would route via CC API to the
   * SDK-unwired property names that triggered the routing — surfaced as
   * `[via CC API: Body]` annotations on each diff line so users can
   * audit the routing decision before they deploy. Empty for stacks whose
   * template uses no SDK-unwired top-level property, for state-only DELETE
   * branches (deletes route via the recorded `provisionedBy`, not via template
   * inspection), and for a type with no Cloud Control route (issue #5600).
   */
  ccApiRoutes: Map<string, string[]>;
  /**
   * DELETE rows a `cdkd refactor` would keep, and where each reappears
   * (go-to-k/cdkd#5203). Set by `cdkd diff` on the stacks it selected, once
   * every tree is built; absent elsewhere.
   */
  refactorHints?: ReadonlyMap<string, MovedTo>;
  /**
   * This stack's rows a `cdkd refactor` could pair (go-to-k/cdkd#5203), set
   * only where that command would plan the stack: a top-level stack with a
   * cdkd record and nothing `blocking`, rollback-orphan ids left out.
   */
  refactorSides?: RefactorSides;
  /**
   * Per-key changes to this node's persisted `Outputs` bag (issue #1921).
   *
   * Empty when the Outputs section is unchanged AND when any output could not
   * be resolved — see {@link resolveTemplateOutputs}. Only real changes are
   * carried (there is no `NO_CHANGE` member), so a non-empty array always means
   * the next deploy would write outputs, which is what makes an Outputs-ONLY
   * change reach {@link nodeHasChanges} instead of printing "No changes
   * detected" while the apply republishes the exports index.
   */
  outputChanges: OutputChange[];
  /**
   * Logical ids this node's diff read out of a rollback-orphan record rather
   * than out of `resources` (issue go-to-k/cdkd#2943). Their rows are ordinary
   * UPDATE / NO_CHANGE rows and carry an annotation.
   */
  adoptedOrphans: string[];
  /**
   * Reasons `cdkd deploy` would refuse THIS node (issue go-to-k/cdkd#2943).
   * Rendered after the rows, and non-empty anywhere in the tree makes
   * `cdkd diff` exit non-zero — the preview is complete, but the deploy it
   * describes cannot start.
   */
  blocking: string[];
  /**
   * What this node's state record holds that the diff could NOT read
   * (go-to-k/cdkd#3018), in THREE fields, one per kind of thing dropped:
   * this one holds the logical id of each unreadable `resources` entry,
   * {@link unreadableContainers} each container that is unreadable as a whole,
   * and {@link unreadableOrphans} each rollback-orphan record (`orphans[]`) the
   * adoption preview could not read as a resource.
   *
   * Three fields rather than one string list because a container carried as a
   * stand-in string is a spelling an entry can imitate (go-to-k/cdkd#3339): an
   * entry keyed `(resources map)` read exactly like an unreadable map, and an
   * orphan record with no id exactly like an entry keyed `''`. Every string
   * here is a key the record itself holds.
   *
   * The load drops the entries and containers so the rest of the stack can be
   * diffed; `computeStackDiff` drops the orphan records before the preview,
   * which throws on a `null` or `undefined` `state` or a `null` record and
   * silently keeps the other shapes. A dropped row the template still declares
   * then previews as a CREATE, but one the TEMPLATE no longer declares reaches
   * no change at all — it would lose its DELETE row and let `--fail` exit 0
   * over a record that used to crash. Counted by {@link nodeHasChanges} for
   * that reason, rendered as one block, and always present in `--json`.
   */
  unreadable: string[];
  /** The containers of this node's record that are unreadable as a whole — see {@link unreadable}. */
  unreadableContainers: UnreadableContainer[];
  /**
   * The rollback-orphan records the adoption preview dropped, by `logicalId`,
   * `null` for one with no string `logicalId` — see {@link unreadable}.
   */
  unreadableOrphans: Array<string | null>;
  /**
   * The rows of {@link changes} that replace, delete or orphan an existing
   * resource (`findDestructiveChanges`), classified against the same state the
   * diff read. Drives `--fail-on=destructive`.
   */
  destructiveChanges: DestructiveChange[];
  /** Direct nested-stack children, DFS order. Empty for leaves and for non-recursive runs. */
  children: DiffTreeNode[];
}

/**
 * `ProviderRegistry.ccRouteUnavailableReason`: why the Cloud Control auto-route
 * cannot serve a type, or `undefined` when it can (issue #5600).
 */
export type CcRouteUnavailableReason = (resourceType: string) => string | undefined;

/**
 * A state-record container `cdkd diff` could not read at all and read as empty
 * (go-to-k/cdkd#3339): the `resources` map, or the `orphans` list. Listed in
 * the order the load checks them, which is the order the preview names them.
 */
export type UnreadableContainer = 'resources' | 'orphans';

/** What one stack's diff yields: its per-resource changes plus its Outputs delta. */
export interface StackDiffResult {
  /** Per-resource changes, including `NO_CHANGE` entries. */
  changes: Map<string, ResourceChange>;
  /**
   * `--fail-on=broadening` (go-to-k/cdkd#4601): this stack's security diff,
   * computed only when called. It reads the UNMASKED changes (the verdict
   * must see what the deploy sends) and renders through this node's printing
   * mask; nothing else of the unmasked changes leaves this function.
   */
  securityDiff: () => Promise<SecurityDiff>;
  /** Per-key Outputs changes (issue #1921); empty when unchanged or unresolvable. */
  outputChanges: OutputChange[];
  /**
   * Logical ids this diff treated as ALREADY IN STATE because a rollback
   * orphan record was verified and spliced in (issue go-to-k/cdkd#2943).
   *
   * The rows for these are ordinary UPDATE / NO_CHANGE rows — the splice is
   * what makes them so — and carry an annotation, because a user who last saw
   * this resource fail and drop out of state would otherwise read the update
   * as cdkd having silently kept it.
   */
  adoptedOrphans: string[];
  /**
   * The adopted records themselves, keyed by logical id (issue
   * go-to-k/cdkd#2943).
   *
   * Returned alongside the names because `buildDiffTree` has two consumers
   * that read `resources` AFTER the diff and must see the same state the diff
   * saw: `collectCcApiRoutes` reads `provisionedBy` for the sticky-CC
   * annotation, and `resolveChildStackParameters` resolves a nested child's
   * `Parameters` against the parent's records. Handing them the un-spliced
   * state made an adopted `cc-api` row print without its routing annotation
   * and made a child parameter referencing an adopted resource drop silently.
   */
  adoptedRecords: Record<string, ResourceState>;
  /**
   * Reasons `cdkd deploy` would REFUSE, in its own words (issue
   * go-to-k/cdkd#2943). Non-empty means the deploy this preview describes
   * cannot start at all.
   *
   * Carried rather than thrown: `deploy` stops at the refusal because there is
   * nothing left to do, while a preview that dies before printing is a preview
   * that cannot be used to decide anything. So `cdkd diff` renders everything
   * it learned and reports these at the end.
   */
  blocking: string[];
  /**
   * Deploy refusals this node's ADOPTED records carry (go-to-k/cdkd#3335): a
   * spliced rollback-orphan record whose `properties` map this diff repaired
   * and `cdkd deploy` refuses. Separate from `blocking` because it is
   * TOP-LEVEL only — see `buildDiffTree`, which is where the gate lives.
   */
  deployRefusals: string[];
  /**
   * Rollback-orphan records (`orphans[]`) the adoption preview could not read
   * as a resource, dropped BEFORE the preview because it throws on one, and
   * carried here so `buildDiffTree` can put them on the node's
   * `unreadableOrphans` — `null` for a record with no string `logicalId`. Empty
   * when the stack holds no orphan records or no preview was supplied.
   */
  unreadableOrphans: Array<string | null>;
  /**
   * The template this diff ran against: condition-false rows pruned, as the
   * deploy engine prunes them. A caller walking this node's resources after
   * the diff reads THIS, not the raw template, or it treats a row the deploy
   * DELETEs as live (go-to-k/cdkd#3815).
   */
  effectiveTemplate: CloudFormationTemplate;
  /**
   * This node's PRINTING corpus (go-to-k/cdkd#4049), already applied to
   * `changes` and `outputChanges`: its `NoEcho` parameter values, what its diff
   * resolver recorded, and what it inherited. A nested child inherits it, since
   * a parent's `NoEcho` value reaches the child through a parameter the child
   * need not declare `NoEcho`.
   */
  printingSecrets: RecordedSecretValues;
  /**
   * The MASK-ONLY derived-name needles this node printed with
   * (go-to-k/cdkd#3869): what its readers read from a secret-named resource,
   * plus what it inherited. Never part of {@link printingSecrets}; a deleted
   * child's stored values are masked with it.
   */
  derivedNames: RecordedSecretValues;
  /**
   * The MASK-ONLY needles of every record of this node named from a secret
   * (go-to-k/cdkd#3869), adopted orphan records included and judged with the
   * stack's whole `NoEcho` values as they stood before the walk (never an
   * `Fn::Split` fragment the resolver recorded since): a nested child's stored values can hold a name this
   * node's row used to pass, which no read of the child's walk names. Never
   * part of {@link printingSecrets}.
   */
  secretNamedRecords: RecordedSecretValues;
  /**
   * The per-record judging bags over a map of this node's records
   * (go-to-k/cdkd#3869): the node's `NoEcho` values plus what each record
   * stores at a `NoEcho` position. For a heal that binds its printing bag
   * outside this call (a nested row's `Parameters` pass). Printing only.
   */
  namingSecretsFor: (resources: Readonly<Record<string, ResourceState>>) => StateNamingSecrets;
  /**
   * The parameter bag and the condition verdicts this node's resolver used
   * (go-to-k/cdkd#4094), for resolving a nested child's input `Parameters`
   * the way the deploy does: against the parent's BOUND parameters (template
   * defaults and SSM-typed lookups included) and its evaluated conditions, not
   * only the parameters handed to this node. A failed binding returns the
   * input bag (undefined at the root); a skipped condition evaluation returns
   * undefined.
   *
   * UNMASKED, unlike `changes` / `outputChanges`: a `NoEcho` parameter's bound
   * value is here as the resolver needs it. It feeds resolution only; a line
   * printing a value derived from it is masked by `printingSecrets`, which
   * already holds every `NoEcho` value of this bag.
   */
  resolvedParameters: Record<string, unknown> | undefined;
  conditions: Record<string, boolean> | undefined;
  /**
   * {@link conditions} without the ones this diff could not decide (a FALSE
   * fallback), the verdicts a `NoEcho` position may narrow an `Fn::If` by
   * (go-to-k/cdkd#4043): an unknown one is read as both branches.
   */
  knownConditions: Record<string, boolean> | undefined;
  /**
   * What this node knows for certain (go-to-k/cdkd#4479): the parameters whose
   * bound value the next deploy binds too, and the conditions whose verdict
   * comes from those alone. A nested child's row is classified against it
   * (`rowValueTrusted`), so a child's recorded verdict is never matched on an
   * input this node only guessed.
   */
  trust: NodeTrust;
}

/**
 * Per nested-child parameter, the `{{resolve:...}}` tokens in its value that
 * the deploy's parent resolves to plaintext (go-to-k/cdkd#4929). Keyed by
 * parameter for the HAND-DOWN only: a row passes a token on to a grandchild
 * only through a `Ref` to a parameter that holds it as a secret, as the
 * deploy's parent copies a pair only for such a `Ref`.
 */
export type SecretTokensByParameter = ReadonlyMap<string, ReadonlySet<string>>;

/** The optional knobs of {@link computeStackDiff}. */
export interface ComputeStackDiffOptions {
  parameters?: Record<string, unknown>;
  /**
   * Same per-type normalization the deploy engine applies (issue #1591).
   * Without it `cdkd diff` forecasts a change `cdkd deploy` will never make —
   * the preview and the apply must narrow identically.
   */
  canonicalizeProperties?: CanonicalizePropertiesFn;
  /**
   * The registry's answer; see {@link CcRouteUnavailableReason}. Omitted, no
   * deploy is being previewed (`cdkd refactor`), so nothing warns about it.
   */
  ccRouteUnavailableReason?: CcRouteUnavailableReason;
  /**
   * `--no-cfn-fallback` (issue #1697): false disables the resolver's
   * CloudFormation fallback for cross-stack references, mirroring the
   * deploy engine's option so preview and apply resolve identically.
   */
  cfnFallback?: boolean;
  /**
   * The cloud assembly's producer artifacts, consulted lazily by an
   * `Fn::GetStackOutput` carrying a `RoleArn` only, as the deploy engine's
   * resolver does (`IntrinsicFunctionResolverOptions.producerLookup`).
   */
  producerLookup?: ProducerLookup;
  /** The stack's synthesized account, named by that reference's refusal. */
  consumerAccount?: string;
  /**
   * go-to-k/cdkd#6146: a caller diffing one stack several times in one run
   * (`cdkd refactor`) shares its NoEcho value MACs here, so they are made once.
   */
  noEchoMacCache?: NoEchoMacCache;
  /** The same caller's schema write-only lookups, one per type per run (go-to-k/cdkd#6146). */
  macWriteOnlyLookups?: MacWriteOnlyLookups;
  /**
   * Force the issue #1948 "stored key the template cannot account for"
   * withholding ON, regardless of what THIS template proves.
   *
   * Exactly one caller needs it and the reason is structural: a DELETED nested
   * child is diffed against an EMPTY template, so `templateHasSecretReference`
   * is false, `declaredKeys` and `desired` are empty, and NONE of the three
   * withholding arms can fire — a pre-GHSA child's whole stored bag would
   * render with values. The PARENT's template is the evidence available, and
   * `buildDeletedSubtree` passes it down.
   */
  inheritSecretBearingTemplate?: boolean;
  /**
   * Runs the SAME rollback-orphan pre-pass `cdkd deploy` runs, so the
   * preview predicts the deploy instead of reporting a CREATE the deploy
   * will not perform (issue go-to-k/cdkd#2943).
   *
   * Optional because it is the only thing on this path that calls a
   * PROVIDER: `cdkd diff` reaches AWS to resolve intrinsics, but until this
   * it never asked a provider whether a resource exists. Callers that cannot
   * afford that (or have no registry) omit it and get the pre-#2943
   * behaviour. The cost is zero when the state holds no records, which is
   * every stack that has not had a rollback orphan something.
   *
   * Receives the CONDITION-PRUNED template, matching
   * `executeDeployment` (`deployment/deploy-engine/execute.ts`) — reading the raw template would
   * re-orphan a resource an `Fn::If` currently excludes.
   */
  previewOrphanAdoption?: (
    state: StackState,
    effectiveTemplate: CloudFormationTemplate,
    stackName: string,
    region: string
  ) => Promise<{ adopted: Record<string, ResourceState>; refusals: string[] }>;
  /**
   * The parent node's {@link StackDiffResult.printingSecrets} for a nested
   * child (go-to-k/cdkd#4049). Printing only: handed to this node's resolver
   * passes as their `inheritedSecrets` (below), which read it to mask.
   */
  inheritedSecrets?: RecordedSecretValues;
  /**
   * Per parameter, the `{{resolve:...}}` tokens in this nested child's
   * parameter values that its parent's REAL pass resolves
   * (go-to-k/cdkd#4929), from `resolveChildStackParameters`. Handed to this
   * node's resolver passes as `secretStandInTokens`, so a child `Fn::Split`
   * keeps such a token whole as the deploy's child keeps its plaintext.
   * Absent at the root.
   */
  inheritedSecretTokens?: SecretTokensByParameter;
  /**
   * The needles of the secret-named resources the parent row read for this
   * nested child's parameters (go-to-k/cdkd#3869), and its ancestors' too.
   * MASK-ONLY, like this node's own `derivedNames`: never part of
   * `printingSecrets`, so no export preview moves.
   */
  inheritedDerivedNames?: RecordedSecretValues;
  /**
   * go-to-k/cdkd#4043 (review round 9): parameters of this nested child the
   * parent fills from a `NoEcho` source, positioned as `NoEcho` ones.
   */
  inheritedNoEchoParameters?: ReadonlySet<string>;
  /**
   * The same, under ANY parent condition verdict (go-to-k/cdkd#4723), for
   * the stale-alias gate only: a stored alias was published under a past one.
   */
  inheritedNoEchoParametersAnyVerdict?: ReadonlySet<string>;
  /**
   * The READ-ONLY stale-attribute healer (issue go-to-k/cdkd#3456), on every
   * resolver context below — condition evaluation, the resource diff and the
   * outputs pass — as `DeployEngine` puts its healer on every context it
   * builds. Without it a `Fn::GetAtt` over a stale attribute map previews as
   * the raw intrinsic or the physical id while the deploy re-reads the
   * record and resolves it. Omitted, no provider read is issued.
   */
  attributeHealer?: StaleAttributeHealer;
  /**
   * Input parameters the parent row names but whose value could not be
   * resolved for this diff (go-to-k/cdkd#4479). This node binds its own
   * `Default` for each, which serves the comparison, but the deploy binds
   * whatever the parent resolves then, so a recorded verdict's fingerprint
   * never reads one.
   */
  parentUnresolvedParameters?: ReadonlySet<string>;
  /**
   * Compare a masked property's layout-2 fingerprint against this node's
   * resolved inputs (go-to-k/cdkd#4543). Set for the stack the user named
   * only: a nested child's deploy classifies a parameter the parent supplied
   * by secrets this preview never resolves, so a child reads such a
   * fingerprint as unmoved rather than risk a change the deploy never makes.
   */
  previewMaskedInputs?: boolean;
  /**
   * This node's nested-stack templates (logical id -> template file), so a
   * masked property reading a clean nested-stack output is compared as the
   * deploy compares it (go-to-k/cdkd#4565). Read only with
   * {@link previewMaskedInputs}.
   */
  nestedTemplates?: Readonly<Record<string, string>>;
  /**
   * The run's account flags (go-to-k/cdkd#4159), carried on the
   * `cdkd state show` pointer of each malformed-record warning this node
   * prints and on `calculateDiff`'s refusals.
   */
  refusalRecovery?: LockRecoveryContext;
  /**
   * State schema v12 (go-to-k/cdkd#4852): the provenance snapshot the parent
   * row hands this nested child on deploy, derived from the parent's records
   * (`inheritedProvenanceForChildDiff`), so a child reader the deploy
   * promotes is promoted here too.
   */
  inheritedReferenceProvenance?: ReadonlyMap<string, ReferenceProvenance>;
}

/**
 * What one node knows for certain, for classifying the rows it hands its
 * nested children (go-to-k/cdkd#4479). See {@link StackDiffResult.trust}.
 */
export interface NodeTrust {
  /** Parameters whose bound value the next deploy binds too. */
  parameters: ReadonlySet<string>;
  /** Conditions with a verdict computed (or reused) from trusted inputs only. */
  conditions: ReadonlySet<string>;
  /**
   * Resources whose physical id and recorded attributes the next deploy keeps:
   * their change is `NO_CHANGE` AND everything their entry reads is trusted
   * ({@link trustedResourceNames}). A `NO_CHANGE` computed from a guessed
   * input is no evidence.
   */
  resources: ReadonlySet<string>;
}
