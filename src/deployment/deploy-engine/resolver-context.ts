import type { DeployEngine } from '../deploy-engine.js';
import type { CloudFormationTemplate } from '../../types/resource.js';
import type { ResourceState } from '../../types/state.js';
import {
  hasMaskableValues,
  inheritNestedStackParameterAssociations,
  redactSecretsForState,
  type RecordedSecretValues,
} from '../secret-redaction.js';
import type { MaskedInputSources } from '../masked-property-fingerprints.js';

declare module '../deploy-engine.js' {
  interface DeployEngine {
    /** @internal */
    buildResolverContext: OmitThisParameter<typeof buildResolverContext>;
    /** @internal */
    maskedInputSources: OmitThisParameter<typeof maskedInputSources>;
  }
}

/**
 * One entry the resolver pushed into `ResolverContext.redactedAttributeReads`
 * (issue [#2847](https://github.com/go-to-k/cdkd/issues/2847)).
 *
 * An INLINE TYPE-ONLY alias rather than a named import: 72 of the 80 suites that `vi.mock`
 * `intrinsic-function-resolver.js` use a bare factory exposing only
 * `getAccountInfo`, so a new VALUE import reds them with a missing-export
 * error. A type import is erased at build time and reds nothing — which is
 * also why the consumer below can share the resolver's own
 * definition instead of re-deriving the structure from a rendered string.
 */
type RedactedAttributeRead = import('../intrinsic-function-resolver.js').RedactedAttributeRead;

/**
 * Resolver context with the imports-recording and exports-index
 * fields wired in. Keeps the four+ inline context construction
 * sites consistent — pass through callable as
 * `this.buildResolverContext({...}, stackName)`.
 */
/** @internal */
export function buildResolverContext(
  this: DeployEngine,
  base: {
    template: CloudFormationTemplate;
    resources: Record<string, ResourceState>;
    parameters?: Record<string, unknown>;
    conditions?: Record<string, boolean>;
    /**
     * The masked-read bag, supplied by the CALLER and only by a caller that
     * READS it (issue #2847 round-4 review). Absent means the resolver serves
     * the mask exactly as `main` does.
     *
     * It used to be set here on EVERY context this method builds, on the
     * argument that an array nobody consults costs nothing and that omitting
     * it would leave a future provisioning site silently unguarded. The first
     * half stopped being true when `resolveRefValue` began deciding the
     * masked-leaf SKIP from the bag's PRESENCE: on the deploy-internal DIFF
     * context — which has no refusal reader — the skip fired anyway, so
     * `{Ref: X}` resolved to the raw physical id and was compared against the
     * `'***'` in state. Measured on a pre-existing issue #2274 stack (a
     * `NoEcho` value in `properties.TableName`, a sibling `{Ref: Tbl}`):
     * NO_CHANGE and a clean deploy on `main`, a spurious UPDATE and then a
     * hard failure at the provisioning refusal with the bag present. Fail-
     * closed, so never an exposure — but a regression for existing users and
     * a divergence from standalone `cdkd diff`, which is bagless and still
     * reports NO_CHANGE.
     *
     * The second half is answered by making the decision VISIBLE instead of
     * ambient: a provisioning site that wants the guard passes the bag on the
     * line where it builds its context, and
     * `tests/unit/deployment/deploy-engine-resolver-context-bag-scope.test.ts`
     * asserts which sites do.
     */
    redactedAttributeReads?: RedactedAttributeRead[];
  },
  stackName: string
): import('../intrinsic-function-resolver.js').ResolverContext {
  // FRESH per-context map — see the field note at the bottom of the returned
  // object. Named here rather than inlined so the nested-stack parameter
  // associations can be copied onto it (issue #2291).
  const recordedSecretValues = new Map<string, string>();
  // Issue #2291: the parent recorded, per child PARAMETER NAME, which
  // `{{resolve:...}}` expression that parameter was resolved from. Copy those
  // onto this resource's bag as `{Ref: <ParamName>}` position associations,
  // so a child leaf spelling the parameter persists ITS OWN expression rather
  // than whichever one the plaintext-keyed inherited map kept.
  //
  // NOT the issue #2087 pre-seed this file's note below warns about, and the
  // difference is which store decides SCOPE. That defect pre-loaded the
  // PLAINTEXT map, which is what `redactSecretsForState` substring-matches
  // with — so every resource's literals became rewritable. These associations
  // can only change an answer for a leaf whose value is already a plaintext in
  // THIS bag, i.e. only for a resource whose own resolution consumed the
  // parameter. They decide WHICH expression such a leaf takes, never WHETHER
  // a leaf is rewritten.
  if (this.options.inheritedSecrets && this.options.inheritedSecrets.size > 0) {
    inheritNestedStackParameterAssociations(recordedSecretValues, this.options.inheritedSecrets);
  }
  return {
    template: base.template,
    resources: base.resources,
    ...(base.parameters &&
      Object.keys(base.parameters).length > 0 && { parameters: base.parameters }),
    ...(base.conditions &&
      Object.keys(base.conditions).length > 0 && { conditions: base.conditions }),
    stateBackend: this.stateBackend,
    stackName,
    ...(this.exportIndexStore && { exportIndex: this.exportIndexStore }),
    recordedImports: this.recordedImports,
    recordedOutputReads: this.recordedOutputReads,
    // Issue #1852: on EVERY context this engine builds — the diff pass, both
    // provisioning arms and the outputs pass all read the same stale record,
    // and the heal is memoized, so whichever asks first pays the one read.
    attributeHealer: (logicalId, resource) =>
      this.healStaleAttributes(logicalId, resource, stackName),
    // The pairs the PARENT resolved for this stack, on a nested-stack child
    // engine only (issue #1903). NOT pre-loaded into the map below: the
    // resolver copies a pair across at the moment a resource's `{Ref: Param}`
    // actually resolves to a value carrying that plaintext
    // (`recordInheritedParameterSecrets`), so the pair lands in the bag of
    // the resource that consumed the parameter and nowhere else.
    //
    // The first cut DID pre-load every context's map, and that was issue
    // #2087: `redactSecretsForState` substring-matches at or above
    // `MIN_NEEDLE_LENGTH`, so a child resource that never referenced the
    // parameter but spells `my-production-bucket` while the secret is
    // `production` had `my-{{resolve:...}}-bucket` persisted. The desired
    // side does NOT mirror that — `redactParametersForDiff` rewrites only the
    // PARAMETERS — so the stack acquired a perpetual UPDATE, or a perpetual
    // REPLACEMENT on a create-only property. The rationale that shipped with
    // it ("the same over-approximation the parent already accepts") was
    // simply wrong: the parent scopes its bag to the ONE resource whose
    // resolution produced the secret, because `perResourceSecrets` is keyed
    // by logical id. Recording at resolution time gives the child the SAME
    // scoping rule.
    //
    // PARITY, not perfection, and the residual is worth naming rather than
    // leaving to be rediscovered: within a resource that genuinely DOES
    // consume the parameter, `redactSecretsForState` still substring-matches
    // every leaf, so an UNRELATED literal in that same resource carrying the
    // plaintext verbatim is rewritten too. The parent has exactly that
    // residual for a resource that resolves a `{{resolve:...}}`, so this is
    // the child reaching parity with it — not a claim that no
    // over-approximation remains.
    //
    // `hasMaskableValues`, not `size` (go-to-k/cdkd#1998): a parent bag
    // holding only LOG-ONLY needles (a `NoEcho` parameter's value) must still
    // reach the child's resolver, which masks with it and carries it into the
    // bag of the child resource consuming the parameter. Every reader of
    // this field that PERSISTS or positions still asks `size` itself.
    ...(this.options.inheritedSecrets &&
      hasMaskableValues(this.options.inheritedSecrets) && {
        inheritedSecrets: this.options.inheritedSecrets,
      }),
    // FRESH per-context map: the resolver records each resolved secret
    // (plaintext -> `{{resolve:...}}` expression) here (GHSA fix). The caller
    // captures it and stores it per-logicalId in `perResourceSecrets` (or in
    // `outputSecrets` for the outputs pass) so each bag is redacted only with
    // the secrets substituted during ITS OWN resolution — see the
    // `perResourceSecrets` field doc for why per-resource, not session-wide.
    recordedSecretValues,
    // Issue #2274. `noEchoAttributeResources` goes on EVERY context this
    // method builds — the diff / no-op one included — because it can only ADD
    // mask-only needles to a bag, which is right wherever that bag ends up
    // redacting something and inert wherever it does not.
    //
    // `redactedAttributeReads` is the opposite and comes from the CALLER: it
    // is an OPT-IN whose presence changes what the resolver SERVES, so it
    // belongs only where a reader exists. The `base` field's own doc carries
    // the measurement that forced the split.
    noEchoAttributeResources: this.noEchoAttributeResources,
    // go-to-k/cdkd#3869: on every context, the diff pass included, since each
    // one prints a `resolved to` line for what it reads. It only ADDS log-only
    // needles to the reading pass's bag, judged from `base.resources` (the
    // record a read is served from) and the target's own bag. The two
    // contexts whose bag DECIDES something from its log-only needles drop it:
    // `maskedInputSources` below and `resolveOutputs`.
    secretNameNeedles: (logicalId: string) =>
      this.noteSecretNamedRecord(
        logicalId,
        Object.hasOwn(base.resources, logicalId) ? base.resources[logicalId] : undefined
      ),
    ...(base.redactedAttributeReads && {
      redactedAttributeReads: base.redactedAttributeReads,
    }),
  };
}

/**
 * Route a NESTED-STACK row's reads of a secret-named resource
 * (go-to-k/cdkd#3869) to a print-only bag (`ResolverContext.printingSecrets`)
 * instead of the row's own: that bag is the child's `inheritedSecrets`, where
 * a log-only needle seeds the child's export-name verdict and would withhold
 * an export the same template publishes at the root (security review). The
 * row's own `resolved to` lines stay masked; its provider lines do not. A
 * no-op for every other type.
 */
export function printNestedStackReadsOnly(
  context: import('../intrinsic-function-resolver.js').ResolverContext,
  resourceType: string
): void {
  if (resourceType === 'AWS::CloudFormation::Stack') context.printingSecrets = new Map();
}

/** The logical id an `Fn::GetAtt` input node reads. */
function getAttTargetOf(node: unknown): string | undefined {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return undefined;
  const record = node as Record<string, unknown>;
  const getAtt = record['Fn::GetAtt'];
  if (Array.isArray(getAtt) && typeof getAtt[0] === 'string') return getAtt[0];
  if (typeof getAtt === 'string') return getAtt.split('.')[0];
  return undefined;
}

/**
 * The sources a masked property's INPUT fingerprint is computed from
 * (go-to-k/cdkd#4543), for the deploy's diff pass and its provisioning arms
 * alike: the parameter classes {@link DeployEngine.fingerprintParameters}
 * recorded, the evaluated `conditions`, a resolver over `resources`, and the
 * assembly's nested-stack templates (go-to-k/cdkd#4565).
 *
 * Each input node resolves through a FRESH context of its own, so nothing it
 * records (secrets, imports, output reads) reaches the resource's own
 * resolution, and its bag holds only what THAT node read: a value it records a
 * secret for is kept as written. It never resolves a `{{resolve:...}}`
 * reference (`skipDynamicReferences`), as the diff pass never does, so both
 * sides resolve an input the same way; the one difference is `resources`,
 * which on the provisioning side holds what this deploy already replaced.
 * `undefined` before the parameters resolve.
 */
/** @internal */
export function maskedInputSources(
  this: DeployEngine,
  template: CloudFormationTemplate,
  resources: Record<string, ResourceState>,
  conditions: Record<string, boolean> | undefined,
  stackName: string
): MaskedInputSources | undefined {
  const parameters = this.fingerprintParameters;
  if (parameters === undefined) return undefined;
  return {
    template,
    parameterInput: parameters.parameterInput,
    conditions,
    childTemplate: this.fingerprintChildTemplates,
    resolve: async (node: unknown) => {
      // No healer, and the stale-attribute PROBE phase: an `Fn::GetAtt` the
      // resolver would answer with the physical-id FALLBACK (a guess, counted
      // in the deploy summary and warned) throws instead, which reads as an
      // unknown input. The fingerprint pass must neither bump that counter nor
      // repeat the warning, and a guessed value is no input to hash.
      // `cdkd diff` builds its context the same way.
      // No derived-name needles either (go-to-k/cdkd#3869): this bag decides
      // whether an input is kept as written, from its log-only needles too.
      const {
        attributeHealer: _healer,
        secretNameNeedles: _needles,
        ...base
      } = this.buildResolverContext(
        {
          template,
          resources,
          parameters: parameters.bound,
          ...(conditions && { conditions }),
        },
        stackName
      );
      const context = {
        ...base,
        recordedImports: [],
        recordedOutputReads: [],
        bestEffort: true,
        skipDynamicReferences: true,
        staleAttributeHeal: { phase: 'probe' as const },
      };
      const value = await this.resolver.resolve(structuredClone(node), context);
      const secrets: RecordedSecretValues | undefined = context.recordedSecretValues;
      // An attribute of a resource whose resolution THIS deploy recorded a
      // secret for is still raw in memory (the save redacts it), so one
      // echoing that secret would be hashed in plaintext. Kept as written
      // exactly when the save's OWN redaction (`redactSecretsForState`, called
      // as the attribute scrub calls it) would change the value: the saved
      // record then holds `***` or a reference, which the next deploy's diff
      // reads and keeps too, so both sides agree. The decision mirrors what
      // state shows anyway, so it is no oracle (security review of
      // go-to-k/cdkd#4543).
      const target = getAttTargetOf(node);
      const targetSecrets = target === undefined ? undefined : this.perResourceSecrets.get(target);
      if (targetSecrets !== undefined && hasMaskableValues(targetSecrets)) {
        const probe = { value };
        const redacted = redactSecretsForState(probe, targetSecrets);
        if (JSON.stringify(redacted) !== JSON.stringify(probe)) {
          return { value, keepAsWritten: true };
        }
      }
      return { value, ...(secrets && { secrets }) };
    },
  };
}
