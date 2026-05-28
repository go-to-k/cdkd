/**
 * Shim: re-exports cdk-local's container-image intrinsic resolver for
 * `cdkd local invoke` / `start-api` / `run-task` — resolves the canonical
 * CDK 2.x `Fn::Join` shape for ECR image URIs (`lambda.DockerImageCode.fromEcr`
 * / ECS `ContainerImage.fromEcrRepository`) and the same-stack ECR `Fn::GetAtt`
 * Arn / RepositoryUri synthesis. The implementation lives in cdk-local and
 * cdkd consumes it verbatim instead of carrying a byte-identical copy.
 * `ImageResolutionContext` is re-exported as a type. See cdk-local's
 * `src/local/intrinsic-image.ts`.
 */
export {
  derivePseudoParametersFromRegion,
  substituteImagePlaceholders,
  tryResolveImageFnJoin,
  type ImageResolutionContext,
} from 'cdk-local';
