import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { cdkdRemedy, proseQuoted } from '../../../utils/pasteable-command.js';
import type { CdkdError } from '../../../utils/error-handler.js';
import { IntrinsicFunctionResolver } from '../../../deployment/intrinsic-function-resolver.js';
import { resolveDynamicReferences } from '../../../deployment/intrinsic-resolver/dynamic-refs.js';
import {
  dynamicReferenceTokens,
  maskSecretsInText,
  type RecordedSecretValues,
} from '../../../deployment/secret-redaction.js';
// Issue #2109: the region split is #2057's, imported rather than re-spelled —
// one answer to "which region must answer for this `{{resolve:...}}`
// expression", shared by the rollback replay and by `cdkd scrub`.
import { classifyReplaySecretRegion } from '../../../deployment/rollback-executor.js';
import { regionLessSecretName } from '../../../deployment/secret-region-classification.js';
import { canonicalizeRegion } from '../../../utils/aws-partition.js';
// An export NAME is a template-controlled RESOLVED value and an index read's
// error message interpolates a bucket / key, so both reach the terminal only
// through the same control-byte strip `export-index-store.ts` uses for the
// name it logs.
import { displayIdent, displayStackName } from '../../../utils/display-safe.js';
import { ScrubRefusalError } from './errors.js';
import { maskedIdent } from './abandoned-scan.js';

/**
 * The `cdkd scrub` resolvers: the stack's own, plus one pinned sibling per
 * FOREIGN region an ARN-named secret reference asks for (issue
 * [#2109](https://github.com/go-to-k/cdkd/issues/2109)).
 *
 * The same shape as `rollback-executor/replay-secrets.ts`'s `ReplayResolvers`, and for the
 * same reasons. One instance per stack rather than per reference, because the
 * resolved-value cache lives on the resolver INSTANCE (issue #1933) — a
 * resolver per reference would re-fetch every secret once per reference. And
 * the pinned sibling is a PLAIN resolver, not a `producerRegionGuest`: it is
 * reached ONLY from a `named-region` verdict, which
 * {@link classifyReplaySecretRegion} returns only for an expression whose
 * SECRET_ID / parameter name starts with `arn:` and carries a region, so a
 * sibling only ever resolves an expression whose key EMBEDS the region it is
 * being resolved in. The process-global verdict store is keyed by the
 * expression STRING alone, and an ARN-form key cannot be shared by two regions,
 * so a sibling can never pin one region's verdict for another region's key. If
 * a future change ever routes a region-LESS expression here, that argument dies
 * with it and the sibling needs the guest flag.
 */
export class ScrubResolvers {
  /** The stack's own resolver — every `local` verdict resolves through this. */
  readonly primary: IntrinsicFunctionResolver;
  private readonly pinned = new Map<string, IntrinsicFunctionResolver>();
  private readonly stackRegion: string;

  constructor(stackRegion: string) {
    this.stackRegion = stackRegion;
    this.primary = new IntrinsicFunctionResolver(stackRegion);
  }

  /** The resolver that must answer for `region` — `primary` when it is the stack's own. */
  forRegion(region: string): IntrinsicFunctionResolver {
    const target = canonicalizeRegion(region);
    if (target === canonicalizeRegion(this.stackRegion)) return this.primary;
    const cached = this.pinned.get(target);
    if (cached) return cached;
    const scoped = new IntrinsicFunctionResolver(target);
    this.pinned.set(target, scoped);
    return scoped;
  }

  /**
   * The resolver for a region-LESS token a v12 record says `region` resolved
   * (go-to-k/cdkd#4847): the primary's producer-region GUEST, which pins no
   * verdict in the process-global store a region-less key shares across
   * regions (the hazard the note above names), or the primary itself.
   */
  forRecordedRegion(region: string): IntrinsicFunctionResolver {
    return this.primary.resolverForRecordedRegion(region);
  }
}

/**
 * What {@link pinCrossRegionSecrets} needs to decide, and then act on, the
 * region question for one template bag (issue #2109).
 */
interface CrossRegionSecretContext {
  /** The region the STACK is deployed in — the consumer's, and the primary resolver's. */
  stackRegion: string;
  /** Producer regions this stack's persisted cross-stack reads name. */
  producerRegions: readonly string[];
  resolvers: ScrubResolvers;
  /**
   * The SAME map the primary resolution records into, so a producer-region
   * plaintext becomes a redaction needle exactly like a local one. This is the
   * whole point of resolving here rather than merely classifying: scrub's
   * product is the needle map, not the resolved bag.
   */
  recordedSecretValues: RecordedSecretValues;
  /** Where the bag came from, for the refusal message ("resource 'Db'"). */
  origin: string;
  /**
   * go-to-k/cdkd#4847: the region the record's v12 provenance gives each
   * token. Such a token is resolved here, in that region, whichever it is: the
   * primary's later pass would classify it against `producerRegions` and
   * refuse it as ambiguous.
   */
  recordedRegions?: ReadonlyMap<string, string> | undefined;
}

/**
 * The refusal a region-AMBIGUOUS reference raises (issue #2109), the twin of
 * `rollback-executor/replay-secrets.ts`'s `regionAmbiguousReplaySecretError`.
 *
 * A `CdkdError`, so it leaves `scrubStack` -> `scrubCommand` ->
 * `withErrorHandling` as a NON-ZERO EXIT with the message printed. That
 * visibility is the acceptance criterion of the issue, not a detail of it: the
 * one outcome that must not survive is scrub reporting success over a document
 * it did not scrub, and a debug log next to a `Done: scrubbed 0 stack(s)` line
 * IS that outcome.
 *
 * It refuses the whole STACK rather than the one reference, which is wider than
 * it needs to be and is the deliberate side of the trade. Scrubbing the rest
 * and reporting success would leave the operator with "no plaintext secrets
 * found" over state that still holds one — the failure this command exists to
 * prevent, arriving through the remediation. Names the reference, both regions
 * and the remedy so the refusal is actionable.
 *
 * Never the resolved value: nothing has been resolved for this reference, and
 * the expression is the same string `state.json` already stores in the clear.
 */
function regionAmbiguousScrubSecretError(
  origin: string,
  stackName: string,
  secretName: string,
  foreignProducerRegions: readonly string[],
  stackRegion: string,
  secrets: RecordedSecretValues
): CdkdError {
  return new ScrubRefusalError(
    `Scrub of ${displayStackName(stackName)} cannot re-resolve the secret reference ${maskedIdent(secretName, secrets)} in ${origin}: ` +
      `the reference carries no region of its own, and this stack read across a region boundary ` +
      `(producer region(s) on record: ${foreignProducerRegions.map((r) => displayIdent(r)).join(', ')}), so it may have been ` +
      `resolved in one of those rather than in ${displayIdent(stackRegion)}. A secret of the same name in two ` +
      `regions is two independent values, so scrub would look for the WRONG plaintext — leaving ` +
      `the real one in state while reporting the stack clean, and using the foreign value as a ` +
      `needle that can rewrite an unrelated literal. Refusing instead. Spell the reference as a ` +
      `full ARN, which names its region and is resolved there, then re-run ${proseQuoted(cdkdRemedy('cdkd scrub'))}.`,
    'SCRUB_SECRET_REGION_AMBIGUOUS'
  );
}

/**
 * The refusal a `named-region` reference raises when its OWN region cannot
 * answer for it (issue #2109).
 *
 * Continuing would hand the leaf back to the stack's own resolver, which is
 * issue #2109 verbatim — so this fails closed for the same reason the ambiguous
 * arm does. The cause is echoed because it is the actionable half (a denied
 * read in the producer region reads very differently from a missing secret) —
 * but MASKED against everything this run has recorded so far (issue #2109
 * review). No resolver error carries a plaintext today; the rule on this repo is
 * that a path which interpolates a foreign message into user-visible text masks
 * it anyway, because the day one does is the day the remediation command prints
 * the secret it exists to remove. The map is the SAME one the resolution records
 * into, so a value recorded a moment earlier in this very leaf is covered.
 */
function unresolvableForeignScrubSecretError(
  origin: string,
  stackName: string,
  secretName: string,
  region: string,
  cause: unknown,
  secrets: RecordedSecretValues,
  /** The region is the one the record's v12 provenance names (go-to-k/cdkd#4847), not an ARN's. */
  recorded = false
): CdkdError {
  return new ScrubRefusalError(
    `Scrub of ${displayStackName(stackName)} could not resolve the secret reference ${maskedIdent(secretName, secrets)} in ${origin} ` +
      `in ${recorded ? 'the region its state record names' : 'the region its ARN names'} (${displayIdent(region)}): ` +
      `${maskSecretsInText(describeAwsFailure(cause).detail, secrets)}. ` +
      `Refusing rather than resolving ` +
      `it in the stack's own region, which would look for a different secret's value and report ` +
      `the stack clean over state that still holds the plaintext.`,
    'SCRUB_CROSS_REGION_SECRET_UNRESOLVED'
  );
}

/**
 * The literal that OPENS a dynamic reference. Used as the CHEAP pre-filter that
 * decides whether a leaf is walked at all — see {@link pinCrossRegionSecrets}.
 */
export const DYNAMIC_REFERENCE_OPENING = '{{resolve:';

/**
 * The openings the assembled-reference guard actually COUNTS: `{{resolve:`
 * followed by a service whose VALUE CloudFormation defines as a secret. Counted
 * against the number of WHOLE tokens of the same class the scan matched, which
 * is how an ASSEMBLED reference is detected without parsing intrinsics — see
 * {@link isAssembledSecretReference}.
 *
 * WHY THE SERVICE IS PART OF THE OPENING (issue #2109 review). Counting the bare
 * `{{resolve:` made the guard fire on any leaf that merely MENTIONS the syntax
 * — measured: `Use the {{resolve: prefix for dynamic references` and
 * `{{resolve:}}` both count one opening and zero tokens. A description, an IAM
 * policy document, a UserData script or an environment variable saying that is
 * ordinary, and the refusal is permanent for the whole stack (exit 2, no bypass
 * flag) with a remedy — "spell the reference as one complete literal" — that is
 * unactionable for prose. Requiring the service makes the count a count of
 * SECRET references rather than of the characters `{{resolve:`.
 *
 * All three mirror `REPLAY_SECRET_SERVICES` in
 * `secret-region-classification.ts`, whose {@link classifyReplaySecretRegion}
 * is what classifies the tokens below — the same set on both sides, so the
 * count and the classification never disagree about what is in scope. Until
 * issue #2482 `ssm-secure` was counted here AHEAD of that set (cdkd did not
 * resolve it, so it could never become a wrong-region needle, and counting it
 * kept the guard correct for the day the resolver's arm changed); that day
 * came, and the two lists agree again.
 *
 * THE TRADE, stated rather than hidden: an `Fn::Join` that splits BEFORE the
 * service name (`['{{resolve:', 'secretsmanager:db:SecretString:pw}}']`) has no
 * counted opening in either part and stops being caught by this guard. The part
 * carrying the service has no `{{resolve:` at all, so `pinCrossRegionSecrets`
 * returns it by identity too. That shape falls to the same resolver-side
 * classification issue [#2134](https://github.com/go-to-k/cdkd/issues/2134)
 * tracks.
 */
const SECRET_REFERENCE_OPENINGS = [
  `${DYNAMIC_REFERENCE_OPENING}secretsmanager:`,
  `${DYNAMIC_REFERENCE_OPENING}ssm:`,
  `${DYNAMIC_REFERENCE_OPENING}ssm-secure:`,
] as const;

/**
 * What an `Fn::Sub` placeholder opens with. A whole token that CONTAINS one is
 * the third assembled shape — see {@link isAssembledSecretReference}.
 */
const SUB_PLACEHOLDER_OPENING = '${';

/** How many SECRET references {@link SECRET_REFERENCE_OPENINGS} `leaf` opens. */
function countSecretReferenceOpenings(leaf: string): number {
  let count = 0;
  for (const opening of SECRET_REFERENCE_OPENINGS) count += leaf.split(opening).length - 1;
  return count;
}

/** Whether a WHOLE token the scan matched is one of the secret spellings. */
function isSecretReferenceToken(token: string): boolean {
  return SECRET_REFERENCE_OPENINGS.some((opening) => token.startsWith(opening));
}

/**
 * Does this leaf ASSEMBLE a secret reference out of parts (issue #2109 review)
 * — i.e. does it OPEN more SECRET references than the scan found COMPLETE
 * tokens of that class in it, or carry a whole token that still holds an
 * `Fn::Sub` placeholder?
 *
 * WHY THIS EXISTS, and it is the load-bearing half of this pre-pass rather than
 * an edge case. The region split runs on the RAW template leaf, BEFORE intrinsic
 * resolution, and the shared token scan is `\{\{resolve:[^}]+\}\}` — a class
 * that cannot cross a `}`. So none of the three shapes that assemble a
 * reference out of parts yields the ONE WHOLE token a literal reference does,
 * and the third one is why this predicate needs two tests rather than one
 * (all four rows MEASURED):
 *
 * ```text
 *   "{{resolve:secretsmanager:my-secret:SecretString:pw}}"        1 opening, 1 token   literal
 *   "{{resolve:secretsmanager:${Env}-db:SecretString:password}}"  1 opening, 0 tokens  Fn::Sub, MID-string
 *   "{{resolve:secretsmanager:"  (one Fn::Join part)              1 opening, 0 tokens  Fn::Join split
 *   "{{resolve:secretsmanager:x:SecretString:${Field}}}"          1 opening, 1 token   Fn::Sub, TRAILING
 * ```
 *
 * The first two assembled rows are caught by the COUNT. The fourth is not, and
 * the count can never catch it: `[^}]+` stops at the `}` of `${Field}` and the
 * `}}` that follows closes the match one brace short, so the scan returns
 * `"{{resolve:secretsmanager:x:SecretString:${Field}"` + `}` — a token, of the
 * right class, exactly one per opening. It is caught instead by the second
 * test: a WHOLE token that still contains `${` has not been assembled yet.
 * Neither a Secrets Manager secret name nor an SSM parameter name may contain
 * `$` or `{`, so the only false positive that test can produce is a JSON key
 * literally spelled `${...}` in a leaf that is NOT under an `Fn::Sub` — and a
 * false positive here now costs a DEFERRAL rather than a refusal, so it is
 * cheaper than it was when this predicate raised
 * `SCRUB_SECRET_REFERENCE_UNCLASSIFIABLE`.
 *
 * WHAT A `true` MEANS FOR THE CALLER, and it changed with issue
 * [#2157](https://github.com/go-to-k/cdkd/issues/2157): the leaf is handed on
 * BY IDENTITY, so the PRIMARY resolver classifies the reference once
 * `resolveSub` / `resolveJoin` have assembled it. Before issue
 * [#2134](https://github.com/go-to-k/cdkd/issues/2134) that was issue #2109
 * verbatim — the resolver had no region question at all, so an identity return
 * meant a foreign secret fetched against the stack's own endpoint, and this
 * predicate therefore had to REFUSE (gated on a foreign producer region being
 * on record, to keep it from refusing the world). #2134 put the classification
 * in `resolveDynamicReferences`, which sees the COMPLETE expression, so the
 * safety property the refusal bought — a reference whose region cannot be
 * established is never resolved in the stack's own region — is now bought
 * downstream over strictly more information.
 *
 * The trailing-placeholder row reached the resolver a different way before that
 * second test existed: the truncated token WAS classified here, and only
 * downstream luck kept it safe (the name form classifies `ambiguous`, the ARN
 * form fails into `SCRUB_CROSS_REGION_SECRET_UNRESOLVED` because the id it
 * looks up still has a literal `${Field}` in it). Post-#2157 it is deferred
 * like the other three, and the resolver answers it on the assembled
 * expression instead of on a token one brace short. Every row is pinned by the
 * suite rather than assumed.
 *
 * Residual, unchanged and stated rather than hidden: an `Fn::Join` that splits
 * BEFORE the service name opens no counted reference at all (see
 * {@link SECRET_REFERENCE_OPENINGS}), so this predicate returns `false` for it
 * and the leaf is returned by identity anyway — the same destination, reached
 * without being noticed.
 */
function isAssembledSecretReference(leaf: string, secretTokens: readonly string[]): boolean {
  return (
    countSecretReferenceOpenings(leaf) !== secretTokens.length ||
    secretTokens.some((token) => token.includes(SUB_PLACEHOLDER_OPENING))
  );
}

/**
 * Resolve every FOREIGN-region `{{resolve:...}}` reference in one leaf through
 * a resolver pinned to the region the expression NAMES, and refuse the ones
 * whose region cannot be established (issue #2109).
 *
 * The returned string is what the primary resolver is handed, so a foreign
 * reference is already a value by the time the stack's own region sees the
 * leaf — the local endpoint is never asked about it at all. A leaf with no
 * foreign reference is returned BY IDENTITY and takes exactly the pre-#2109
 * path: `resolveDynamicReferences` has well-tested substitution semantics (it
 * collects matches from the ORIGINAL string, so a resolved plaintext that is
 * itself token-shaped is never re-resolved — issue #1917) and this change does
 * not relitigate any of it.
 *
 * That #1917 guarantee does NOT cross this seam — the primary receives a string
 * this function already substituted into — so the result is re-scanned and a
 * token the substitution INTRODUCED is refused rather than passed on. Fail
 * closed: a stopped scrub is recoverable, a lookup for a secret id spliced
 * together out of a plaintext is not.
 */
async function resolveForeignRegionTokens(
  leaf: string,
  stackName: string,
  ctx: CrossRegionSecretContext
): Promise<string> {
  const shownStackName = displayStackName(stackName);
  // ONE spelling of the token scan, shared with `secret-redaction.ts` and the
  // rollback replay (issue #1936): a private regex here would answer a
  // different question from the one the resolver is about to ask.
  const tokens = dynamicReferenceTokens(leaf);
  // FIRST, before any classification: does every SECRET reference this leaf
  // OPENS exist as a complete, already-assembled token the scan could see? Two
  // tests, because the shapes fail in two different ways — see
  // {@link isAssembledSecretReference} for the measured table and for the
  // false positive counting bare `{{resolve:` produced.
  //
  // 1. COUNT. Openings and tokens are filtered to the SAME secret spellings, so
  //    a complete non-secret reference cannot make the two disagree. `!==`
  //    rather than `>` is not a stronger test today: matches are
  //    non-overlapping and each one BEGINS at a counted opening, so tokens can
  //    never exceed openings — the nested spelling gives 2 openings and 1 token,
  //    which `>` catches too. It is kept because that anchoring is a property of
  //    today's scan rather than of this function, and `!==` is the spelling that
  //    still refuses if a future scanner emits a token this count did not see.
  // 2. PLACEHOLDER. A whole token that still contains `${` is a TRAILING
  //    `Fn::Sub` placeholder, which the count provably cannot see.
  //
  // NOT A REFUSAL ANY MORE — it DEFERS (issue
  // [#2157](https://github.com/go-to-k/cdkd/issues/2157)). Until issue
  // [#2134](https://github.com/go-to-k/cdkd/issues/2134) this same condition
  // threw `SCRUB_SECRET_REFERENCE_UNCLASSIFIABLE` whenever a foreign producer
  // region was also on record, because there was then genuinely nowhere else
  // the question could be asked: the reference did not exist as a complete
  // expression anywhere, so nothing downstream could classify it either.
  // #2134 moved the classification INTO `resolveDynamicReferences`, which runs
  // on the ASSEMBLED expression (`resolveSub` / `resolveJoin` re-enter it with
  // their result), and `scrubStack` supplies that resolver the same
  // `producerRegions` evidence this pre-pass holds. So the leaf is now handed
  // on BY IDENTITY and answered where the whole expression exists — routed to
  // the region its ARN names, or refused per reference by the resolver's own
  // `DYNAMIC_REFERENCE_REGION_AMBIGUOUS`.
  //
  // WHAT IS PRESERVED -- stated because the first three cuts of this change
  // each asserted the wrong half of it.
  //
  // The region safety, over strictly MORE information: a reference whose region
  // cannot be established is never resolved in the stack's own region. The
  // resolver classifies the ASSEMBLED expression rather than the raw leaf, and
  // `classifyReplaySecretRegion` verdicts an ARN-form token `named-region`
  // whatever evidence it holds, so a deferred reference cannot be answered by
  // the wrong region.
  //
  // LOUDNESS when the deferred reference then goes UNRESOLVED is kept by the
  // RESOLVER, which reports what it declined into the abandoned-unit bag
  // `scrubStack` opts into, never by a proxy here (issue
  // [#2166](https://github.com/go-to-k/cdkd/issues/2166): keying on "it threw"
  // or "the raw text survived" was wrong both ways, and fired permanently on
  // prose). A lookup that FAILS is a `token` unit; a placeholder `resolveSub`
  // KEPT inside the reference, where nothing throws, is a `placeholder` unit.
  // Both are counted findings: the stack is not printed clean and `--fail`
  // exits non-zero.
  //
  // Deferring is unconditional on evidence, unlike the refusal it replaces.
  // The refusal was gated on `foreignProducerRegions.length > 0` to keep it
  // from refusing the world; deferral needs no such gate, because the reason
  // to defer is that THIS pass cannot classify an unassembled leaf, which is
  // true whatever evidence is on record. With no foreign region the two paths
  // agree anyway: a leaf whose scan yields no token produced empty `verdicts`
  // and fell out of the `named-region` test below by identity already.
  const secretTokens = tokens.filter(isSecretReferenceToken);
  if (isAssembledSecretReference(leaf, secretTokens)) return leaf;
  const verdicts = tokens.map((token) => {
    const verdict = classifyReplaySecretRegion(token, ctx.stackRegion, ctx.producerRegions);
    // go-to-k/cdkd#4847: a region-less token's recorded region, resolved here
    // ONLY where the v11 verdict does not already settle it: another region,
    // or this one against foreign evidence (`ambiguous`). A recorded-local
    // token v11 calls `local` stays the primary's, whose failed lookup is a
    // counted finding rather than a refusal of the whole stack.
    const recorded =
      regionLessSecretName(token) === undefined ? undefined : ctx.recordedRegions?.get(token);
    const takesRecorded =
      recorded !== undefined &&
      (canonicalizeRegion(recorded) !== canonicalizeRegion(ctx.stackRegion) ||
        verdict.kind === 'ambiguous');
    return [
      token,
      !takesRecorded
        ? verdict
        : ({
            kind: 'named-region',
            secretName: regionLessSecretName(token)!,
            region: recorded!,
            recorded: true,
          } as const),
    ] as const;
  });

  // Refuse FIRST, over the whole leaf, before any reference is read — a leaf
  // can splice several references together, and reading the safe ones first
  // would leave a credential fetched and cached for a leaf that is about to be
  // refused anyway.
  for (const [, verdict] of verdicts) {
    if (verdict.kind === 'ambiguous') {
      throw regionAmbiguousScrubSecretError(
        ctx.origin,
        stackName,
        verdict.secretName,
        verdict.foreignProducerRegions,
        ctx.stackRegion,
        ctx.recordedSecretValues
      );
    }
  }
  if (!verdicts.some(([, verdict]) => verdict.kind === 'named-region')) return leaf;

  const localTokens: string[] = [];
  let out = '';
  let cursor = 0;
  for (const [token, verdict] of verdicts) {
    const at = leaf.indexOf(token, cursor);
    // Unreachable while the tokens come from a scan of THIS string, so this
    // guards a future scanner change — and the direction it fails in is the
    // point. Handing the leaf back to the primary resolver would send a token
    // whose foreign region is already KNOWN to the stack's own region: issue
    // #2109 reintroduced by the guard meant to prevent a regression.
    if (at < 0) {
      throw new ScrubRefusalError(
        `Scrub of ${shownStackName} could not locate a scanned dynamic reference in ${ctx.origin}, ` +
          `in the value it was scanned from. Refusing rather than resolving it in ` +
          `${displayIdent(ctx.stackRegion)}, which would be the wrong region for a reference that names ` +
          `another one. This is an internal invariant failure — please report it with the ` +
          `resource type and property path.`,
        'SCRUB_SECRET_TOKEN_SCAN_MISMATCH'
      );
    }
    out += leaf.slice(cursor, at);
    if (verdict.kind === 'named-region') {
      const resolver =
        'recorded' in verdict
          ? ctx.resolvers.forRecordedRegion(verdict.region)
          : ctx.resolvers.forRegion(verdict.region);
      try {
        // The SAME `recordedSecretValues` map the primary records into, and the
        // resolver's own recording rules apply: an `ssm` reference is recorded
        // only when the producer region says `SecureString`, which is precisely
        // the verdict the stack's own region cannot be trusted to give (#1957).
        out += await resolveDynamicReferences(resolver, token, {
          template: { Resources: {} },
          resources: {},
          recordedSecretValues: ctx.recordedSecretValues,
        });
      } catch (err) {
        throw unresolvableForeignScrubSecretError(
          ctx.origin,
          stackName,
          verdict.secretName,
          verdict.region,
          err,
          ctx.recordedSecretValues,
          'recorded' in verdict
        );
      }
    } else {
      out += token;
      localTokens.push(token);
    }
    cursor = at + token.length;
  }
  out += leaf.slice(cursor);

  const surviving = dynamicReferenceTokens(out);
  if (
    surviving.length !== localTokens.length ||
    surviving.some((token, i) => token !== localTokens[i])
  ) {
    throw new ScrubRefusalError(
      `Scrub of ${shownStackName} refused ${ctx.origin}: resolving a cross-region secret reference ` +
        `produced a value that is itself dynamic-reference shaped, which the stack's own ` +
        `resolver would then resolve as if it were a reference of this stack's. Refusing rather ` +
        `than passing it on.`,
      'SCRUB_SECRET_RESOLUTION_REINTRODUCED_TOKEN'
    );
  }
  return out;
}

/**
 * Rewrite one template bag so every FOREIGN-region secret reference in it is
 * already resolved — in the region the expression NAMES — before the stack's
 * own resolver walks it (issue
 * [#2109](https://github.com/go-to-k/cdkd/issues/2109)).
 *
 * WHY SCRUB NEEDS THIS AT ALL. `scrubStack` learns which plaintexts to look for
 * by RE-RESOLVING the template through one resolver built from the stack's own
 * region, and `resolveSecretsManagerReference` builds its client from that
 * region and passes the SECRET_ID through as an opaque string — the AWS SDK's
 * endpoint ruleset has no ARN-derived endpoint rule, so a reference naming
 * another region's ARN is sent to this stack's regional endpoint. Both halves
 * of that go wrong at once, and the second is the one that is easy to miss: the
 * plaintext scrub exists to remove is never found (the needle is the wrong
 * region's value), so the command reports the stack CLEAN over state that still
 * holds the secret; and the foreign value is a real string, so scanning for it
 * can rewrite an unrelated stored literal that happens to coincide.
 *
 * The split is `classifyReplaySecretRegion`'s, imported from
 * `rollback-executor.ts` rather than re-spelled — one answer to "which region
 * must answer for this expression", shared by the rollback replay (#2057) and
 * by scrub. Its known OVER-refusal is inherited with it: a name-form reference
 * in a stack with ANY foreign producer region on record is refused even when it
 * is the stack's own purely-local secret, because the evidence
 * (`state.imports` / `state.outputReads`) is per-STACK and not per-reference.
 * That is the fail-closed side of a trade whose other side is a silently
 * unscrubbed state file.
 *
 * Returns the bag BY IDENTITY when nothing was foreign, which is every bag on
 * every existing code path. The caller keeps the ORIGINAL bag as its position
 * source either way — a substituted copy must never reach
 * `redactSecretsForState`, whose whole job is to read UNRESOLVED expressions
 * off it.
 */
export async function pinCrossRegionSecrets<T>(
  bag: T,
  stackName: string,
  ctx: CrossRegionSecretContext
): Promise<T> {
  // NO PATH IS THREADED HERE, and its absence is a decision rather than an
  // oversight (issue #2109 review, revisited by issue
  // [#2157](https://github.com/go-to-k/cdkd/issues/2157)). The walk used to
  // build an `a.b[0].c` spelling for exactly ONE consumer: the
  // assembled-reference REFUSAL, which named the leaf because such a reference
  // is often one leaf of a `Properties` bag carrying hundreds. That refusal is
  // now a DEFERRAL, and the two refusals left in `resolveForeignRegionTokens`
  // (`ambiguous`, and a token the substitution introduced) name `ctx.origin`
  // only -- so the path had no reader left and was being built at every node of
  // every bag for nothing.
  //
  // Giving those two refusals a leaf path would be a real improvement and is a
  // DELIBERATE non-goal here: it changes user-visible message TEXT, which is a
  // different subject from relaxing an over-refusal. The cross-stack pre-pass
  // below keeps its own `path` because its refusals do read it.
  const walk = async (v: unknown): Promise<unknown> => {
    if (typeof v === 'string') {
      // THIS LINE BOUNDS THE WHOLE PRE-PASS (issue #2109 review). The region
      // split below arms only when the RAW leaf ITSELF carries a `{{resolve:`
      // opening; a leaf whose opening is CONTRIBUTED by another intrinsic is
      // returned by identity here and never reaches it.
      //
      // NOT A GAP ANY MORE, and the reachable shape was measured: a parameter
      // `DbSecretRef` whose `Default` is a full foreign-ARN reference, used as
      // `MasterUserPassword: { "Fn::Sub": "${DbSecretRef}" }`. This walk sees
      // only `"${DbSecretRef}"` and returns it, and `resolveSub` then re-scans
      // the SUBSTITUTED string — where, since issue
      // [#2134](https://github.com/go-to-k/cdkd/issues/2134),
      // `resolveDynamicReferences` classifies the assembled reference and routes
      // it to the region its ARN names (or refuses it as `ambiguous`). Before
      // #2134 this same path resolved the foreign reference against the stack's
      // own endpoint and reported the stack clean over surviving plaintext. The
      // same holds for a `Ref` / `Fn::FindInMap` that yields the opening, and it
      // is why the assembled-reference refusal this pass used to raise could be
      // relaxed to a deferral (issue #2157): the destination now answers.
      if (!v.includes(DYNAMIC_REFERENCE_OPENING)) return v;
      return await resolveForeignRegionTokens(v, stackName, ctx);
    }
    if (Array.isArray(v)) {
      const out: unknown[] = new Array(v.length) as unknown[];
      let changed = false;
      for (let i = 0; i < v.length; i++) {
        out[i] = await walk(v[i]);
        if (out[i] !== v[i]) changed = true;
      }
      return changed ? out : v;
    }
    if (v !== null && typeof v === 'object') {
      // `Object.create(null)`, the same `__proto__` hazard `redactByPath` and
      // `reresolveCrossStackValue` answer this way: a JSON-parsed bag can carry
      // an OWN `__proto__` key, and assigning it onto an object literal walks
      // the prototype setter instead of defining the key.
      const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      let changed = false;
      for (const [k, val] of Object.entries(v)) {
        out[k] = await walk(val);
        if (out[k] !== val) changed = true;
      }
      return changed ? out : v;
    }
    return v;
  };
  return (await walk(bag)) as T;
}
