export { recordNestedStackParameterExpressions } from './nested-stack/record-parameter-expressions.js';
export { nestedStackRowTagSpellingOf } from './nested-stack/row-tag-spellings.js';
export {
  inheritNestedStackParameterAssociations,
  inheritedParameterExpression,
  inheritedRenderedToken,
  withdrawRenderedParameterSpelling,
  inheritedRenderedSpan,
  recordInheritedParameterValue,
  recordInheritedParameterRead,
  redactInheritedParameterValue,
  positionByInheritedParameter,
} from './nested-stack/inherited-parameters.js';
export {
  templateRereadsAccountId,
  recordInheritedPseudoParameters,
  inheritedPseudoValue,
  inheritedPseudoSpan,
} from './nested-stack/pseudo-parameters.js';
export type { ParameterBinding } from './nested-stack/pseudo-parameters.js';
export {
  splitOutsideDynamicReferences,
  standsForInheritedSecret,
  rereadParameterExpression,
  positionByParameterReread,
} from './nested-stack/reread.js';
