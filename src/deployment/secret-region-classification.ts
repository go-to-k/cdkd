/**
 * WHICH REGION MUST ANSWER for one `{{resolve:...}}` reference.
 *
 * Extracted from `rollback-executor.ts` for issue
 * [#2134](https://github.com/go-to-k/cdkd/issues/2134), which needs the same
 * answer inside `IntrinsicFunctionResolver.resolveDynamicReferences` -- and
 * `rollback-executor.ts` IMPORTS that resolver, so importing the classifier
 * back out of it would close a cycle. The module is deliberately a LEAF: its
 * only runtime dependency is `canonicalizeRegion`, which is itself
 * import-free, so anything may depend on it.
 *
 * It is NOT a general "region utilities" module and should not grow into one.
 * What lives here is the ONE decision every consumer must answer identically
 * -- the deploy resolver, `cdkd scrub`, `cdkd drift` and the rollback replay
 * -- because a second spelling of it is how two commands come to disagree
 * about whether a given secret reference is safe to resolve locally.
 *
 * `rollback-executor.ts` re-exports every name below, so its existing
 * importers are unaffected by the move.
 */
import type { StackState } from '../types/state.js';
import { canonicalizeRegion } from '../utils/aws-partition.js';

/**
 * The `{{resolve:<service>:...}}` families whose value can be a SECRET, and
 * therefore the only ones the region question below is asked about: every
 * `secretsmanager` reference by spelling, every `ssm-secure` one by spelling
 * (issue #2482 — it is resolved through the same `GetParameter` as `ssm`, so
 * the wrong region answers it in exactly the same way), and every `ssm` one,
 * which is secret exactly when its parameter is a `SecureString` (issue #1901).
 *
 * Every OTHER service is `local` because cdkd cannot resolve it at all — the
 * resolver's unsupported-service arm leaves such a token in place, so there
 * is no lookup for a region to get wrong. None of CloudFormation's three
 * services is in that position any more; the arm exists for a spelling that
 * is not a dynamic reference at all, or one AWS adds later.
 */
const REPLAY_SECRET_SERVICES: ReadonlySet<string> = new Set([
  'secretsmanager',
  'ssm',
  'ssm-secure',
]);

/**
 * Which region must answer for one `{{resolve:...}}` reference in a bag being
 * replayed — issue [#2057](https://github.com/go-to-k/cdkd/issues/2057).
 */
export type ReplaySecretRegionVerdict =
  /** The stack's own region answers. Every non-secret reference, and every
   *  secret one whose origin is not in doubt. */
  | { kind: 'local' }
  /** The expression NAMES its region (ARN form), and it is not this stack's —
   *  so a resolver pinned to `region` answers, per issue #1957's "a named
   *  region binds". */
  | { kind: 'named-region'; secretName: string; region: string }
  /** The expression names no region and this stack read across a region
   *  boundary, so nothing on hand can establish where it came from. Refused. */
  | { kind: 'ambiguous'; secretName: string; foreignProducerRegions: string[] };

/**
 * Split a `{{resolve:secretsmanager:...}}` inner body into its SECRET_ID.
 *
 * Mirrors `IntrinsicFunctionResolver.resolveSecretsManagerReference`'s own
 * split — including the END-ANCHORED whole-secret form — because a secret ID
 * may legitimately contain colons (an ARN always does), so `split(':')[1]` is
 * wrong for exactly the shape this file cares about most.
 */
function secretsManagerSecretId(inner: string): string {
  const afterService = inner.substring('secretsmanager:'.length);
  let stringIdx = afterService.indexOf(':SecretString:');
  let binaryIdx = afterService.indexOf(':SecretBinary:');
  if (stringIdx < 0 && afterService.endsWith(':SecretString')) {
    stringIdx = afterService.length - ':SecretString'.length;
  }
  if (binaryIdx < 0 && afterService.endsWith(':SecretBinary')) {
    binaryIdx = afterService.length - ':SecretBinary'.length;
  }
  const delimiterIdx =
    stringIdx >= 0 && binaryIdx >= 0
      ? Math.min(stringIdx, binaryIdx)
      : stringIdx >= 0
        ? stringIdx
        : binaryIdx;
  return delimiterIdx >= 0 ? afterService.substring(0, delimiterIdx) : afterService;
}

/**
 * The parameter name an `{{resolve:ssm:...}}` reference asks for — byte-for-byte
 * what `IntrinsicFunctionResolver.resolveSSMReference` passes as `GetParameter`'s
 * `Name`, which is `parts.slice(1).join(':')` on the colon-split inner body.
 *
 * The whole remainder, deliberately, with NOTHING stripped:
 *
 *  - An SSM dynamic reference CAN name a full ARN. The resolver joins the tail
 *    back together, so `{{resolve:ssm:arn:aws:ssm:us-west-2:111122223333:parameter/db/pw}}`
 *    reaches AWS as that ARN. A `split(':')[1]` here would yield the literal
 *    `'arn'` — a parameter that does not exist — and then report the reference
 *    as region-LESS and refuse it, which is the guess-in-the-other-direction the
 *    `named-region` arm exists to prevent.
 *  - A trailing `:<version>` / `:<label>` is part of the name AS SSM PARSES IT
 *    (`GetParameter` accepts `name:3` / `name:prod`), so stripping it would name
 *    a different thing in the refusal message than the one that would be read.
 *
 * A COLON-LESS body (`{{resolve:ssm}}` / `{{resolve:ssm-secure}}`) names no
 * parameter at all, and the empty string is what says so: the caller reads a
 * falsy name as `local`, which hands the reference on to the resolver's own
 * `PARAMETER_NAME is required`. Without the guard `indexOf(':')` is `-1` and
 * `substring(0)` returns the SERVICE STRING as the parameter name, so with a
 * foreign producer region on record the same malformed input drew the
 * ambiguous-region refusal naming `'ssm-secure'` as the secret. Doubly
 * degenerate, so the consequence is wording only — but the two sibling
 * extractions answer `''` here ({@link secretsManagerSecretId}'s fixed-length
 * `substring` past the end, and `arnRegion`'s `startsWith('arn:')` test), and a
 * third that answers something else is the kind of split a later reader has to
 * rediscover.
 */
function ssmParameterName(inner: string): string {
  // Strip the SERVICE, whatever its spelling: `ssm:` and `ssm-secure:` both
  // reach here (issue #2482), and a fixed `'ssm:'.length` would turn
  // `ssm-secure:/pw` into `secure:/pw`. The first colon ends the service; a
  // parameter name may legitimately carry colons after it (an ARN does).
  const serviceEnd = inner.indexOf(':');
  return serviceEnd < 0 ? '' : inner.substring(serviceEnd + 1);
}

/**
 * The region an ARN names, or `undefined` for anything that is not an ARN with
 * a populated region field (`arn:<partition>:<service>:<region>:...`).
 */
function arnRegion(secretId: string): string | undefined {
  if (!secretId.startsWith('arn:')) return undefined;
  const region = secretId.split(':')[3];
  return region ? region : undefined;
}

/**
 * The producer regions a stack's persisted cross-stack reads name, for
 * the replay's `RollbackExecutorContext.importedProducerRegions` (issue #2057).
 *
 * Both record kinds count, and for the same reason: each one is a value this
 * stack read out of ANOTHER region's state, so each one is a way a
 * foreign-region `{{resolve:...}}` expression can have reached this stack's own
 * record. `imports` is the strong `Fn::ImportValue` edge; `outputReads` is the
 * weak `Fn::GetStackOutput` one (schema v8), which is the EASIER of the two to
 * point across a region boundary because the reference carries its own
 * `Region` argument.
 *
 * Deduplicated case-insensitively, keeping each region's first-recorded
 * spelling so the refusal message echoes what the user will see in
 * `state.json`. The consumer's own region is deliberately NOT filtered here —
 * {@link classifyReplaySecretRegion} does that, because it is the one that
 * knows which region is asking.
 *
 * Exported so the two `RollbackExecutorContext` construction sites derive the
 * list identically — `cdkd rollback` from the state it loaded, and
 * `DeployEngine.rollbackExecutorContext` from `crossStackReadsForPartialSave`,
 * which unions that snapshot with the reads the failing deploy itself made.
 */
export function producerRegionsFromState(
  state: Pick<StackState, 'imports' | 'outputReads'>
): string[] {
  const seen = new Set<string>();
  const regions: string[] = [];
  for (const entry of [...(state.imports ?? []), ...(state.outputReads ?? [])]) {
    const canonical = canonicalizeRegion(entry.sourceRegion);
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    regions.push(entry.sourceRegion);
  }
  return regions;
}

/**
 * Decide which region must answer for a single `{{resolve:...}}` expression a
 * rollback replay is about to re-resolve — issue
 * [#2057](https://github.com/go-to-k/cdkd/issues/2057).
 *
 * WHY A REPLAY CAN BE HOLDING A FOREIGN REGION'S EXPRESSION AT ALL. Since
 * issue #1934 a cross-stack consumer re-resolves a redacted producer value in
 * the PRODUCER's region (`reresolveCrossStackValue` /
 * `resolverForProducerRegion`) — correct, because a Secrets Manager secret or
 * an SSM `SecureString` of the same NAME in two regions is two independent
 * values. The plaintext is then recorded into the CONSUMER's
 * `recordedSecretValues`, so the consumer's `state.json` (and from there the
 * rollback journal) persists the PRODUCER's spelling of the expression. That is
 * the right thing to persist, and it is region-less: the reader cannot tell
 * from the string which region produced it.
 *
 * The replay rebuilds its resolver from the CONSUMER's region alone, so
 * re-resolving that expression locally answers from a same-named secret in the
 * wrong region and writes it to a LIVE resource. Silent, and on the recovery
 * path. The rule applied here is the family's, from issue #1957: A NAMED REGION
 * BINDS; NEVER SUBSTITUTE A GUESS. The three verdicts are that one sentence:
 *
 *  - **`named-region`** — the expression's SECRET_ID is an ARN, which names its
 *    own region. The region is ESTABLISHED, so it binds: the caller resolves
 *    through a resolver pinned to it (each command's own `*Resolvers.forRegion`) rather
 *    than refusing. Refusing here would be the guess in the other direction.
 *
 *    cdkd would otherwise get this wrong, which is why the arm exists at all:
 *    `resolveSecretsManagerReference` builds its client from
 *    `this.explicitRegion` and passes the ARN through as an opaque `SecretId`,
 *    and `@aws-sdk/client-secrets-manager`'s endpoint ruleset has NO
 *    ARN-derived endpoint rule (unlike, say, S3 access points), so a
 *    foreign-region ARN is sent to the stack's own regional endpoint. What the
 *    SERVICE then does with it is not something this repo can settle offline —
 *    see the fixture note in
 *    `tests/integration/rollback-cross-region-secret/README.md`. Pinning the
 *    client to the ARN's region is correct either way: if Secrets Manager would
 *    have refused the foreign ARN, this turns a hard failure into a correct
 *    resolution; if it would have honoured it, this reaches the same value by
 *    the documented route. Neither outcome is a regression.
 *
 *  - **`ambiguous`** — the expression names no region (the plain name form) AND
 *    this stack has a foreign producer region on record
 *    (the replay's `RollbackExecutorContext.importedProducerRegions`). Nothing on hand
 *    can establish the origin, so the replay refuses instead of guessing.
 *
 *    KNOWN OVER-REFUSAL, accepted deliberately, and WIDER THAN THE SSM CASE
 *    ALONE — state both, because the second one is the common shape:
 *
 *    (a) Any NAME-FORM `secretsmanager` reference in a stack that has ANY
 *    foreign producer region on record is refused, even when that secret is
 *    the stack's own purely-local one and has nothing to do with the
 *    cross-region read. The evidence is per-STACK, not per-reference, so one
 *    cross-region export plus one ordinary
 *    `{{resolve:secretsmanager:mysecret:SecretString:pw}}` is enough — and CDK's
 *    `secretValueFromJson` emits exactly that name form, so this is the shape
 *    most people will meet. It also persists: with the union the producer
 *    region stays on record until the next SUCCESSFUL deploy. Per-reference
 *    evidence is what would narrow it, and that needs the region recorded
 *    ALONGSIDE the expression — the persisted-shape change issue #2057
 *    deliberately deferred (its options 1 and 2). Until then the refusal is
 *    loud, names the ARN spelling as the remedy, and is the fail-closed side
 *    of a trade whose other side is a silent wrong-secret write.
 *
 *    (b) An `ssm` reference is secret only when its parameter is a
 *    `SecureString`, and this arm cannot tell. So a `{{resolve:ssm:/app/env}}`
 *    naming a PUBLIC `String` that reached a persisted bag (issue #2036's
 *    acknowledged over-redaction) is refused too. Narrowing it by
 *    `isRecordedSecretExpression` was considered and REJECTED, and not because
 *    the store is unreachable — it is imported by this very file. It is
 *    unusable: `recordedSecretExpressions` is populated BY resolution, and in
 *    the standalone `cdkd rollback` process nothing has resolved anything when
 *    the first op is classified, so the store is empty and every `ssm` verdict
 *    would come back "not secret" — turning the protection off for exactly the
 *    SecureString case it exists for. Worse, once one op DID resolve a
 *    reference the store would be warm for the next, so the verdict would
 *    depend on OP ORDER. A resolve-the-type-first probe is unsound for the
 *    same reason the whole issue exists: the TYPE is region-dependent (#1957),
 *    so probing locally can report `String` for a name that is `SecureString`
 *    in the producer's region and wave through the very write this refuses.
 *    The residual is therefore a loud, actionable error on a narrow
 *    intersection (an over-redacted public ssm reference AND a cross-region
 *    read on record), which is the fail-closed side of the trade.
 *
 *  - **`local`** — everything else, which is the overwhelmingly common case:
 *    every non-secret service, every same-region ARN (the ordinary CDK
 *    `secretValueFromJson` shape), and every name-form expression in a stack
 *    with no foreign producer region recorded. Resolved exactly as before this
 *    change.
 *
 * A same-region ARN answers `local` even when a foreign producer region IS on
 * record: the expression settles the question itself, so the weaker evidence
 * never gets consulted.
 */
export function classifyReplaySecretRegion(
  expression: string,
  consumerRegion: string,
  importedProducerRegions: readonly string[] | undefined
): ReplaySecretRegionVerdict {
  const inner = expression.startsWith('{{resolve:')
    ? expression.slice('{{resolve:'.length, -'}}'.length)
    : undefined;
  if (inner === undefined) return { kind: 'local' };
  const service = inner.split(':')[0];
  if (service === undefined || !REPLAY_SECRET_SERVICES.has(service)) return { kind: 'local' };

  const secretName =
    service === 'secretsmanager' ? secretsManagerSecretId(inner) : ssmParameterName(inner);
  if (!secretName) return { kind: 'local' };

  const named = arnRegion(secretName);
  if (named !== undefined) {
    return canonicalizeRegion(named) === canonicalizeRegion(consumerRegion)
      ? { kind: 'local' }
      : { kind: 'named-region', secretName, region: named };
  }

  const seen = new Set<string>();
  const foreignProducerRegions: string[] = [];
  for (const candidate of importedProducerRegions ?? []) {
    const canonical = canonicalizeRegion(candidate);
    if (!canonical || canonical === canonicalizeRegion(consumerRegion)) continue;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    foreignProducerRegions.push(candidate);
  }
  if (foreignProducerRegions.length === 0) return { kind: 'local' };
  return { kind: 'ambiguous', secretName, foreignProducerRegions };
}
