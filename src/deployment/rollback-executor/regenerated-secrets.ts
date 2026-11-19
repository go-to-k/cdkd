import type { ResourceState } from '../../types/state.js';
import { type CompletedOperation } from './types.js';
import { deepEqual, isReplacementOp } from './plan/classify.js';
import { isStandaloneInlinePolicyType } from '../inline-policy-claims.js';
import { dynamicReferenceTokens } from '../secret-redaction.js';

/**
 * go-to-k/cdkd#6591: a rollback that REGENERATES a Secrets Manager secret.
 *
 * Reverting an in-place `AWS::SecretsManager::Secret` update whose
 * `GenerateSecretString` changed makes AWS generate a NEW value, as
 * CloudFormation's rollback does. A resource whose old record reads that secret
 * through a `{{resolve:secretsmanager:...}}` reference must then be restored
 * with the value the secret holds AFTER its revert, which is what
 * CloudFormation's dependency-ordered rollback sends. Two things stood in the
 * way: reverse completion order reverts such a reader BEFORE the secret, and
 * the replay pins each token to the version its record names (#4852), a
 * version the regeneration has just made stale.
 */

const SECRET_TYPE = 'AWS::SecretsManager::Secret';

/**
 * Does reverting `op` make AWS generate a new value for the secret? An
 * in-place UPDATE of a secret whose old record declares `GenerateSecretString`
 * and whose deployed record declares a different one: the provider regenerates
 * only when that block changed (#2472).
 */
export function revertRegeneratesSecret(
  op: CompletedOperation,
  stateResources: Record<string, ResourceState>
): boolean {
  if (op.changeType !== 'UPDATE' || op.resourceType !== SECRET_TYPE) return false;
  if (isReplacementOp(op)) return false;
  const current = Object.hasOwn(stateResources, op.logicalId)
    ? stateResources[op.logicalId]
    : undefined;
  const previousGenerate = op.previousState?.properties?.['GenerateSecretString'];
  if (previousGenerate === undefined || previousGenerate === null) return false;
  return !deepEqual(previousGenerate, current?.properties?.['GenerateSecretString']);
}

/**
 * The spellings a `{{resolve:secretsmanager:<id>:...}}` token may use for the
 * secret `op` reverted: its ARN (the physical id, what a CDK `Ref` renders)
 * and its recorded `Name`. A partial ARN or a name the record does not carry
 * matches nothing, so such a token keeps its pin.
 */
export function regeneratedSecretAddresses(op: CompletedOperation): Set<string> {
  const out = new Set<string>();
  const id = op.previousState?.physicalId;
  if (typeof id === 'string' && id !== '') out.add(id);
  const name = op.previousState?.properties?.['Name'];
  if (typeof name === 'string' && name !== '') out.add(name);
  return out;
}

/**
 * The SECRET_ID of a `{{resolve:secretsmanager:...}}` token, or `undefined`
 * for any other token. The id may be an ARN, which carries colons, so it ends
 * at the `:SecretString` / `:SecretBinary` segment, as the resolver splits it
 * (`resolveSecretsManagerReference`).
 */
export function secretsManagerTokenSecretId(token: string): string | undefined {
  const prefix = '{{resolve:secretsmanager:';
  if (!token.startsWith(prefix) || !token.endsWith('}}')) return undefined;
  const body = token.slice(prefix.length, -2);
  const cut = [':SecretString', ':SecretBinary']
    .map((segment) => {
      const mid = body.indexOf(`${segment}:`);
      if (mid >= 0) return mid;
      return body.endsWith(segment) ? body.length - segment.length : -1;
    })
    .filter((at) => at >= 0);
  const id = cut.length === 0 ? body : body.slice(0, Math.min(...cut));
  return id === '' ? undefined : id;
}

/** Does `leaf` hold a token addressing one of `addresses`? */
export function leafReadsSecret(leaf: string, addresses: ReadonlySet<string>): boolean {
  return dynamicReferenceTokens(leaf).some((token) => {
    const id = secretsManagerTokenSecretId(token);
    return id !== undefined && addresses.has(id);
  });
}

/**
 * Step 1's order with every op whose old record depends on a regenerated
 * secret moved to just after that secret's revert, so its restore resolves the
 * value the secret holds once reverted. The limits mirror
 * `orderDeleteFirstAfterDependencies`: never past an op that depends on the
 * moved one, nor past a standalone inline policy (#4821); processed
 * latest-first and repeated until nothing moves, bounded.
 */
export function orderAfterRegeneratedSecrets(
  ops: readonly CompletedOperation[],
  stateResources: Record<string, ResourceState>
): CompletedOperation[] {
  const out = [...ops];
  const secrets = new Set(
    ops.filter((op) => revertRegeneratesSecret(op, stateResources)).map((op) => op.logicalId)
  );
  if (secrets.size === 0) return out;
  for (let pass = 0; pass < out.length; pass++) {
    let moved = false;
    for (const op of [...out].reverse()) {
      if (op.changeType === 'CREATE') continue;
      const deps = new Set(
        (Array.isArray(op.previousState?.dependencies) ? op.previousState.dependencies : []).filter(
          (id): id is string => typeof id === 'string' && id !== op.logicalId && secrets.has(id)
        )
      );
      if (deps.size === 0) continue;
      const from = out.indexOf(op);
      let last = -1;
      out.forEach((other, at) => {
        if (other !== op && deps.has(other.logicalId)) last = at;
      });
      if (last <= from) continue;
      const between = out.slice(from + 1, last + 1);
      if (
        between.some(
          (other) =>
            isStandaloneInlinePolicyType(other.resourceType) ||
            (Array.isArray(other.previousState?.dependencies) &&
              other.previousState.dependencies.includes(op.logicalId)) ||
            (Array.isArray(stateResources[other.logicalId]?.dependencies) &&
              stateResources[other.logicalId]!.dependencies!.includes(op.logicalId))
        )
      ) {
        continue;
      }
      out.splice(from, 1);
      out.splice(last, 0, op);
      moved = true;
    }
    if (!moved) break;
  }
  return out;
}
