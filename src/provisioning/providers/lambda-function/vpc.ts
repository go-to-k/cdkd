import type { LambdaFunctionProvider } from '../lambda-function-provider.js';
import type { VpcConfig } from '@aws-sdk/client-lambda';

/**
 * Build Lambda VpcConfig parameter from CDK properties.
 *
 * Returns undefined when VpcConfig is unset, so the SDK leaves the function
 * outside any VPC. Returns an empty config (no subnets, no SGs) when caller
 * explicitly clears it on update — that detaches the function from its VPC.
 */
export function buildVpcConfig(this: LambdaFunctionProvider, raw: unknown): VpcConfig | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== 'object') {
    return undefined;
  }
  const vpc = raw as Record<string, unknown>;
  const result: VpcConfig = {};
  if (Array.isArray(vpc['SubnetIds'])) {
    result.SubnetIds = vpc['SubnetIds'] as string[];
  }
  if (Array.isArray(vpc['SecurityGroupIds'])) {
    result.SecurityGroupIds = vpc['SecurityGroupIds'] as string[];
  }
  if (typeof vpc['Ipv6AllowedForDualStack'] === 'boolean') {
    result.Ipv6AllowedForDualStack = vpc['Ipv6AllowedForDualStack'];
  }
  return result;
}

/**
 * Build VpcConfig for an update call, accounting for VPC detach.
 *
 * UpdateFunctionConfiguration treats an absent VpcConfig as "no change",
 * so omitting it cannot move a function out of its existing VPC. To
 * detach we must explicitly send empty SubnetIds / SecurityGroupIds.
 */
export function buildVpcConfigForUpdate(
  this: LambdaFunctionProvider,
  newRaw: unknown,
  previousRaw: unknown
): VpcConfig | undefined {
  const next = this.buildVpcConfig(newRaw);
  if (next) {
    return next;
  }
  if (this.hasVpcConfig(previousRaw)) {
    return { SubnetIds: [], SecurityGroupIds: [] };
  }
  return undefined;
}

/**
 * Normalize a template `Environment` block for UpdateFunctionConfiguration.
 *
 * `Environment: {}` (present, but no `Variables` key — a hand-written L1 /
 * imported-template shape CDK never emits) passed through verbatim does NOT
 * clear the live env vars: the API keeps the old `Variables` when the input
 * `Environment` carries none (live-verified 2026-07-22, issue #1158). The
 * template's declarative meaning is "no env vars", so a Variables-less
 * block is rewritten to the explicit-clear `{Variables: {}}`. A present
 * `Variables` map (even empty) and an absent `Environment` pass through
 * unchanged — removal handling stays with `removalDefaults`. A `null`
 * block (hand-written JSON) is treated like absent rather than crashing on
 * the property read.
 */
export function normalizeEnvironmentForUpdate(
  this: LambdaFunctionProvider,
  environment: { Variables?: Record<string, string> } | undefined
): { Variables?: Record<string, string> } | undefined {
  if (environment == null) return undefined;
  if (environment.Variables === undefined) return { Variables: {} };
  return environment;
}

/**
 * Determine whether the function actually attaches to a VPC, i.e. has at
 * least one Subnet ID. A bare VpcConfig with empty arrays does not create
 * any ENIs, so we skip the wait in that case.
 */
export function hasVpcConfig(this: LambdaFunctionProvider, raw: unknown): boolean {
  if (raw === undefined || raw === null || typeof raw !== 'object') {
    return false;
  }
  const vpc = raw as Record<string, unknown>;
  const subnets = vpc['SubnetIds'];
  return Array.isArray(subnets) && subnets.length > 0;
}
