/**
 * Shim: re-exports cdk-local's Lambda-ARN intrinsic resolver
 * (`resolveLambdaArnIntrinsic` — accepts `Ref` / `Fn::GetAtt: [.., 'Arn']`
 * / the REST-v1 invoke-ARN `Fn::Join` / `Fn::Sub` wrappers and returns a
 * discriminated outcome). The implementation lives in cdk-local and cdkd
 * consumes it verbatim instead of carrying a byte-identical copy. See
 * cdk-local's `src/local/intrinsic-lambda-arn.ts`.
 */
export { resolveLambdaArnIntrinsic, type LambdaArnResolveOutcome } from 'cdk-local';
