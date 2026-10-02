import type { IntrinsicFunctionResolver } from '../intrinsic-function-resolver.js';
import { injectiveKey } from '../../state/record-keys.js';
import {
  ambientCredentialConfig,
  credentialFingerprint,
} from '../../utils/ambient-client-defaults.js';
import {
  DynamicReferenceRegionAmbiguousError,
  IntrinsicResolutionRefusalError,
} from '../../utils/error-handler.js';
import { stringifyValue } from '../../utils/stringify.js';
import {
  type DynamicReferencePass,
  MAX_DYNAMIC_REFERENCE_THROTTLE_RETRIES,
  type NamedRequestMasks,
  type ResolverContext,
  dynamicReferenceRetryDelays,
  isDeliberateResolutionRefusal,
  quotedRender,
  recordedSecretExpressions,
  withoutProducerRegions,
} from './support.js';
import { withRetry } from '../retry.js';
import { isThrottlingError, markNonRetryable } from '../retryable-errors.js';
import {
  type DynamicReferenceSubstitution,
  SECRET_MASK,
  dynamicReferenceTokens,
  recordResolvedPair,
} from '../secret-redaction.js';
import { classifyReplaySecretRegion } from '../secret-region-classification.js';
import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { GetParameterCommand } from '@aws-sdk/client-ssm';

/** `sendWithThrottleRetry` keeps its type parameter, which `OmitThisParameter` would erase. */
type SendWithThrottleRetry = <T>(
  operation: () => Promise<T>,
  ...rest: Parameters<OmitThisParameter<typeof sendWithThrottleRetry>> extends [unknown, ...infer R]
    ? R
    : never
) => Promise<T>;

declare module '../intrinsic-function-resolver.js' {
  interface IntrinsicFunctionResolver {
    resolveDynamicReferences: OmitThisParameter<typeof resolveDynamicReferences>;
    /** @internal */
    resolveTemplateLeafReferences: OmitThisParameter<typeof resolveTemplateLeafReferences>;
    /** @internal */
    resolveDynamicReferencesWithLogTwin: OmitThisParameter<
      typeof resolveDynamicReferencesWithLogTwin
    >;
    /** @internal */
    resolveSecretsManagerReference: OmitThisParameter<typeof resolveSecretsManagerReference>;
    /** @internal */
    sendWithThrottleRetry: SendWithThrottleRetry;
    /** @internal */
    resolveSSMReference: OmitThisParameter<typeof resolveSSMReference>;
  }
}

/**
 * Resolve the dynamic references of a PERSISTED string leaf: text read back
 * out of a state record, a rollback journal or a producer stack's outputs.
 * That is what every caller of this method hands it (`cdkd drift`, the
 * rollback replay, `cdkd scrub`'s per-token delegation, the cross-stack
 * re-resolution); a TEMPLATE leaf goes through {@link resolve}, which takes
 * {@link resolveTemplateLeafReferences}.
 *
 * The distinction is load-bearing for two refusals. A token of a
 * service cdkd does not resolve is REFUSED on the template route when it
 * holds a secret, because leaving it would send that secret to AWS for the
 * first time. Persisted text is different on both counts: AWS already holds
 * it, so refusing buys no confidentiality, and the refusal is DETERMINISTIC
 * there -- a journal `previousState` holding `{{resolve:<plaintext>}}` beside
 * the reference that resolves to it would fail its rollback op on every
 * retry, where replaying the literal is a correct no-op. So this entry point
 * keeps the warn-and-leave for every such token, and the value scan redacts
 * whatever is persisted afterwards (issue #2743). A resolvable token
 * assembled from a secret (a twin mask in it, or a secret a parent passed
 * in) that resolves to a secret is REFUSED on the template route, since recording it would persist the other secret inside
 * the reference (issue #4166); here it resolves, for the same two reasons.
 */
export async function resolveDynamicReferences(
  this: IntrinsicFunctionResolver,
  value: string,
  context?: ResolverContext
): Promise<string> {
  return (await this.resolveDynamicReferencesWithLogTwin(value, value, context, undefined, true))
    .result;
}

/** A TEMPLATE string leaf: the refusing route (see {@link resolveDynamicReferences}). */
export async function resolveTemplateLeafReferences(
  this: IntrinsicFunctionResolver,
  value: string,
  context?: ResolverContext
): Promise<string> {
  return (await this.resolveDynamicReferencesWithLogTwin(value, value, context)).result;
}

/**
 * {@link resolveDynamicReferences}, also returning the LOG TWIN of the result
 * (issue [#3100](https://github.com/go-to-k/cdkd/issues/3100), see
 * `LogTwin`). `logTwin` is the caller's twin of `value`, which may already
 * mask spans an earlier write put there.
 *
 * Every arm that writes into `result` writes into the twin too, replacing
 * the SAME token: a secret verdict writes {@link SECRET_MASK}, anything else
 * the value itself. The verdict is the one each arm already holds — the
 * fresh lookup's `isSecret`, the cache entry's own `secret` (never the
 * process-wide store, for the #1933 reason the cache-hit arm states), and
 * for a region-pinned sibling the twin the sibling itself returns. An arm
 * that `continue`s without writing leaves the token in both.
 *
 * A token whose text an earlier write masked (`{{resolve:${Pw}}}` over a
 * secret `Pw`) is not found in the twin, so the twin keeps the masked token
 * where the value holds its resolution. What the twin cannot carry is a
 * NEEDLE match that straddles a masked span, which is why the log lines go
 * through `logTwinText` rather than masking the twin alone.
 */
export async function resolveDynamicReferencesWithLogTwin(
  this: IntrinsicFunctionResolver,
  value: string,
  logTwin: string,
  context?: ResolverContext,
  // The DISPLAY of a token a parent resolver delegated here (issue #3150):
  // its log text and its names' log texts, as the parent paired them. Log
  // lines only: `logTwin` stays the token itself, so the twin this method
  // registers for its result is the one it registered before.
  inherited?: { tokenLogText: string; nameLogText: (name: string) => string },
  // PERSISTED text rather than a template leaf: neither the unsupported-service
  // arm nor the secret-assembled refusal (issue #4166) refuses it. Set by {@link resolveDynamicReferences} alone, so the
  // default -- every internal route -- is the refusing one.
  persistedText = false
): Promise<DynamicReferencePass> {
  // Match all {{resolve:...}} patterns
  const pattern = /\{\{resolve:([^}]+)\}\}/g;
  let result = value;
  let twin = logTwin;
  // Issue #3156: every replacement below, in order, with its own verdict;
  // `complete` drops at each arm that leaves a token in place, the recovery
  // arm included.
  const substitutions: DynamicReferenceSubstitution[] = [];
  let complete = true;
  let match: RegExpExecArray | null;

  // Collect all matches first (to avoid issues with modifying string during iteration)
  const matches: Array<{ fullMatch: string; inner: string }> = [];
  while ((match = pattern.exec(value)) !== null) {
    matches.push({ fullMatch: match[0], inner: match[1]! });
  }
  // Each token's log twin, paired by position with the twin's own tokens
  // (issue #3150). The two strings carry the same tokens in the same order
  // unless a mask covers part of a token's `{{resolve:` opener or `}}`
  // closer; then no token is paired and every name prints as `***`.
  const twinTokens = dynamicReferenceTokens(logTwin);
  const tokensAligned = twinTokens.length === matches.length;

  for (const [index, { fullMatch, inner }] of matches.entries()) {
    // OUTSIDE the `try` below: none of this can throw, and the catch needs
    // `tokenLogText` to record the entry as the twin would PRINT it rather
    // than as the raw token spells it.
    const service = inner.split(':')[0];
    const pairedTwin = tokensAligned ? twinTokens[index] : undefined;
    const tokenLogText =
      inherited?.tokenLogText ??
      (pairedTwin === undefined
        ? SECRET_MASK
        : this.straddleSafeTwin(fullMatch, pairedTwin, context));
    const nameLogText =
      inherited?.nameLogText ??
      (pairedTwin === undefined
        ? () => SECRET_MASK
        : this.dynamicReferenceNameLogText(inner, pairedTwin, context));

    // PER-TOKEN `try`, so one unfetchable reference stops abandoning every
    // LATER token in the same leaf (go-to-k/cdkd#3181). This loop was a bare
    // sequential walk: a deleted SSM parameter in token 1 meant token 2 was
    // never fetched and recorded no needle, so a plaintext behind it survived
    // every redaction pass and every re-run.
    //
    // THE LOG-TWIN INVARIANT IS UNAFFECTED, which is the half that had to be
    // ARGUED rather than tested (issue #3100). Tokens pair to twin tokens BY
    // INDEX into `matches` / `twinTokens`, both built BEFORE this loop, and
    // recovery changes neither list: a skipped token is still visited, still
    // occupies its index, and simply writes into neither string. The rule
    // "every arm that writes into `result` writes into the twin too,
    // replacing the SAME token" is untouched — what changes is only that a
    // LATER arm now runs at all. An arm that throws part-way wrote to neither,
    // since every write site sits at the end of its arm.
    try {
      // A `secretsmanager` reference resolves to a real secret by SPELLING. A
      // plain `ssm` one resolves to a secret only when the parameter's `Type` is
      // `SecureString` (issue #1901) — a fact discovered from the GetParameter
      // response below and remembered in `recordedSecretExpressions`, so the
      // cache-hit and skip arms here can act on it without a second lookup.
      // Either way the plaintext -> expression mapping is recorded so the deploy
      // engine keeps the UNRESOLVED expression in persisted state and masks the
      // value out of logs (GHSA fix). A plain `String` / `StringList` parameter
      // is public config and stays RESOLVED in state, so it is never recorded.
      // Recorded on the cache-hit path too, so a second reference to the same
      // secret in the same pass is still redacted.
      // `ssm-secure` is a secret by SPELLING too (issue #2482): CloudFormation
      // defines that service for SecureString parameters only, so no lookup is
      // needed to know the value must not be persisted — and on the comparison
      // path below it is left unresolved WITHOUT a `GetParameter`, exactly like
      // `secretsmanager`.
      const isKnownSecret =
        service === 'secretsmanager' ||
        service === 'ssm-secure' ||
        recordedSecretExpressions.has(fullMatch);

      // Diff / no-op comparison path: leave SECRET references UNRESOLVED (the
      // expression is what state stores, so comparing keeps like-for-like and
      // makes no live GetSecretValue). A plain `ssm` reference still resolves —
      // it is public config stored resolved in state — but it cannot be waved
      // through on spelling alone, so an ssm reference of UNKNOWN type falls
      // through to the lookup below, which asks for the type WITHOUT decrypting.
      // (GHSA fix + issue #1901.)
      if (isKnownSecret && context?.skipDynamicReferences) {
        complete = false;
        continue;
      }

      // WHICH REGION MUST ANSWER for this reference (issue #2134). Asked HERE,
      // token by token, because here is the first point at which the COMPLETE
      // expression exists: `resolveSub` and `resolveJoin` both re-enter this
      // method with their assembled result, so a reference whose opening or
      // whose tail is contributed by a `Ref` / `Fn::Sub` / `Fn::FindInMap` /
      // `Fn::Join` part is a whole token by the time it reaches this loop.
      //
      // The pre-#2134 answer was a PRE-PASS over the RAW template leaf in
      // `cdkd scrub`, which by construction could not see such a reference --
      // it scanned text in which the reference did not yet exist, found
      // nothing to classify, and handed the leaf on. `resolveSub` then
      // resolved the assembled expression on THIS resolver, so a foreign ARN
      // was fetched against the stack's own regional endpoint. What that COSTS
      // depends on the spelling, and the measurement corrected the issue's own
      // framing: for an ARN-form reference SSM validates the region and answers
      // `Incorrect region in: arn:aws:ssm:...`, so it is a hard FAILURE rather
      // than a silent wrong-region read (probed against real AWS with this fix
      // reverted). The SILENT miss belongs to the region-LESS spelling, where a
      // same-named secret in the wrong region answers successfully -- which is
      // what the `ambiguous` refusal below covers.
      //
      // Placed after the `skipDynamicReferences` arm on purpose -- but the
      // reason is NARROWER than "the comparison path resolves no secret at
      // all", which is false: that arm skips only a KNOWN secret, so a plain
      // `ssm` reference of unknown type falls through it and IS fetched. What
      // makes the placement safe is that the only `skipDynamicReferences`
      // caller (`diff-recursive.ts`) supplies no `producerRegions`, so the
      // refusal cannot arm there whichever side of the arm it sits on. Stated
      // this way because the stronger claim would go stale the moment a second
      // caller sets both.
      // Placed BEFORE the cache lookup on purpose too -- a `named-region`
      // token is resolved by a SIBLING and belongs in the sibling's cache, so
      // this resolver must never hold an entry for it.
      const regionVerdict = classifyReplaySecretRegion(
        fullMatch,
        // `explicitRegion` is the region that BINDS; `resolverRegion` is its
        // fallback guess and is only reachable from test construction (see the
        // fields' own docs). The guess is used rather than `''` because an
        // empty consumer region reads EVERY recorded producer region as
        // foreign, turning the refusal below into a blanket one.
        this.explicitRegion ?? this.resolverRegion,
        context?.producerRegions
      );

      if (regionVerdict.kind === 'ambiguous') {
        // Non-retryable: this is a DECISION, not a transient failure, so a
        // retry can only re-take it -- and the retry wrapper would otherwise
        // spend the full backoff budget before surfacing the message that
        // tells the user how to fix their template.
        throw markNonRetryable(
          new DynamicReferenceRegionAmbiguousError(
            // `fullMatch` is the token cut from the ASSEMBLED reference string,
            // so `resolveSub` re-entering with an assembled body puts a
            // plaintext here — the same plaintext the sibling throws mask after
            // parsing it out of this very token (issue #2827 review round 2).
            `Refusing to resolve the secret reference ${this.displayMasked(tokenLogText, context)}: it names ` +
              `${quotedRender(this.displayMasked(nameLogText(regionVerdict.secretName), context), "'", 'a secret whose name is not a plain identifier')} without a region, and this stack reads from ` +
              `${this.displayMasked(regionVerdict.foreignProducerRegions.map((r) => this.displayMasked(r, context)).join(', '), context)} as well as its own ` +
              `region. cdkd cannot tell which one must answer, and resolving against ` +
              `the wrong one yields a different secret. Spell the reference as a full ARN ` +
              `to say which region owns it.`
          )
        );
      }

      // Issue #4266: a `secretsmanager` / `ssm-secure` result is a secret by
      // SPELLING, so the issue #4166 refusal needs no lookup to know it
      // applies. Refused before the sibling delegation and the cache, so an
      // id assembled from another secret is never sent to AWS, where
      // CloudTrail records it. After the `ambiguous` refusal, which makes no
      // lookup either and which `cdkd scrub` re-raises by class. A plain
      // `ssm` token still needs the lookup to learn its `Type`, and is
      // refused after it.
      if (!persistedText && (service === 'secretsmanager' || service === 'ssm-secure')) {
        this.refuseSecretAssembledReference(fullMatch, tokenLogText, context);
      }

      if (regionVerdict.kind === 'named-region') {
        // Delegate the single TOKEN -- not the whole string -- to a resolver
        // pinned to the region the ARN names. `resolverForProducerRegion`
        // marks the sibling a `producerRegionGuest`, so it cannot pin a
        // verdict in the process-global `recordedSecretExpressions` store: the
        // #1933 hazard, where one region's `ssm` parameter TYPE decides
        // another region's redaction.
        //
        // Exactly ONE level of recursion, and it is provable rather than
        // argued: the sibling is constructed pinned to `verdict.region`, so
        // when it re-enters this method the same classifier compares that ARN's
        // region against its own and returns `local`. A name-form reference can
        // never arrive here at all, because only the `named-region` arm
        // delegates.
        const sibling = this.resolverForProducerRegion(
          regionVerdict.region,
          context,
          nameLogText(regionVerdict.region)
        );
        // Same evidence-stripping as `reresolveCrossStackValue` above, and for
        // the same reason. Harmless on THIS path today -- the token is ARN-form
        // by construction, so the sibling verdicts `local` whatever evidence it
        // holds -- but the shape is identical, and leaving one site to depend
        // on that argument is how the other one broke.
        const foreign = await sibling.resolveDynamicReferencesWithLogTwin(
          fullMatch,
          fullMatch,
          // Unconditional here: this arm is reached only for an ARN-form token,
          // whose region the ARN itself states, so the origin is known by
          // construction and the evidence can only mislead.
          withoutProducerRegions(context),
          // How the sibling PRINTS the token and its names (issue #3150). Not
          // passed as the twin: the sibling registers its result against the
          // twin it holds, and a masked twin there would register a public
          // value as `***`, which `Fn::Base64` then persists.
          { tokenLogText, nameLogText },
          // PROPAGATED, not defaulted: this internal route is entered ON
          // BEHALF of whatever drove the outer call, so a delegation made for
          // persisted text must not re-arm the refusal the outer call was
          // exempt from. The sibling reaches the refusal of a secret result
          // assembled from a secret (issue #4166); the unsupported-service
          // refusal it cannot reach, since the arm is only taken for an
          // ARN-form resolvable service.
          persistedText
        );
        // Replacer FUNCTION for the same reason as every other substitution in
        // this method: a resolved secret legitimately containing `$&` would
        // otherwise splice the matched expression back into itself.
        result = result.replace(fullMatch, () => foreign.result);
        twin = twin.replace(fullMatch, () => foreign.twin);
        // ONE logical replacement, carrying the verdict the sibling's own
        // replacement took. A sibling that left its token, or replaced other
        // than exactly this one, makes the pass incomplete.
        const [delegated] = foreign.substitutions;
        substitutions.push({
          token: fullMatch,
          value: foreign.result,
          secret: foreign.substitutions.length === 1 && delegated!.secret,
        });
        if (!foreign.complete || foreign.substitutions.length !== 1) complete = false;
        continue;
      }

      // Check cache first. INSTANCE-scoped, so a hit can only ever be a value
      // THIS resolver resolved — i.e. one from its own stack and its own region
      // (issue #1933; see the field's own doc) — and keyed by the credential
      // identity too (issue #3660). The key is read ONCE here and reused at the
      // `set` below: every service arm's first `await` is its lookup helper,
      // which selects `clientsForRegion(...)` before ITS first `await`, so the
      // key and the client that answers come from one reading. Never log it.
      const dynamicReferenceCacheKey = injectiveKey(
        credentialFingerprint(ambientCredentialConfig()),
        fullMatch
      );
      const cached = this.cachedDynamicReferences.get(dynamicReferenceCacheKey);
      if (cached) {
        // The `cached.value` test excludes the empty string: an empty secret is
        // not a usable redaction needle (it would match every empty leaf).
        //
        // The verdict is read off the ENTRY **and only off the entry** —
        // deliberately NOT `isKnownSecret`, and that exclusion is the point.
        // `isKnownSecret` consults the process-global `recordedSecretExpressions`,
        // which a FOREIGN resolver writes to, so ORing it in here would re-open
        // the cross-resolver channel this cache's instance scope exists to close
        // — in the opposite direction from the leak (issue #1933 review):
        //
        //   virginia resolves `/env` -> `String` -> retracts the memo, caches
        //   {value:'prod', secret:false}; tokyo resolves the SAME expression ->
        //   `SecureString` -> re-adds the memo; virginia's next resource hits
        //   this arm with `isKnownSecret` true from TOKYO's add and records
        //   'prod' as a redaction NEEDLE, rewriting its own `my-prod-bucket`
        //   into `my-{{resolve:ssm:/env}}-bucket`.
        //
        // That is exactly the corruption the retraction arm below exists to
        // prevent, arriving through the cache instead. Reachable at the default
        // `--stack-concurrency 4`.
        //
        // Nothing legitimate is lost, because `cached.secret` is AUTHORITATIVE
        // for every entry this resolver could have written: for ssm it is
        // `param.secure` off the fresh `GetParameter` response (which OVERWRITES
        // the `isKnownSecret` seed below), for secretsmanager it is `true` by
        // spelling, and only `cacheable` — i.e. definitive — verdicts are stored
        // at all. A cache hit therefore already knows its own answer, and the
        // global store can only ever contradict it with another region's.
        //
        // Still deliberately does NOT add to `recordedSecretExpressions`:
        // reaching this arm means the resolution that POPULATED this instance's
        // cache already recorded whatever it was entitled to pin, and a second
        // add could only ever be a no-op or an un-pinning it explicitly avoided
        // (issue #1916).
        // Reachable for a plain `ssm` token only: the other two services are
        // refused above, before the cache (issue #4266).
        if (cached.secret && cached.value && !persistedText) {
          this.refuseSecretAssembledReference(fullMatch, tokenLogText, context);
        }
        const recorded = context?.recordedSecretValues;
        if (cached.secret && cached.value && recorded) {
          recorded.set(cached.value, fullMatch);
          // The uncollapsed twin of that entry (issue #2485) — see the
          // fresh-resolution seam below.
          recordResolvedPair(recorded, fullMatch, cached.value);
        }
        // Replacer FUNCTION, not a string: `String.replace` interprets `$&`,
        // "$`", `$'` and `$1` inside a replacement STRING, so a resolved value
        // containing any of them would be corrupted on its way to AWS — and
        // `$&` in particular splices the matched `{{resolve:...}}` expression
        // back INTO the value. A secret is exactly the kind of value that
        // legitimately contains `$`.
        result = result.replace(fullMatch, () => cached.value);
        twin = twin.replace(fullMatch, () =>
          cached.secret && cached.value ? SECRET_MASK : cached.value
        );
        substitutions.push({ token: fullMatch, value: cached.value, secret: cached.secret });
        continue;
      }

      const parts = inner.split(':');

      let resolved: string;
      let isSecret = isKnownSecret;
      /**
       * May the resolved value be REMEMBERED, or must the next pass re-ask?
       *
       * Cleared for exactly the answers the verdict store refuses to pin — an
       * ssm parameter judged secret from a `Type` that is not a definitive
       * `SecureString` (issue #1901's fail-closed arm). Caching one would pin
       * the transient answer for the whole resolver anyway, which is what the
       * refusal to memoize exists to prevent: before the value cache became
       * instance-scoped this was already true process-wide, and the
       * "next pass re-asks" property only ever held on the comparison path,
       * which caches nothing (issue #1933).
       */
      let cacheable = true;
      // A definitive `SecureString` verdict read on the deploy path, pinned
      // only once the issue #4166 refusal below has passed: pinned first,
      // a refused token would stay in the process-wide store, where the
      // redaction path can still name it as a leaf's expression.
      let pinSecureVerdict = false;

      if (service === 'secretsmanager') {
        resolved = await this.resolveSecretsManagerReference(inner, context, nameLogText);
      } else if (service === 'ssm') {
        // On the comparison path fetch the parameter WITHOUT decryption: a
        // `SecureString` then comes back as its encrypted blob, so the type can
        // be learned with no plaintext ever leaving AWS. `String` /
        // `StringList` are unaffected by the flag, so the value is the same one
        // the deploy path would resolve and is safe to cache and substitute.
        const decrypt = context?.skipDynamicReferences !== true;
        const param = await this.resolveSSMReference(parts, decrypt, 'ssm', context, nameLogText);
        // The FRESH response is authoritative, so a definitive public verdict
        // both clears `isSecret` and RETRACTS a stale memo. Without the
        // retraction the verdict could only ever be raised, so one transient
        // unclassifiable `Type` (or a parameter retyped SecureString ->
        // String) pinned "secret" for the process — and a pinned PUBLIC value
        // then becomes a redaction NEEDLE, rewriting an unrelated string that
        // merely contains it (`prod` turning `my-prod-bucket` into
        // `my-{{resolve:ssm:/env}}-bucket` in that resource's record). Only a
        // definitive `SecureString` is memoized: an unclassifiable type is
        // treated as secret for THIS resolution but deliberately not pinned,
        // so the next pass re-asks instead of inheriting a transient answer.
        if (param.type === 'SecureString') {
          if (decrypt) pinSecureVerdict = true;
          // The comparison path resolves nothing, so it cannot refuse; it
          // still must not pin a token the deploy path would refuse.
          else if (
            persistedText ||
            !this.tokenAssembledForRecording(fullMatch, tokenLogText, context)
          ) {
            this.pinSecretVerdict(fullMatch, true);
          }
        } else if (!param.secure) {
          this.pinSecretVerdict(fullMatch, false);
        } else {
          // Secret, but from a `Type` too anomalous to memoize — so the VALUE is
          // not memoized either. See `cacheable`'s doc above.
          cacheable = false;
        }
        isSecret = param.secure;
        if (param.secure) {
          if (!decrypt) {
            // Comparison path: the value in hand is ciphertext, which is neither
            // what state holds nor safe to cache. Leave the expression
            // unresolved, exactly as the secretsmanager skip above does — once
            // a SecureString verdict is pinned above, later passes
            // short-circuit before the lookup (a TEMPLATE token assembled from
            // a secret is not pinned, so it is looked up again, issue #4166).
            complete = false;
            continue;
          }
        }
        resolved = param.value;
      } else if (service === 'ssm-secure') {
        // Issue #2482. Before this arm existed the spelling fell through to
        // the unsupported-service warning below and the LITERAL TOKEN went to
        // AWS as the property's value — cdkd never passes through
        // CloudFormation, so nothing resolved it server-side, and where the
        // service API accepted the string (an IAM console password does) the
        // live credential WAS the template text, with the deploy exiting 0.
        //
        // The value is a secret by SPELLING and the verdict does not depend on
        // the response: CloudFormation defines `ssm-secure` for SecureString
        // parameters only, and every reader that asks whether an expression is
        // secret (`isKnownSecret` above, `isSecretExpressionByVerdictOrSpelling`
        // in `secret-redaction.ts`) answers from the spelling. The expression is
        // still RECORDED into the process-wide store at the shared tail below,
        // beside `secretsmanager`, because that store is also ENUMERATED (the
        // #1916 losing-member recovery) — not because a verdict needs a memo.
        // The lookup itself is the `ssm` arm's, with decryption —
        // `isKnownSecret` kept the comparison path away from here, so
        // `decrypt` is unconditional. A definitive `String` / `StringList` answer is
        // REFUSED rather than resolved under a secret spelling: the template
        // says the value is secret and the parameter says it is not, and
        // resolving it would record a public value as a redaction needle over
        // that disagreement. `markNonRetryable` because the parameter's type
        // is not something a retry can change.
        const param = await this.resolveSSMReference(
          parts,
          true,
          'ssm-secure',
          context,
          nameLogText
        );
        if (!param.secure) {
          // `secure` is false only for the two PUBLIC types the predicate
          // names, so `type` is a definitive `String` / `StringList` here.
          // not-in-class(param.type): `secure` is false only when AWS's `Type`
          // EQUALS `String` or `StringList`, so it is one of those two literals
          // and carries no control character (issue #3441).
          throw markNonRetryable(
            new IntrinsicResolutionRefusalError(
              // Masked for the reason the `ssm-secure` refusal above states.
              `Refusing to resolve ${this.displayMasked(tokenLogText, context)}: the parameter is a ${param.type} ` +
                `parameter, and the ssm-secure spelling is defined for SecureString parameters only. ` +
                `Reference it as {{resolve:ssm:...}} if it is public configuration.`
            )
          );
        }
        isSecret = true;
        resolved = param.value;
      } else {
        // Masked like the lookup echoes above (issue #2728, review round 1):
        // `service` is whatever sits before the first `:` of the ASSEMBLED
        // token, and `resolveSub` re-enters this method with the assembled
        // string — a body of `{{resolve:${Pw}}}` over a variable that
        // resolved a secret makes `service` BE that plaintext, on a `warn`
        // emitted at default verbosity.
        //
        // Issue #2743: a token ASSEMBLED FROM A SECRET is refused rather
        // than left in place. The `continue` below leaves the literal span
        // in the value, so the plaintext inside it would go to AWS as the
        // property's value and into `state.json`. Two independent
        // detectors, either one refuses:
        //
        // - `tokenLogText !== fullMatch`: the log twin masks a span of this
        //   token, i.e. an earlier write put a secret there. Floor-free, so
        //   it sees a secret shorter than the needle floor. An UNPAIRED twin
        //   (the twin's tokens do not line up with the value's, which only
        //   a mask over a `{{resolve:` opener or a `}}` closer causes) makes
        //   `tokenLogText` the bare mask, so it lands here too: fail closed.
        // - the needle mask changes the raw token: a recorded or inherited
        //   plaintext sits in it although no twin says so (a `Ref` to a
        //   nested-stack parameter the parent decrypted registers no twin).
        //
        // An UNTAINTED token keeps the warn-and-leave below: `cdkd drift`
        // and the rollback replay re-enter here with persisted text that
        // merely looks like a reference, and report it per token.
        //
        // The grammar bounds what this predicate sees (`[^}]+`). A plaintext
        // holding ONE `}` leaves no complete token, so this loop never sees
        // it: it reaches the provider as the ordinary text it is, and the
        // value scan redacts it in state. A plaintext holding `}}` DOES
        // form a token, from its own prefix (`ab}}cd` makes
        // `{{resolve:ab}}`), and the twin half refuses that one.
        //
        // BOTH halves are skipped for persisted text, explicitly. Only the
        // needle half can fire there (that entry point passes the value as
        // its own twin, so every token pairs with itself), and it is the one
        // that must not: see {@link resolveDynamicReferences}.
        if (!persistedText && this.tokenAssembledFromSecret(fullMatch, tokenLogText, context)) {
          throw markNonRetryable(
            new IntrinsicResolutionRefusalError(
              `Refusing to resolve ${this.displayMasked(tokenLogText, context)}: its service is not one cdkd ` +
                `resolves (secretsmanager, ssm, ssm-secure), and the reference was assembled from a ` +
                `secret value, so leaving it as written would send that value to AWS and record it ` +
                `in state in the clear.`
            )
          );
        }
        this.logger.warn(
          this.displayMasked(
            `Unsupported dynamic reference service: ${this.displayMasked(nameLogText(String(service)), context)}`,
            context
          )
        );
        complete = false;
        continue;
      }

      // Issue #4166: refused BEFORE the cache write too, so a later pass
      // cannot take the value from the cache arm without the same check.
      if (isSecret && resolved && !persistedText) {
        this.refuseSecretAssembledReference(fullMatch, tokenLogText, context);
      }
      if (pinSecureVerdict) this.pinSecretVerdict(fullMatch, true);

      // The verdict is stored ALONGSIDE the value so the cache-hit arm above can
      // re-record it into a later pass's bag on its own, without depending on a
      // process-global verdict store another stack's resolver can retract from
      // under it (issue #1933).
      if (cacheable) {
        this.cachedDynamicReferences.set(dynamicReferenceCacheKey, {
          value: resolved,
          secret: isSecret,
        });
      }
      if (isSecret && resolved) {
        // The map is bound ONCE and both writes go through that binding: the
        // entry, and the same pair keyed by EXPRESSION, per map instance
        // (issue #2485) — the map keeps one expression per plaintext, and the
        // redaction path needs to know what THIS token resolved to in THIS
        // pass to position a literal leaf that embeds it beside a sibling
        // sharing the value. One binding makes it structurally impossible for
        // the entry and the pair to disagree about which pass the evidence
        // belongs to.
        const recorded = context?.recordedSecretValues;
        if (recorded) {
          recorded.set(resolved, fullMatch);
          recordResolvedPair(recorded, fullMatch, resolved);
        }
        // The value-keyed map above COLLAPSES a group of expressions sharing a
        // resolved value down to its last member; this set does not, which is
        // what lets the redaction path name the losing member (issue #1916).
        //
        // Gated on the SPELLING rather than on `isSecret`, and that is the
        // whole care of this line: every ssm verdict is owned by the arm above,
        // which pins ONLY a definitive `SecureString`. An unclassifiable `Type`
        // sets `isSecret` for THIS resolution and is deliberately NOT pinned,
        // so that the next pass re-asks AWS instead of inheriting a transient
        // answer — recording it here would pin it for the process and undo
        // exactly that (issue #1901). It IS recorded above as pass-local
        // evidence, though: the redaction path positions a literal leaf that
        // embeds such a token — or a whole-token leaf this store cannot vouch
        // for — by that record, for THIS pass only; what the unclassifiable
        // verdict does not get is the process-wide pin. `ssm-secure` is secret by
        // spelling exactly like `secretsmanager` (issue #2482), so it is
        // recorded here for the same reason: `positionByIntrinsicSkeleton`
        // enumerates this set to name a LOSING member, and without the entry
        // two intrinsic-shaped `ssm-secure` references sharing a value would
        // persist the winner's expression at the loser's position.
        if (service === 'secretsmanager' || service === 'ssm-secure') {
          this.pinSecretVerdict(fullMatch, true);
        }
      }
      // Replacer FUNCTION — see the cache-hit arm above for why a replacement
      // STRING is unsafe here.
      result = result.replace(fullMatch, () => resolved);
      twin = twin.replace(fullMatch, () => (isSecret && resolved ? SECRET_MASK : resolved));
      substitutions.push({ token: fullMatch, value: resolved, secret: isSecret });
    } catch (err) {
      // No bag means the caller did not opt in: keep the pre-#3181 abort.
      if (context?.abandonedResolutions === undefined) throw err;
      // A deliberate REFUSAL still aborts. Getting this backwards turns a
      // decision that must stop the run into a silently skipped token.
      if (isDeliberateResolutionRefusal(err)) throw err;
      context.abandonedResolutions.push(
        this.abandonedUnit('token', tokenLogText, err, context, fullMatch, (text) => {
          // The thrown text can echo the reference's own ARGUMENT back —
          // SSM's `ValidationException` / `ParameterNotFound` name the
          // parameter. `sendWithThrottleRetry` masks that echo by position
          // before it rethrows (go-to-k/cdkd#3171); this pass is the layer
          // for a lookup failure raised by any other route.
          // For an ASSEMBLED reference that argument can be a SUB-FLOOR
          // secret, which the needle mask cannot see. `nameLogText` is
          // twin-derived and so has no floor; map each raw segment through
          // it before the needle mask runs.
          // DEFENCE IN DEPTH since go-to-k/cdkd#3171, and measured as such:
          // with this pre-pass deleted, `redacts a LONGER reference field
          // before a shorter one that prefixes it` in
          // `tests/unit/deployment/intrinsic-resolver-per-token-recovery.test.ts`
          // stays green, because its SDK rejection is now masked (longest name
          // first, `positionalNameMask`) before it reaches this catch. That
          // case was this pass's fence until then. The shape it fences is
          // still the one to keep in mind: a LONGER secret-derived field in
          // the thrown text while a SHORTER field prefixing it sorts EARLIER
          // in `inner.split(':')` (`...staging label: ***SECRETTAIL` under
          // source order). A secret wholly inside ONE field leaves the piece
          // counts equal, so `dynamicReferenceNameLogText` does not degrade.
          //
          // LONGEST FIRST, and deduplicated. Replacing a SHORTER segment
          // first mangles a longer one that contains it, so the longer one's
          // own replacement then matches nothing and its remainder survives:
          // for `secretsmanager:SEC:SecretString:SECRET`, masking `SEC` turns
          // `SECRET` into `***RET` and `RET` is left in the clear. This is
          // the same precedence `buildNeedleRegex` applies for the same
          // reason — the repo had already solved it, and the first cut of
          // this loop re-derived it wrongly in source order.
          let out = text;
          const segments = [...new Set(inner.split(':'))]
            .filter((segment) => segment.length > 0)
            .sort((a, b) => b.length - a.length);
          for (const segment of segments) {
            const logged = nameLogText(segment);
            if (logged !== segment) out = out.split(segment).join(logged);
          }
          return out;
        })
      );
      // Leave the token in BOTH strings, unreplaced and still paired -- and
      // so the pass is not complete (issue #3156).
      complete = false;
      continue;
    }
  }

  // Registered HERE rather than by callers (issue #3100): every route into
  // a reference-bearing string — `resolveValue`, a region-pinned sibling,
  // a cross-stack re-resolution, `cdkd scrub` / `drift` — reaches this
  // method, so an `Fn::Join` / `Fn::Sub` whose part arrived by any of them
  // (`Fn::Select`, `Fn::If`, `Fn::ImportValue`, ...) still masks where the
  // substitution wrote. A per-caller registration missed each route in turn.
  if (context) this.rememberLogTwin(context, result, twin);
  return { result, twin, substitutions, complete };
}

/**
 * Resolve a Secrets Manager dynamic reference
 *
 * Format: secretsmanager:SECRET_ID:SecretString:JSON_KEY:VERSION_STAGE:VERSION_ID
 * SECRET_ID can be a simple name or an ARN (arn:aws:secretsmanager:REGION:ACCOUNT:secret:NAME)
 * which contains colons, so we cannot simply split on ':'.
 * Instead, we find ':SecretString:' or ':SecretBinary:' as the delimiter.
 *
 * The whole-secret form omits everything after the type segment and carries no trailing
 * colon: "secretsmanager:SECRET_ID:SecretString" (returns the full secret string). We detect
 * it with an end-anchored check so that, for the whole-secret form, a SECRET_ID that merely
 * contains ":SecretString" mid-name is not split incorrectly. (The end-anchored fallback only
 * runs when no mid-string ":SecretString:" delimiter is present, so the json-key / version
 * forms are unaffected.)
 */
export async function resolveSecretsManagerReference(
  this: IntrinsicFunctionResolver,
  inner: string,
  // For the two log lines below only (issue #2728): a reference ASSEMBLED
  // by `Fn::Sub` / `Fn::Join` from a value this pass resolved out of a
  // secret carries that plaintext in its secret id / JSON key, and the
  // debug echo and the retry label would print it.
  context: ResolverContext | undefined,
  // Each name's log text, from the token's twin (issue #3150,
  // `dynamicReferenceNameLogText`). Required: a default would print the
  // names raw for a caller that forgot it.
  nameLogText: (name: string) => string
): Promise<string> {
  // inner = "secretsmanager:SECRET_ID:SecretString:JSON_KEY:VERSION_STAGE:VERSION_ID"
  // Remove the "secretsmanager:" prefix
  const afterService = inner.substring('secretsmanager:'.length);

  // Find :SecretString: or :SecretBinary: as the delimiter between SECRET_ID and the rest
  let secretId: string;
  let jsonKey = '';
  let versionStage = '';
  let versionId = '';

  let secretStringIdx = afterService.indexOf(':SecretString:');
  let secretBinaryIdx = afterService.indexOf(':SecretBinary:');
  let delimiterLenAtBinary = ':SecretBinary:'.length;
  let delimiterLenAtString = ':SecretString:'.length;

  // Whole-secret form: "<SECRET_ID>:SecretString" / "<SECRET_ID>:SecretBinary" with NO
  // trailing colon and no JSON_KEY (end of string). The trailing-colon indexOf above misses
  // it, so fall back to an END-ANCHORED check. An end-anchored check (not a loose includes)
  // avoids a false split when a secret NAME legitimately contains ":SecretString" mid-name.
  if (secretStringIdx < 0 && afterService.endsWith(':SecretString')) {
    secretStringIdx = afterService.length - ':SecretString'.length;
    delimiterLenAtString = ':SecretString'.length;
  }
  if (secretBinaryIdx < 0 && afterService.endsWith(':SecretBinary')) {
    secretBinaryIdx = afterService.length - ':SecretBinary'.length;
    delimiterLenAtBinary = ':SecretBinary'.length;
  }

  const delimiterIdx =
    secretStringIdx >= 0 && secretBinaryIdx >= 0
      ? Math.min(secretStringIdx, secretBinaryIdx)
      : secretStringIdx >= 0
        ? secretStringIdx
        : secretBinaryIdx;
  const delimiterLen =
    delimiterIdx >= 0 && delimiterIdx === secretBinaryIdx
      ? delimiterLenAtBinary
      : delimiterLenAtString;

  if (delimiterIdx >= 0) {
    secretId = afterService.substring(0, delimiterIdx);
    // remaining = "JSON_KEY:VERSION_STAGE:VERSION_ID" (empty for the whole-secret form)
    const remaining = afterService.substring(delimiterIdx + delimiterLen);
    const remainingParts = remaining.split(':');
    jsonKey = remainingParts[0] || '';
    versionStage = remainingParts[1] || '';
    versionId = remainingParts[2] || '';
  } else {
    // No :SecretString: or :SecretBinary: found, treat entire afterService as SECRET_ID
    secretId = afterService;
  }

  // Empty strings should be treated as undefined (handles trailing :: in references)
  if (!versionStage) {
    versionStage = 'AWSCURRENT';
  }

  if (!secretId) {
    throw new Error('Dynamic reference: secretsmanager SECRET_ID is required');
  }

  // MASKED PER RAW VALUE rather than over the assembled message (issue
  // [#2827](https://github.com/go-to-k/cdkd/issues/2827)). `secretId` /
  // `jsonKey` come from the ASSEMBLED reference text — `resolveSub` /
  // `resolveJoin` re-enter `resolveDynamicReferences` with the assembled
  // string — so an `Fn::Sub` that builds either out of a value this same
  // pass decrypted puts that plaintext in every line and every throw below.
  // The raw-value form is what buys `maskSecretsInText`'s WHOLE-VALUE arm,
  // which has no {@link MIN_NEEDLE_LENGTH} floor; masking the finished
  // message reaches only the substring arm, where a sub-floor plaintext
  // prints in full. Same rule `masked-retry-logger.ts` states for a
  // provider's wrapped `error.message`.
  const loggedSecretId = this.displayMasked(nameLogText(secretId), context);
  const loggedJsonKey = this.displayMasked(nameLogText(jsonKey), context);

  this.logger.debug(
    `Resolving dynamic reference: secretsmanager:${loggedSecretId}:SecretString:${loggedJsonKey}:` +
      `${this.displayMasked(nameLogText(versionStage), context)}:` +
      `${this.displayMasked(nameLogText(versionId), context)}`
  );

  // Region-sensitive, and the reason issue #1957 is a security defect rather
  // than only a correctness one: the same secret NAME in two regions is two
  // different credentials.
  const client = this.clientsForRegion(this.explicitRegion).secretsManager;

  const command = new GetSecretValueCommand({
    SecretId: secretId,
    ...(versionStage && versionStage !== '' && { VersionStage: versionStage }),
    ...(versionId && versionId !== '' && { VersionId: versionId }),
  });

  const response = await this.sendWithThrottleRetry(
    () => client.send(command),
    `secretsmanager:${loggedSecretId}`,
    // Every name the REQUEST carries, as sent (go-to-k/cdkd#3171). The JSON
    // key is not sent, so no SDK text can quote it.
    this.namedRequestMasks(
      [
        [secretId, loggedSecretId],
        [versionStage, this.displayMasked(nameLogText(versionStage), context)],
        [versionId, this.displayMasked(nameLogText(versionId), context)],
      ],
      context
    )
  );
  const secretString = response.SecretString;

  if (!secretString) {
    throw new Error(
      `Dynamic reference: secret ${quotedRender(loggedSecretId, "'")} does not contain a SecretString value`
    );
  }

  // If JSON_KEY is specified, parse JSON and extract the key
  if (jsonKey) {
    try {
      const parsed = JSON.parse(secretString) as Record<string, unknown>;
      // `Object.hasOwn` (issue #2767), and the worst site of the class:
      // `jsonKey` comes from the dynamic reference's own text, so
      // `{{resolve:secretsmanager:<id>:SecretString:constructor}}` read the
      // `Object` function out of the parsed secret, passed the not-found
      // throw below, and `stringifyValue` rendered its SOURCE TEXT as the
      // resolved secret value.
      const keyValue = Object.hasOwn(parsed, jsonKey) ? parsed[jsonKey] : undefined;
      if (keyValue === undefined) {
        throw new Error(
          `Dynamic reference: key ${quotedRender(loggedJsonKey, "'")} not found in secret ${quotedRender(loggedSecretId, "'")}`
        );
      }
      // NOT part of the `stringifyValue` escaping class (issue #2759): the
      // encoding happens HERE, before `resolveDynamicReferences` records the
      // returned string as the needle, so what the bag holds IS the encoded
      // form and every later masker matches it literally.
      return stringifyValue(keyValue);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(
          `Dynamic reference: secret ${quotedRender(loggedSecretId, "'")} is not valid JSON but JSON_KEY ${quotedRender(loggedJsonKey, "'")} was specified`
        );
      }
      throw error;
    }
  }

  // No JSON_KEY: return full secret string
  return secretString;
}

/**
 * Run one dynamic-reference lookup, retrying THROTTLE-shaped failures only
 * (issue #1933 review).
 *
 * Both lookups behind `{{resolve:...}}` were bare `send` calls, so a single
 * `Rate exceeded` aborted the deploy. That was already the wrong trade for a
 * read, and this PR raises the call count on both paths: the resolved-value
 * cache is per-resolver now (one lookup per stack rather than one per
 * process), and a value whose ssm `Type` came back unclassifiable is
 * deliberately not cached at all (one lookup per OCCURRENCE, so it re-asks
 * AWS rather than inheriting a transient verdict). Retrying only the throttle
 * shape keeps every real answer — `ParameterNotFound`, `AccessDenied`, a
 * malformed reference — failing fast and unchanged.
 *
 * Two bounds, both NAMED rather than fixed here:
 *
 * - No `isInterrupted` is threaded, so a Ctrl-C landing inside the backoff is
 *   only noticed when that sleep ends — worst case ~8s, ~15s across the whole
 *   schedule. `withRetry` supports the hook, but the only interrupt state in
 *   the tree is `DeployEngine.interrupted`, which reaches nothing here;
 *   wiring it means a resolver option threaded from that engine.
 * - It says NOTHING about concurrency. The client is captured before the
 *   first attempt, so a sibling stack's teardown (`stackAwsClients.destroy()`
 *   in `deploy.ts`) during a backoff surfaces as a raw, non-throttle-shaped
 *   failure on the next attempt, and the retry does not make that safe. Issue
 *   [#1957](https://github.com/go-to-k/cdkd/issues/1957) NARROWED this rather
 *   than removing it: a lookup whose region differs from the ambient one now
 *   runs on {@link clientsForRegion}'s own clients, which no sibling stack can
 *   destroy because nothing else in the process holds a reference to them. A
 *   sibling in the SAME region still shares the ambient instance, so the
 *   window survives exactly where the two stacks agree on the region.
 */
export async function sendWithThrottleRetry<T>(
  this: IntrinsicFunctionResolver,
  operation: () => Promise<T>,
  label: string,
  // REQUIRED (go-to-k/cdkd#3171): the lookup's request carries the
  // reference's names, and both SDK-text routes out of here quote them — the
  // retry line and the rethrown rejection. A default would print them raw
  // for a caller that forgot it.
  masks: NamedRequestMasks
): Promise<T> {
  try {
    return await withRetry(operation, label, {
      maxRetries: MAX_DYNAMIC_REFERENCE_THROTTLE_RETRIES,
      // Classifies the RAW error: the retry decision is made before any
      // masking, so masking cannot change which failures are retried.
      isRetryable: (_message, error) => isThrottlingError(error),
      logger: masks.retryLogger,
      ...(dynamicReferenceRetryDelays.sleep ? { sleep: dynamicReferenceRetryDelays.sleep } : {}),
    });
  } catch (error) {
    throw masks.error(error);
  }
}

/**
 * Resolve an `{{resolve:ssm:...}}` dynamic reference, reporting whether the
 * parameter is a `SecureString` (issue #1901).
 *
 * `secure` is read off the SAME `GetParameter` response that carries the
 * value, so classifying a reference costs no extra API call — which is what
 * makes it affordable on the comparison path too.
 *
 * `decrypt` maps straight to `WithDecryption`. SSM ignores it for `String` /
 * `StringList` (their `Value` is identical either way), so the only thing it
 * changes is whether a `SecureString`'s `Value` comes back as plaintext or as
 * its encrypted blob. Callers that only need the TYPE pass `false` and MUST
 * discard the value when `secure` is set — it is ciphertext, not the resolved
 * reference.
 */
export async function resolveSSMReference(
  this: IntrinsicFunctionResolver,
  parts: string[],
  decrypt: boolean,
  // The spelling being resolved — `ssm` or, since issue #2482, `ssm-secure`.
  // Log-only: it names the reference in the debug / retry / warning lines so
  // an `ssm-secure` lookup is not reported as an `ssm` one.
  service: 'ssm' | 'ssm-secure',
  // For the log lines only (issue #2728) — see `resolveSecretsManagerReference`.
  context: ResolverContext | undefined,
  // As in `resolveSecretsManagerReference` (issue #3150), and required for
  // the same reason.
  nameLogText: (name: string) => string
): Promise<{ value: string; secure: boolean; type: string | undefined }> {
  const parameterName = parts.slice(1).join(':');

  if (!parameterName) {
    // not-in-class(service): the typed `service: 'ssm' | 'ssm-secure'` PARAMETER of resolveSSMReference, not the text parsed off an assembled reference.
    throw new Error(`Dynamic reference: ${service} PARAMETER_NAME is required`);
  }

  // MASKED PER RAW VALUE — see `resolveSecretsManagerReference`'s twin
  // comment for why the raw form and not the assembled message (issue
  // [#2827](https://github.com/go-to-k/cdkd/issues/2827)).
  const loggedParameterName = this.displayMasked(nameLogText(parameterName), context);

  // not-in-class(service): the typed `service: 'ssm' | 'ssm-secure'` PARAMETER of resolveSSMReference, not the text parsed off an assembled reference.
  this.logger.debug(`Resolving dynamic reference: ${service}:${loggedParameterName}`);

  // Region-sensitive in BOTH of its outputs: the value, and the `Type` this
  // method reports back. A region-B `SecureString` classified against a
  // region-A `String` namesake is persisted in PLAINTEXT (issue #1957).
  const client = this.clientsForRegion(this.explicitRegion).ssm;

  const command = new GetParameterCommand({
    Name: parameterName,
    WithDecryption: decrypt,
  });

  const response = await this.sendWithThrottleRetry(
    () => client.send(command),
    `${service}:${loggedParameterName}`,
    // The one name the request carries (go-to-k/cdkd#3171).
    this.namedRequestMasks([[parameterName, loggedParameterName]], context)
  );
  const paramValue = response.Parameter?.Value;

  if (paramValue === undefined || paramValue === null) {
    throw new Error(
      `Dynamic reference: SSM parameter ${quotedRender(loggedParameterName, "'")} not found or has no value`
    );
  }

  // A SecureString parameter reached through the plain `{{resolve:ssm:...}}`
  // form decrypts to a real secret, so the caller treats it exactly like a
  // `{{resolve:secretsmanager:...}}` value: hand the plaintext to the provider,
  // persist the unresolved expression. Plain `String` / `StringList` is public
  // config and stays resolved in state (issue #1901).
  //
  // The predicate names the PUBLIC types rather than testing for
  // `=== 'SecureString'`, so it fails CLOSED: an absent `Type` (the SDK types
  // every field optional), an unexpected spelling, or a type AWS adds later
  // is treated as SECRET. Testing for the secret type instead would classify
  // all three as public, which on the deploy path persists plaintext — the
  // exact disclosure this fix exists to close — and on the comparison path
  // would substitute and cache the `WithDecryption: false` CIPHERTEXT. The
  // cost of the safe direction is bounded and self-consistent: an unclassified
  // parameter is stored as its expression and compared as its expression, so
  // it does not become a perpetual UPDATE, and the two genuinely-public types
  // are named explicitly so no real `String` / `StringList` is affected.
  const paramType = response.Parameter?.Type;
  // `type` is reported alongside the verdict so the caller can tell a
  // DEFINITIVE `SecureString` (safe to memoize) from an unclassifiable one
  // (treated as secret, but not pinned — see the caller).
  const secure = paramType !== 'String' && paramType !== 'StringList';
  if (
    secure &&
    paramType !== 'SecureString' &&
    !this.warnedUnrecognizedSsmTypes.has(injectiveKey(parameterName, String(paramType)))
  ) {
    // Reached only if AWS stops returning `Type`, or returns one cdkd does not
    // know. The value is treated as a secret (see above), which is safe but
    // silently changes what state stores — so say so rather than let the
    // parameter quietly start persisting as its expression. Once per
    // (parameter, type) per resolver — see `warnedUnrecognizedSsmTypes`.
    // ENCODED, not separated (go-to-k/cdkd#3496). DEFENCE IN DEPTH: the
    // warned-once class of go-to-k/cdkd#3308, but only ONE half is ungated.
    // `parameterName` is template text; the other half is the SDK's own
    // `Type` string, so a collision would need AWS to return one carrying a
    // NUL. Encoded so the set does not depend on that, since what it would
    // cost is the SECOND warning about a parameter silently persisting as
    // its expression.
    this.warnedUnrecognizedSsmTypes.add(injectiveKey(parameterName, String(paramType)));
    // Through the builder (issue #3441): this arm is reached precisely
    // because the `Type` matched NONE of the names cdkd knows, so its text is
    // unconstrained — being a type name answers the secret question, not
    // the control-character one.
    const reported =
      paramType === undefined
        ? '(absent)'
        : quotedRender(this.displayMasked(String(paramType), context), "'");
    // Masked like the debug echo above (issue #2728), and per RAW VALUE
    // since issue #2827: the name may have been assembled from a value this
    // pass resolved out of a secret.
    // not-in-class(service): the typed `service: 'ssm' | 'ssm-secure'` PARAMETER of resolveSSMReference, not the text parsed off an assembled reference.
    this.logger.warn(
      `SSM parameter ${quotedRender(loggedParameterName, "'")} reported an unrecognized Type ${reported} — treating ` +
        `its value as a secret, so cdkd will persist the {{resolve:${service}:...}} expression rather ` +
        `than the resolved value. Declare the parameter as String / StringList if it is ` +
        `public config.`
    );
  }
  return { value: paramValue, secure, type: paramType };
}
