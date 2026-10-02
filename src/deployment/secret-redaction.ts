/**
 * Secret redaction for resolved dynamic references. The implementation lives in
 * `secret-redaction/*.ts` (issue #4415); this module re-exports exactly the names
 * it always exported, so no importer changes.
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
  wholeStringLeavesOf,
  carriesSecretMask,
  recordDerivedMaskOnlyValue,
  recordFreshNoEchoValuesIn,
  carryFreshNoEchoMark,
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
  isSecretExpressionByVerdictOrSpelling,
  DYNAMIC_REFERENCE_INNER,
  WHOLE_DYNAMIC_REFERENCE_PATTERN,
  isSingleDynamicReferenceToken,
} from './secret-redaction/rules.js';
export { intrinsicSkeletonPattern, identityKeyFor } from './secret-redaction/positions.js';
export {
  pathCrossesDottedKey,
  isUncertifiedBaselineMaskPosition,
  DYNAMIC_REFERENCE_TOKEN_SCAN,
  dynamicReferenceTokens,
} from './secret-redaction/redact-path.js';
export { spanNamesResolvableService } from './secret-redaction/anchors.js';
export { redactSecretsForState, scrubResourceRecord } from './secret-redaction/redact-state.js';
export {
  maskSecretsInText,
  maskRecordedSecretsInText,
  ERROR_CAUSE_MASK_MAX_DEPTH,
  errorCauseChain,
  maskSecretsInError,
  type SecretMasker,
  createSecretMasker,
} from './secret-redaction/mask-errors.js';
