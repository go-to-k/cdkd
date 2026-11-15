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
import { canonicalizeRegion } from '../utils/aws-partition.js';
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

/**
 * Why a re-export source left its producer's tree unjudged: it could not be
 * read, its stack name is recorded masked, or it lies past the re-export
 * depth bound. `shown` is the stack and region rendered for display (record
 * identifiers only, never a value).
 */
export type OpaqueSource =
  | { reason: 'unreadable'; shown: string }
  | { reason: 'redacted' }
  | { reason: 'too-deep'; shown: string };

/** A verdict, with the re-export source that blocked the check, if one did. */
export interface Judgement {
  verdict: ProducerSecretVerdict;
  source?: OpaqueSource | undefined;
}

/** A value one resolver call returned, with its producer's verdict. */
export interface JudgedValue {
  value: string | undefined;
  verdict?: ProducerSecretVerdict | undefined;
  source?: OpaqueSource | undefined;
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

/** `a` or `b`, whichever weighs more, keeping the winner's blocking source. */
export function strongerJudgement(
  a: Judgement | undefined,
  b: Judgement | undefined
): Judgement | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return strongerVerdict(a.verdict, b.verdict) === a.verdict ? a : b;
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
 * secret, matched as the WHOLE served value. Such a name can hold a short
 * ordinary value (`Outputs.PasswordPolicy` of `strict`, a `*SecretEnabled` of
 * `true`), which the producer's own equal export must not be refused for.
 */
const NAMED_LEAF_EXACT_FLOOR = 8;

/** Shortest name-judged leaf matched INSIDE a longer served value. */
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
  /** Leaves of attributes their dotted NAME says are secrets, from 8 characters. */
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
          else if (isSensitiveAttributeName(path) && leaf.length >= NAMED_LEAF_EXACT_FLOOR) {
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
  /**
   * The first stack the tree re-exports from that could not be read (for
   * display): nothing the tree serves is judged then.
   */
  opaqueSource: OpaqueSource | undefined;
}

const emptySummary = (): TreeSummary => ({
  segments: new Set(),
  typed: new Set(),
  named: new Set(),
  unverified: new Set(),
  opaqueSource: undefined,
});

/** The verdict `summary` gives `served`. */
function verdictOf(summary: TreeSummary, served: string): Judgement | undefined {
  const secret: Judgement = { verdict: 'secret' };
  for (const s of summary.segments) if (holds(served, s, SEGMENT_SUBSTRING_FLOOR)) return secret;
  for (const t of summary.typed) if (holds(served, t, SEGMENT_SUBSTRING_FLOOR)) return secret;
  for (const n of summary.named) if (holds(served, n, NAMED_LEAF_FLOOR)) return secret;
  if (summary.opaqueSource !== undefined) {
    return { verdict: 'unreadable', source: summary.opaqueSource };
  }
  // A parent output can embed the child's in a longer one (`Fn::Join`).
  for (const u of summary.unverified) {
    if (holds(served, u, NAMED_LEAF_FLOOR)) return { verdict: 'unreadable' };
  }
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
 * that stack's record names. A malformed entry is skipped; one whose stack
 * name is redacted (`outputReads[].sourceStack` persists as the mask or a
 * `{{resolve:` reference when secret-derived) is `redacted`, since the record
 * it names cannot be found.
 */
function sourcesOf(state: unknown): ({ stackName: string; region: string } | 'redacted')[] {
  if (state === null || typeof state !== 'object') return [];
  const out: ({ stackName: string; region: string } | 'redacted')[] = [];
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
      if (sourceStack === SECRET_MASK || sourceStack.includes('{{resolve:')) out.push('redacted');
      else if (sourceStack !== '') out.push({ stackName: sourceStack, region: sourceRegion });
    }
  }
  return out;
}

/** A record read: its state, no record at that key, or a read that failed. */
type RecordRead = { state: unknown } | 'absent' | 'error';

/** One record of a producer's tree, with how far from the producer it is. */
interface TreeNode {
  stackName: string;
  region: string;
  state: unknown;
  depth: number;
}

/**
 * Judges a value served from cdkd state, for the resolver
 * `buildCrossStackResolver` builds, against the PRODUCER it was read from:
 * that record, its nested-stack children (`<parent>~<id>`, the union a nested
 * tree's masking takes in `cdkd state show`), and the stacks it reads across
 * (`imports` / `outputReads`), transitively. Record READS are memoized, once
 * per resolver; each judgement walks the tree afresh from its producer with
 * one visited set, so a cycle (`outputReads` can cross-read) neither waits
 * on itself nor leaves a cut summary behind. One GET per child or source
 * record per run, whichever output was served, which a local command can pay.
 */
export class ProducerSecretReader {
  private readonly reads = new Map<string, Promise<RecordRead>>();
  private readonly getState: (
    stackName: string,
    region: string
  ) => Promise<{ state: unknown } | null | undefined>;
  private readonly debug: (message: string) => void;
  private readonly listStacks:
    | (() => Promise<readonly { stackName: string; region?: string | undefined }[]>)
    | undefined;
  private listed:
    | Promise<readonly { stackName: string; region?: string | undefined }[] | 'error'>
    | undefined;

  public constructor(
    getState: (stackName: string, region: string) => Promise<{ state: unknown } | null | undefined>,
    debug: (message: string) => void,
    /** The state records, for a re-export source's region case recovery. */
    listStacks?: () => Promise<readonly { stackName: string; region?: string | undefined }[]>
  ) {
    this.getState = getState;
    this.debug = debug;
    this.listStacks = listStacks;
  }

  /**
   * A re-export source's record. `outputReads[].sourceRegion` is persisted
   * FOLDED when the template names a Region, while the record key keeps the
   * deploy's spelling (`--region US-EAST-1`), so a miss at the exact key is
   * retried at a case-variant record, both sides folded, as the loader's
   * `Fn::GetStackOutput` and index-miss scan do. A case-variant record that
   * still cannot be read, or a listing that fails, is `error` (fail closed).
   */
  private async readSource(
    stackName: string,
    region: string
  ): Promise<{ state: unknown; region: string } | 'absent' | 'error'> {
    const exact = await this.read(stackName, region);
    if (typeof exact === 'object') return { state: exact.state, region };
    if (exact === 'error' || this.listStacks === undefined) return exact;
    const list = this.listStacks;
    this.listed ??= Promise.resolve()
      .then(() => list())
      .catch((err: unknown) => {
        this.debug(
          `state listing failed while checking a cross-stack value for secrets: ${displaySafe(describeAwsFailure(err).detail)}`
        );
        return 'error' as const;
      });
    const refs = await this.listed;
    if (refs === 'error') return 'error';
    const folded = canonicalizeRegion(region);
    const variants = refs.filter(
      (ref) =>
        ref.stackName === stackName &&
        ref.region !== undefined &&
        ref.region !== region &&
        canonicalizeRegion(ref.region) === folded
    );
    let failed = false;
    for (const ref of variants) {
      const got = await this.read(stackName, ref.region!);
      // The variant's own spelling: its nested children live under it.
      if (typeof got === 'object') return { state: got.state, region: ref.region! };
      if (got === 'error') failed = true;
    }
    // Every variant gone since the listing: no record, as for no variant.
    return failed ? 'error' : 'absent';
  }

  /** A record, read once per resolver. */
  private read(stackName: string, region: string): Promise<RecordRead> {
    const key = producerRecordKey(stackName, region);
    let read = this.reads.get(key);
    if (read === undefined) {
      read = Promise.resolve()
        .then(() => this.getState(stackName, region))
        .then(
          (got): RecordRead =>
            got === null || got === undefined || got.state === undefined
              ? 'absent'
              : { state: got.state },
          (err: unknown): RecordRead => {
            this.debug(
              `state read failed for ${displayIdent(stackName)} (${displayIdent(region)}) while checking a cross-stack value for secrets: ${displaySafe(describeAwsFailure(err).detail)}`
            );
            return 'error';
          }
        );
      this.reads.set(key, read);
    }
    return read;
  }

  /**
   * The summary of producer `stackName`'s tree, breadth first:
   * - a nested child that is missing or unreadable leaves its row's recorded
   *   outputs unverified;
   * - a re-export source that is unreadable, redacted or past the depth bound
   *   makes the tree `opaque` (fail closed); one with NO record is outside
   *   cdkd (moved to CloudFormation by `cdkd export`, say) and is skipped, as
   *   `--from-cfn-stack` values are.
   */
  private async summarize(stackName: string, region: string, state: unknown): Promise<TreeSummary> {
    const summary = emptySummary();
    const visited = new Set([producerRecordKey(stackName, region)]);
    let frontier: TreeNode[] = [{ stackName, region, state, depth: 0 }];
    while (frontier.length > 0) {
      const next: TreeNode[] = [];
      // `visited` is tested and set before each await, so no record is
      // walked twice and no walk waits on another.
      const claim = (name: string, at: string): boolean => {
        const key = producerRecordKey(name, at);
        if (visited.has(key)) return false;
        visited.add(key);
        return true;
      };
      await Promise.all(
        frontier.map(async (node) => {
          const own = producerSecretNeedles(node.state);
          for (const v of own.segments) summary.segments.add(v);
          for (const v of own.typed) summary.typed.add(v);
          for (const v of own.named) summary.named.add(v);
          const deeper = node.depth + 1;
          const resources =
            node.state !== null && typeof node.state === 'object'
              ? (node.state as { resources?: unknown }).resources
              : undefined;
          const rows =
            resources !== null && typeof resources === 'object' && !Array.isArray(resources)
              ? Object.entries(resources)
              : [];
          const nested = rows.map(async ([logicalId, record]) => {
            if (record === null || typeof record !== 'object') return;
            const r = record as { resourceType?: unknown; attributes?: unknown };
            if (r.resourceType !== NESTED_STACK_TYPE) return;
            const childName = `${node.stackName}~${logicalId}`;
            if (!claim(childName, node.region)) return;
            const child =
              deeper <= MAX_NESTED_DEPTH ? await this.read(childName, node.region) : 'error';
            if (typeof child === 'object') {
              next.push({
                stackName: childName,
                region: node.region,
                state: child.state,
                depth: deeper,
              });
              return;
            }
            for (const { leaf } of namedLeaves('', r.attributes)) {
              if (isPlaintext(leaf)) summary.unverified.add(leaf);
            }
          });
          const sources = sourcesOf(node.state).map(async (source) => {
            if (source === 'redacted') {
              summary.opaqueSource ??= { reason: 'redacted' };
              return;
            }
            const shown = `${displayIdent(source.stackName)} (${displayIdent(source.region)})`;
            if (deeper > MAX_NESTED_DEPTH) {
              summary.opaqueSource ??= { reason: 'too-deep', shown };
              return;
            }
            if (!claim(source.stackName, source.region)) return;
            const got = await this.readSource(source.stackName, source.region);
            if (got === 'error') summary.opaqueSource ??= { reason: 'unreadable', shown };
            else if (got !== 'absent') {
              next.push({
                stackName: source.stackName,
                region: got.region,
                state: got.state,
                depth: deeper,
              });
            }
          });
          await Promise.all([...nested, ...sources]);
        })
      );
      frontier = next;
    }
    return summary;
  }

  /** The verdict on `served`, read from producer `stackName`'s record `state`. */
  public async judge(
    stackName: string,
    region: string,
    state: unknown,
    served: string
  ): Promise<Judgement | undefined> {
    return verdictOf(await this.summarize(stackName, region, state), served);
  }

  /**
   * The verdict on `served`, an exports-index value for `exportName` published
   * by `producerStack`: that record is read (the entry carries the value
   * alone). An unreadable record is `unreadable`; a missing one, or one no
   * longer exporting `served`, is `stale`.
   */
  public async judgeIndexed(
    producerStack: string,
    producerRegion: string,
    exportName: string,
    served: string
  ): Promise<Judgement | undefined> {
    const got = await this.read(producerStack, producerRegion);
    // No record left at the key the index names: the entry outlived it.
    if (got === 'absent') return { verdict: 'stale' };
    if (got === 'error') return { verdict: 'unreadable' };
    const state = got.state;
    const verdict = await this.judge(producerStack, producerRegion, state, served);
    if (verdict?.verdict === 'secret') return verdict;
    const outputs = (state as { outputs?: unknown }).outputs;
    const current =
      outputs !== null &&
      typeof outputs === 'object' &&
      importableOutputKeys(state as Parameters<typeof importableOutputKeys>[0]).includes(exportName)
        ? servedOutputValue((outputs as Record<string, unknown>)[exportName])
        : undefined;
    return current !== served ? { verdict: 'stale' } : verdict;
  }
}

/** Why the re-export source blocked the check, and what the operator can do. */
function sourceRemedy(source: OpaqueSource): string {
  if (source.reason === 'redacted') {
    return 'the producer re-exports from a stack whose name is recorded masked, so cdkd cannot find its state';
  }
  if (source.reason === 'too-deep') {
    return `the producer re-exports from ${source.shown}, beyond the ${MAX_NESTED_DEPTH}-level re-export bound`;
  }
  return `the producer re-exports from ${source.shown}, whose state cdkd could not read (retry; or a newer-schema record needs a cdkd upgrade)`;
}

/** The argv refusal for a value with `judgement`. */
export function producerSecretArgvReason(judgement: Judgement): string {
  const tail =
    'which cdkd will not put on the docker run command line; pass the value through Environment or Secrets instead';
  if (judgement.verdict === 'secret') {
    return `resolved a cross-stack value holding a secret of the producer stack, ${tail}`;
  }
  if (judgement.verdict === 'stale') {
    return `resolved a cross-stack value the producer stack no longer exports (a stale exports index entry), so cdkd could not check it for secrets, ${tail}`;
  }
  if (judgement.source !== undefined) {
    return `resolved a cross-stack value cdkd could not check for secrets: ${sourceRemedy(judgement.source)}, ${tail}`;
  }
  return `resolved a cross-stack value whose producer stack's state cdkd could not read to check it for secrets, ${tail}`;
}

/** Why a `Secrets` `ValueFrom` resolving to a value with `judgement` is dropped. */
export function producerSecretValueFromReason(judgement: Judgement): string {
  if (judgement.verdict === 'secret') {
    return 'ValueFrom resolved a cross-stack value holding a secret of the producer stack, rather than naming a Secrets Manager secret or an SSM parameter';
  }
  if (judgement.verdict === 'stale') {
    return 'ValueFrom resolved a cross-stack value the producer stack no longer exports (a stale exports index entry), which cdkd could not check for secrets';
  }
  if (judgement.source !== undefined) {
    return `ValueFrom resolved a cross-stack value cdkd could not check for secrets: ${sourceRemedy(judgement.source)}`;
  }
  return "ValueFrom resolved a cross-stack value whose producer stack's state cdkd could not read to check it for secrets";
}
