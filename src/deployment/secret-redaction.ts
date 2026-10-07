/**
 * Secret redaction for resolved dynamic references (GHSA fix).
 *
 * CloudFormation dynamic references (`{{resolve:secretsmanager:...}}`) are
 * resolved to plaintext by `IntrinsicFunctionResolver.resolveDynamicReferences`
 * so the concrete secret can be handed to the AWS API on create / update. That
 * plaintext must NEVER be persisted to cdkd state or shown in CLI output, or
 * anyone with read access to the state bucket / terminal logs recovers the
 * secret — which defeats the entire point of storing it in Secrets Manager.
 *
 * The resolver records, per resolution pass, every plaintext secret VALUE it
 * substituted together with the original `{{resolve:...}}` expression it came
 * from (a `RecordedSecretValues` map on `ResolverContext`). This module turns
 * that record into two pure operations:
 *
 * - {@link redactSecretsForState} rewrites the bag cdkd is about to PERSIST so
 *   each secret value is replaced by the original unresolved expression. This
 *   is CloudFormation-parity: CFn keeps the `{{resolve:...}}` reference in the
 *   template and resolves it service-side, so the concrete value never lands in
 *   a persisted artifact. cdkd reaches that outcome only where this function is
 *   actually called with a usable position source — it FAILS OPEN at positions
 *   it cannot certify (go-to-k/cdkd#2852), and callers that pass
 *   `NO_RECORDED_SECRETS` or bypass it entirely still persist plaintext
 *   (go-to-k/cdkd#2846, go-to-k/cdkd#2847). Storing the expression (rather than
 *   a blind `***`
 *   marker) also means the next `cdkd deploy` diffs expression-vs-expression
 *   and does not spuriously re-apply the resource on every run.
 *
 * - {@link maskSecretsInText} replaces any known secret value inside an
 *   arbitrary string with a fixed marker, for log / error-message paths where
 *   the resolved value would otherwise be echoed (`Fn::Join` / `Fn::Sub` debug
 *   lines, the Cloud Control JSON-patch log, AWS validation errors quoting the
 *   offending value).
 *
 * {@link maskSecretsInText} works by VALUE match alone: a resolved secret is a
 * distinctive plaintext string, so a value scan covers the embedded cases
 * uniformly without threading a path argument through every resolver method.
 * Over-redaction (a coincidental match elsewhere) is harmless and the safe
 * direction; under-redaction would leak a secret, so a match is always
 * replaced. {@link redactSecretsForState} layers POSITION on top of that scan —
 * see its own doc and {@link redactByPath} — because a value match cannot tell
 * two expressions apart once they resolve to the same plaintext.
 *
 * The module is a LEAF — it imports nothing outside `secret-redaction/` —
 * because both the resolver and the deploy engine consume it and both already
 * sit on a dense import ring.
 *
 * This file is a barrel: the implementation lives in `secret-redaction/*.ts`
 * (issue #4415), and it re-exports exactly the names it always exported, so no
 * importer changes. Import from here, never from a sibling directly.
 */
export {
  type RecordedSecretValues,
  SECRET_MASK,
  recordResolvedPair,
  mergeResolvedPairs,
  type DynamicReferenceSubstitution,
  type IntrinsicLeafResolution,
  recordIntrinsicLeafResolution,
  intrinsicLeafResolutionOf,
  recordIntrinsicLeafResolutionAs,
  markSameGenerationBag,
  isSameGenerationBag,
} from './secret-redaction/pairs.js';
export {
  recordSecretExpression,
  forgetSecretExpression,
  isRecordedSecretExpression,
  clearRecordedSecretExpressions,
  recordMaskOnlyValue,
  recordMaskOnlyValuesIn,
  recordNoEchoAttributeValues,
  wholeStringLeavesOf,
  carriesSecretMask,
  recordDerivedMaskOnlyValue,
  recordFreshNoEchoValuesIn,
  carryFreshNoEchoMark,
  isSecretExpressionByVerdictOrSpelling,
  recordNoEchoParameterFreshValue,
  isNoEchoParameterPlaintext,
  noEchoParameterPlaintextsOf,
  noEchoParameterValuesOf,
  withoutNoEchoParameterEntries,
  markNoEchoParameterClass,
  freshNoEchoValuesOf,
  isMaskOnlyPlaintext,
} from './secret-redaction/mask-only.js';
export {
  recordLogOnlyValue,
  carryLogOnlyValues,
  carryLogOnlyValuesCarriedBy,
  recordLogOnlySplitFragments,
  shareLogOnlyValues,
  recordLogOnlyParameterValue,
  literalSplitDelimitersOf,
  printingCorpusOf,
  logOnlyValueCount,
  unionOfSecretBags,
  createUnionSecretMasker,
  hasLogOnlyValues,
  hasMaskableValues,
} from './secret-redaction/log-only.js';
export {
  embedsFreshNoEchoValue,
  carriesFreshNoEchoValue,
  type FreshNoEchoLeaf,
  type FreshNoEchoClass,
  freshNoEchoLeafPositions,
  recordRecoverableMaskedOutput,
  recoverMaskedOutput,
  clearRecoverableMaskedOutputs,
} from './secret-redaction/fresh-noecho.js';
export {
  splitGetAttStringForm,
  crossStackSourceKey,
  recordCrossStackExpression,
} from './secret-redaction/cross-stack.js';
export {
  recordNestedStackParameterExpressions,
  inheritNestedStackParameterAssociations,
  inheritedParameterExpression,
  recordInheritedParameterRead,
  redactInheritedParameterValue,
} from './secret-redaction/nested-stack.js';
export {
  MIN_NEEDLE_LENGTH,
  type PathSourceRules,
  TEMPLATE_DERIVED_RULES,
  TEMPLATE_SOURCED_RULES,
  STATE_SOURCED_READBACK_RULES,
  STATE_SOURCED_BASELINE_RULES,
  STATE_SOURCED_CROSS_GENERATION_RULES,
  STATE_DERIVED_RULES,
  DYNAMIC_REFERENCE_INNER,
  WHOLE_DYNAMIC_REFERENCE_PATTERN,
  isSingleDynamicReferenceToken,
} from './secret-redaction/rules.js';
export { intrinsicSkeletonPattern } from './secret-redaction/positions.js';
export { identityKeyFor } from './secret-redaction/identity-keys.js';
export {
  pathCrossesDottedKey,
  isUncertifiedBaselineMaskPosition,
  DYNAMIC_REFERENCE_TOKEN_SCAN,
  dynamicReferenceTokens,
} from './secret-redaction/redact-path.js';
export { spanNamesResolvableService } from './secret-redaction/anchors.js';
export { liveMatchesUnresolvedTokenFrame } from './secret-redaction/unresolved-token-frame.js';
export { redactSecretsForState, scrubResourceRecord } from './secret-redaction/redact-state.js';
export {
  type NoEchoCoordinate,
  type NoEchoPositionSources,
  readsNoEchoSource,
  noEchoCoordinatesOf,
  maskWholeValue,
  valueAtCoordinate,
  maskAtCoordinates,
  maskReadbackAtCoordinates,
  maskedLeafCoordinatesOf,
  recordPassedNoEchoParameters,
  passedNoEchoParametersOf,
  canonicalCoordinates,
  noEchoLeavesOf,
  isMarkedCoordinate,
  witnessNormalize,
  noEchoComparison,
  noEchoOutputsComparison,
  PREVIOUS_NOECHO_VALUE,
} from './secret-redaction/noecho-leaves.js';
export {
  maskSecretsInText,
  maskRecordedSecretsInText,
  ERROR_CAUSE_MASK_MAX_DEPTH,
  errorCauseChain,
  maskSecretsInError,
  type SecretMasker,
  createSecretMasker,
} from './secret-redaction/mask-errors.js';
