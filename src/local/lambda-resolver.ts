export type {
  ResolvedLambda,
  ResolvedLambdaLayer,
  ResolvedAssetLambdaLayer,
  ResolvedArnLambdaLayer,
  ResolvedZipLambda,
  ResolvedImageLambda,
} from './lambda-resolver/types.js';
export { LocalInvokeResolutionError } from './lambda-resolver/types.js';
export type { ParsedTarget } from './lambda-resolver/target.js';
export { parseTarget, resolveLambdaTarget } from './lambda-resolver/target.js';
export { extractEphemeralStorageMb } from './lambda-resolver/properties.js';
export type { AssetCodeResolveOptions } from './lambda-resolver/asset-code.js';
export { resolveAssetCodeDirectory, assetPathDirs } from './lambda-resolver/asset-code.js';
export type {
  ParsedLayerVersionArn,
  LayerArnRejection,
  LayerArnClassification,
} from './lambda-resolver/layers.js';
export { resolveLambdaLayers, classifyLayerVersionArn } from './lambda-resolver/layers.js';
