/**
 * The resolver's condition, mapping, encoding, AZ, pseudo-parameter and Cidr
 * functions. Each family's body lives in `./functions/` (issue #5835); this
 * module re-exports them so every importer keeps importing from here.
 */
export {
  resolveIf,
  resolveEquals,
  resolveConditionReference,
  resolveAnd,
  resolveOr,
  resolveNot,
} from './functions/conditions.js';
export { resolveFindInMap } from './functions/find-in-map.js';
export { resolveBase64 } from './functions/base64.js';
export { resolveGetAZs } from './functions/get-azs.js';
export { resolvePseudoParameter } from './functions/pseudo-parameter.js';
export { resolveCidr, expandIPv6, ipv6ToBigInt, bigIntToIPv6 } from './functions/cidr.js';
