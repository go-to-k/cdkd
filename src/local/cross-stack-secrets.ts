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
import { producerRecordKey } from '../state/record-keys.js';
import { importableOutputKeys } from '../types/state.js';
import { describeAwsFailure } from '../utils/aws-failure-text.js';
import { displayIdent } from '../utils/display-safe.js';
import { isSecretValuedAttribute, isSensitiveAttributeName } from '../utils/stringify.js';
import type { CrossStackResolver } from './state-resolver.js';

/**
 * What a cdkd-built resolver knows of a value it returned: `secret` when it
 * holds a secret its producer's state records, `unverified` when the
 * producer's state could not be read to tell (fail closed).
 */
export type ProducerSecretVerdict = 'secret' | 'unverified';

/** The check a cdkd-built resolver carries beside cdk-local's contract. */
export interface ProducerSecretCheck {
  /**
   * The verdict on `value`, which this resolver returned, or `undefined` when
   * it holds no producer secret this resolver read.
   */
  producerSecretOf(value: string): ProducerSecretVerdict | undefined;
}

/** The {@link ProducerSecretCheck} a resolver carries, if it carries one. */
export function producerSecretCheckOf(
  resolver: CrossStackResolver | undefined
): ProducerSecretCheck | undefined {
  const check = (resolver as Partial<ProducerSecretCheck> | undefined)?.producerSecretOf;
  if (typeof check !== 'function') return undefined;
  return { producerSecretOf: (value) => check.call(resolver, value) };
}

/**
 * Shortest id SEGMENT matched inside a longer value (`secret-physical-id.ts`'s
 * masking floor); a shorter one only whole.
 */
const SEGMENT_SUBSTRING_FLOOR = 4;

/**
 * Shortest attribute LEAF matched inside a longer value. A secret-named
 * attribute can hold a short ordinary word (a nested stack's
 * `Outputs.PasswordPolicy` of `strict`), which must not refuse every export
 * containing it; the credentials these leaves stand for are far longer.
 */
const LEAF_SUBSTRING_FLOOR = 16;

/** Every string leaf of `value` with its dotted path under `name`. */
function namedLeaves(
  name: string,
  value: unknown,
  out: { path: string; leaf: string }[] = []
): { path: string; leaf: string }[] {
  if (typeof value === 'string') out.push({ path: name, leaf: value });
  else if (Array.isArray(value)) value.forEach((v, i) => namedLeaves(`${name}.${i}`, v, out));
  else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) namedLeaves(`${name}.${k}`, v, out);
  }
  return out;
}

/** A value that is plaintext, not the mask or a reference the post-pass handles. */
const isPlaintext = (n: string): boolean =>
  n !== '' && n !== SECRET_MASK && !n.includes('{{resolve:');

/** The needles of one producer state, by how each is matched. */
export interface ProducerSecretNeedles {
  /** Bearer-credential id segments ({@link secretSegmentsOfState}). */
  segments: string[];
  /** Leaves of attributes whose name or type says they are secrets. */
  leaves: string[];
}

/**
 * The secrets a producer state records in plaintext: the bearer-credential
 * segments of its physical ids and secret-named nested-stack outputs
 * ({@link secretSegmentsOfState}), and the leaves of every attribute whose
 * dotted name (`MasterUserSecret.SecretArn` is an ARN, not a secret) or type
 * says it is a secret (`AWS::IAM::AccessKey`'s `SecretAccessKey`, an ApiKey's
 * `ApiKey`) -- the attributes the same-stack check refuses
 * (`secretAttributeRead`).
 */
export function producerSecretNeedles(state: unknown): ProducerSecretNeedles {
  const segments = secretSegmentsOfState(state).filter(isPlaintext);
  const leaves: string[] = [];
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
        const typed = isSecretValuedAttribute(type, name);
        for (const { path, leaf } of namedLeaves(name, stored)) {
          if ((typed || isSensitiveAttributeName(path)) && isPlaintext(leaf)) leaves.push(leaf);
        }
      }
    }
  }
  return { segments, leaves };
}

/** Whether `value` is `needle`, or holds it and the needle reaches `floor`. */
function holds(value: string, needle: string, floor: number): boolean {
  return value === needle || (needle.length >= floor && value.includes(needle));
}

/**
 * The per-resolver record behind {@link ProducerSecretCheck}: the needles of
 * every producer state the resolver read, and the values it served without
 * reading their producer's state.
 */
export class ProducerSecretLedger implements ProducerSecretCheck {
  private readonly segments = new Set<string>();
  private readonly leaves = new Set<string>();
  private readonly unverified = new Set<string>();

  /** Note the secrets of a producer state (or a nested child's) the resolver read. */
  public noteProducerState(state: unknown): void {
    const { segments, leaves } = producerSecretNeedles(state);
    for (const s of segments) this.segments.add(s);
    for (const l of leaves) this.leaves.add(l);
  }

  /** Note a value served while the state that could judge it could not be read. */
  public noteUnverified(value: string): void {
    this.unverified.add(value);
  }

  public producerSecretOf(value: string): ProducerSecretVerdict | undefined {
    for (const s of this.segments) if (holds(value, s, SEGMENT_SUBSTRING_FLOOR)) return 'secret';
    for (const l of this.leaves) if (holds(value, l, LEAF_SUBSTRING_FLOOR)) return 'secret';
    return this.unverified.has(value) ? 'unverified' : undefined;
  }
}

/** The argv refusal for a value with `verdict`. */
export function producerSecretArgvReason(verdict: ProducerSecretVerdict): string {
  return verdict === 'secret'
    ? 'resolved a cross-stack value holding a secret of the producer stack, which cdkd will not put on the docker run command line; pass the value through Environment or Secrets instead'
    : "resolved a cross-stack value whose producer stack's state cdkd could not read to check it for secrets, which cdkd will not put on the docker run command line; pass the value through Environment or Secrets instead";
}

/** Why a `Secrets` `ValueFrom` resolving to a value with `verdict` is dropped. */
export function producerSecretValueFromReason(verdict: ProducerSecretVerdict): string {
  return verdict === 'secret'
    ? 'ValueFrom resolved a cross-stack value holding a secret of the producer stack, rather than naming a Secrets Manager secret or an SSM parameter'
    : "ValueFrom resolved a cross-stack value whose producer stack's state cdkd could not read to check it for secrets";
}

/**
 * An Output value as the resolver serves it: a scalar as its string, anything
 * else as JSON.
 */
export function servedOutputValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** The nested-stack row type whose child record holds the row's outputs. */
const NESTED_STACK_TYPE = 'AWS::CloudFormation::Stack';

/** A backstop on the nested walk, far past any real tree. */
const MAX_NESTED_DEPTH = 32;

/**
 * Reads what {@link ProducerSecretLedger} needs from cdkd state, for the
 * resolver `buildCrossStackResolver` builds: each producer record a value was
 * served from, and the nested-stack child records under it (`<parent>~<id>`),
 * since a parent output can carry a child's secret only the child's record
 * names (the union a nested tree's masking takes, `cdkd state show`). Each
 * record is read once.
 */
export class ProducerSecretReader implements ProducerSecretCheck {
  private readonly ledger = new ProducerSecretLedger();
  private readonly reads = new Map<string, Promise<unknown>>();
  private readonly walked = new Map<string, Promise<ReadonlySet<string>>>();

  private readonly getState: (
    stackName: string,
    region: string
  ) => Promise<{ state: unknown } | null | undefined>;
  private readonly debug: (message: string) => void;

  public constructor(
    getState: (stackName: string, region: string) => Promise<{ state: unknown } | null | undefined>,
    debug: (message: string) => void
  ) {
    this.getState = getState;
    this.debug = debug;
  }

  public producerSecretOf(value: string): ProducerSecretVerdict | undefined {
    return this.ledger.producerSecretOf(value);
  }

  /** A record's state, `undefined` when it is missing or cannot be read. */
  private read(stackName: string, region: string): Promise<unknown> {
    const key = producerRecordKey(stackName, region);
    let read = this.reads.get(key);
    if (read === undefined) {
      read = Promise.resolve()
        .then(() => this.getState(stackName, region))
        .then(
          (got) => got?.state ?? undefined,
          (err: unknown) => {
            this.debug(
              `state read failed for ${displayIdent(stackName)} (${displayIdent(region)}) while checking a cross-stack value for secrets: ${describeAwsFailure(err).detail}`
            );
            return undefined;
          }
        );
      this.reads.set(key, read);
    }
    return read;
  }

  /**
   * Note the secrets of producer `stackName`'s record `state` (already read)
   * and of its nested children, then judge `served`, the value read from it.
   * A child record that cannot be read leaves its row's recorded outputs
   * unverified, for a value served from THIS producer's tree only: another
   * producer exporting the same ordinary value (a region name, `true`) is
   * judged by its own records.
   *
   * Every nested row's child is read, whichever output was served: one GET
   * per child record per run, which a local command can pay.
   */
  public async noteProducer(
    stackName: string,
    region: string,
    state: unknown,
    served?: string
  ): Promise<void> {
    const unverified = await this.tree(stackName, region, state, 0);
    if (served !== undefined && unverified.has(served)) this.ledger.noteUnverified(served);
  }

  /** {@link walk}, once per record. */
  private tree(
    stackName: string,
    region: string,
    state: unknown,
    depth: number
  ): Promise<ReadonlySet<string>> {
    const key = producerRecordKey(stackName, region);
    let walk = this.walked.get(key);
    if (walk === undefined) {
      walk = this.walk(stackName, region, state, depth);
      this.walked.set(key, walk);
    }
    return walk;
  }

  /**
   * Note the needles of `state` and its nested children; return the output
   * leaves of the rows whose child record could not be read.
   */
  private async walk(
    stackName: string,
    region: string,
    state: unknown,
    depth: number
  ): Promise<ReadonlySet<string>> {
    this.ledger.noteProducerState(state);
    const unverified = new Set<string>();
    const resources =
      state !== null && typeof state === 'object'
        ? (state as { resources?: unknown }).resources
        : undefined;
    if (resources === null || typeof resources !== 'object' || Array.isArray(resources)) {
      return unverified;
    }
    await Promise.all(
      Object.entries(resources).map(async ([logicalId, record]) => {
        if (record === null || typeof record !== 'object') return;
        const r = record as { resourceType?: unknown; attributes?: unknown };
        if (r.resourceType !== NESTED_STACK_TYPE) return;
        const childName = `${stackName}~${logicalId}`;
        const child = depth < MAX_NESTED_DEPTH ? await this.read(childName, region) : undefined;
        if (child !== undefined) {
          for (const leaf of await this.tree(childName, region, child, depth + 1)) {
            unverified.add(leaf);
          }
          return;
        }
        for (const { leaf } of namedLeaves('', r.attributes)) {
          if (isPlaintext(leaf)) unverified.add(leaf);
        }
      })
    );
    return unverified;
  }

  /**
   * Judge `served`, an exports-index value for `exportName` published by
   * `producerStack`: read that record (the entry carries the value alone). A
   * missing or unreadable record, or one no longer exporting `served` (a
   * stale entry), leaves the value unverified.
   */
  public async noteIndexed(
    producerStack: string,
    producerRegion: string,
    exportName: string,
    served: string
  ): Promise<void> {
    const state = await this.read(producerStack, producerRegion);
    if (state === undefined || state === null) {
      this.ledger.noteUnverified(served);
      return;
    }
    await this.noteProducer(producerStack, producerRegion, state, served);
    const outputs = (state as { outputs?: unknown }).outputs;
    const current =
      outputs !== null &&
      typeof outputs === 'object' &&
      importableOutputKeys(state as Parameters<typeof importableOutputKeys>[0]).includes(exportName)
        ? servedOutputValue((outputs as Record<string, unknown>)[exportName])
        : undefined;
    if (current !== served) this.ledger.noteUnverified(served);
  }
}
