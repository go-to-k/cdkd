import { stripControlChars, stripForDisplay } from '../../../utils/regexp.js';
import { displayStackName, safeMsg } from '../../../utils/display-safe.js';
import type { CloudFormationTemplate } from '../../../types/resource.js';
import type { ResourceState, StackState } from '../../../types/state.js';
import { DiffCalculator } from '../../../analyzer/diff-calculator.js';
import { IntrinsicFunctionResolver } from '../../../deployment/intrinsic-function-resolver.js';
import { declaresNoEcho } from '../../../deployment/noecho-declared.js';
import {
  computeOutputsDiff,
  resolveTemplateOutputs,
  templateHasSecretDynamicReference,
  type OutputChange,
} from '../../../analyzer/outputs-diff.js';
import {
  isWholeDynamicReferenceValue,
  noEchoParameterValueSeed,
} from '../../../deployment/outputs-export-alias.js';
import { bindingSkippedOutputs } from '../../../analyzer/skipped-outputs.js';
import {
  hasMaskableValues,
  printingCorpusOf,
  recordLogOnlyParameterValue,
  literalSplitDelimitersOf,
  carryLogOnlyValues,
  type RecordedSecretValues,
  readsNoEchoSource,
  noEchoOutputsComparison,
  recordedNoEchoValuesOf,
  unionOfSecretBags,
} from '../../../deployment/secret-redaction.js';
import {
  noEchoComparisonForTemplate,
  noEchoParameterNamesOf,
} from '../../../deployment/deploy-engine/noecho.js';
import {
  type StateNamingSecrets,
  namingSecretsWithRecordedNoEcho,
  stateSecretNameNeedles,
  secretNamedRecordNeedles,
  storedSecretNameNeedles,
} from '../../../deployment/secret-name-needles.js';
import type { MaskerFn } from '../../../provisioning/masked-retry-logger.js';
import type { S3StateBackend } from '../../../state/s3-state-backend.js';
import { parameterInputsFor } from '../../../deployment/masked-property-fingerprints.js';
import { diffSecurity } from '../../../analyzer/security-diff.js';
import { childTemplateLoader } from '../../../deployment/nested-output-templates.js';
import { findNestedStackTypeChanges } from '../../../deployment/type-change-guard.js';
import {
  deferredServiceTokenWarning,
  findServiceTokenRefusals,
  serviceTokenBlockingReason,
} from '../../../deployment/custom-resource-service-token.js';
import type { CrossStackRead } from '../../../deployment/intrinsic-resolver/context.js';
import { crossStackOutputProvenanceSource } from '../../../deployment/read-provenance-sources.js';
import { logger } from './logger.js';
import type { StackDiffResult, ComputeStackDiffOptions } from './types.js';
import {
  nestedStackTypeChangeReason,
  findUnroutableDropRefusals,
  findUnwrittenCreateOnlyRefusals,
} from './refusals.js';
import {
  standInTokensOf,
  diffPrintingSecrets,
  createDiffPrintingMasker,
  maskResourceChangeForDisplay,
  maskOutputChangeForDisplay,
} from './printing.js';
import { bindParametersAndConditions } from './parameters-conditions.js';
import { previewOrphanSplice } from './orphan-splice.js';
import { outputChangesAfterResolutionFailure } from './outputs-failure.js';
import { trustedResourceNames } from './trust.js';
import { healerUnderRecordPrintingBag } from './child-parameters.js';
import { stackIdTailOf } from '../../../state/stack-id-tail.js';
import { previewNoEchoMacChanges } from './noecho-macs.js';

/**
 * Compute the per-resource diff for one stack: `currentState` (cdkd state)
 * vs `template` (synth desired state), with a best-effort intrinsic
 * resolver so changes buried inside intrinsics (e.g. `Fn::Join` literal
 * args) are detected against resolved values in state.
 *
 * Also computes the `Outputs` delta (issue #1921) — an Outputs-only change has
 * a byte-identical `Resources` section, so without it such a stack previews as
 * "No changes detected" while the apply persists new outputs and republishes
 * the exports index.
 *
 * Pure with respect to AWS state mutation — only reads state (the resolver
 * may read producer state for `Fn::ImportValue` / `Fn::GetStackOutput`).
 */
export async function computeStackDiff(
  currentState: StackState,
  template: CloudFormationTemplate,
  region: string,
  stackName: string,
  stateBackend: S3StateBackend,
  diffCalculator: DiffCalculator,
  /**
   * The optional knobs, as ONE object rather than four trailing positionals
   * (issue #1926 review): the fourth arrival pushed this to ten parameters and
   * made `buildDeletedSubtree` pad with three `undefined`s to reach the one it
   * needed, which is exactly the call shape a wrong-slot bug hides in.
   */
  options: ComputeStackDiffOptions = {}
): Promise<StackDiffResult> {
  const {
    parameters,
    canonicalizeProperties,
    ccRouteUnavailableReason,
    cfnFallback,
    producerLookup,
    consumerAccount,
    noEchoMacCache,
    macWriteOnlyLookups,
    inheritSecretBearingTemplate,
    inheritedSecrets,
    inheritedSecretTokens,
    inheritedDerivedNames,
    attributeHealer: unboundAttributeHealer,
    parentUnresolvedParameters,
    inheritedNoEchoParameters,
    inheritedNoEchoParametersAnyVerdict,
  } = options;
  // go-to-k/cdkd#3869: every heal of this node binds the healed record's
  // printing bag, judged over the records the diff reads at that moment
  // (`healResources`, which takes the adopted records once they are spliced).
  let healResources: Readonly<Record<string, ResourceState>> = currentState.resources ?? {};
  // Set once the per-record NoEcho judge exists (below); a heal runs after.
  let healNamingSecrets:
    | ((resources: Readonly<Record<string, ResourceState>>) => StateNamingSecrets)
    | undefined;
  const attributeHealer =
    unboundAttributeHealer &&
    healerUnderRecordPrintingBag(
      unboundAttributeHealer,
      () => healResources,
      (map) => healNamingSecrets?.(map)
    );
  // This template's `NoEcho` parameters, plus (in a nested child) the ones the
  // parent fills from a `NoEcho` source (go-to-k/cdkd#4043 review round 9).
  const noEchoParametersOf = (t: CloudFormationTemplate): Set<string> =>
    new Set([...noEchoParameterNamesOf(t), ...(inheritedNoEchoParameters ?? [])]);
  // The parent's printing corpus (go-to-k/cdkd#4049), as the `inheritedSecrets`
  // of every resolver pass this node runs: parameter binding, condition
  // evaluation and the diff resolver each print debug lines, and a child's
  // parameter need not be `NoEcho` to hold the parent's `NoEcho` value. The
  // parent's `printingSecrets` is already a `diffPrintingSecrets` corpus with
  // an EMPTY map, so it is handed on as it is, not copied per pass.
  const inheritedForResolver =
    inheritedSecrets !== undefined && hasMaskableValues(inheritedSecrets)
      ? inheritedSecrets
      : undefined;
  const secretStandInTokens = standInTokensOf(inheritedSecretTokens);
  const intrinsicResolver = new IntrinsicFunctionResolver(region, {
    cfnFallback: cfnFallback ?? true,
    ...(producerLookup && { producerLookup }),
    ...(consumerAccount && { consumerAccount }),
  });

  // Issue #2740: the source the skipped-output digests are compared against,
  // snapshotted HERE — before the parameter binding and condition evaluation
  // below, and before any resolution — at the same point of this flow as the
  // deploy engine's own snapshot, so the two digests agree. Taken as a deep
  // COPY so nothing downstream can make a resolved value visible to it; the
  // invariant and why it does not rest on any one resolver are in
  // `skipped-outputs.ts`. `Resources` is dropped: the digest never reads it.
  // The BINDING decision is made below, once the resource diff is in hand.
  const outputsDigestSource: CloudFormationTemplate = structuredClone({
    ...template,
    Resources: {},
  });

  const {
    mergedParameters,
    unboundParameterNames,
    effectiveTemplate,
    conditions,
    trustedParameters,
    everyConditionKnown,
    trustedConditions,
    stillUnknown,
  } = await bindParametersAndConditions({
    template,
    parameters,
    stackName,
    stateBackend,
    currentState,
    intrinsicResolver,
    inheritedForResolver,
    inheritedSecrets,
    parentUnresolvedParameters,
    attributeHealer,
  });

  // The PRINTING half of go-to-k/cdkd#4049. The diff resolver gets a bag of its
  // own, as the deploy's diff pass does, so a `Ref` to a `NoEcho` parameter
  // records its value there as a log-only needle, and so does an encoding
  // derived from one (`Fn::Base64`). Every `NoEcho` parameter's bound value is
  // ALSO recorded into it up front: the resolver records one only when a `Ref`
  // serves it, while a property that STOPPED reading the parameter still holds
  // it on the stored side, and a `Fn::GetAtt` reading a stored copy prints it
  // in the resolver's own debug lines. Its log-only needles decide nothing:
  // every resolver reader that decides reads the bag's MAP, and the one
  // verdict that reads log-only needles (the `NoEcho` export alias, #4043)
  // reads the Outputs pass's bags below, never this one. That map holds at most
  // the mask-only entries of an encoding derived from a needle
  // (`Fn::Base64`), since `skipDynamicReferences` resolves no secret, and the
  // INHERITED bag handed to the resolver below has an empty map.
  const diffSecrets: RecordedSecretValues = new Map();
  // The pieces of every literal `Fn::Split` over a `NoEcho` value too
  // (go-to-k/cdkd#4049), for a property that stopped reading one. A bag of
  // their OWN that this node's masker reads and its corpus leaves out: the
  // corpus is a nested child's inherited bag, whose carry would move a piece
  // into the child's Outputs pass and refuse an alias its deploy publishes.
  const splitPieces: RecordedSecretValues = new Map();
  // go-to-k/cdkd#3869: what a `Ref` / `Fn::GetAtt` read from a resource NAMED
  // from a secret, recorded by the resolver as print-only needles. A bag of
  // its OWN, like `splitPieces`: this node's masker reads it, and its corpus
  // (a nested child's inherited bag) leaves it out, so no child's export
  // preview moves.
  const derivedNames: RecordedSecretValues = new Map();
  const splitDelimiters = literalSplitDelimitersOf(
    template,
    new Set(
      Object.entries(template.Parameters ?? {})
        .filter(([, definition]) => declaresNoEcho(definition))
        .map(([name]) => name)
    )
  );
  for (const [name, definition] of Object.entries(template.Parameters ?? {})) {
    if (
      declaresNoEcho(definition) &&
      mergedParameters !== undefined &&
      Object.prototype.hasOwnProperty.call(mergedParameters, name) &&
      // A value that IS a `{{resolve:...}}` token is an expression the diff
      // prints as written (a nested input), so it is no needle: the rows
      // leave it, and so must the resolver's own lines.
      !isWholeDynamicReferenceValue(mergedParameters[name])
    ) {
      recordLogOnlyParameterValue(diffSecrets, mergedParameters[name]);
      recordLogOnlyParameterValue(splitPieces, mergedParameters[name], splitDelimiters);
    }
  }
  // go-to-k/cdkd#3869: the name of a resource NAMED from a secret that another
  // record STORES, judged from state alone (and the `NoEcho` values above). A
  // property that stopped reading the resource prints that stored copy as its
  // OLD side, on the `--verbose` replacement line and in its row, and no
  // resolution of this pass reads it. Mask-only, like `derivedNames`.
  // Every judge of the records (here, the adoption pass and
  // `secretNamedRecords`) takes this COPY of the stack's whole `NoEcho`
  // values, taken before the walk: the resolver later records into
  // `diffSecrets` an `Fn::Split` fragment of one, and an ordinary record
  // named like a fragment would be judged secret-named, its id spellings
  // over-masking a nested child.
  const noEchoJudgeValues: RecordedSecretValues = new Map(diffSecrets);
  carryLogOnlyValues(diffSecrets, noEchoJudgeValues);
  // Per record, also what it stores where a `NoEcho` parameter served it
  // (go-to-k/cdkd#3869): a name taken from a value since CHANGED (a pre-v11
  // record holds the old plaintext), or a short or `Number` one, which the
  // bound values cannot judge. Positioned by the template as this diff
  // evaluated it, a condition it could not evaluate read on both branches.
  const namingNoEchoParameters = noEchoParametersOf(effectiveTemplate);
  const namingConditions =
    conditions === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(conditions).filter(([name]) => !stillUnknown.includes(name))
        );
  const namingTemplateResources = (effectiveTemplate.Resources ?? {}) as Record<
    string,
    { Type?: unknown; Properties?: unknown } | undefined
  >;
  const recordedNamingValues = (
    resources: Readonly<Record<string, ResourceState>>,
    logicalId: string
  ): RecordedSecretValues | undefined => {
    const record = Object.hasOwn(resources, logicalId) ? resources[logicalId] : undefined;
    const templateResource = Object.hasOwn(namingTemplateResources, logicalId)
      ? namingTemplateResources[logicalId]
      : undefined;
    const bag = recordedNoEchoValuesOf(
      templateResource?.Type === record?.resourceType ? templateResource?.Properties : undefined,
      record,
      namingNoEchoParameters,
      namingConditions
    );
    return hasMaskableValues(bag) ? bag : undefined;
  };
  const noEchoJudge = (
    resources: Readonly<Record<string, ResourceState>>
  ): ((logicalId: string) => RecordedSecretValues | undefined) =>
    namingSecretsWithRecordedNoEcho(noEchoJudgeValues, (logicalId) =>
      recordedNamingValues(resources, logicalId)
    );
  // The resolver's judge reads `diffSecrets` LIVE (it grows mid-walk), so the
  // record's stored values are memoized and the union is taken per call.
  const liveNamingJudge = (
    resources: Readonly<Record<string, ResourceState>>
  ): ((logicalId: string) => RecordedSecretValues | undefined) => {
    // Keyed by the record object too: a record rewritten mid-pass is re-read.
    const memo = new Map<string, { record: unknown; bag: RecordedSecretValues | undefined }>();
    return (logicalId) => {
      const record = Object.hasOwn(resources, logicalId) ? resources[logicalId] : undefined;
      let hit = memo.get(logicalId);
      if (hit === undefined || hit.record !== record) {
        hit = { record, bag: recordedNamingValues(resources, logicalId) };
        memo.set(logicalId, hit);
      }
      const stored = hit.bag;
      return stored === undefined ? diffSecrets : unionOfSecretBags([diffSecrets, stored]);
    };
  };
  healNamingSecrets = noEchoJudge;
  const stateNames = storedSecretNameNeedles(
    currentState.resources ?? {},
    noEchoJudge(currentState.resources ?? {}),
    new Map(),
    currentState.outputs
  );
  // ONE cached masker for the `--verbose` replacement line and the final pass
  // below; it re-reads the bags when they grow, as they do mid-walk.
  // The Outputs pass records into a bag of its OWN (go-to-k/cdkd#4043), the
  // twin of the deploy's outputs-pass bag: which `NoEcho` values it holds
  // decides which export aliases the deploy refuses (each `Export.Name`'s bag
  // shares its log-only set and forwards its entries into it). Printing reads
  // it too, for an encoding an output derives from one (`Fn::Base64`).
  const outputsPassSecrets: RecordedSecretValues = new Map();
  const printing = createDiffPrintingMasker(
    [diffSecrets, inheritedForResolver, outputsPassSecrets],
    [
      splitPieces,
      derivedNames,
      stateNames,
      ...(inheritedDerivedNames ? [inheritedDerivedNames] : []),
    ]
  );
  const maskForLog: MaskerFn = printing.mask;

  const resolveRecordingInto =
    (
      bag: RecordedSecretValues,
      printingSecrets?: RecordedSecretValues,
      crossStackReads?: Map<string, CrossStackRead>
    ) =>
    (value: unknown): Promise<unknown> =>
      intrinsicResolver.resolve(value, {
        recordedSecretValues: bag,
        ...(printingSecrets && { printingSecrets }),
        // go-to-k/cdkd#4852: the resource diff's cross-stack reads, for the
        // read-provenance arm (as the deploy's diff pass records them).
        ...(crossStackReads && { crossStackReads }),
        secretNameNeedles: stateSecretNameNeedles(
          currentState.resources,
          liveNamingJudge(currentState.resources)
        ),
        secretNameSink: derivedNames,
        ...(inheritedForResolver && { inheritedSecrets: inheritedForResolver }),
        ...(secretStandInTokens && { secretStandInTokens }),
        template: effectiveTemplate,
        resources: currentState.resources,
        stateBackend,
        stackName,
        // go-to-k/cdkd#6170: the tail the deploy resolves `AWS::StackId` with.
        stackIdTail: () => stackIdTailOf(currentState, stackName),
        // Diff resolution is best-effort (the calculator catches failures and
        // keeps the raw intrinsic): a Ref to a to-be-created resource is the
        // expected case here, so the resolver logs it at debug, not warn
        // (issue #1017).
        bestEffort: true,
        // Nested-stack children receive their input `Parameters` resolved
        // against the parent's deployed state (issue #555 follow-up). Without
        // this, a `Ref` to a synthesized nested-stack input parameter (e.g.
        // `referenceto<Parent>RootTopicName`) is neither a resource nor a
        // parameter in the diff context, so `resolveBestEffort` keeps the raw
        // intrinsic and the diff calculator reports a spurious UPDATE of every
        // property whose value derives from that parameter — even on a freshly
        // deployed tree. The deploy engine forwards exactly this resolved
        // parameter map to the child engine via `DeployEngineOptions.parameters`
        // (`NestedStackProvider.extractParameters`), so resolving here too makes
        // the recursive diff match what the deploy actually wrote to state.
        // Template-declared parameter defaults are merged in as well (issue
        // #1027) so `Ref` / `Fn::Sub` / `Fn::FindInMap` over parameters
        // resolve like they do on deploy.
        ...(mergedParameters && { parameters: mergedParameters }),
        // Evaluated conditions so `Fn::If` resolves in property values.
        ...(conditions && { conditions }),
        // Leave SECRET `{{resolve:...}}` dynamic references UNRESOLVED for diff
        // (GHSA fix): state stores the unresolved expression, so comparing the
        // desired side as its expression avoids a spurious perpetual change and
        // any live secret fetch that would print the plaintext. As on the deploy
        // engine's twin, an `ssm` reference is classified by the parameter's TYPE
        // rather than its spelling (issue #1901), so a not-yet-classified one
        // still costs one `GetParameter` here — issued with
        // `WithDecryption: false`, so a `SecureString` never yields plaintext.
        skipDynamicReferences: true,
        ...(attributeHealer && { attributeHealer }),
      });
  const crossStackReads = new Map<string, CrossStackRead>();
  const resolveFn = resolveRecordingInto(diffSecrets, undefined, crossStackReads);
  const orphanSplice = await previewOrphanSplice({
    currentState,
    options,
    effectiveTemplate,
    stackName,
    region,
    noEchoJudge,
    stateNames,
    setHealResources: (resources) => {
      healResources = resources;
    },
  });
  const { adoptedOrphans, adoptedRecords, deployRefusals, stateForDiff, unreadableOrphans } =
    orphanSplice;
  let { blocking } = orphanSplice;

  // go-to-k/cdkd#4543: the deploy's input fingerprint, recomputed from this
  // node's parameters, verdicts and state, through the same classification
  // (`parameterInputsFor`) and the same resolution rules (no `{{resolve:...}}`
  // reference resolved, a fresh bag per input). An unbound parameter is an
  // unknown input, so a property reading one is not compared.
  let maskedInputs: Parameters<DiffCalculator['calculateDiff']>[8];
  if (options.previewMaskedInputs === true) {
    const classified = parameterInputsFor({
      template,
      values: mergedParameters,
      unbound: unboundParameterNames,
    });
    const resourcesForInputs = stateForDiff.resources;
    maskedInputs = {
      sources: {
        template: effectiveTemplate,
        parameterInput: classified.parameterInput,
        conditions,
        // The same reader of the same assembly the deploy's engine builds.
        childTemplate: childTemplateLoader(options.nestedTemplates),
        resolve: async (node: unknown) => {
          const secrets: RecordedSecretValues = new Map();
          const value = await intrinsicResolver.resolve(structuredClone(node), {
            recordedSecretValues: secrets,
            // go-to-k/cdkd#3869: its lines masked, its deciding bag untouched.
            secretNameNeedles: stateSecretNameNeedles(
              resourcesForInputs,
              liveNamingJudge(resourcesForInputs)
            ),
            secretNameSink: derivedNames,
            template: effectiveTemplate,
            resources: resourcesForInputs,
            stateBackend,
            stackName,
            stackIdTail: () => stackIdTailOf(currentState, stackName),
            bestEffort: true,
            ...(Object.keys(classified.bound).length > 0 && { parameters: classified.bound }),
            ...(conditions && Object.keys(conditions).length > 0 && { conditions }),
            skipDynamicReferences: true,
            // As the deploy's fingerprint pass (`maskedInputSources`): no
            // healer, and a physical-id fallback reads as an unknown input.
            staleAttributeHeal: { phase: 'probe' },
          });
          return { value, secrets };
        },
      },
    };
  }
  const changes = await diffCalculator.calculateDiff(
    stateForDiff,
    effectiveTemplate,
    resolveFn,
    canonicalizeProperties,
    undefined,
    undefined,
    // `--verbose`'s `requires replacement (from <old> to <new>)` line prints
    // resolved values (go-to-k/cdkd#4049).
    maskForLog,
    undefined,
    maskedInputs,
    options.refusalRecovery,
    // go-to-k/cdkd#4043: compare what the deploy persists for a value a
    // `NoEcho` source served (`***`), reading a pre-v11 record's plaintext as
    // the migration witness. Only the verdicts this diff knows position an
    // `Fn::If`; an unknown one masks the whole leaf.
    noEchoComparisonForTemplate(
      effectiveTemplate,
      conditions === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(conditions).filter(([name]) => !stillUnknown.includes(name))
          ),
      mergedParameters,
      stateForDiff.resources,
      new Set([region, stackName]),
      inheritedNoEchoParameters
    ),
    // State schema v12 (go-to-k/cdkd#4852): the same read-provenance members
    // the deploy's diff reads: a nested child's snapshot (derived from the
    // parent's records, `inheritedProvenanceForChildDiff`) and each producer
    // output a cross-stack read of this diff read (one state read per
    // producer, and only for a reader holding read versions).
    {
      ...(options.inheritedReferenceProvenance && {
        inherited: options.inheritedReferenceProvenance,
      }),
      crossStackOutputs: crossStackOutputProvenanceSource(
        crossStackReads,
        crossStackReads,
        stateBackend
      ),
    }
  );
  // go-to-k/cdkd#6146: a property whose recorded NoEcho value MACs prove the
  // value moved is a change, as the deploy sends it. No KMS call unless a
  // record carries MACs; none in a nested child.
  const macConditions =
    conditions === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(conditions).filter(([name]) => !stillUnknown.includes(name))
        );
  const macMoved = await previewNoEchoMacChanges({
    changes,
    template: effectiveTemplate,
    resources: stateForDiff.resources,
    parameterValues: mergedParameters,
    sources: {
      parameters: noEchoParametersOf(effectiveTemplate),
      ...(macConditions !== undefined && { conditions: macConditions }),
    },
    nestedChild: inheritedSecrets !== undefined || inheritedNoEchoParameters !== undefined,
    stackName,
    region,
    stackInstanceId: stateForDiff.stackInstanceId,
    logger,
    ...(noEchoMacCache !== undefined && { cache: noEchoMacCache }),
    ...(macWriteOnlyLookups !== undefined && { writeOnlyLookups: macWriteOnlyLookups }),
  });
  if (macMoved.length > 0) {
    logger.info(
      safeMsg`Stack ${displayStackName(stackName)}: ${macMoved.sort().join(', ')} read a NoEcho parameter whose value changed since the last deploy (its recorded MAC differs): the deploy sends it.`
    );
  }
  // The deploy reads back every resource a `NoEcho` parameter feeds, since
  // state holds only `***` there; this preview cannot, so it says so once.
  // Informational: it never counts as a change for `--fail`.
  const noEchoReaders = Object.keys(effectiveTemplate.Resources ?? {}).filter(
    (logicalId) =>
      changes.get(logicalId)?.changeType === 'NO_CHANGE' &&
      readsNoEchoSource(effectiveTemplate.Resources?.[logicalId]?.Properties, {
        parameters: noEchoParametersOf(effectiveTemplate),
        // Only the verdicts this diff knows narrow an `Fn::If`.
        ...(conditions !== undefined && {
          conditions: Object.fromEntries(
            Object.entries(conditions).filter(([name]) => !stillUnknown.includes(name))
          ),
        }),
      })
  );
  if (noEchoReaders.length > 0) {
    logger.info(
      safeMsg`Stack ${displayStackName(stackName)}: ${String(noEchoReaders.length)} unchanged resource(s) read a NoEcho parameter, whose value state holds only as ***: the deploy compares it with AWS, and updates a resource whose value changed.`
    );
  }

  // The deploy's nested-stack Type-change refusal (go-to-k/cdkd#3453), read
  // through the SAME finder over the same two inputs the engine hands it —
  // this diff's `changes` and the state after the orphan splice — so the
  // preview cannot disagree with it about which rows it refuses. Joins
  // `blocking` at every node, beside the adoption refusals: in a CDK
  // assembly a change to a child's template moves the parent row's
  // `TemplateURL` hash, so the deploy reaches the child engine where this
  // refusal runs.
  const nestedStackTypeChanges = findNestedStackTypeChanges({
    changes,
    stateResources: stateForDiff.resources,
  });
  if (nestedStackTypeChanges.length > 0) {
    blocking = [...blocking, ...nestedStackTypeChanges.map(nestedStackTypeChangeReason)];
  }

  // The deploy's ServiceToken refusal (go-to-k/cdkd#4749), through the SAME
  // finder over the same inputs. The diff takes no `--recreate-via-*`, so it
  // previews the flag-less deploy. A row the preview cannot judge (the token
  // reads a resource this deploy replaces, or a value it could not resolve)
  // is decided by the deploy once resolved, so it is a warning, not blocking.
  const serviceTokens = findServiceTokenRefusals({
    changes,
    stateResources: stateForDiff.resources,
  });
  if (serviceTokens.refused.length > 0) {
    blocking = [
      ...blocking,
      ...serviceTokens.refused.map((refusal) => serviceTokenBlockingReason(refusal, maskForLog)),
    ];
  }
  for (const row of serviceTokens.deferred) {
    logger.warn(printing.mask(deferredServiceTokenWarning(row)));
  }

  // The deploy's create-only drop refusal (issue #2790), through the SAME
  // predicate the engine refuses on, over this diff's rows and records. The
  // diff takes no `--prefer-sdk-route`, so it previews the flag-less deploy:
  // such a row shows a replacement that deploy refuses. A WARNING, not a
  // `blocking` reason: blocking means exit 3 ("cdkd deploy would refuse to
  // start"), but this deploy refuses only without the flag and only when it
  // reaches the resource, so a stack always deployed WITH the flag would
  // otherwise exit 3 on every `cdkd diff`. A key the SDK provider now writes
  // (#5572) is refused under any flag, but still only at the resource, after
  // other rows may have changed, so it is a warning too.
  for (const reason of findUnwrittenCreateOnlyRefusals(
    changes,
    stateForDiff.resources,
    ccRouteUnavailableReason
  )) {
    logger.warn(printing.mask(reason));
  }

  // The deploy's pre-flight refusal of a route-driving key on a type with no
  // Cloud Control route (issue #5600). A WARNING for the reason above: the
  // deploy refuses it only without `--prefer-sdk-route`, so a stack always
  // deployed WITH the flag would otherwise exit 3 on every `cdkd diff`.
  if (ccRouteUnavailableReason !== undefined) {
    const refusals = findUnroutableDropRefusals(
      effectiveTemplate,
      stateForDiff.resources,
      ccRouteUnavailableReason,
      (name) =>
        conditions !== undefined && Object.hasOwn(conditions, name) && !stillUnknown.includes(name)
    );
    for (const reason of refusals) logger.warn(printing.mask(reason));
  }

  // Issue #1921: the Outputs section, resolved through the SAME resolver /
  // conditions the resource diff just used. Resolving here rather than in a
  // second pass matters — parameter binding and condition evaluation can issue
  // SSM calls, and a separate entry point would pay for them twice.
  //
  // `effectiveTemplate` mirrors the deploy engine's no-change branch. Condition
  // pruning only rewrites `Resources`, so its `Outputs` are the raw template's.
  // `currentState.outputs` is passed for ONE decision inside the resolver — the
  // LITERAL `Export.Name` of a secret-bearing stack, which the preview cannot
  // evaluate deploy's predicate for but state can answer (issue #1942): the bag
  // holding that alias key proves a previous deploy published it. See the
  // resolver's own note for the different-value / absent-key rows.
  // `bindingSkipped` (issue #2740) is what lets the preview agree with a
  // deploy that SKIPPED an output whose failure happens inside a secret lookup
  // this resolver never makes; see the resolver's doc. Decided HERE rather
  // than beside the snapshot because it needs `changes`: an output referencing
  // a resource this deploy will touch must NOT bind — the deploy would take
  // the changed-resources path, re-resolve every output, and publish the row
  // (and its `Export.Name`) the record would otherwise have hidden.
  const changedLogicalIds = new Set(
    [...changes.values()].filter((c) => c.changeType !== 'NO_CHANGE').map((c) => c.logicalId)
  );
  const bindingSkipped = bindingSkippedOutputs(
    outputsDigestSource,
    currentState.skippedOutputs,
    changedLogicalIds
  );
  // The deploy's seed (go-to-k/cdkd#4043, Phase B): every `NoEcho` value,
  // and on a nested child each parent one a parameter carries. A whole
  // `{{resolve:...}}` token is no plaintext, as for the print corpus.
  const noEchoSeed = noEchoParameterValueSeed(
    effectiveTemplate.Parameters,
    mergedParameters,
    inheritedForResolver,
    parameters
  );
  // The condition verdicts this diff KNOWS: an `Fn::If` on an unknown one is
  // read as a whole by the positional readers below (review B5).
  const knownConditions =
    conditions === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(conditions).filter(([name]) => !stillUnknown.includes(name))
        );
  // An attribute the record declares `NoEcho` (a custom resource's, a nested
  // stack's output): the comparison below and the stale-alias gate read it.
  const recordDeclaresNoEchoAttribute = (logicalId: string, attribute: string): boolean => {
    const record = Object.hasOwn(stateForDiff.resources, logicalId)
      ? stateForDiff.resources[logicalId]
      : undefined;
    const names = record?.noEchoAttributeNames as unknown;
    return Array.isArray(names) && names.includes(attribute);
  };
  const resolved = await resolveTemplateOutputs(
    effectiveTemplate,
    resolveFn,
    conditions,
    currentState.outputs,
    bindingSkipped,
    {
      // `diffSecrets` as the PRINT-ONLY corpus: it holds every `NoEcho` value
      // up front, so the resolver's own lines over an output stay masked,
      // while the verdict reads only what this pass's bags recorded.
      resolveInto: (bag) => resolveRecordingInto(bag, diffSecrets),
      secrets: outputsPassSecrets,
      noEchoParameterValues: noEchoSeed,
      // The deploy's positional refusal (go-to-k/cdkd#4657).
      noEchoNameSources: {
        parameters: noEchoParametersOf(effectiveTemplate),
        ...(knownConditions !== undefined && { conditions: knownConditions }),
      },
      ...(inheritedNoEchoParametersAnyVerdict !== undefined && {
        noEchoNameParametersAnyVerdict: inheritedNoEchoParametersAnyVerdict,
      }),
      noEchoAttributeIsNoEcho: recordDeclaresNoEchoAttribute,
    }
  );
  // The RAW template too whenever a parameter is unbound or a condition has no
  // verdict (go-to-k/cdkd#4470):
  // main skipped condition evaluation for exactly those stacks and so scanned
  // the unpruned template, while known-FALSE pruning now runs first and can
  // drop the only secret reference — releasing a legacy stored output main
  // withheld (#1948).
  const templateHasSecretReference =
    resolved.templateHasSecretReference ||
    inheritSecretBearingTemplate === true ||
    (!everyConditionKnown && templateHasSecretDynamicReference(template));
  // go-to-k/cdkd#4043: an output a `NoEcho` source serves persists `***`, so
  // it is compared as `***` on both sides (a pre-v11 stored plaintext is the
  // migration witness); an unchanged one is no change, as for a resource.
  const outputTemplateValues: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const [name, definition] of Object.entries(effectiveTemplate.Outputs ?? {})) {
    outputTemplateValues[name] = (definition as { Value?: unknown } | undefined)?.Value;
  }
  const compareNoEchoOutputs = noEchoOutputsComparison(outputTemplateValues, {
    parameters: noEchoParametersOf(effectiveTemplate),
    attributeIsNoEcho: recordDeclaresNoEchoAttribute,
    ...(knownConditions !== undefined && { conditions: knownConditions }),
  });
  const diffOutputsAgainst = (
    rawDesired: Record<string, unknown>,
    exportNames: ReadonlySet<string>,
    forceLegacyRecord = false
  ): OutputChange[] => {
    const { current: storedOutputs, desired } = compareNoEchoOutputs(
      currentState.outputs,
      rawDesired
    );
    return computeOutputsDiff(storedOutputs, desired, exportNames, resolved.secretSourceKeys, {
      declaredKeys: resolved.declaredKeys,
      templateHasSecretReference,
      forceLegacyRecord,
      secretBearingExportNames: resolved.secretBearingExportNames,
      refusedNoEchoExportNames: resolved.refusedNoEchoExportNames,
      exportNameReadsNoEcho: resolved.exportNameReadsNoEcho,
      // A malformed `exportNames` (not a list) reads as none recorded, so the
      // alias test falls back to the key's own shape -- the wider refusal.
      storedExportNames: Array.isArray(currentState.exportNames)
        ? currentState.exportNames.filter((name): name is string => typeof name === 'string')
        : undefined,
    });
  };

  // A partially-resolved bag previews the deploy's NO-CHANGE merge when the
  // deploy will take that branch, and reports NO delta otherwise.
  //
  // The merge (issue #3101). With no resource change the deploy persists what
  // resolved and keeps each failed key's stored value (go-to-k/cdkd#2771), so a
  // sibling output added or changed beside a broken one IS written, and
  // suppressing it here let `--fail` exit 0 for a change the deploy makes. The
  // preview runs the deploy's own `mergeNoChangeOutputs` rather than a copy,
  // and only when `failuresMirrorDeploy` holds: every failure is one the deploy
  // records too (a throw, or `undefined`), named by output key.
  // `hasChanges` is the same predicate the deploy branches on.
  //
  // It also needs parameters that bound, and a template in which no condition
  // verdict can reach an output (`templateLetsConditionsReachOutputs`, whose
  // doc derives the routes). Conditions are evaluated best-effort here, so a
  // verdict can differ from the deploy's (a malformed `Fn::Sub` inside
  // `Fn::Equals` keeps its placeholder here and throws at deploy). The test is
  // not "declares no `Conditions`": every env-agnostic CDK app declares
  // `CDKMetadataAvailable` for its metadata resource alone. `everyConditionKnown`
  // is false when any parameter failed to bind, where a `Ref` to the unbound
  // parameter fails here and resolves at deploy, and when any condition has
  // no verdict (go-to-k/cdkd#4470). Both are shapes where the
  // preview KNOWS its resolution differs, so it keeps the suppression there.
  //
  // Everywhere the merge does run, a failure can still depend on something only
  // the deploy has: a secret this diff never fetches, used as a mapping key,
  // throws here and resolves at deploy, and the routes to such information are
  // not enumerable. So the preview never claims a failed output is unchanged:
  // it compares each one that has a stored value at that value, leaves the rest
  // out of the comparison, and a warning names both groups.
  //
  // The deploy runs the mixed-generation refusal TWICE: inside the merge, which
  // this preview shares, and again on the bag as its save redacts it
  // (`deploy-engine.ts`, after the observed-capture drain). The second check is
  // not reproduced here, and it CAN answer differently. This preview's own bag
  // never gains a late expression (it drains no captures and resolves with
  // `skipDynamicReferences`), but the DEPLOY's can: a secret recorded during
  // its drain whose plaintext equals a resolved literal output redacts that
  // output into an expression and turns `merged` into `kept`, the behaviour
  // `deploy-engine-outputs-only-change.test.ts` pins. What the deploy then
  // writes depends on the values: a row this preview showed may not be
  // written, and a late needle matching a STORED value makes the save redact
  // that value in whichever bag it keeps, a rewrite no diff path previews,
  // merge or not. `--strict-getatt` also departs from the preview: an output
  // whose resolution throws, or resolves to `undefined`, aborts the deploy
  // instead of reaching the merge.
  //
  // The suppression, everywhere else. With a resource change pending an output
  // usually fails because it references a resource this deploy has yet to
  // create — that CREATE is already on the resource side — and this preview
  // cannot tell it from an output that will fail again. Deploy's
  // changed-resources branch has no gate at all, correctly, because by then
  // every resource exists. Since issue #2740 a key the last deploy skipped is
  // dropped before this point and never sets the flag — but only while its
  // record still BINDS (digest unchanged, the key still absent from state, no
  // referenced resource changing this run). Fail any of those and the key
  // resolves here like any other.
  let outputChanges: OutputChange[] = [];
  if (!resolved.resolutionFailed) {
    outputChanges = diffOutputsAgainst(resolved.outputs, resolved.exportNames);
  } else {
    outputChanges = outputChangesAfterResolutionFailure({
      diffCalculator,
      changes,
      resolved,
      everyConditionKnown,
      template,
      currentState,
      effectiveTemplate,
      outputsPassSecrets,
      noEchoSeed,
      diffOutputsAgainst,
      stackName,
    });
  }

  // go-to-k/cdkd#4049: mask what this node PRINTS, at the value, once every
  // consumer that reads the values above has run. The human renderer and
  // `--json` both read these, so neither prints a `NoEcho` value. Only the
  // copies change: `stateForDiff`'s records are never written through.
  const printingSecrets = printing.corpus();
  let shownChanges = changes;
  let shownOutputChanges = outputChanges;
  let shownBlocking = blocking;
  let shownDeployRefusals = deployRefusals;
  // The MASK corpus, not `printingSecrets`: it adds the mask-only bags, so a
  // node whose only needles are a secret-derived name a row read
  // (`derivedNames`, go-to-k/cdkd#3869) still masks what it prints.
  if (hasMaskableValues(printing.maskCorpus())) {
    const mask: MaskerFn = printing.mask;
    // A refusal can quote a physical id or a record value that embeds one.
    // Masked after EACH sanitizing step, because each step can assemble a
    // needle the text before it did not hold: the strip DELETES control
    // characters, rejoining a needle one split, and `stripForDisplay` then
    // turns U+2028 / U+2029 into a space and trims, assembling a needle that
    // contains a space (`correct horse`). The middle mask is the one the strip
    // alone always had: it runs on text whose separators and edges are still
    // the needle's own, so a needle holding U+2028 or edge whitespace still
    // matches there. The renderer's `stripForDisplay` leaves the result
    // unchanged (go-to-k/cdkd#2888).
    const maskReason = (reason: string): string =>
      mask(stripForDisplay(mask(stripControlChars(mask(reason)))));
    shownBlocking = blocking.map(maskReason);
    shownDeployRefusals = deployRefusals.map(maskReason);
    shownChanges = new Map(
      [...changes].map(([logicalId, change]) => [
        logicalId,
        maskResourceChangeForDisplay(change, mask),
      ])
    );
    // With the up-front split pieces (go-to-k/cdkd#4049): display only.
    const nameCorpus = printingCorpusOf(printing.maskCorpus());
    shownOutputChanges = outputChanges.map((change) =>
      maskOutputChangeForDisplay(change, mask, nameCorpus)
    );
  }

  return {
    changes: shownChanges,
    securityDiff: () =>
      diffSecurity({
        stackName,
        changes: changes.values(),
        records: stateForDiff.resources,
        template: effectiveTemplate,
        secretMask: () => printing.mask,
      }),
    outputChanges: shownOutputChanges,
    adoptedOrphans,
    adoptedRecords,
    blocking: shownBlocking,
    unreadableOrphans,
    deployRefusals: shownDeployRefusals,
    effectiveTemplate,
    printingSecrets,
    derivedNames: diffPrintingSecrets([derivedNames, inheritedDerivedNames]),
    secretNamedRecords: secretNamedRecordNeedles(
      stateForDiff.resources,
      noEchoJudge(stateForDiff.resources)
    ),
    namingSecretsFor: noEchoJudge,
    resolvedParameters: mergedParameters,
    conditions,
    knownConditions:
      conditions === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(conditions).filter(([name]) => !stillUnknown.includes(name))
          ),
    trust: {
      parameters: trustedParameters,
      conditions: trustedConditions,
      resources: trustedResourceNames(
        effectiveTemplate,
        stateForDiff,
        changes,
        trustedParameters,
        trustedConditions,
        conditions
      ),
    },
  };
}
