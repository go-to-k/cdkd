/**
 * Whether a value cdkd's `--from-state` cross-stack resolver returned holds a
 * PRODUCER stack's secret (go-to-k/cdkd#6337).
 *
 * `cdkd local run-task` keeps a same-stack secret off the `docker run` argv
 * (go-to-k/cdkd#6330) by reading the consumer's own state, which says nothing
 * about a value read through `Fn::ImportValue` / `Fn::GetStackOutput`: an
 * `AWS::AppSync::ApiKey` exported by another stack reached the argv as
 * plaintext. cdk-local's `CrossStackResolver` contract returns the value only,
 * so the resolver `buildCrossStackResolver` builds also carries JUDGED variants
 * of its two methods BESIDE that contract, each returning the value with the
 * verdict of the producer it was read from, and cdkd's own post-pass
 * (`applyCrossStackResolverToTask`) calls them through
 * {@link producerSecretCheckOf}. The verdict belongs to that one call: an
 * equal value another producer exports is judged by that producer's records. A resolver without it (the
 * `--from-cfn-stack` one cdk-local builds) is not judged here.
 */
import { SECRET_MASK } from '../deployment/secret-redaction.js';
import { secretSegmentsOfState } from '../provisioning/secret-physical-id.js';
import { producerRecordKey } from '../state/record-keys.js';
import { importableOutputKeys } from '../types/state.js';
import { describeAwsFailure } from '../utils/aws-failure-text.js';
import { displayIdent, displaySafe } from '../utils/display-safe.js';
import { isSecretValuedAttribute, isSensitiveAttributeName } from '../utils/stringify.js';
import type { CrossStackResolver } from './state-resolver.js';

/**
 * What a cdkd-built resolver knows of a value one call returned: `secret` when
 * it holds a secret its producer's state records; `unreadable` when the state
 * that could tell (the producer's record, a nested child's, a stack it
 * re-exports from) could not be read; `stale` when the exports index served a
 * value the producer record no longer exports. Each but `secret` fails closed.
 */
export type ProducerSecretVerdict = 'secret' | 'unreadable' | 'stale';

/** A value one resolver call returned, with its producer's verdict. */
export interface JudgedValue {
  value: string | undefined;
  verdict?: ProducerSecretVerdict | undefined;
}

/** The judged variants a cdkd-built resolver carries beside cdk-local's contract. */
export interface ProducerSecretCheck {
  resolveImportJudged(exportName: string): Promise<JudgedValue>;
  resolveGetStackOutputJudged(
    producerStack: string,
    producerRegion: string,
    outputName: string
  ): Promise<JudgedValue>;
}

/** The {@link ProducerSecretCheck} a resolver carries, if it carries one. */
export function producerSecretCheckOf(
  resolver: CrossStackResolver | undefined
): ProducerSecretCheck | undefined {
  const r = resolver as Partial<ProducerSecretCheck> | undefined;
  const judgedImport = r?.resolveImportJudged;
  const judgedOutput = r?.resolveGetStackOutputJudged;
  if (typeof judgedImport !== 'function' || typeof judgedOutput !== 'function') return undefined;
  return {
    resolveImportJudged: (exportName) => judgedImport.call(resolver, exportName),
    resolveGetStackOutputJudged: (stack, region, output) =>
      judgedOutput.call(resolver, stack, region, output),
  };
}

/** `a` or `b`, whichever weighs more: `secret` over the fail-closed verdicts. */
export function strongerVerdict(
  a: ProducerSecretVerdict | undefined,
  b: ProducerSecretVerdict | undefined
): ProducerSecretVerdict | undefined {
  if (a === 'secret' || b === 'secret') return 'secret';
  return a ?? b;
}

/**
 * Shortest id segment or TYPED secret (`isSecretValuedAttribute`) matched
 * inside a longer value (`secret-physical-id.ts`'s masking floor); a shorter
 * one only whole.
 */
const SEGMENT_SUBSTRING_FLOOR = 4;

/**
 * Shortest leaf a NAME heuristic (`isSensitiveAttributeName`) counts as a
 * secret at all, and matches inside a longer value. Such a name can hold a
 * short ordinary value (`Outputs.PasswordPolicy` of `strict`, a
 * `*SecretEnabled` of `true`), which must not refuse an export equal to or
 * containing it; the credentials these leaves stand for are far longer.
 */
const NAMED_LEAF_FLOOR = 16;

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
  /** Leaves of attributes their TYPE says are secrets (`isSecretValuedAttribute`). */
  typed: string[];
  /** Leaves of attributes their dotted NAME says are secrets, from 16 characters. */
  named: string[];
}

/**
 * The secrets a producer state records in plaintext: the bearer-credential
 * segments of its physical ids and secret-named nested-stack outputs
 * ({@link secretSegmentsOfState}), and the leaves of every attribute whose type
 * (an ApiKey's `ApiKey`) or dotted name (`AWS::IAM::AccessKey`'s
 * `SecretAccessKey`; `MasterUserSecret.SecretArn` is an ARN) says it is a
 * secret -- the attributes the same-stack check refuses (`secretAttributeRead`).
 */
export function producerSecretNeedles(state: unknown): ProducerSecretNeedles {
  const segments = secretSegmentsOfState(state).filter(isPlaintext);
  const typed: string[] = [];
  const named: string[] = [];
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
        const isTyped = isSecretValuedAttribute(type, name);
        for (const { path, leaf } of namedLeaves(name, stored)) {
          if (!isPlaintext(leaf)) continue;
          if (isTyped) typed.push(leaf);
          else if (isSensitiveAttributeName(path) && leaf.length >= NAMED_LEAF_FLOOR) {
            named.push(leaf);
          }
        }
      }
    }
  }
  return { segments, typed, named };
}

/** Whether `value` is `needle`, or holds it and the needle reaches `floor`. */
function holds(value: string, needle: string, floor: number): boolean {
  return value === needle || (needle.length >= floor && value.includes(needle));
}

/** What a producer's tree says about the values it serves. */
interface TreeSummary {
  segments: Set<string>;
  typed: Set<string>;
  named: Set<string>;
  /** Output leaves of nested rows whose child record could not be read. */
  unverified: Set<string>;
  /** A stack the tree re-exports from could not be read: nothing it serves is judged. */
  opaque: boolean;
}

const emptySummary = (): TreeSummary => ({
  segments: new Set(),
  typed: new Set(),
  named: new Set(),
  unverified: new Set(),
  opaque: false,
});

function mergeInto(into: TreeSummary, from: TreeSummary): void {
  for (const k of ['segments', 'typed', 'named', 'unverified'] as const) {
    for (const v of from[k]) into[k].add(v);
  }
  if (from.opaque) into.opaque = true;
}

/** The verdict `summary` gives `served`. */
function verdictOf(summary: TreeSummary, served: string): ProducerSecretVerdict | undefined {
  for (const s of summary.segments) if (holds(served, s, SEGMENT_SUBSTRING_FLOOR)) return 'secret';
  for (const t of summary.typed) if (holds(served, t, SEGMENT_SUBSTRING_FLOOR)) return 'secret';
  for (const n of summary.named) if (holds(served, n, NAMED_LEAF_FLOOR)) return 'secret';
  if (summary.opaque) return 'unreadable';
  // A parent output can embed the child's in a longer one (`Fn::Join`).
  for (const u of summary.unverified) if (holds(served, u, NAMED_LEAF_FLOOR)) return 'unreadable';
  return undefined;
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

/** A backstop on the nested and re-export walks, far past any real tree. */
const MAX_NESTED_DEPTH = 32;

/**
 * The stacks a record read across stacks (`imports` / `outputReads`): an
 * output can re-export another stack's value, secret included, which only
 * that stack's record names. A malformed entry, or a redacted stack name, is
 * skipped.
 */
function sourcesOf(state: unknown): { stackName: string; region: string }[] {
  if (state === null || typeof state !== 'object') return [];
  const out: { stackName: string; region: string }[] = [];
  for (const list of [
    (state as { imports?: unknown }).imports,
    (state as { outputReads?: unknown }).outputReads,
  ]) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (entry === null || typeof entry !== 'object') continue;
      const { sourceStack, sourceRegion } = entry as {
        sourceStack?: unknown;
        sourceRegion?: unknown;
      };
      if (typeof sourceStack !== 'string' || typeof sourceRegion !== 'string') continue;
      if (sourceStack === '' || sourceStack.includes('{{resolve:')) continue;
      out.push({ stackName: sourceStack, region: sourceRegion });
    }
  }
  return out;
}

/**
 * Judges a value served from cdkd state, for the resolver
 * `buildCrossStackResolver` builds, against the PRODUCER it was read from:
 * that record, its nested-stack children (`<parent>~<id>`, the union a nested
 * tree's masking takes in `cdkd state show`), and the stacks it reads across
 * (`imports` / `outputReads`), transitively. Each record is read, and each
 * tree summarized, once per resolver: one GET per child or source record per
 * run, whichever output was served, which a local command can pay.
 */
export class ProducerSecretReader {
  private readonly reads = new Map<string, Promise<unknown>>();
  private readonly trees = new Map<string, Promise<TreeSummary>>();
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
              `state read failed for ${displayIdent(stackName)} (${displayIdent(region)}) while checking a cross-stack value for secrets: ${displaySafe(describeAwsFailure(err).detail)}`
            );
            return undefined;
          }
        );
      this.reads.set(key, read);
    }
    return read;
  }

  /**
   * The summary of `stackName`'s tree, once per record. `path` holds the
   * records being summarized above this one: a cycle (which deploy order
   * makes impossible for `imports`) contributes nothing rather than waiting
   * on itself.
   */
  private tree(
    stackName: string,
    region: string,
    state: unknown,
    path: ReadonlySet<string>
  ): Promise<TreeSummary> {
    const key = producerRecordKey(stackName, region);
    if (path.has(key) || path.size >= MAX_NESTED_DEPTH) return Promise.resolve(emptySummary());
    let tree = this.trees.get(key);
    if (tree === undefined) {
      tree = this.summarize(stackName, region, state, new Set([...path, key]));
      this.trees.set(key, tree);
    }
    return tree;
  }

  private async summarize(
    stackName: string,
    region: string,
    state: unknown,
    path: ReadonlySet<string>
  ): Promise<TreeSummary> {
    const summary = emptySummary();
    const own = producerSecretNeedles(state);
    for (const v of own.segments) summary.segments.add(v);
    for (const v of own.typed) summary.typed.add(v);
    for (const v of own.named) summary.named.add(v);
    const resources =
      state !== null && typeof state === 'object'
        ? (state as { resources?: unknown }).resources
        : undefined;
    const rows =
      resources !== null && typeof resources === 'object' && !Array.isArray(resources)
        ? Object.entries(resources)
        : [];
    const nested = rows.map(async ([logicalId, record]) => {
      if (record === null || typeof record !== 'object') return;
      const r = record as { resourceType?: unknown; attributes?: unknown };
      if (r.resourceType !== NESTED_STACK_TYPE) return;
      const childName = `${stackName}~${logicalId}`;
      const child = await this.read(childName, region);
      if (child !== undefined) {
        mergeInto(summary, await this.tree(childName, region, child, path));
        return;
      }
      for (const { leaf } of namedLeaves('', r.attributes)) {
        if (isPlaintext(leaf)) summary.unverified.add(leaf);
      }
    });
    const sources = sourcesOf(state).map(async (source) => {
      const got = await this.read(source.stackName, source.region);
      if (got === undefined) summary.opaque = true;
      else mergeInto(summary, await this.tree(source.stackName, source.region, got, path));
    });
    await Promise.all([...nested, ...sources]);
    return summary;
  }

  /** The verdict on `served`, read from producer `stackName`'s record `state`. */
  public async judge(
    stackName: string,
    region: string,
    state: unknown,
    served: string
  ): Promise<ProducerSecretVerdict | undefined> {
    return verdictOf(await this.tree(stackName, region, state, new Set()), served);
  }

  /**
   * The verdict on `served`, an exports-index value for `exportName` published
   * by `producerStack`: that record is read (the entry carries the value
   * alone). A missing or unreadable record is `unreadable`; one no longer
   * exporting `served` is `stale`.
   */
  public async judgeIndexed(
    producerStack: string,
    producerRegion: string,
    exportName: string,
    served: string
  ): Promise<ProducerSecretVerdict | undefined> {
    const state = await this.read(producerStack, producerRegion);
    if (state === undefined || state === null) return 'unreadable';
    const verdict = await this.judge(producerStack, producerRegion, state, served);
    if (verdict === 'secret') return verdict;
    const outputs = (state as { outputs?: unknown }).outputs;
    const current =
      outputs !== null &&
      typeof outputs === 'object' &&
      importableOutputKeys(state as Parameters<typeof importableOutputKeys>[0]).includes(exportName)
        ? servedOutputValue((outputs as Record<string, unknown>)[exportName])
        : undefined;
    return current !== served ? 'stale' : verdict;
  }
}

/** The argv refusal for a value with `verdict`. */
export function producerSecretArgvReason(verdict: ProducerSecretVerdict): string {
  const tail =
    'which cdkd will not put on the docker run command line; pass the value through Environment or Secrets instead';
  if (verdict === 'secret') {
    return `resolved a cross-stack value holding a secret of the producer stack, ${tail}`;
  }
  if (verdict === 'stale') {
    return `resolved a cross-stack value the producer stack no longer exports (a stale exports index entry), so cdkd could not check it for secrets, ${tail}`;
  }
  return `resolved a cross-stack value whose producer stack's state cdkd could not read to check it for secrets, ${tail}`;
}

/** Why a `Secrets` `ValueFrom` resolving to a value with `verdict` is dropped. */
export function producerSecretValueFromReason(verdict: ProducerSecretVerdict): string {
  if (verdict === 'secret') {
    return 'ValueFrom resolved a cross-stack value holding a secret of the producer stack, rather than naming a Secrets Manager secret or an SSM parameter';
  }
  if (verdict === 'stale') {
    return 'ValueFrom resolved a cross-stack value the producer stack no longer exports (a stale exports index entry), which cdkd could not check for secrets';
  }
  return "ValueFrom resolved a cross-stack value whose producer stack's state cdkd could not read to check it for secrets";
}
