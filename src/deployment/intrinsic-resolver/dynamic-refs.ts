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
import {
  type DynamicReferencePass,
  type ResolverContext,
  isDeliberateResolutionRefusal,
  quotedRender,
  recordedSecretExpressions,
  withoutProducerRegions,
} from './support.js';
import { markNonRetryable } from '../retryable-errors.js';
import {
  type DynamicReferenceSubstitution,
  SECRET_MASK,
  dynamicReferenceTokens,
  recordResolvedPair,
} from '../secret-redaction.js';
import { classifyReplaySecretRegion } from '../secret-region-classification.js';

declare module '../intrinsic-function-resolver.js' {
  interface IntrinsicFunctionResolver {
    resolveDynamicReferences: OmitThisParameter<typeof resolveDynamicReferences>;
    /** @internal */
    resolveTemplateLeafReferences: OmitThisParameter<typeof resolveTemplateLeafReferences>;
    /** @internal */
    resolveDynamicReferencesWithLogTwin: OmitThisParameter<
      typeof resolveDynamicReferencesWithLogTwin
    >;
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
