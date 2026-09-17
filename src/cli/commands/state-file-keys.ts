import type { S3StateBackend } from '../../state/s3-state-backend.js';
import { STACK_REF_MAX_CODE_POINTS, displayIdent } from '../../utils/display-safe.js';

/**
 * Shared helpers for enumerating and describing cdkd state-bucket keys.
 *
 * Extracted from `bootstrap-destroy.ts` (issue #1010) so that `cdkd gc`
 * (issue #1012) reuses the exact same whole-bucket state-file discovery
 * instead of duplicating it — the "scan the WHOLE bucket, not just the
 * default `cdkd/` prefix" rule was a review blocker once already (PR #1018)
 * and must not drift between the two commands.
 */

/**
 * Every cdkd state file ends with this suffix, regardless of the
 * `--state-prefix` it was deployed under (`{prefix}/{stack}/{region}/state.json`,
 * or legacy `{prefix}/{stack}/state.json`).
 */
export const STATE_FILE_SUFFIX = '/state.json';

/**
 * The prefix `cdkd bootstrap` writes under, and the one `gc` /
 * `bootstrap --destroy` configure their own state backend with.
 *
 * Shared here rather than spelled per command for the same reason this module
 * exists at all: `bootstrap-destroy.ts` and `gc.ts` each held their own copy,
 * and it is now also the `knownPrefix` argument to {@link describeStateKey},
 * where a copy that drifted from the backend's actual prefix would silently
 * send every key back to the shape heuristic instead of the exact depth rule.
 *
 * Note this is only the DEFAULT. Other commands accept `--state-prefix`, so
 * the whole-bucket listings deliberately do not scope to it.
 */
export { DEFAULT_STATE_PREFIX } from '../../state/state-prefix.js';

/**
 * The prefix `CustomResourceProvider` writes its response placeholders under.
 *
 * Re-exported here (rather than re-spelled) for exactly the reason the
 * paragraph above gives for `DEFAULT_STATE_PREFIX`: `gc.ts` collects what the
 * provider produces, and a second spelling is how a sweeper silently stops
 * covering the family it was written for (issue #2052).
 */
export { CUSTOM_RESOURCE_RESPONSE_PREFIX } from '../../state/state-prefix.js';

/**
 * Segments left under a known prefix for the legacy `{prefix}/{stack}` layout.
 *
 * The twin of `S3StateBackend`'s `LEGACY_KEY_DEPTH`, which counts the
 * `state.json` segment as well; this one counts what remains after the prefix
 * and the suffix are stripped, so it is that value minus one. Fenced against it
 * by a unit test rather than imported: a value import from `s3-state-backend.js`
 * breaks every suite that mocks that module. That is the reason, and it is
 * specific to THAT module — this file does import values from `display-safe.js`,
 * which is a leaf with no imports of its own.
 */
const LEGACY_SEGMENTS_UNDER_PREFIX = 1;

/**
 * Every cdkd stack lock ends with this suffix — the lock lives next to the
 * state file (`{prefix}/{stack}/{region}/lock.json`, or the legacy region-less
 * `{prefix}/{stack}/lock.json` that `lock-manager.ts` still writes for a
 * pre-v2 stack).
 */
export const LOCK_FILE_SUFFIX = '/lock.json';

/**
 * `us-east-1` / `ap-northeast-1` / `us-gov-west-1` — a region-shaped segment.
 *
 * The first token is `[a-z]{2}` OR the literal `eusc` (issue #2001). Every
 * region AWS ships has a two-letter first token except the European Sovereign
 * Cloud partition's, which is four — `eusc-de-east-1` — and the old
 * `^[a-z]{2}` rejected that whole partition. Enumerated from
 * `aws-cdk-lib/region-info` and `@aws-sdk/util-endpoints`: 46 REAL regions,
 * first tokens all two letters or `eusc`, none three. (A count of 53 includes
 * the `aws-global` / `aws-iso-*-global` PSEUDO-regions, whose first token is
 * `aws`; they carry no trailing `-<digits>`, so this pattern rejects them and
 * so did the old one — no behavioural difference, but at 53 the "two letters
 * or eusc" claim is false as stated.)
 *
 * **The exception is enumerated rather than widened, and that is the whole
 * design.** The obvious fix — relaxing the bound to `{2,4}` — was written
 * first and review measured what it cost: `api-prod-1`, `demo-app-1`,
 * `dev-api-1`, `core-api-1`, `test-stack-2` all become region-shaped under it.
 * Those are idiomatic STACK names, and in the legacy region-less layout a
 * stack name sits exactly where a region would, so the pattern would report
 * the key's PREFIX as the stack for each of them — the same wrong answer this
 * issue is about, arriving from the other side and at a far higher rate. A
 * length class cannot separate `eusc` from `demo`; only naming the partition
 * can.
 *
 * The cost of enumerating is that a future partition with a new non-two-letter
 * token needs this line updated. That is the same failure this issue fixed, it
 * is a one-token change, and it fails in the recoverable direction (a region
 * read as a stack name) rather than corrupting ordinary stack names.
 *
 * It stays SHAPE-based and deliberately does not reuse `isClientSafeRegion`
 * from `intrinsic-function-resolver.ts`: that predicate is charset-based (its
 * job is to keep a value inside a hostname label, so it accepts anything
 * lowercase-alphanumeric) and would classify almost every stack name as a
 * region. This one has the opposite job — telling a region segment apart from
 * a stack name in the same position — so it must constrain the shape.
 *
 * A two-letter STACK name like `db-prod-1` is still misread in the legacy
 * layout; that is pre-existing (`main` does the same) and is what the
 * `knownPrefix` depth rule below repairs for callers that can supply one.
 */
const REGION_SEGMENT = /^(?:[a-z]{2}|eusc)(-[a-z]+)+-\d+$/;

/**
 * List every state file in the bucket — the WHOLE bucket, not just the
 * default `cdkd/` prefix. Other commands accept `--state-prefix`, so live
 * stack state may exist under ANY prefix in this bucket; scoping this
 * listing to the default prefix would let reference scans and teardown
 * guards silently miss those stacks and delete live data.
 */
export async function listAllStateKeys(
  stateBackend: Pick<S3StateBackend, 'listRawKeys'>
): Promise<string[]> {
  const keys = await stateBackend.listRawKeys('');
  return keys.filter((k) => k.endsWith(STATE_FILE_SUFFIX));
}

/**
 * List every stack lock file in the bucket — same whole-bucket rule as
 * {@link listAllStateKeys}. A lock under ANY prefix means a deploy /
 * destroy may be in flight for that stack.
 */
export async function listAllLockKeys(
  stateBackend: Pick<S3StateBackend, 'listRawKeys'>
): Promise<string[]> {
  const keys = await stateBackend.listRawKeys('');
  return keys.filter((k) => k.endsWith(LOCK_FILE_SUFFIX));
}

/** The two halves {@link parseStateKey} splits a state or lock key into. */
export interface StateKeyParts {
  /** The stack segment, RAW — sanitise before rendering. */
  stack: string;
  /** The region segment when the key carries one; absent on a legacy key. */
  region?: string;
}

/**
 * Split `{prefix}/{stack}/{region}/state.json` into its parts; legacy
 * `{prefix}/{stack}/state.json` yields a `region`-less result. Pass
 * {@link LOCK_FILE_SUFFIX} to parse lock keys.
 *
 * STRUCTURAL, so a caller that needs the halves never has to re-parse a
 * RENDERED string. `gc.ts` did exactly that — it ran `/^(\S+) \((\S+)\)$/` over
 * `describeStateKey`'s own output to build a `cdkd state show ...` command —
 * and that re-parse was already fragile before this change (`\S` excludes
 * `\r`, so a planted carriage return silently took the no-match branch and put
 * the WHOLE rendered string in the command's stack-name position). Sanitising
 * the rendered form would have broken the re-parse outright; returning the
 * parts removes the question. Issue
 * [#3179](https://github.com/go-to-k/cdkd/issues/3179) section C.
 *
 * The shape heuristic below cannot be made exact, and it errs in BOTH
 * directions -- a region it fails to recognise is reported AS the stack name,
 * while a region-shaped STACK name in the legacy layout makes it report the
 * key's PREFIX as the stack. Neither is safe: `cdkd gc`'s corrupt-state abort
 * turns whichever answer it gets into a `cdkd state show ...` recovery
 * command, so a wrong one is handed to the user as a command to run.
 *
 * `knownPrefix` narrows it where a caller can: a key with exactly one segment
 * under a prefix we know is the legacy `{stack}` layout by construction,
 * whatever the stack is named, so no shape test is needed there at all. That
 * repairs the pre-existing two-letter case (`cdkd/db-prod-1/state.json`, which
 * `main` describes as `cdkd (db-prod-1)`).
 *
 * **It is a narrowing, not a safety net for the pattern above.** A first cut
 * treated it as one — widening `REGION_SEGMENT` to `{2,4}` and relying on this
 * rule to undo the damage — and review measured that the damage is repo-wide
 * while this rule reaches only keys under the ONE prefix a caller names. The
 * listing deliberately spans the whole bucket, so foreign and nested prefixes
 * are in scope and unreachable from here; six shapes regressed against `main`
 * that way. The pattern must be right on its own.
 *
 * **It deliberately does NOT claim the two-segment case.** A first cut did, on
 * the reasoning that at that depth the last segment must be the region -- and
 * review found `--state-prefix cdkd/team-a`, which nests inside the default
 * prefix, so `cdkd/team-a/MyStack/state.json` is a LEGACY key two segments
 * deep and would have been mis-split as `team-a (MyStack)` where `main` said
 * `MyStack`. Depth cannot tell that apart from a real `{stack}/{region}`; only
 * the shape of the tail can, so the heuristic keeps that case.
 */
export function parseStateKey(
  key: string,
  suffix: string = STATE_FILE_SUFFIX,
  knownPrefix?: string
): StateKeyParts {
  const body = key.slice(0, -suffix.length);

  // Tolerate a trailing slash on the caller's prefix. Without this a
  // `knownPrefix` of `'cdkd/'` fails the `startsWith` below and silently
  // demotes every key to the heuristic — which is the exact failure this
  // parameter exists to prevent, arriving through a spelling rather than a
  // drift.
  const prefix = knownPrefix?.replace(/\/+$/, '');

  if (prefix !== undefined && prefix !== '' && key.startsWith(`${prefix}/`)) {
    const rest = body.slice(prefix.length + 1).split('/');
    // `{stack}` — the legacy region-less layout, and the only depth this rule
    // can settle on its own.
    //
    // Spelled locally rather than imported: this module is deliberately
    // dependency-free apart from one `type`, and importing a VALUE from
    // `s3-state-backend.js` breaks every suite that mocks that module. The two
    // copies are fenced against each other by
    // `tests/unit/cli/state-file-keys.test.ts` instead, which imports both.
    // `LEGACY_KEY_DEPTH` counts the `state.json` segment too, hence the `- 1`.
    if (rest.length === LEGACY_SEGMENTS_UNDER_PREFIX && rest[0]) return { stack: rest[0] };
    // Everything else -- including two segments, which may be `{stack}/{region}`
    // OR a legacy key under a prefix nested inside this one -- is the
    // heuristic's to answer.
  }

  const segments = body.split('/');
  const last = segments[segments.length - 1] ?? key;
  const secondLast = segments[segments.length - 2];
  // `secondLast` must be non-empty as well as present: a double slash otherwise
  // pairs onto nothing and yields a leading-space " (us-east-1)", which
  // `gc.ts`'s re-parse of this string then fails to match, emitting a recovery
  // command with an empty stack name.
  if (secondLast !== undefined && secondLast !== '' && REGION_SEGMENT.test(last)) {
    return { stack: secondLast, region: last };
  }
  return { stack: last };
}

/**
 * `{prefix}/{stack}/{region}/state.json` → `stack (region)`; legacy
 * `{prefix}/{stack}/state.json` → `stack`. Pass {@link LOCK_FILE_SUFFIX} to
 * describe lock keys.
 *
 * The split is {@link parseStateKey}'s; this renders it for a HUMAN, through
 * `displayIdent`, which is the whole of what changed for issue
 * [#3179](https://github.com/go-to-k/cdkd/issues/3179) section C. Both halves
 * come out of an S3 KEY, and a state-bucket key is not cdkd's to trust: anyone
 * holding `s3:PutObject` on the bucket chooses it, the same premise
 * go-to-k/cdkd#3207 rests on for the record BODY. Every reader of this string
 * puts it in front of an operator who is deciding whether to destroy something,
 * so an unbounded, unsanitised value is read as cdkd's own words.
 *
 * Measured on this tree before the change, with `cdkd/` as the known prefix:
 * a key segment `Prod<ESC>[2K<CR>SafeStack` rendered as itself, and a terminal
 * ERASES the line and shows `SafeStack (us-east-1)` — a different stack than
 * the record names. `displayIdent` sanitises to ASCII, caps the length, and
 * quotes anything outside the plain-identifier set, so that segment now renders
 * visibly quoted and visibly altered.
 *
 * The stack half takes `STACK_REF_MAX_CODE_POINTS` rather than the default cap,
 * matching `state.ts`'s `formatStackRefSafe`: a cdkd state-record stack name is
 * NOT bounded by CloudFormation's 128, because a nested-stack child's name is
 * minted recursively as `${parent}~${logicalId}`.
 *
 * What this does NOT make safe is a value INTERPOLATED INTO A COMMAND — see
 * {@link isPasteableIdent}, which exists because `displayIdent` correctly
 * renders `--state-bucket=attacker` bare (every character of it is a plain
 * identifier character) while that value is a flag, not a name.
 */
export function describeStateKey(
  key: string,
  suffix: string = STATE_FILE_SUFFIX,
  knownPrefix?: string
): string {
  const { stack, region } = parseStateKey(key, suffix, knownPrefix);
  const name = displayIdent(stack, { maxCodePoints: STACK_REF_MAX_CODE_POINTS });
  return region === undefined ? name : `${name} (${displayIdent(region)})`;
}

/**
 * The shape a state-key segment must have before it may be interpolated into a
 * command cdkd invites an operator to PASTE.
 *
 * An ALLOW-LIST, and deliberately so: the first cut of this predicate was a
 * deny-list that refused a leading `-`, and review defeated it with a leading
 * `~`. A deny-list has to enumerate every character a shell treats specially
 * BEFORE cdkd sees the word, and the set of things nobody thought of is
 * unbounded. The repo already settled this once — `rollback-executor.ts`'s
 * `PASTEABLE_LOGICAL_ID` is `/^[A-Za-z0-9]{1,255}$/`, with a comment naming
 * `~user` and `=x` by name.
 *
 * This one is wider than that because the values here are not logical ids: a
 * cdkd state record's stack name carries `~` (a nested-stack child is minted
 * `${parent}~${logicalId}`) and a region carries `-`. What it keeps from the
 * precedent is the LEADING character, which is where the danger is. MEASURED
 * in bash on a real host rather than reasoned:
 *
 *     ~root        -> /var/root        ~/x  -> $HOME/x       ~-  -> $OLDPWD
 *     a=~/x        -> a=$HOME/x
 *     Parent~Child -> inert            a:~/x -> inert
 *
 * So `~` is dangerous only in the leading position or straight after `=`,
 * which is why a medial `~` stays in the set and `=` stays out of it entirely.
 * A leading digit or letter also closes the option case: `--state-bucket=x`
 * cannot match, and that one is NOT about shell quoting — it is still an
 * OPTION after quoting, which is why the answer is refusal rather than quoting.
 */
const PASTEABLE_STATE_IDENT = /^[A-Za-z0-9][A-Za-z0-9~_.-]*$/;

/**
 * The cap for rendering a whole state or lock KEY, as opposed to one segment.
 *
 * A key CONTAINS a stack name, so capping it at `STACK_REF_MAX_CODE_POINTS`
 * cuts a legitimate one: the fixed segments around the name — `{prefix}/`,
 * `/{region}/` and `state.json` / `lock.json` — are not free. The extra 64
 * covers them with roughly 37 characters left for the prefix — measured, not
 * generous: at a full-budget stack name a longer `--state-prefix` still
 * overflows, and the cost of that is cosmetic. It matters because a key renders
 * `[cut: N more characters withheld]` is at its least useful inside the very
 * sentence that tells an operator to go and inspect THAT key.
 *
 * Same status as the constant it builds on, and stated for the same reason: a
 * BUDGET, not an enforced bound. Nothing in `src/` validates key length.
 */
export const STATE_KEY_MAX_CODE_POINTS = STACK_REF_MAX_CODE_POINTS + 64;

/**
 * Is this value safe to interpolate into a command we tell an operator to RUN?
 *
 * Two independent tests, and BOTH are load-bearing:
 *
 * 1. {@link PASTEABLE_STATE_IDENT}, which decides the shell question — see its
 *    own note for why it is an allow-list and what was measured.
 * 2. It renders byte-identically through `displayIdent`, which adds the LENGTH
 *    cap and the ASCII rule the regex does not carry, asked through the public
 *    API rather than by re-spelling `PLAIN_IDENT` (a second spelling of a
 *    security predicate is how the two drift).
 *
 * Deliberately NOT shell-quoting instead. Quoting answers test 2's population
 * and none of the option case — `'--state-bucket=attacker'` is still parsed as
 * a flag — and a command that LOOKS runnable is the thing being handed over, so
 * the honest answer for a value failing either test is to print the S3 key and
 * let the operator decide.
 */
export function isPasteableIdent(value: string): boolean {
  if (!PASTEABLE_STATE_IDENT.test(value)) return false;
  return displayIdent(value, { maxCodePoints: STACK_REF_MAX_CODE_POINTS }) === value;
}
