import { nullPrototypeRecord } from '../../../utils/own-keys.js';
import type { CloudFormationTemplate, TemplateResource } from '../../../types/resource.js';
import type { ResourceState, StackState } from '../../../types/state.js';
import {
  AWS_NO_VALUE,
  IntrinsicFunctionResolver,
} from '../../../deployment/intrinsic-function-resolver.js';
import type { ProducerLookup } from '../../../deployment/intrinsic-resolver/cdk-cross-account-ref.js';
import {
  dynamicReferenceTokens,
  hasMaskableValues,
  type RecordedSecretValues,
  readsNoEchoSource,
} from '../../../deployment/secret-redaction.js';
import {
  type StateNamingSecrets,
  secretNamePrintingBags,
  stateSecretNameNeedles,
} from '../../../deployment/secret-name-needles.js';
import { withPrintingSecrets } from '../../../deployment/resource-secrets-scope.js';
import type { S3StateBackend } from '../../../state/s3-state-backend.js';
import type { StaleAttributeHealer } from '../../../deployment/stale-attribute-heal.js';
import type { SecretTokensByParameter, NodeTrust } from './types.js';
import { standInTokensOf } from './printing.js';
import { collectRefTargets, isScalarList } from './parameters-conditions.js';
import { rowValueTrusted } from './trust.js';
import { stackIdTailOf } from '../../../state/stack-id-tail.js';

/**
 * go-to-k/cdkd#4043 (review round 9): the keys of a nested-stack row's
 * `Parameters` whose value reads a `NoEcho` parameter of the parent (any
 * position: a whole `Ref`, or one embedded in an `Fn::Sub` / `Fn::Join`). The
 * deploy's child engine positions each as a `NoEcho` parameter, so the child's
 * preview does too.
 */
export function noEchoFedChildParameters(
  parentStackRow: { Properties?: Record<string, unknown> },
  parentNoEchoParameters: ReadonlySet<string>,
  parentConditions: Record<string, boolean> | undefined,
  parentResources: Record<string, ResourceState>
): Set<string> {
  const fed = new Set<string>();
  const rawParams = parentStackRow.Properties?.['Parameters'];
  if (rawParams === null || typeof rawParams !== 'object') return fed;
  for (const [name, value] of Object.entries(rawParams as Record<string, unknown>)) {
    if (
      readsNoEchoSource(value, {
        parameters: parentNoEchoParameters,
        // An attribute the parent's record declares `NoEcho` (a custom
        // resource's, a nested stack's output), as the deploy's fresh mark.
        attributeIsNoEcho: (logicalId, attribute) => {
          const names = (
            Object.hasOwn(parentResources, logicalId) ? parentResources[logicalId] : undefined
          )?.noEchoAttributeNames as unknown;
          return Array.isArray(names) && names.includes(attribute);
        },
        ...(parentConditions !== undefined && { conditions: parentConditions }),
      })
    ) {
      fed.add(name);
    }
  }
  return fed;
}

/**
 * Resolve a nested-stack child's input `Parameters` (declared on the parent's
 * `AWS::CloudFormation::Stack` row under `Properties.Parameters`) to scalar
 * values against the PARENT's deployed state, its BOUND parameters and its
 * evaluated conditions (go-to-k/cdkd#4094) — the parent's
 * {@link StackDiffResult.resolvedParameters} / `conditions`, not the bag
 * handed to the parent. The deploy resolves this row on the parent engine's
 * context, which holds the template defaults, the SSM-typed lookups and the
 * condition verdicts; the input bag alone left a `Ref` to a parent template
 * parameter unresolved, and an `Fn::If` in the row took its FALSE branch.
 *
 * A LIST value is joined on `,`, as `NestedStackProvider.extractParameters`
 * puts it on the wire: the bound bag holds a list-typed parameter as an ARRAY,
 * which the child's binding would otherwise ignore (it takes scalars only) and
 * then diff against its own `Default`. A redacted token bound as an array of
 * expressions (`tokenValueForComparison`) joins back to the token itself, the
 * value the input bag used to carry — up to that split's per-element trim and
 * the comma a JSON-key slot may hold, both recorded on that helper; the deploy
 * trims the same way.
 *
 * This is the diff-time analogue of `NestedStackProvider.extractParameters`:
 * the deploy engine resolves these same `Parameters` against the parent's
 * resolver context and forwards the scalar map to the child engine as
 * `DeployEngineOptions.parameters`, so a `Ref` to a child input parameter
 * resolves at deploy time. The recursive diff must do the same or it reports
 * spurious changes on every freshly-deployed nested child whose property
 * derives from a passed-down parameter.
 *
 * Each value is resolved independently and best-effort: a value that cannot
 * be resolved (e.g. a `Ref` to a resource not yet in state) is dropped from
 * the map rather than forwarded as a raw intrinsic — leaving it out means the
 * child's `Ref` to that parameter falls through to the existing
 * intrinsic-vs-resolved comparison path (no behavior change for the
 * unresolvable case), while resolvable parameters (the freshly-deployed tree)
 * get exact scalar values.
 */
export async function resolveChildStackParameters(
  parentStackRow: TemplateResource,
  parentTemplate: CloudFormationTemplate,
  parentState: StackState,
  region: string,
  parentStackName: string,
  stateBackend: S3StateBackend,
  parentParameters: Record<string, unknown> | undefined,
  parentConditions: Record<string, boolean> | undefined,
  cfnFallback?: boolean,
  /**
   * The PARENT node's printing corpus (go-to-k/cdkd#4049): this resolver's
   * `--verbose` lines print a child input assembled from a parent `NoEcho`
   * value (`Fn::Sub`), or a physical id embedding one. Log-only needles over
   * an empty map, so it decides nothing.
   */
  printingSecrets?: RecordedSecretValues,
  // The parent node's read-only healer (issue go-to-k/cdkd#3456): the deploy
  // resolves this row's `Parameters` on a parent-engine context, which carries
  // the parent's healer.
  attributeHealer?: StaleAttributeHealer,
  /**
   * Filled with every row key whose value THREW here (go-to-k/cdkd#4479). The
   * child binds its own `Default` for such a key, which is right for the
   * comparison but no evidence of what the deploy binds, so the child's
   * recorded-verdict fingerprint must not read it. An `AWS::NoValue` key is
   * not one: the deploy binds the `Default` there too.
   */
  unresolvedKeys?: Set<string>,
  /** What the parent node knows for certain; see {@link rowValueTrusted}. */
  trust?: NodeTrust,
  /**
   * Receives the print-only needles of every secret-named resource the row
   * READ (go-to-k/cdkd#3869): the child prints those values as its own
   * parameters, so the caller masks the child's walk with them.
   */
  derivedNameSink?: RecordedSecretValues,
  /** As `computeStackDiff`'s `producerLookup`. */
  producerLookup?: ProducerLookup,
  /** As `computeStackDiff`'s `consumerAccount`. */
  consumerAccount?: string,
  /**
   * go-to-k/cdkd#4929. `inherited`: this parent node's own
   * `inheritedSecretTokens`, so an `Fn::Split` in the row keeps such a token
   * whole as this node's resource diff does. `child`: filled, per row key,
   * with each `{{resolve:...}}` token in its resolved value that the deploy's
   * parent resolves to plaintext -- one this pass left unresolved as a secret
   * (the real pass resolves it), or one the row passes on through a `Ref` to
   * a parameter `inherited` names it for (the deploy's parent holds its
   * plaintext there, and the child inherits the pair).
   * Token TEXT a `Ref` / `Fn::FindInMap` hands over is neither, as on the
   * deploy, where the real pass passes it through as text.
   */
  secretTokens?: {
    inherited: SecretTokensByParameter | undefined;
    child: Map<string, ReadonlySet<string>>;
  }
): Promise<Record<string, unknown>> {
  const rawParams = parentStackRow.Properties?.['Parameters'];
  if (!rawParams || typeof rawParams !== 'object' || Array.isArray(rawParams)) {
    return {};
  }
  const inheritedStandIns = standInTokensOf(secretTokens?.inherited);
  const resolver = new IntrinsicFunctionResolver(region, {
    cfnFallback: cfnFallback ?? true,
    ...(producerLookup && { producerLookup }),
    ...(consumerAccount && { consumerAccount }),
  });
  const resolved: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(rawParams as Record<string, unknown>)) {
    // go-to-k/cdkd#4479: only a value this diff KNOWS the deploy passes may
    // feed the child's recorded-verdict fingerprint (default deny, see
    // `rowValueTrusted`). Marked before resolving, because an `AWS::NoValue`
    // is skipped below either way.
    if (trust === undefined || !rowValueTrusted(value, parentState, parentConditions, trust)) {
      unresolvedKeys?.add(name);
    }
    // Per row key (go-to-k/cdkd#4929): the deploy's child holds a plaintext
    // only in the parameters whose value the parent RESOLVED, so the same
    // spelling another key passes as text is no evidence for this one.
    const skippedSecretReferences = new Set<string>();
    try {
      const resolvedValue = await resolver.resolve(value, {
        template: parentTemplate,
        resources: parentState.resources,
        // go-to-k/cdkd#3869: a parent row passing a secret-named resource's
        // id or ARN to its child masks it on this resolution's lines.
        secretNameNeedles: stateSecretNameNeedles(parentState.resources),
        secretNameSink: derivedNameSink ?? new Map(),
        stateBackend,
        stackName: parentStackName,
        // go-to-k/cdkd#6170: the tail the deploy resolves the parent's row with.
        stackIdTail: () => stackIdTailOf(parentState, parentStackName),
        // Best-effort like computeStackDiff's resolver: an unresolvable
        // parameter is expected (caught + omitted below), not warn-worthy.
        bestEffort: true,
        ...(parentParameters && { parameters: parentParameters }),
        ...(parentConditions && { conditions: parentConditions }),
        ...(printingSecrets &&
          hasMaskableValues(printingSecrets) && { inheritedSecrets: printingSecrets }),
        // Leave SECRET `{{resolve:...}}` dynamic references UNRESOLVED here
        // too (issue #1903). Without it `cdkd diff --recursive` DECRYPTED a
        // secret-bearing nested-stack input parameter at plan time and printed
        // the plaintext in the child's diff.
        //
        // This flag is only correct BECAUSE the deploy half landed with it:
        // `DeployEngineOptions.inheritedSecrets` now makes the child's
        // `state.json` hold the `{{resolve:...}}` expression rather than the
        // resolved value, so the desired side and the stored side are both
        // expressions. On its own it would have compared an expression against
        // a child state still holding plaintext and reported a spurious
        // perpetual change on every run — which is why the issue's two halves
        // could not be split.
        skipDynamicReferences: true,
        skippedSecretReferences,
        ...(inheritedStandIns && { secretStandInTokens: inheritedStandIns }),
        ...(attributeHealer && { attributeHealer }),
      });
      // An `Fn::If` selecting `AWS::NoValue`: the deploy's resolver drops the
      // key from the row's `Parameters`, so the child binds its own Default.
      if (resolvedValue === AWS_NO_VALUE) continue;
      const childValue = isScalarList(resolvedValue)
        ? resolvedValue.map((element) => String(element)).join(',')
        : resolvedValue;
      resolved[name] = childValue;
      if (secretTokens !== undefined && typeof childValue === 'string') {
        // An inherited token is passed on only by a row value that READS,
        // by `Ref`, a parameter it stands for a secret in: the deploy's parent
        // copies a pair into the row's bag when a `Ref` to a parameter holding
        // the plaintext resolves, never for the same spelling another
        // parameter holds as text (an `Fn::FindInMap` value).
        const refs = new Set<string>();
        collectRefTargets(value, refs);
        const tokens = new Set<string>();
        for (const token of dynamicReferenceTokens(childValue)) {
          if (
            skippedSecretReferences.has(token) ||
            [...refs].some((ref) => secretTokens.inherited?.get(ref)?.has(token) === true)
          ) {
            tokens.add(token);
          }
        }
        if (tokens.size > 0) secretTokens.child.set(name, tokens);
      }
    } catch {
      // Unresolvable (e.g. references a not-yet-deployed resource): omit it so
      // the child diff falls back to the intrinsic-vs-resolved comparison.
      unresolvedKeys?.add(name);
    }
  }
  return resolved;
}

/**
 * Build the diff tree for one stack and (when `recursive`) every nested
 * `AWS::CloudFormation::Stack` descendant.
 *
 * Children come from the **union** of the condition-pruned template's
 * nested-stack rows and the state's nested-stack rows so the tree previews
 * the full next deploy:
 *
 *  - In template (present / CREATE / UPDATE): recurse via the child's synth
 *    template + child state. A child with no state file diffs against an
 *    empty state → all CREATE (the "nested child not deployed yet" case).
 *  - In state but NOT in the pruned template (removed from CDK code, or its
 *    row's `Condition` evaluates false → DELETE): recurse
 *    via the child's state diffed against an empty template → all DELETE,
 *    descending into state-listed grandchildren the same way. This mirrors
 *    `cdkd deploy <parent>` cascade-deleting a removed nested stack.
 *
 * Missing child template path (a template row whose synth output lacks
 * `Metadata['aws:asset:path']`) is a hard error — synth is inconsistent
 * and the user should re-synth, exactly as `NestedStackProvider` would
 * fail at deploy time.
 */
/**
 * The template's `Resources` entries whose logical id the state already
 * records — the only rows that can diff as an UPDATE. Own keys only, and
 * tolerant of a malformed section, since it feeds a prefetch that must never
 * throw.
 */
export function recordedTemplateResources(
  template: CloudFormationTemplate,
  state: StackState
): Record<string, unknown> {
  const recorded: Record<string, unknown> = nullPrototypeRecord<unknown>();
  const resources: unknown = template.Resources;
  const stateResources: unknown = state.resources;
  if (
    resources === null ||
    typeof resources !== 'object' ||
    stateResources === null ||
    typeof stateResources !== 'object'
  ) {
    return recorded;
  }
  for (const [logicalId, resource] of Object.entries(resources)) {
    if (Object.prototype.hasOwnProperty.call(stateResources, logicalId)) {
      recorded[logicalId] = resource;
    }
  }
  return recorded;
}

/**
 * `healer`, each read bound to the healed record's PRINTING bag
 * (go-to-k/cdkd#3869), as `cdkd drift` binds it: a heal reads the record
 * through `provider.import`, whose lines name its physical id, so the record's
 * own name spellings and those of each secret-named record it holds are
 * log-only needles around the read. `resources` answers the records the diff
 * reads AT THE TIME OF THE HEAL (adopted records included), and is judged once
 * per map. A record other than the one the map holds under its id is judged
 * with itself in place. Its own properties (the read-only flag) are kept.
 */
export function healerUnderRecordPrintingBag(
  healer: StaleAttributeHealer,
  resources: () => Readonly<Record<string, ResourceState>>,
  /**
   * The judging bags per map (go-to-k/cdkd#3869): the node's `NoEcho` values
   * plus what each record stores at a `NoEcho` position. Absent: record-only.
   */
  namingSecrets?: (resources: Readonly<Record<string, ResourceState>>) => StateNamingSecrets
): StaleAttributeHealer {
  let judged:
    | {
        readonly map: Readonly<Record<string, ResourceState>>;
        readonly bagOf: (logicalId: string) => RecordedSecretValues;
      }
    | undefined;
  const bagFor = (logicalId: string, resource: ResourceState): RecordedSecretValues => {
    const map = resources();
    if (!Object.hasOwn(map, logicalId) || map[logicalId] !== resource) {
      const withSelf = { ...map, [logicalId]: resource };
      return secretNamePrintingBags(withSelf, namingSecrets?.(withSelf))(logicalId);
    }
    if (judged?.map !== map) {
      judged = { map, bagOf: secretNamePrintingBags(map, namingSecrets?.(map)) };
    }
    return judged.bagOf(logicalId);
  };
  return Object.assign(
    (logicalId: string, resource: ResourceState) =>
      withPrintingSecrets(bagFor(logicalId, resource), () => healer(logicalId, resource)),
    healer
  );
}
