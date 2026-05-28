/**
 * Shim: re-exports cdk-local's state-substitution engine used by
 * `cdkd local invoke` / `start-api` / `run-task` / `start-service` to resolve
 * intrinsic-valued env-var / image / role / volume values against a state
 * source (cdkd's S3 `--from-state` or a deployed CFn stack via
 * `--from-cfn-stack`). Supports `Ref` / `Fn::GetAtt` / `Fn::Sub` / `Fn::Join` /
 * `Fn::Select` / `Fn::Split` plus async `Fn::ImportValue` / `Fn::GetStackOutput`
 * via a cross-stack resolver, and reports per-key unresolved reasons. The
 * implementation lives in cdk-local and cdkd consumes it verbatim instead of
 * carrying a byte-identical copy. See cdk-local's `src/local/state-resolver.ts`.
 */
export {
  substituteAgainstState,
  substituteAgainstStateAsync,
  substituteEnvVarsFromState,
  substituteEnvVarsFromStateAsync,
  type CrossStackResolver,
  type SubstitutionContext,
  type StateEnvSubstitutionAudit,
  type PseudoParameters,
} from 'cdk-local';
