/**
 * The two `AWS::DynamoDB::Table` `StreamSpecification` members that are NOT
 * members of the SDK's `StreamSpecification`: `ResourcePolicy`
 * (`{ PolicyDocument }`, the resource-based policy of the STREAM) and `Tags`
 * (issue [#3458](https://github.com/go-to-k/cdkd/issues/3458)).
 *
 * `CreateTable` / `UpdateTable` take only `{ StreamEnabled, StreamViewType }`,
 * so a block carrying either member deployed green with neither applied — a
 * template granting access to a table's stream left the stream with no policy.
 * CloudFormation applies both against the STREAM arn (`LatestStreamArn`),
 * re-applies both after a `StreamViewType` change (which mints a NEW arn), and
 * REMOVES both when the member leaves a block whose stream stays (measured on
 * real CloudFormation; the measurements are on the issue).
 *
 * Pure, so the write plan, the create-time refusal and the drift read-back
 * gate cannot answer "does this block declare the member" differently.
 */
import { configStringRefusal, requireConfigObject } from './config-shape.js';

/** The CFn property holding both members. */
export const STREAM_SPECIFICATION_KEY = 'StreamSpecification';
/** The stream's resource-based policy member. */
export const STREAM_POLICY_KEY = 'ResourcePolicy';
/** The stream's tag-list member. */
export const STREAM_TAGS_KEY = 'Tags';

const POLICY_PATH = `${STREAM_SPECIFICATION_KEY}.${STREAM_POLICY_KEY}`;
const TAGS_PATH = `${STREAM_SPECIFICATION_KEY}.${STREAM_TAGS_KEY}`;

/** One read of `StreamSpecification.ResourcePolicy`. */
export type StreamPolicyRead =
  /** Not declared. With a declared previous side this is a REMOVAL. */
  | { kind: 'absent' }
  /** Declared and readable; `document` is the JSON STRING the API takes. */
  | { kind: 'usable'; document: string }
  /** Declared but unreadable. Never sent, never read as "no policy". */
  | { kind: 'unusable'; reason: string };

/** One read of `StreamSpecification.Tags`. */
export type StreamTagsRead =
  | { kind: 'absent' }
  /** Declared and readable, in DECLARED order (a later duplicate key wins). */
  | { kind: 'usable'; tags: Map<string, string> }
  | { kind: 'unusable'; reason: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The message a `config-shape` guard would throw, or `undefined`. */
function refusalOf(guard: () => unknown): string | undefined {
  try {
    guard();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** The members of a `StreamSpecification` block, or none for a non-object. */
function blockMembers(block: unknown): Record<string, unknown> {
  return isPlainObject(block) ? block : {};
}

/**
 * Read `StreamSpecification.ResourcePolicy`.
 *
 * The CFn shape is `{ PolicyDocument: <object | JSON string> }` and the
 * document is REQUIRED, so a block without one is unreadable rather than "no
 * policy": reading it as absent would DELETE the live policy on an update.
 */
export function readStreamPolicy(block: unknown): StreamPolicyRead {
  const value = blockMembers(block)[STREAM_POLICY_KEY];
  if (value === undefined || value === null) return { kind: 'absent' };
  const containerRefusal = refusalOf(() => requireConfigObject(value, POLICY_PATH));
  if (containerRefusal !== undefined) return { kind: 'unusable', reason: containerRefusal };
  const documentPath = `${POLICY_PATH}.PolicyDocument`;
  const document = (value as Record<string, unknown>)['PolicyDocument'];
  if (typeof document === 'string') {
    return document.trim() === ''
      ? { kind: 'unusable', reason: `${documentPath} must not be a blank string` }
      : { kind: 'usable', document };
  }
  if (document === undefined || document === null) {
    return {
      kind: 'unusable',
      reason: `${documentPath} is required when ${POLICY_PATH} is declared`,
    };
  }
  const documentRefusal = refusalOf(() => requireConfigObject(document, documentPath));
  if (documentRefusal !== undefined) return { kind: 'unusable', reason: documentRefusal };
  return { kind: 'usable', document: JSON.stringify(document) };
}

/**
 * Read `StreamSpecification.Tags`.
 *
 * Refusals name an entry by POSITION, never by its key: the key is a RESOLVED
 * template value, and a copy embedded here would reach only the substring
 * mask, which ignores a value shorter than its minimum needle.
 *
 * ONE unreadable entry makes the whole list unusable. Filtering it out would
 * send a list nobody declared, and on an update would untag a key the
 * unreadable entry may well have named.
 */
export function readStreamTags(block: unknown): StreamTagsRead {
  const value = blockMembers(block)[STREAM_TAGS_KEY];
  if (value === undefined || value === null) return { kind: 'absent' };
  if (!Array.isArray(value)) {
    return { kind: 'unusable', reason: `${TAGS_PATH} must be an array of {Key, Value} entries` };
  }
  const tags = new Map<string, string>();
  for (const [position, entry] of (value as unknown[]).entries()) {
    const entryPath = `${TAGS_PATH}[${position}]`;
    const refusal =
      refusalOf(() => requireConfigObject(entry, entryPath)) ??
      // `fallback` is a non-blank placeholder so a BLANK key is refused; a
      // blank VALUE is a legal tag value, hence the blank fallback there.
      configStringRefusal(entry, 'Key', 'required', entryPath) ??
      configStringRefusal(entry, 'Value', '', entryPath);
    if (refusal !== undefined) return { kind: 'unusable', reason: refusal };
    const { Key: key, Value: tagValue } = entry as Record<string, unknown>;
    if (typeof key !== 'string') {
      return { kind: 'unusable', reason: `${entryPath}.Key is required` };
    }
    // An ABSENT `Value` is the empty tag value: the CFn member is required,
    // and the empty string is what the tagging API records for it.
    tags.set(key, typeof tagValue === 'string' ? tagValue : '');
  }
  return { kind: 'usable', tags };
}

/**
 * Every refusal a CREATE must raise before `CreateTable` goes out. A create has
 * no live setting to leave alone, so an unreadable member there is a template
 * error, not a skip — and refusing after the table exists would create it only
 * to delete it again.
 */
export function streamMemberRefusals(block: unknown): string[] {
  const refusals: string[] = [];
  const policy = readStreamPolicy(block);
  if (policy.kind === 'unusable') refusals.push(policy.reason);
  const tags = readStreamTags(block);
  if (tags.kind === 'unusable') refusals.push(tags.reason);
  return refusals;
}

/** One call against the STREAM arn. */
export type StreamMemberOp =
  | { kind: 'deletePolicy' }
  | { kind: 'untag'; keys: string[] }
  | { kind: 'tag'; tags: Array<{ Key: string; Value: string }> }
  | { kind: 'putPolicy'; document: string };

/**
 * The calls one update (or create) needs against the CURRENT stream arn.
 *
 * `freshStream` says the arn the calls will address was minted by THIS
 * operation — a create, an update-time enable, or the disable / re-enable a
 * `StreamViewType` change is applied as. A fresh stream holds nothing, so the
 * previous side is irrelevant there: every readable declared member is
 * applied, and nothing is deleted. Otherwise the stream is the one the previous
 * side was applied to, and the plan is the difference:
 *
 * - a member `absent` with a DECLARED previous is a template REMOVAL and is
 *   removed (CloudFormation does the same). Because the rule is symmetric in
 *   its two sides, a rollback — which replays `update()` with the sides SWAPPED
 *   — restores the old policy and tags through the same arms, a view-type
 *   change included (the rollback mints yet another arn, and `freshStream`
 *   applies the old members to it).
 * - an `unusable` member reports through `onUnusable` and the live setting is
 *   left alone rather than overwritten with a guess: no call on a stream that
 *   stays, and the PREVIOUS member carried over onto a fresh one.
 * - an `unusable` PREVIOUS tag list cannot say which keys cdkd applied, so a
 *   removal against it untags nothing.
 *
 * ORDER is part of the contract, because a resource policy is an access
 * grant: `deletePolicy` comes FIRST and `putPolicy` LAST, so on a partial
 * failure the stream never holds a policy alongside a tag set it was not
 * declared with (a policy conditioned on `aws:ResourceTag` reads the tags).
 *
 * The caller asks only while the DESIRED side has a stream: a disabled stream
 * is gone and takes both members with it, so nothing addresses its dead arn.
 */
export function planStreamMemberOps(
  desiredBlock: unknown,
  previousBlock: unknown,
  options: { freshStream: boolean },
  onUnusable: (reason: string) => void
): StreamMemberOp[] {
  let desiredPolicy = readStreamPolicy(desiredBlock);
  let desiredTags = readStreamTags(desiredBlock);
  if (desiredPolicy.kind === 'unusable') onUnusable(desiredPolicy.reason);
  if (desiredTags.kind === 'unusable') onUnusable(desiredTags.reason);

  let previousPolicy = readStreamPolicy(previousBlock);
  let previousTags = readStreamTags(previousBlock);
  if (options.freshStream) {
    // "Left alone" has to survive the arn swap: the fresh stream holds
    // nothing, so an unreadable member CARRIES the previous one over.
    if (desiredPolicy.kind === 'unusable' && previousPolicy.kind === 'usable') {
      desiredPolicy = previousPolicy;
    }
    if (desiredTags.kind === 'unusable' && previousTags.kind === 'usable') {
      desiredTags = previousTags;
    }
    previousPolicy = { kind: 'absent' };
    previousTags = { kind: 'absent' };
  }

  const ops: StreamMemberOp[] = [];
  if (desiredPolicy.kind === 'absent' && previousPolicy.kind !== 'absent') {
    ops.push({ kind: 'deletePolicy' });
  }

  if (desiredTags.kind !== 'unusable') {
    const desired = desiredTags.kind === 'usable' ? desiredTags.tags : new Map<string, string>();
    const previous = previousTags.kind === 'usable' ? previousTags.tags : new Map<string, string>();
    const keysToRemove = [...previous.keys()].filter((key) => !desired.has(key));
    if (keysToRemove.length > 0) ops.push({ kind: 'untag', keys: keysToRemove });
    const tagsToSet = [...desired]
      .filter(([key, value]) => previous.get(key) !== value)
      .map(([Key, Value]) => ({ Key, Value }));
    if (tagsToSet.length > 0) ops.push({ kind: 'tag', tags: tagsToSet });
  }

  if (
    desiredPolicy.kind === 'usable' &&
    !(previousPolicy.kind === 'usable' && previousPolicy.document === desiredPolicy.document)
  ) {
    ops.push({ kind: 'putPolicy', document: desiredPolicy.document });
  }
  return ops;
}

/** The drift read-back gates: one API call each, so each is asked separately. */
export function streamDeclaresPolicy(desiredBlock: unknown): boolean {
  return readStreamPolicy(desiredBlock).kind === 'usable';
}

/** See {@link streamDeclaresPolicy}. */
export function streamDeclaresTags(desiredBlock: unknown): boolean {
  return readStreamTags(desiredBlock).kind === 'usable';
}

/**
 * Re-shape a `GetResourcePolicy` answer into the CFn member, in the DECLARED
 * spelling of `PolicyDocument`: a template may carry the document as an object
 * or as a JSON string, and the comparator does not convert between them.
 * `undefined` when AWS holds no policy.
 */
export function reverseMapStreamPolicy(
  livePolicy: string | undefined,
  desiredBlock: unknown
): Record<string, unknown> | undefined {
  if (livePolicy === undefined || livePolicy === '') return undefined;
  const declared = blockMembers(blockMembers(desiredBlock)[STREAM_POLICY_KEY])['PolicyDocument'];
  let parsed: unknown;
  try {
    parsed = JSON.parse(livePolicy);
  } catch {
    // A non-JSON body is reported as AWS sent it.
    return { PolicyDocument: livePolicy };
  }
  if (typeof declared !== 'string') return { PolicyDocument: parsed };
  // Declared as a STRING: report the declared string itself when it says the
  // same thing AWS holds, so whitespace and key order are not drift.
  let declaredParsed: unknown;
  try {
    declaredParsed = JSON.parse(declared);
  } catch {
    return { PolicyDocument: livePolicy };
  }
  return {
    PolicyDocument: canonicalJson(declaredParsed) === canonicalJson(parsed) ? declared : livePolicy,
  };
}

/** A key-order-independent serialization. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
