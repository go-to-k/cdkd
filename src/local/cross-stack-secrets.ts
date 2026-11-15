/**
 * Whether a value cdkd's `--from-state` cross-stack resolver returned holds a
 * PRODUCER stack's secret (go-to-k/cdkd#6337).
 *
 * `cdkd local run-task` keeps a same-stack secret off the `docker run` argv
 * (go-to-k/cdkd#6330) by reading the consumer's own state, which says nothing
 * about a value read through `Fn::ImportValue` / `Fn::GetStackOutput`: an
 * `AWS::AppSync::ApiKey` exported by another stack reached the argv as
 * plaintext. cdk-local's `CrossStackResolver` contract returns the value only,
 * so the resolver `buildCrossStackResolver` builds carries this check BESIDE
 * that contract, and cdkd's own post-pass (`applyCrossStackResolverToTask`)
 * reads it through {@link producerSecretCheckOf}. A resolver without it (the
 * `--from-cfn-stack` one cdk-local builds) is not judged here.
 */
import { SECRET_MASK } from '../deployment/secret-redaction.js';
import { secretSegmentsOfState } from '../provisioning/secret-physical-id.js';
import { isSecretValuedAttribute, isSensitiveAttributeName } from '../utils/stringify.js';
import type { CrossStackResolver } from './state-resolver.js';

/** The check a cdkd-built resolver carries beside cdk-local's contract. */
export interface ProducerSecretCheck {
  /**
   * Why `value`, which this resolver returned, must not be served where it
   * prints (the `docker run` argv), or `undefined` when it holds no producer
   * secret this resolver read.
   */
  producerSecretReason(value: string): string | undefined;
}

/** The {@link ProducerSecretCheck} a resolver carries, if it carries one. */
export function producerSecretCheckOf(
  resolver: CrossStackResolver | undefined
): ProducerSecretCheck | undefined {
  const check = (resolver as Partial<ProducerSecretCheck> | undefined)?.producerSecretReason;
  if (typeof check !== 'function') return undefined;
  return { producerSecretReason: (value) => check.call(resolver, value) };
}

/** Shortest needle matched INSIDE a longer value; a shorter one only whole. */
const SUBSTRING_FLOOR = 4;

/** Every string leaf of `value`. */
function stringLeaves(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringLeaves(v, out);
  else if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) stringLeaves(v, out);
  }
  return out;
}

/**
 * The secrets a producer state records in plaintext: the bearer-credential
 * segments of its physical ids and secret-named nested-stack outputs
 * ({@link secretSegmentsOfState}), and the leaves of every attribute whose
 * name or type says it is a secret (`AWS::IAM::AccessKey`'s
 * `SecretAccessKey`, an ApiKey's `ApiKey`) — the attributes the same-stack
 * check refuses (`secretAttributeRead`). The mask and a `{{resolve:` reference
 * are no plaintext: the post-pass handles both on their own.
 */
export function producerSecretNeedles(state: unknown): string[] {
  const needles = secretSegmentsOfState(state);
  const resources =
    state !== null && typeof state === 'object'
      ? (state as { resources?: unknown }).resources
      : undefined;
  if (resources !== null && typeof resources === 'object' && !Array.isArray(resources)) {
    for (const record of Object.values(resources)) {
      if (record === null || typeof record !== 'object') continue;
      const r = record as { resourceType?: unknown; attributes?: unknown };
      const attributes = r.attributes;
      if (attributes === null || typeof attributes !== 'object' || Array.isArray(attributes)) {
        continue;
      }
      const type = typeof r.resourceType === 'string' ? r.resourceType : undefined;
      for (const [name, stored] of Object.entries(attributes)) {
        if (!isSensitiveAttributeName(name) && !isSecretValuedAttribute(type, name)) continue;
        needles.push(...stringLeaves(stored));
      }
    }
  }
  return needles.filter((n) => n !== '' && n !== SECRET_MASK && !n.includes('{{resolve:'));
}

/** Whether `value` holds one of `needles`. */
export function holdsNeedle(value: string, needles: Iterable<string>): boolean {
  for (const needle of needles) {
    if (value === needle) return true;
    if (needle.length >= SUBSTRING_FLOOR && value.includes(needle)) return true;
  }
  return false;
}

/**
 * The per-resolver record behind {@link ProducerSecretCheck}: the needles of
 * every producer state the resolver read, and the values it served without
 * reading their producer's state (fail closed).
 */
export class ProducerSecretLedger implements ProducerSecretCheck {
  private readonly needles = new Set<string>();
  private readonly unverified = new Set<string>();

  /** Note the secrets of a producer state the resolver read a value from. */
  public noteProducerState(state: unknown): void {
    for (const needle of producerSecretNeedles(state)) this.needles.add(needle);
  }

  /** Note a value served while its producer's state could not be read. */
  public noteUnverified(value: string): void {
    this.unverified.add(value);
  }

  public producerSecretReason(value: string): string | undefined {
    if (holdsNeedle(value, this.needles)) {
      return 'resolved a cross-stack value holding a secret of the producer stack, which cdkd will not put on the docker run command line; pass the value through Environment or Secrets instead';
    }
    if (this.unverified.has(value)) {
      return "resolved a cross-stack value whose producer stack's state cdkd could not read to check it for secrets, which cdkd will not put on the docker run command line; pass the value through Environment or Secrets instead";
    }
    return undefined;
  }
}
