import { AsyncLocalStorage } from 'node:async_hooks';
import { ProvisioningError } from '../../utils/error-handler.js';
import { displaySafe } from '../../utils/display-safe.js';
import { isSecretDerivedValue, type MaskerFn } from '../masked-retry-logger.js';
import {
  errorCauseChain,
  maskMatchSpans,
  maskSecretsInError,
  SECRET_MASK,
} from '../../deployment/secret-redaction.js';
import { CloudControlWaitAbandonedError } from './shared.js';

/**
 * The logger a call's lines go through: the plain one, or an
 * {@link IdScrubLog}. One message argument only: an extra argument would
 * reach the console unscrubbed, so a call through `CloudControlProvider.logger`
 * (typed this way) passing one does not compile. A helper handed that logger
 * under the wider `Logger` type is not held to it.
 */
export interface IdLogSink {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** `true` when this call withholds its id; absent on a plain logger. */
  readonly withheld?: boolean;
}

/**
 * The sink every line of a `create()` / `update()` / `delete()` call goes
 * through, and the scrub applied to the error leaving it (go-to-k/cdkd#3869).
 * Installed as the call's `idLogScope` store, so `CloudControlProvider.logger`
 * returns it to every helper the call reaches; a call nested in another (the
 * failed-create remnant delete) wraps the outer sink, keeping its needles.
 *
 * A Cloud Control identifier can carry a name taken from a secret
 * (`AWS::Logs::MetricFilter` is `<LogGroupName>|<FilterName>`). After a
 * rotation under an unchanged reference that name is the PRE-rotation value,
 * which this deploy never resolved, and a name AWS or cdkd derived from a
 * secret is no longer its plaintext, so `maskSecrets` cannot recognise either.
 * So the id is withheld, since nothing here says which identifier part came
 * from a secret, whenever a bag of the call holds a secret-derived string leaf
 * or key (`isSecretDerivedValue`):
 *
 *  - a `{{resolve:` reference or `***`: a previous or delete bag is the state
 *    record, which keeps a secret leaf that way;
 *  - a value the masker recognises: a create's desired bag, a rollback
 *    revert's RESOLVED bags, an in-process rollback's delete bag
 *    (go-to-k/cdkd#2007), and `drift --revert`'s AWS readback as the previous
 *    side, where the evidence is the CURRENT secret.
 *
 * Every message goes through the caller's masker FIRST, so a current secret
 * is masked whole before an id part could split it. Withheld then means every
 * occurrence of the whole id and of each non-empty `|` part, in its raw and
 * its masked spelling, becomes `***`, at any length: a line naming one part
 * (an ARN built from a name, an AWS error quoting it) is caught too, and
 * over-masking is the safe direction. For the thrown error that holds because
 * the scrub only REMOVES text: an already-deleted or retryable phrase can be
 * cut (the failure surfaces), never made; `maskSecretsInError` keeps the
 * classifiers' code fields and the retry markers.
 *
 * The bound: an identifier never named to this call (a FAILED create with no
 * `Identifier`) is not known, so status text quoting it is not scrubbed.
 */
export class IdScrubLog implements IdLogSink {
  private needles: string[] = [];
  private readonly base: IdLogSink;
  private readonly mask: MaskerFn;
  /** Does a bag of this call hold a secret-derived leaf? */
  private readonly evidence: boolean;

  constructor(base: IdLogSink, mask: MaskerFn, evidence: boolean) {
    this.base = base;
    this.mask = mask;
    this.evidence = evidence;
  }

  /**
   * This call's own needles only. In the one nested call (the failed-create
   * remnant `delete()`, handed no bag, so its evidence is `false` whatever
   * masker it carries) it is `false`, so that delete scrubs no guard
   * `reason`; `cleanupFailedCreateRemnant` prints no guard, and every line the
   * nested call prints reaches the outer sink through `base`.
   */
  get withheld(): boolean {
    return this.needles.length > 0;
  }

  /** Withhold `id` from here on, when the call's bags gave evidence. */
  addId(id: string | undefined): void {
    if (!this.evidence || id === undefined || id === '') return;
    const parts = [id, ...id.split('|')].filter((needle) => needle !== '');
    // Each part's DISPLAY spellings too: `abandonWait` renders the identifier
    // through `displaySafe(..., { asciiOnly: true })`, which turns a non-ASCII
    // or control run into a space, so the raw needle no longer matches it.
    const raw = [
      ...new Set(
        parts.flatMap((part) => [part, displaySafe(part), displaySafe(part, { asciiOnly: true })])
      ),
    ].filter((needle) => needle !== '' && needle !== SECRET_MASK);
    // Each needle's MASKED spelling too: the masker runs first, so where a
    // current secret is a SUBSTRING of an id part it has already rewritten that
    // part (`prod-old-filter` -> `***-old-filter`), and the raw needle no longer
    // matches. Longest first, so a part inside a longer part (`ab` in `ab-c`)
    // cannot leave the longer one's remainder.
    const masked = raw.map((needle) => this.mask(needle));
    this.needles = [
      ...new Set([
        ...this.needles,
        ...raw,
        ...masked.filter((m, i) => m !== '' && m !== raw[i] && m !== SECRET_MASK),
      ]),
    ].sort((a, b) => b.length - a.length);
  }

  // The UNION of every occurrence (go-to-k/cdkd#4986): replacing needle by
  // needle left the tail of one that overlaps another (`maskMatchSpans`).
  readonly scrub = (text: string): string =>
    maskMatchSpans(this.mask(text), this.needles, SECRET_MASK);

  /**
   * `text` scrubbed, except that an abandoned wait's request tokens and its
   * resume command (`aws ... cloudcontrol get-resource-request-status
   * --request-token ...`) are KEPT verbatim, masker only: they are Cloud
   * Control- and cdkd-minted, never the identifier, and the command is the one
   * handle on a resource the operation may have left untracked, which a short
   * needle (`FunctionName|1`) would otherwise cut into a wrong command. With
   * no token there is no abandoned wait, and nothing is kept.
   */
  scrubKeepingResume(text: string, requestTokens: readonly string[]): string {
    const tokens = requestTokens.filter((token) => token !== '');
    if (tokens.length === 0) return this.scrub(text);
    const keep = new RegExp(`(${[RESUME_COMMAND.source, ...tokens.map(escapeRegExp)].join('|')})`);
    return text
      .split(keep)
      .map((segment, i) => (i % 2 === 1 ? this.mask(segment) : this.scrub(segment)))
      .join('');
  }

  /**
   * `error` with every link's text scrubbed, or `error` itself when this call
   * withholds nothing. The request tokens of the chain's abandoned waits are
   * kept ({@link scrubKeepingResume}), and so are each link's `logicalId` and
   * `resourceType`: cdkd-authored, already the caller's, and compared EXACTLY
   * by the classifiers (`isUpdateUnsupportedError`, the name-collision
   * anchor, `isRefusedBeforeApplying`), which a short needle inside the
   * logical id would otherwise turn against their own resource.
   */
  scrubError(error: unknown): unknown {
    if (this.needles.length === 0 || !(error instanceof Error)) return error;
    const original = errorCauseChain(error);
    const tokens = abandonedRequestTokens(error);
    const scrubbed = maskSecretsInError(error, new Map(), (text) =>
      this.scrubKeepingResume(text, tokens)
    );
    const clones = errorCauseChain(scrubbed);
    original.forEach((link, i) => {
      const clone = clones[i];
      if (clone === undefined || clone === link) return;
      for (const key of VERBATIM_ERROR_FIELDS) {
        const descriptor = Object.getOwnPropertyDescriptor(link, key);
        if (descriptor === undefined || typeof descriptor.value !== 'string') continue;
        // A clone whose field cannot be redefined (a frozen original's copy)
        // keeps the scrubbed value: never trade the provider's error for a
        // TypeError.
        try {
          Object.defineProperty(clone, key, descriptor);
        } catch {
          // left scrubbed
        }
      }
    });
    return scrubbed;
  }

  /** A WARN whose text may carry an abandoned wait's resume command; see {@link scrubKeepingResume}. */
  warnKeepingResume(message: string, requestTokens: readonly string[]): void {
    this.base.warn(this.scrubKeepingResume(message, requestTokens));
  }

  debug(message: string): void {
    this.base.debug(this.scrub(message));
  }
  info(message: string): void {
    this.base.info(this.scrub(message));
  }
  warn(message: string): void {
    this.base.warn(this.scrub(message));
  }
  error(message: string): void {
    this.base.error(this.scrub(message));
  }
}

/** The own fields {@link IdScrubLog.scrubError} copies verbatim onto every scrubbed link. */
export const VERBATIM_ERROR_FIELDS = ['logicalId', 'resourceType'] as const;

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The resume command `buildResumeCommand` renders, alone: an `--profile` may
 * sit between `aws` and the service, bare or single-quoted as `shellQuote`
 * renders it (a `commandHole` included), and neither the token nor the region
 * holds a space. Exported for its unit test. Matched as the command only, never its line, since a
 * log line can flatten the message (identifier clause included) onto one.
 */
export const RESUME_COMMAND =
  /aws(?: --profile (?:'(?:[^'\n]|'\\'')*'|\S+))? cloudcontrol get-resource-request-status --request-token \S+(?: --region \S+)?/;

/** The request tokens of every abandoned wait in `error`'s cause chain, as `maskSecretsInError` walks it. */
export function abandonedRequestTokens(error: unknown): string[] {
  return error instanceof Error
    ? errorCauseChain(error).flatMap((link) =>
        link instanceof CloudControlWaitAbandonedError ? [link.requestToken] : []
      )
    : [];
}

/** The {@link IdScrubLog} of the `create()` / `update()` / `delete()` call in progress. */
export const idLogScope = new AsyncLocalStorage<IdScrubLog>();

/** Run `fn` with `idLog` as the call's sink, scrubbing the error it throws. */
export async function inIdLogScope<T>(idLog: IdScrubLog, fn: () => Promise<T>): Promise<T> {
  try {
    return await idLogScope.run(idLog, fn);
  } catch (error) {
    throw idLog.scrubError(error);
  }
}

/**
 * The identifier a failed Cloud Control operation's error names, if any: a
 * FAILED or cancelled event's `Identifier`, or an abandoned wait's last seen
 * one, which `CloudControlWaitAbandonedError` carries as its `physicalId`.
 */
export function identifierCarriedBy(error: unknown): string | undefined {
  return error instanceof ProvisioningError ? error.physicalId : undefined;
}

/**
 * Does any string leaf or key of `value` satisfy `isSecretDerivedValue`?
 * Past depth 64 (as `holdsSecretDerivedEntry` bounds its walk) the answer
 * is `true`: for a log line, withholding is the safe direction.
 */
export function holdsSecretDerivedLeaf(value: unknown, mask: MaskerFn, depth = 0): boolean {
  if (typeof value === 'string') return isSecretDerivedValue(value, mask);
  if (value === null || typeof value !== 'object') return false;
  if (depth > 64) return true;
  if (Array.isArray(value))
    return value.some((entry) => holdsSecretDerivedLeaf(entry, mask, depth + 1));
  return Object.entries(value as Record<string, unknown>).some(
    ([key, entry]) =>
      isSecretDerivedValue(key, mask) || holdsSecretDerivedLeaf(entry, mask, depth + 1)
  );
}

/**
 * What an `import()` that yields no attributes means downstream, for the two
 * unreadable-model warnings. `cdkd import`'s `reimportedAttributes` keeps the
 * attributes a record already holds for the SAME physical id when an import
 * yields none, so "falls back to the physical id" is true only without such a
 * record; stated unconditionally, it contradicted the re-import's own
 * mask-kept warning (issue #2927).
 */
export const IMPORT_YIELDED_NO_ATTRIBUTES_CONSEQUENCE =
  `Attributes the stack's state already records for this physical id are kept; without ` +
  `them, an Fn::GetAtt against this resource falls back to a value constructed from its ` +
  `physical id.`;

/**
 * Whether a deploy keeps `AWS::SSM::Parameter` `Value` in the clear (issue
 * #2925). The #3735 table holds `Value` back because `GetParameter` returns
 * the plaintext a dynamic reference or a NoEcho `Ref` put there; CDK's
 * `stringValue` reads it through `Fn::GetAtt`, so an ordinary value must keep
 * resolving.
 *
 * The provider receives RESOLVED properties, so a `{{resolve:...}}` text is
 * normally gone by now. What still tells a secret apart is the run's secret
 * masker (`context.maskSecrets`, which knows every value this deploy resolved
 * from a secret): `isSecretDerivedValue` asks it, and also catches a
 * `{{resolve:` left unresolved. A value it flags is masked here; any other
 * string is kept, as the SDK provider's `create()` records it. Save-time
 * `scrubResourceRecord` remains the backstop for both routes.
 */
export function isLiteralDeployOnlyKey(
  resourceType: string,
  key: string,
  desired: Record<string, unknown>,
  mask: MaskerFn
): boolean {
  if (resourceType !== 'AWS::SSM::Parameter' || key !== 'Value') return false;
  const declared = desired['Value'];
  return typeof declared === 'string' && !isSecretDerivedValue(declared, mask);
}

/**
 * Every LEAF of `value` replaced by {@link SECRET_MASK}, with object and array
 * CONTAINERS rebuilt at the same shape. See
 * `CloudControlProvider.maskUncertifiedModelValues` for why the shape must
 * survive.
 *
 * A `JSON.parse` result is acyclic by construction, so no visited-set is
 * needed — that answers CYCLES and nothing else. It is NOT a depth guarantee:
 * measured on this repo's node, `JSON.parse` survives ~100,000 nesting levels
 * while this recursion throws `RangeError` between 1,000 and 5,000. No Cloud
 * Control resource model comes close, and the `try` in `import()` is narrowed
 * to the parse, so such a `RangeError` would fail the import loudly rather than
 * degrade it silently — which is the direction this design wants. On the
 * deploy path (`maskDeployedNonAttributeKeys`) it would surface as a failed
 * create / update the same way. Recorded so the acyclic sentence is not read
 * as covering depth.
 */
export function maskLeavesDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((element) => maskLeavesDeep(element));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = maskLeavesDeep(nested);
    }
    return out;
  }
  return SECRET_MASK;
}
