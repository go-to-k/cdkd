/**
 * Resource provider contract and CloudFormation template types.
 *
 * The declarations live in the sibling `resource/` directory; this entry
 * re-exports every one of them, so providers and callers keep importing
 * from `src/types/resource.ts` only.
 */
export type {
  CloudFormationTemplate,
  TemplateParameter,
  TemplateResource,
  TemplateOutput,
} from './resource/template.js';
export type {
  EffectivePropertiesResult,
  NoEchoAttributesResult,
  ResourceCreateResult,
  ResourceUpdateOutcome,
  ResourceUpdateResult,
  IndeterminateGuard,
  ResourceDeleteResult,
  ResourceImportInput,
  ResourceImportResult,
} from './resource/results.js';
export type {
  SecretMasker,
  SecretMaskingContext,
  UpdateContext,
  InlinePolicyPrincipalKind,
  InlinePolicyClaimed,
  CreateContext,
} from './resource/contexts.js';
export { RESOURCE_NOT_FOUND } from './resource/read-state.js';
export type {
  ResourceNotFound,
  ResourceIdentityVerdict,
  ReadCurrentStateContext,
} from './resource/read-state.js';
export type { DeleteContext, ResourceProvider, ProviderRegistry } from './resource/provider.js';
