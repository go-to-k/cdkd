/**
 * Reading a state body: the key-region adoption, the legacy (`version: 1`) key probes and reads, and `parseStateBody`.
 *
 * Moved verbatim out of `src/state/s3-state-backend.ts` (go-to-k/cdkd#5835); the
 * `S3StateBackend` class keeps one `f.call(this, ...)` delegator per moved method.
 */
import type { S3StateBackend } from '../s3-state-backend.js';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import {
  STATE_SCHEMA_VERSIONS_READABLE,
  describeRegionValueKind,
  stackInstanceIdCarriedFrom,
  type StackState,
} from '../../types/state.js';
import { displayIdent, displaySafe, safeMsg } from '../../utils/display-safe.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { describeJsonParseFailure, utf8ByteLength } from '../../utils/json-parse-failure.js';
import { UNRENDERABLE } from '../lock-contention-message.js';
import { StateError } from '../../utils/error-handler.js';
import { type LegacyStateProbe, legacyProbeBelongsTo, isNoSuchKey } from './shared.js';

/**
 * Make the S3 KEY's region the region of the record read from it, and report
 * a body that named a different one.
 *
 * The key is the authority, and that is not a new rule: `saveState`
 * normalizes the body it writes against the same `region` argument
 * `getStateKey` builds the key from, and has done since `83e5ddb66` — the
 * commit that introduced the region-scoped layout (schema v2, PR
 * [#57](https://github.com/go-to-k/cdkd/pull/57)). Key and body therefore
 * agree by construction for every record any cdkd version has ever written,
 * so this makes the READ symmetric with a write rule that already held
 * rather than inventing a second one — and a divergence means the record was
 * written by something that is not cdkd.
 *
 * It is not cosmetic. `region` is what `destroy-runner/run.ts` and `under-lock.ts` lock, saves and
 * `deleteState`s against (`state.region ?? ctx.baseRegion`), and what
 * `DeleteContext.expectedRegion` carries so a provider can tell "the
 * resource is genuinely gone" from "I looked in the wrong region"
 * (`src/provisioning/region-check.ts`). A divergent body aimed all of that
 * at a region the record does not live in, and `cdkd state destroy` reported
 * `✓ State deleted` having deleted nothing (issue
 * [#3328](https://github.com/go-to-k/cdkd/issues/3328)). Normalizing HERE
 * fixes every consumer at once, with no region threaded through any of them.
 *
 * REFUSING instead was rejected deliberately: this is the shared read path
 * for deploy, destroy, rollback AND the recovery commands (`cdkd state
 * orphan`, `cdkd state destroy`), which is the same reason `parseStateBody`
 * validates nothing inside a well-formed root. A refusal would strand the
 * record it was asked to clean up, leaving `aws s3 rm` as the only remedy.
 *
 * It REPLACES rather than defaults, which is the half `??` cannot do:
 * `state.region ?? ctx.baseRegion` falls through only for `null` /
 * `undefined`, so a `"region": ""` built the key `cdkd/<stack>//state.json`
 * and a `"region": 123` reached `acquireLock` / `deleteState` as a region.
 *
 * **An ABSENT region is normalized too, and silently.** A body carrying no
 * `region` makes no claim to contradict, and the key it was read from names
 * one — which is the answer `legacyProbeBelongsTo` already gives one layout
 * over, where a body naming no region belongs to ANY region (issue
 * [#2550](https://github.com/go-to-k/cdkd/issues/2550)): "any region" plus
 * "read under this key" is this key's region. It is also strictly better than
 * what absence used to reach, which was `ctx.baseRegion` at the destroy —
 * the CLI's region, which need not be the key's at all.
 *
 * **`null` and `''` are NOT folded in with absent here, unlike in
 * `legacyProbeBelongsTo`**, and the difference is the key: the legacy key
 * names no region, so a falsy field there has to mean "any". This key names
 * one, so nothing needs inferring and the only question left is whether the
 * body AGREES — which `null` and `''` do not. They are also two of the shapes
 * `export.ts`'s nested-child refusal keys on, and folding them in would drop
 * that refusal silently.
 *
 * The divergent value is REPORTED to the caller rather than only logged
 * because one caller refuses on it: `walkCdkdStateStackTree` (`export.ts`)
 * fails a nested child whose recorded region is not its parent's, and
 * normalizing the state without reporting would have made that refusal
 * unreachable rather than fixed.
 */
export function adoptKeyRegion(
  this: S3StateBackend,
  state: StackState,
  region: string,
  shownStackName: string,
  shownRegionName: string
): { state: StackState; divergentBodyRegion?: unknown } {
  const raw = (state as { region?: unknown }).region;
  // The overwhelmingly common case: every record cdkd wrote. Returned as-is
  // so the healthy path allocates nothing.
  //
  // STRICT equality, deliberately: `'US-EAST-1'` or `' us-east-1'` against a
  // key of `us-east-1` is reported as a divergence, which on the destroy
  // means a refusal over a record that is arguably fine. Accepted, and
  // narrower than it looks — `saveState` writes the key's spelling verbatim,
  // so no cdkd-written record can hold either — and the alternative is worse:
  // a folding comparand here would have to agree with every consumer of the
  // value, and `getStateKey` does not fold. `confirmDeleteTargetIdentity`
  // folds because it compares two AWS-supplied regions, not a record against
  // its own key.
  if (raw === region) return { state };
  if (raw === undefined) {
    return { state: { ...state, ...stackInstanceIdCarriedFrom(state), region } };
  }

  // The VALUE is withheld from this warn, which prints at default verbosity.
  // It is body content, and a region a record supplies is precisely the
  // misdirection channel #3328 is about: a line reading
  // `body region 'eu-west-1'` hands the operator a region to re-run a
  // destructive command against. What is safe is its KIND — a bounded token,
  // one of ten — which is the same judgement `probeLegacyState` reaches one
  // branch over, for the reason its comment gives (it spells its own, pinned
  // verbatim by a unit case; `describeRegionValueKind`'s doc says why the two
  // are not collapsed).
  const kind = describeRegionValueKind(raw);
  this.logger.warn(
    `State record for stack ${shownStackName} carries a 'region' of its own (${kind}) that ` +
      `is not the region of the S3 key it was read from (${shownRegionName}). cdkd stamps ` +
      `the key's region into every record it writes, so this record was not written by cdkd. ` +
      `Continuing against ${shownRegionName} — the key is authoritative. Re-run with ` +
      `--verbose to see the recorded value, where it has one to show.`
  );
  // Sanitized even at debug, for the reason `tryGetLegacy`'s sibling gives:
  // debug is quieter than warn, not a different terminal. CAPPED as well: a
  // planted `region` is unvalidated body content of any length, and an
  // uncapped one floods the stream it is meant to explain.
  //
  // The EMPTY answer is spelled out rather than shown as `''` or
  // `<unrenderable>`, because `displaySafe` maps BOTH `null` and `''` to the
  // empty string — the two shapes the warn above singles out by kind — and a
  // debug line that adds nothing for them would make the warn's
  // "--verbose to see it" a false promise. The KIND is the whole answer for
  // those two, and this says so instead of implying a value was withheld.
  //
  // A non-empty region renders through `displayIdent`, which carries its own
  // cap and cut marker and a boundary of its own, never inside cdkd's quotes
  // (go-to-k/cdkd#3617).
  this.logger.debug(
    `State record for stack ${shownStackName} carries body region ` +
      (displaySafe(raw, { asciiOnly: true }) === ''
        ? `${kind}, which renders as nothing — its kind above is the whole of it.`
        : `${displayIdent(raw)}.`)
  );
  return {
    state: { ...state, ...stackInstanceIdCarriedFrom(state), region },
    divergentBodyRegion: raw,
  };
}

/**
 * Read the legacy key and classify what is there — {@link LegacyStateProbe}
 * says what each answer means and which consumer acts on it.
 */
export async function probeLegacyState(
  this: S3StateBackend,
  stackName: string
): Promise<LegacyStateProbe> {
  try {
    const response = await this.s3Client.send(
      new GetObjectCommand({
        Bucket: this.config.bucket,
        ...(await this.ownerParam()),
        Key: this.getLegacyStateKey(stackName),
      })
    );
    if (!response.Body) {
      this.logger.debug(
        `Legacy state probe for ${this.displayName(stackName)}: response carried no body`
      );
      return { kind: 'unreadable', reason: 'the response carried no body' };
    }
    const bodyString = await response.Body.transformToString();
    const state = JSON.parse(bodyString) as Partial<StackState>;
    // Mirror `tryGetLegacy`'s gate — `if (state.region && state.region !==
    // region)` — clause for clause, because the delete side has to accept
    // exactly the records the read side hands out:
    //
    //   falsy (undefined / null / '')   gate passes  -> readable from ANY region
    //   truthy string                   gate compares
    //   truthy NON-string (123, [...])  gate refuses from EVERY region
    //
    // A `typeof === 'string'` test is not enough for the last one: it sorts
    // a mangled `"region": 123` in with the region-less bodies, so the sweep
    // would delete a record `getState` will not even read. That is issue
    // #2550's read/delete asymmetry again, pointing the other way. `''` is
    // the same trap mirrored: a string, but falsy, so the read accepts it
    // from anywhere while an equality test would refuse to sweep it.
    const raw = (state as { region?: unknown }).region;
    if (!raw) return { kind: 'no-region' };
    if (typeof raw !== 'string') {
      // `typeof` only — never the value, which is body content. It is a
      // bounded token (one of seven), so it is safe in `reason` too and
      // tells the operator whether the field is a number, an array or an
      // object without showing them any of it.
      this.logger.debug(
        `Legacy state probe for ${this.displayName(stackName)}: ` +
          `'region' is ${typeof raw}, not a string`
      );
      return { kind: 'unreadable', reason: `its 'region' field is ${typeof raw}, not a string` };
    }
    return { kind: 'region', region: raw };
  } catch (error) {
    if (isNoSuchKey(error)) return { kind: 'absent' };
    // Don't fail the whole list on a single bad legacy file — log & skip.
    // `reason` is a BOUNDED value — an error class name, never a message.
    //
    // `describeAwsFailure().summary` is not safe here: it withholds AWS's
    // own wording only for AWS-AUTHORED failures, and returns `error.message`
    // verbatim for anything else. The failure that matters is `JSON.parse`
    // on the body, whose V8 `SyntaxError` embeds ~30 characters OF THAT BODY
    // in its message — so a principal able to write the state bucket could
    // put terminal escapes, or a neighbouring plaintext property value, into
    // a default-verbosity warn. A class name cannot carry either.
    const { detail } = describeAwsFailure(error);
    // Sanitized, unlike the usual detail-at-debug site: debug is quieter
    // than warn, not a different terminal. (The `try` above spans
    // `s3Client.send`, so this `detail` is AWS's own wording as well as a
    // parse snippet -- an earlier revision claimed only the latter.)
    this.logger.debug(
      `Could not read legacy state region for ${this.displayName(stackName)}: ` +
        `${displaySafe(detail, { asciiOnly: true }) || UNRENDERABLE}`
    );
    const cls = error instanceof Error && error.name ? error.name : 'an unknown error';
    return { kind: 'unreadable', reason: displaySafe(cls, { asciiOnly: true }) || UNRENDERABLE };
  }
}

/**
 * The region a legacy record should be listed under, or `undefined` when it
 * names none / could not be read. Preserves `listStacks`'s behaviour across
 * the {@link probeLegacyState} split.
 */
export async function readLegacyRegion(
  this: S3StateBackend,
  stackName: string
): Promise<string | undefined> {
  const probe = await this.probeLegacyState(stackName);
  return probe.kind === 'region' ? probe.region : undefined;
}

/**
 * Whether an operation targeting `region` owns the legacy record — the
 * DELETE-side counterpart of `tryGetLegacy`'s read gate, and issue #2550.
 *
 * The two must agree. `tryGetLegacy` accepts a body that names NO region
 * from any region (`if (state.region && state.region !== region)` is false
 * when the field is absent), so `cdkd destroy` reads such a record, deletes
 * the AWS resources, and finishes. The old equality test here answered
 * `undefined === 'us-east-1'` — false — so the record survived a successful
 * destroy, kept appearing in `cdkd state list`, and the next deploy of that
 * name planned updates against resources that were gone.
 *
 * `unreadable` is deliberately NOT treated as `no-region`: a 403, a 503 or a
 * malformed body says nothing about who owns the record, and a read that
 * failed must never authorise a delete. It collapsed into the same
 * `undefined` as the other two before, which is why the one-line fix — make
 * `undefined` match — was wrong: it would also have made `stateExists`
 * report state for a stack that has none, since `absent` reads the same way.
 */
export async function legacyBelongsToRegion(
  this: S3StateBackend,
  stackName: string,
  region: string
): Promise<boolean> {
  return legacyProbeBelongsTo(await this.probeLegacyState(stackName), region);
}

/**
 * Try to read the legacy `version: 1` state. Returns null when the legacy
 * key is missing or its embedded region does not match the caller's region.
 */
export async function tryGetLegacy(
  this: S3StateBackend,
  stackName: string,
  region: string
): Promise<{ state: StackState; etag: string } | null> {
  try {
    const response = await this.s3Client.send(
      new GetObjectCommand({
        Bucket: this.config.bucket,
        ...(await this.ownerParam()),
        Key: this.getLegacyStateKey(stackName),
      })
    );

    if (!response.Body || !response.ETag) {
      return null;
    }

    const bodyString = await response.Body.transformToString();
    const state = this.parseStateBody(bodyString, stackName);

    // Region gate: the same `stackName` may have lived in a different region
    // before the user changed `env.region`. We do NOT want to silently load
    // that record for a different target region — that's the silent-failure
    // bug PR 1 fixes.
    if (state.region && state.region !== region) {
      // Guarded like the sibling in `probeLegacyState`, and for the reason
      // that one gives: debug is quieter than warn, not a different terminal.
      // `state.region` here is state-BODY content, not just a key segment.
      this.logger.debug(
        `Legacy state for stack ${this.displayName(stackName)} has region ` +
          `${displayIdent(state.region)}, not ${displayIdent(region)} — skipping legacy fallback.`
      );
      return null;
    }

    // The gate above SHORT-CIRCUITS on a falsy region, so `''` / `0` / `false`
    // reach here as a DEFINED `state.region` that names no region at all — and
    // that field is what `destroy-runner.ts` locks, saves and deletes against
    // (`state.region ?? ctx.baseRegion`, which `''` is not nullish enough to
    // escape). A `""` built the key `cdkd/<stack>//state.json` and a `0` built
    // `cdkd/<stack>/0/state.json`, neither of which `listStacks` can see
    // afterwards — the same two failures `adoptKeyRegion` replaces one branch
    // over, arriving by the path it deliberately does not touch (go-to-k/cdkd#3328,
    // review round 1).
    //
    // The repair is to DROP the field rather than adopt the caller's region:
    // the legacy key names no region, so `undefined` is the honest value, and
    // it is what the gate above already decided this record means (it accepted
    // it from ANY region, which is `legacyProbeBelongsTo`'s `no-region` —
    // go-to-k/cdkd#2550). Every consumer's `?? baseRegion` then reaches its
    // fallback, which is the pre-v2 behaviour for a record that predates the
    // region-scoped layout. Adopting `region` instead would arm
    // `DeleteContext.expectedRegion` for a population
    // `cloud-control-provider.ts`'s `confirmDeleteTargetIdentity` documents as
    // arriving WITHOUT one.
    const legacyRegion = (state as { region?: unknown }).region;
    // ABSENT is the common legacy record and needs no rewrite — returned by
    // identity so the ordinary path allocates nothing.
    if (legacyRegion !== undefined && (typeof legacyRegion !== 'string' || legacyRegion === '')) {
      this.logger.debug(
        `Legacy state for stack ${this.displayName(stackName)} names no usable region ` +
          `(${describeRegionValueKind(legacyRegion)}); reading it as region-less.`
      );
      // `region` is OPTIONAL on `StackState`, so the rest object is already
      // assignable — no cast.
      const { region: _dropped, ...withoutRegion } = state;
      return { state: withoutRegion, etag: response.ETag };
    }

    return { state, etag: response.ETag };
  } catch (error) {
    if (isNoSuchKey(error)) return null;
    // Same guard as the new-key path above, and reachable from the same
    // command: `getState` falls back here, so a `state show` on a legacy
    // record takes this refusal (issue #3003).
    throw this.wrapS3Failure(
      error,
      (text) =>
        new StateError(
          `Failed to get legacy state for stack ${this.displayName(stackName)}: ${text}`,
          error instanceof Error ? error : undefined
        )
    );
  }
}

/**
 * Parse a state body and validate the schema version. Future-proofs against
 * a binary that predates schema version `N` reading a `version: N+1` blob:
 * the old binary would otherwise treat unknown fields as defaults and
 * silently lose data on the next save.
 */
export function parseStateBody(
  this: S3StateBackend,
  bodyString: string,
  stackName: string
): StackState {
  let root: unknown;
  try {
    root = JSON.parse(bodyString);
  } catch (error) {
    // V8's `SyntaxError` quotes a window of the offending INPUT, and before
    // `cdkd scrub` this body holds plaintext property and output values, so
    // the message names only the failure's offset and size (issue #5247;
    // `describeJsonParseFailure` owns the rule). V8's full text goes to
    // `debug` only, ASCII-allowlisted as `probeLegacyState` does its own
    // (issue #3003: the body is writable by anyone with `s3:PutObject`, and
    // an unsanitized newline forges a line).
    this.logger.debug(
      safeMsg`State file for stack ${this.displayName(stackName)} failed to parse: ${displaySafe(describeAwsFailure(error).detail, { asciiOnly: true }) || UNRENDERABLE}`
    );
    // `docs/troubleshooting-locks-state.md` quotes this message, and
    // `scripts/check-docs-error-strings.ts` fails when it can no longer
    // derive it from here: the checker is the authority, and it runs in CI.
    //
    // NO `cause`, deliberately (issue #5247): the `SyntaxError` carries the
    // same body window, and `formatError` prints a cause on its `Caused by:`
    // line while the CLI's last-resort handler inspects the whole chain. No
    // reader keys on this cause -- `getState` rethrows a `StateError`
    // unchanged, and the retry classifiers and `extractDeploymentEventError`
    // look for AWS markers a `SyntaxError` never carries -- and a snippet-free
    // wrapper would only print this message's own detail a second time.
    throw new StateError(
      `State file for stack ${this.displayName(stackName)} is not valid JSON: ` +
        `${describeJsonParseFailure(error, utf8ByteLength(bodyString))}`
    );
  }

  // Past the parse, a non-object ROOT is the one SHAPE refused here (issue
  // #2947; the schema-version check below is a value check). A body that
  // parses to `null`, an array or a primitive is usable by no consumer:
  // `null` threw a raw `TypeError` at the `.version` read below, and the
  // others passed it and reached every consumer as a record. Everything
  // INSIDE a well-formed root is deliberately NOT validated at this boundary:
  // this is the read path for deploy, destroy, rollback and the recovery
  // commands (`state orphan`, `state destroy`), so a refusal here would make
  // a broken record unreadable by every one of them AT ONCE, including the
  // two whose job is to clean it up — and plain `cdkd state show --json`
  // reads such a record today. That is an argument about what stays
  // FIXABLE, not a claim about what works now: `state orphan` and
  // `state destroy` still abort on a `null` resources bag at their own
  // dereference, which is issue go-to-k/cdkd#3018's class, and each is one
  // guard away precisely because the boundary let the record through.
  // Normalising one here would be worse than either, though NOT for the
  // reason it is tempting to give: the deploy path's `previousState` lookup
  // already reads a `null` entry exactly as it reads an absent one (a
  // truthiness test), so dropping the entry changes nothing at that lookup.
  // What it changes is a consumer that enumerates KEYS — the destroy count,
  // `state orphan`'s `id in resources` — for which a `null` entry keeps the
  // logical id visible (nameable to a command, even though `state orphan`,
  // like the diff, still refuses the entry at its own dereference today —
  // go-to-k/cdkd#3018 again) while a dropped one erases it from the record
  // silently. Inner shapes are tolerated where they are dereferenced instead.
  if (root === null || typeof root !== 'object' || Array.isArray(root)) {
    const got = root === null ? 'null' : Array.isArray(root) ? 'an array' : `a ${typeof root}`;
    throw new StateError(
      `State file for stack ${this.displayName(stackName)} is not a JSON object (it parses to ${got}), ` +
        `so cdkd cannot read it as a state record.`
    );
  }
  const parsed = root as StackState;

  const v = parsed.version;
  if (v !== undefined && !STATE_SCHEMA_VERSIONS_READABLE.includes(v)) {
    // `displaySafe` rather than `String(v)`: the value is an unchecked cast, so
    // a string one reached the terminal verbatim (issue #3003) and one whose
    // coercion throws — an object whose `toString` is not callable — made the
    // refusal itself throw a `TypeError` (issue #2947); `displaySafe` absorbs
    // both. `null` is mapped to its word FIRST, because `displaySafe` renders
    // an absent value empty, and the refusal would then say the `UNRENDERABLE`
    // stand-in instead of the one precise word it has. The REFUSAL is
    // unchanged: `includes` compares with SameValueZero, so no value is
    // coerced to reach it.
    const vShown: unknown = v;
    const shown =
      displaySafe(vShown === null ? 'null' : vShown, { asciiOnly: true }) || UNRENDERABLE;
    throw new StateError(
      `Unsupported state schema version ${shown} for stack ${this.displayName(stackName)}. ` +
        `This cdkd binary supports versions ${STATE_SCHEMA_VERSIONS_READABLE.join(', ')}. ` +
        `Upgrade cdkd to a version that supports schema ${shown}.`
    );
  }

  return parsed;
}
