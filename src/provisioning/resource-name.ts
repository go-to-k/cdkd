export {
  withStackScopeBeforeStateRead,
  withStackScope,
  isNameGeneration,
  withNameGeneration,
  currentNameGeneration,
  getCurrentStackName,
  isBeforeStateRead,
  getCurrentStackInstanceId,
  withSkipPrefix,
  getCurrentSkipPrefix,
} from './resource-name/stack-scope.js';
export type { StackScope } from './resource-name/stack-scope.js';
export {
  PATTERN_B_RESOURCE_TYPES,
  PATTERN_B_NAME_PROPERTIES,
  PATTERN_B_NAME_OPTIONS,
  derivesPatternBName,
  STACK_INSTANCE_SUFFIX_LENGTH,
  stackInstanceNameSuffix,
  generateResourceName,
  looksLikeCdkdGeneratedName,
  generateResourceNameWithFallback,
  recordedGeneratedNameKept,
} from './resource-name/generate.js';
export type { ResourceNameOptions } from './resource-name/generate.js';
export {
  generatedNameFor,
  applyDefaultNameForFallback,
  fallbackNameRuleTypes,
  fallbackNamePropertyFor,
  fallbackNamePathFor,
  withoutGeneratedFallbackName,
  explicitNamePropertyFor,
  alternateNamePropertiesFor,
} from './resource-name/fallback.js';
export type { GeneratedNameInput } from './resource-name/fallback.js';
