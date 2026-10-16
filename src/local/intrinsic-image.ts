/**
 * Boundary shim over cdk-local's container-image intrinsic resolver for
 * `cdkd local invoke` / `start-api` / `run-task` — resolves the canonical
 * CDK 2.x `Fn::Join` shape for ECR image URIs (`lambda.DockerImageCode.fromEcr`
 * / ECS `ContainerImage.fromEcrRepository`) and the same-stack ECR `Fn::GetAtt`
 * Arn / RepositoryUri synthesis. The implementation lives in cdk-local and
 * cdkd consumes it instead of carrying a byte-identical copy.
 * `ImageResolutionContext` is re-exported as a type. See cdk-local's
 * `src/local/intrinsic-image.ts`.
 *
 * Two of the three symbols are bare re-exports. `derivePseudoParametersFromRegion`
 * is NOT: it is wrapped, for the reason below.
 */

import { canonicalizeRegion } from '../utils/aws-partition.js';
import { derivePseudoParametersFromRegion as derivePseudoParametersFromRegionUpstream } from 'cdk-local/internal';

export {
  substituteImagePlaceholders,
  tryResolveImageFnJoin,
  type ImageResolutionContext,
} from 'cdk-local/internal';

/**
 * Derive `${AWS::Region}` / `${AWS::AccountId}` / `${AWS::Partition}` /
 * `${AWS::URLSuffix}` for the `Fn::Join` `Code.ImageUri` path (issue #637),
 * with the region CANONICALIZED to its lower-case spelling first.
 *
 * ## Why this is a wrapper rather than a re-export
 *
 * Issue [#1795](https://github.com/go-to-k/cdkd/issues/1795) canonicalizes the
 * region inside `derivePartitionAndUrlSuffix` (`src/utils/aws-partition.ts`),
 * so every cdkd-OWNED region -> partition/suffix derivation inherits ONE
 * normalization point. This helper is a FOURTH derivation that the fix
 * structurally could not reach (issue
 * [#1814](https://github.com/go-to-k/cdkd/issues/1814)): the implementation is
 * cdk-local's, and it carries its own partition table whose prefix tests are
 * case-sensitive in the same direction. So an upper-cased `--region CN-NORTH-1`
 * still fell through to the commercial partition here and synthesized
 * `<acct>.dkr.ecr.CN-NORTH-1.amazonaws.com/...` — a `cn-` region carrying the
 * commercial suffix, a host that does not exist — at the five call sites, across
 * three files, that reach this symbol:
 *
 * - `src/cli/commands/local-start-api.ts` (the `Fn::Join` `Code.ImageUri` path)
 * - `src/cli/commands/local-invoke-agentcore.ts` (x3)
 * - `src/local/lambda-resolver.ts`
 *
 * cdk-local's table now matches prefixes case-insensitively and carries the
 * three rows cdkd's issue #1764 added (issue
 * [#1831](https://github.com/go-to-k/cdkd/issues/1831)), so the PARTITION and
 * URL suffix agree with cdkd's table without this wrapper. The wrapper stays
 * for the returned `region`: upstream echoes its input unfolded, and that value
 * is substituted as `${AWS::Region}` into every ARN the resolver builds, so a
 * raw upper-cased region would misspell those. Canonicalizing the INPUT
 * (rather than post-processing the result) is what covers both.
 * {@link canonicalizeRegion} is idempotent, so this stays correct if upstream
 * later folds the region too.
 *
 * `undefined` passes through untouched — upstream answers `undefined` for a
 * missing region and that verdict is not this shim's to change.
 */
export function derivePseudoParametersFromRegion(
  region: string | undefined,
  accountId?: string
): ReturnType<typeof derivePseudoParametersFromRegionUpstream> {
  return derivePseudoParametersFromRegionUpstream(canonicalizeRegion(region), accountId);
}
