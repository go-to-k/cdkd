import { type RecordedSecretValues, SECRET_MASK } from './pairs.js';
import { logOnlyValuesOf, hasMaskableValues } from './log-only.js';
import { buildNeedleRegex } from './rules.js';

/**
 * Replace every recorded secret value inside `text` with {@link SECRET_MASK}.
 * Used on log lines and error messages where a resolved secret could otherwise
 * be echoed. Whole-value and embedded matches are both masked. Returns `text`
 * unchanged when there is nothing to mask.
 *
 * The MASK-ONLY class (issue #2274) participates here FULLY — `secrets.keys()`,
 * not the persist path's narrowed `substringNeedlesOf` — and the asymmetry is
 * deliberate rather than an oversight. The persist path withholds the substring
 * arm from a mask because an inline `***` is a value nothing downstream can
 * recognise or re-resolve; this output is a log line, an error message or an
 * event, which no consumer reads back as a value, so a partial mask costs
 * nothing and closes an EMBEDDED disclosure that would otherwise print. See
 * the mask-only channel note above.
 *
 * The LOG-ONLY needles ({@link logOnlyValuesOf}, go-to-k/cdkd#1998) take part
 * on the same terms, which is what makes this the PRINTING masker: a `NoEcho`
 * parameter's value is masked here and never rewritten by the persist path. A
 * caller asking whether the RECORDED needles changed a text, to decide what
 * to persist or send, calls {@link maskRecordedSecretsInText} instead.
 */
export function maskSecretsInText(text: string, secrets: RecordedSecretValues): string {
  const logOnly = logOnlyValuesOf.get(secrets);
  if (logOnly === undefined || logOnly.size === 0) return maskRecordedSecretsInText(text, secrets);
  // Whole-value first, then the substring scan over BOTH populations in one
  // regex, so a longer needle of either kind is matched before a shorter one
  // it overlaps.
  if (text !== '' && (secrets.has(text) || logOnly.has(text))) return SECRET_MASK;
  const regex = buildNeedleRegex([...secrets.keys(), ...logOnly]);
  if (!regex) return text;
  return text.replace(regex, SECRET_MASK);
}

/**
 * {@link maskSecretsInText} over the MAP alone, without the log-only needles
 * (go-to-k/cdkd#1998). For a DETECTOR — "did a recorded secret change this
 * text?" — whose answer decides what is persisted or sent, never for a line
 * that is printed.
 */
export function maskRecordedSecretsInText(text: string, secrets: RecordedSecretValues): string {
  if (secrets.size === 0) return text;
  // Whole-value masking first (covers below-threshold secrets that are the
  // entire string), then substring masking for the rest. An empty-string secret
  // is never matched (it would mask every empty string).
  if (text !== '' && secrets.has(text)) return SECRET_MASK;
  const regex = buildNeedleRegex(secrets.keys());
  if (!regex) return text;
  return text.replace(regex, SECRET_MASK);
}

/**
 * How deep {@link maskSecretsInError} follows a `cause` chain. A CYCLE is
 * already handled by the visited-set, so this bounds only a pathologically long
 * chain; the same bounded-walk shape `extractDeploymentEventError` (depth 10)
 * and the retry classifiers (depth 5) use. A link BEYOND the cap keeps its
 * original, UNMASKED message, and the last cloned link points at it.
 */
export const ERROR_CAUSE_MASK_MAX_DEPTH = 20;

/**
 * The `cause` chain of `root`, root first, stopping at the first non-`Error`
 * link, at a link already visited (so a cycle terminates instead of hanging),
 * or at {@link ERROR_CAUSE_MASK_MAX_DEPTH}.
 *
 * EXPORTED so a caller that RENDERS a chain walks exactly the links
 * {@link maskSecretsInError} masked — the two sets must be the same one. A
 * renderer with its own walk would eventually print a link past the depth cap,
 * which by that function's contract still carries its ORIGINAL, unmasked
 * message. `cdkd scrub`'s `--all` loop is the first such caller.
 */
export function errorCauseChain(root: Error): Error[] {
  const chain: Error[] = [];
  const seen = new Set<Error>();
  let current: unknown = root;
  while (
    current instanceof Error &&
    !seen.has(current) &&
    chain.length < ERROR_CAUSE_MASK_MAX_DEPTH
  ) {
    seen.add(current);
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

/** `error.stack` when it reads as a string; a throwing accessor reads as none. */
function readStack(error: Error): string | undefined {
  try {
    const stack: unknown = (error as { stack?: unknown }).stack;
    return typeof stack === 'string' ? stack : undefined;
  } catch {
    return undefined;
  }
}

/** `descriptor` with its DATA value masked, or `descriptor` itself when nothing changed. */
function maskDescriptorValue(
  descriptor: PropertyDescriptor,
  maskText: (text: string) => string
): PropertyDescriptor {
  if (!('value' in descriptor)) return descriptor;
  const value = maskErrorFieldValue(descriptor.value, maskText);
  return value === descriptor.value ? descriptor : { ...descriptor, value };
}

/**
 * The own fields of an error link that `retryable-errors.ts`'s classifiers
 * compare EXACTLY (`name`, `code`, `ccErrorCode`, `ccOperation`), plus the
 * SDK's other code fields. {@link maskSecretsInError} copies such a field
 * verbatim when its value is a STRING; any other value is masked like every
 * field. `logicalId` is compared exactly too (the other-resource anchor) but
 * is NOT listed. Providers now pass the logical id in `ProvisioningError`'s
 * logical-id slot (go-to-k/cdkd#4222), but the fence holding them to it
 * (`tests/unit/provisioning/logical-id-slot-4222.test.ts`) checks spelling,
 * not data flow, so a physical id, which a secret can name, can still arrive
 * there. Masking costs at most an anchor that fails closed: no collision or
 * replace recovery, never a delete. {@link isAuxiliaryAnchor} is the one
 * `logicalId` kept.
 */
const CLASSIFIER_IDENTIFIER_FIELDS: ReadonlySet<string> = new Set([
  'name',
  'code',
  'Code',
  '__type',
  'ccErrorCode',
  'ccOperation',
]);

/**
 * `markAuxiliaryFailure`'s mark (`<owner>/auxiliary`, read by
 * `isAuxiliaryFailure`, which requires the same shape as this): the one
 * `logicalId` copied verbatim. Its owner is never a physical id: a provider
 * passes its template logical id, and `withRetry` the fixed owner `withRetry`
 * (go-to-k/cdkd#4222). The suffix alone
 * does not identify it — a physical id can end in a `/auxiliary` path segment —
 * so the mark's own descriptor shape is required too: `markAuxiliaryFailure`
 * defines it non-enumerable and read-only, while a `ProvisioningError`'s field
 * is an ordinary assignment. Any other `logicalId` is masked like every field.
 */
function isAuxiliaryAnchor(key: PropertyKey, descriptor: PropertyDescriptor): boolean {
  return (
    key === 'logicalId' &&
    descriptor.enumerable === false &&
    descriptor.writable === false &&
    typeof descriptor.value === 'string' &&
    descriptor.value.endsWith('/auxiliary')
  );
}

function isPlainContainer(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return Array.isArray(value)
    ? proto === Array.prototype
    : proto === Object.prototype || proto === null;
}

/** One entered node, read ONCE so the copy pass invokes no trap a second time. */
interface FieldNode {
  proto: object | null;
  isArray: boolean;
  length: PropertyDescriptor | undefined;
  extensible: boolean;
  entries: Array<[PropertyKey, PropertyDescriptor]>;
}

/** `node`'s shape when it is a plain container; `undefined` when not, or when reading it throws. */
function readFieldNode(node: object): FieldNode | undefined {
  try {
    if (!isPlainContainer(node)) return undefined;
    const entries: Array<[PropertyKey, PropertyDescriptor]> = [];
    for (const key of Reflect.ownKeys(node)) {
      const descriptor = Object.getOwnPropertyDescriptor(node, key);
      if (descriptor) entries.push([key, descriptor]);
    }
    const isArray = Array.isArray(node);
    return {
      proto: Object.getPrototypeOf(node) as object | null,
      isArray,
      length: isArray ? Object.getOwnPropertyDescriptor(node, 'length') : undefined,
      extensible: Object.isExtensible(node),
      entries,
    };
  } catch {
    return undefined;
  }
}

/**
 * An error's own field value with `maskText` applied to a string, and to every
 * string reachable through PLAIN objects and arrays (go-to-k/cdkd#4190) — the
 * returned value is a COPY when anything changed and `value` itself otherwise;
 * the original is never written.
 *
 * Bounds, each keeping the value AS IT IS (the masking floor):
 * - a class instance (`Date`, `Map`, an `Error`, the SDK's `$response`) is
 *   not entered, and an accessor is not invoked (a getter can throw or have
 *   effects); nor is a plain object's KEY masked;
 * - nothing deeper than {@link ERROR_CAUSE_MASK_MAX_DEPTH} levels is entered;
 * - a node whose read throws (only a Proxy's trap can: a revoked one, a
 *   hostile one) is kept by reference and not entered, its siblings masked;
 *   each node is read ONCE, so the copy invokes no trap a second time.
 *
 * Breadth-first with a visited set, so a node is entered at its SHALLOWEST
 * depth, a cycle terminates in linear work, and a node shared by two parents
 * WITHIN this value stays shared in the copy. A non-extensible node's copy is
 * made non-extensible too, and each property keeps its own attributes (an
 * array's `length` included).
 */
function maskErrorFieldValue(value: unknown, maskText: (text: string) => string): unknown {
  if (typeof value === 'string') return maskText(value);
  if (typeof value !== 'object' || value === null) return value;
  try {
    const nodes = new Map<object, FieldNode>();
    const seen = new Set<object>();
    let changed = false;
    let frontier: object[] = [value];
    for (let depth = 0; frontier.length > 0 && depth < ERROR_CAUSE_MASK_MAX_DEPTH; depth++) {
      const next: object[] = [];
      for (const node of frontier) {
        if (seen.has(node)) continue;
        seen.add(node);
        const read = readFieldNode(node);
        if (!read) continue;
        nodes.set(node, read);
        for (const [, descriptor] of read.entries) {
          if (!('value' in descriptor)) continue;
          const child: unknown = descriptor.value;
          if (typeof child === 'string') {
            if (!changed && maskText(child) !== child) changed = true;
          } else if (typeof child === 'object' && child !== null) {
            next.push(child);
          }
        }
      }
      frontier = next;
    }
    if (!changed) return value;
    const copies = new Map<object, object>();
    for (const [node, read] of nodes) {
      copies.set(
        node,
        read.isArray
          ? new Array<unknown>((read.length?.value as number | undefined) ?? 0)
          : (Object.create(read.proto) as object)
      );
    }
    for (const [node, read] of nodes) {
      const copy = copies.get(node)!;
      for (const [key, original] of read.entries) {
        if (key === 'length' && read.isArray) continue;
        const descriptor = { ...original };
        if ('value' in descriptor) {
          const child: unknown = descriptor.value;
          if (typeof child === 'string') descriptor.value = maskText(child);
          else if (typeof child === 'object' && child !== null && copies.has(child)) {
            descriptor.value = copies.get(child);
          }
        }
        Object.defineProperty(copy, key, descriptor);
      }
      if (read.length?.writable === false) {
        Object.defineProperty(copy, 'length', { writable: false });
      }
      if (!read.extensible) Object.preventExtensions(copy);
    }
    return copies.get(value) ?? value;
  } catch {
    return value;
  }
}

/**
 * Return `error` with {@link maskSecretsInText} applied to the `message` AND the
 * `stack` of every link in its `cause` chain, and to a COPY of each other own
 * data field ({@link maskErrorFieldValue}, go-to-k/cdkd#4190), with the
 * prototype and every descriptor's attributes preserved (issue
 * [#2038](https://github.com/go-to-k/cdkd/issues/2038) review).
 *
 * Two bounds on that "every link", both stated here because the PUBLIC contract
 * is what a caller reads and neither is visible from the call site:
 * - The walk stops at {@link ERROR_CAUSE_MASK_MAX_DEPTH}. A chain longer than
 *   that keeps its remaining links' ORIGINAL, UNMASKED messages, and the last
 *   cloned link points straight at them.
 * - Own FIELDS are masked by {@link maskErrorFieldValue}'s bound: a string, or
 *   the strings reachable through PLAIN objects and arrays, never a class
 *   instance (the SDK's `$response` is one) nor an accessor. A `cause` that is
 *   not an `Error` (a string, a plain object) is such a field and is masked
 *   the same way (go-to-k/cdkd#4190).
 *
 * **Why an error and not just its text.** `formatError` (`src/utils/error-handler.ts`)
 * renders a `CdkdError`'s CAUSE as `Caused by: <cause.message>`, and `handleError`
 * logs that at `error` level for any failure that escapes a command — so a raw
 * provider error attached as a `ProvisioningError`'s cause reaches the terminal
 * verbatim, at DEFAULT verbosity, even when every log site that INTERPOLATED
 * the message masked it. Masking the string at each log site cannot close that:
 * the sink reads the error OBJECT.
 *
 * `formatError` is not the only such sink, and the second one is what makes the
 * CHAIN argument below concrete rather than hypothetical: the CLI's top-level
 * rejection handler (`runCli` in `src/cli/run-cli.ts`, around `main()` in
 * `src/cli/index.ts`) does `console.error('Fatal error:', error)`,
 * which renders the whole object through `util.inspect` — every `[cause]` link
 * AND every link's `stack`. Measured: an outer `Error('top')` wrapping
 * `Error("Value 'hunter2' failed")` prints as
 * `Error: top ... { [cause]: Error: Value 'hunter2' failed ... }`. So a
 * multi-level sink exists TODAY, and it is why `stack` is masked below rather
 * than merely preserved.
 *
 * **Why the whole CHAIN and not just the top link.** Masking only `error.message`
 * looks sufficient because `formatError` renders one level — and it is not, in
 * two ways that a top-level-only fix gets exactly backwards. A provider that
 * wraps an AWS failure in a generic sentence (`new Error('the call failed',
 * { cause: awsError })`) leaves the plaintext ONE link down, where the
 * identity-return below then reports "nothing to mask" and hands back an object
 * still carrying it — the function's own contract says the returned error is
 * safe to render, and every later reader believes it. And `formatError`
 * rendering a single level is an implementation detail: one edit there (walking
 * the chain is the obvious improvement) re-opens the hole with nothing failing.
 * So the invariant is about the OBJECT, not about today's renderer.
 *
 * **Why a clone rather than assigning to `error.message`.** The argument is an
 * error cdkd did not create — usually the AWS SDK's — and mutating a caller's
 * object is visible to every other holder of it, including a retry loop that
 * may still classify it. Each link's clone copies the prototype and EVERY own
 * property descriptor, symbols included, so the three things that read a cause
 * chain keep working: `isMarkedNonRetryable` (a non-enumerable `Symbol.for`
 * marker), `extractDeploymentEventError` / `isThrottlingError` /
 * `isTransientServerError` (`$metadata`, `Code`, `name`), and the chain itself.
 * `Object.assign` would have dropped the marker, which is why the descriptors
 * form is used.
 *
 * `message`, `cause` and `stack` are the three descriptors deliberately NOT
 * copied through: each is re-defined per link, and copying a NON-CONFIGURABLE
 * original would make that re-definition throw. `cause` is rewired to the CLONE
 * of whatever it pointed at, in a second pass over the already-built clone map —
 * which is what makes a cyclic chain terminate rather than recurse. A `cause`
 * that is not an `Error` keeps its original descriptor, its value masked.
 *
 * **Why the other own fields are masked too** (go-to-k/cdkd#4190). An AWS SDK
 * exception copies its error body onto own fields: awsQuery (IAM, STS, SNS)
 * adds `Error: { Type, Code, Message }`, and many JSON / XML exceptions a
 * modeled `Message` string, each the same text as `message`. A reader walking
 * the object (`util.inspect`, `JSON.stringify`, a debug dump) prints them, so
 * every DATA field's value goes through {@link maskErrorFieldValue} — which
 * copies, never mutates — and a name ONLY in such a field (message and stack
 * clean) still makes a clone. The link's own {@link CLASSIFIER_IDENTIFIER_FIELDS}
 * are the exception, copied verbatim: a retry / collision classifier matches
 * them EXACTLY, so a recorded value occurring inside one (`Throttling` in
 * `ThrottlingException`) would flip its verdict, and each holds an AWS- or
 * cdkd-authored code rather than echoed text. So is an auxiliary-failure
 * `logicalId` mark ({@link isAuxiliaryAnchor}); every other `logicalId` is
 * masked, since a provider can put a physical id there.
 *
 * **Why `stack` is re-defined as DATA rather than copied.** V8 installs `stack`
 * as an own ACCESSOR whose getter reads a slot the engine attaches to an error
 * IT created, so copying that descriptor onto an `Object.create` clone yields a
 * getter with nothing behind it and `clone.stack` reads `undefined` (measured).
 * That is not a leak today — the clone is only ever reached as a `cause`, and
 * `handleError` prints the TOP-level error's stack — but this function is
 * exported and generic, so a future top-level caller would get back an error
 * with no trace at all. The clone therefore carries a masked COPY of the
 * original's stack text, which both preserves the trace and closes the sink the
 * copy would otherwise open: a stack's first line embeds the message, so an
 * unmasked stack re-exposes exactly the plaintext the `message` mask removed —
 * and `util.inspect` prints it. An original with no readable string `stack`
 * (not an engine-created error) simply gets no own `stack`, as before.
 *
 * Returns the ORIGINAL object by identity when NOTHING ANYWHERE IN THE CHAIN
 * changed, so a non-secret failure keeps referential equality and the common
 * path allocates nothing.
 *
 * `extraMask` is an OPTIONAL text transform run on every link's `message` and
 * `stack` BEFORE the bag pass, for the class the bag structurally cannot reach
 * (issue [#3234](https://github.com/go-to-k/cdkd/issues/3234)): a name masked
 * BY POSITION rather than by value. A bag masks a sub-`MIN_NEEDLE_LENGTH`
 * plaintext only as the WHOLE text, so a 1-3 character secret EMBEDDED in a
 * longer name that another module quoted back is invisible here — while the
 * caller that resolved the name holds both it and its masked log text and can
 * substitute one for the other exactly. BEFORE rather than after, because the
 * substitution matches the RAW name: a bag pass that had already rewritten part
 * of it would leave nothing for the transform to find.
 *
 * It is a pure `(text) => text` so this module stays a no-import LEAF. With
 * `extraMask` supplied the empty-bag short-circuit no longer applies — an empty
 * bag plus a positional transform still has work to do.
 *
 * THE BOUND, unchanged by `extraMask`: a thrown value that is not an `Error`
 * is handed back BY IDENTITY and masked by neither pass. A caller whose
 * callees can reject with a non-`Error` owes that case its own handling.
 */
export function maskSecretsInError<T>(
  error: T,
  secrets: RecordedSecretValues,
  extraMask?: (text: string) => string
): T {
  // `hasMaskableValues`, not `size`: a bag holding only log-only needles
  // (go-to-k/cdkd#1998) still has work to do.
  if (!(error instanceof Error) || (!hasMaskableValues(secrets) && !extraMask)) return error;
  const maskText = (text: string): string =>
    maskSecretsInText(extraMask ? extraMask(text) : text, secrets);
  const chain = errorCauseChain(error);
  let changed = false;
  const links = chain.map((link) => {
    const message = maskText(link.message);
    const stack = readStack(link);
    const maskedStack = typeof stack === 'string' ? maskText(stack) : undefined;
    // `Reflect.ownKeys` rather than `Object.getOwnPropertyDescriptors` + delete:
    // the latter's return type has a REQUIRED index signature, so removing the
    // keys re-defined below would need a cast. Symbols are included, which is
    // what carries `markNonRetryable`'s marker.
    const descriptors: Record<PropertyKey, PropertyDescriptor> = {};
    for (const key of Reflect.ownKeys(link)) {
      if (key === 'message' || key === 'cause' || key === 'stack') continue;
      const descriptor = Object.getOwnPropertyDescriptor(link, key);
      if (!descriptor) continue;
      descriptors[key] =
        (typeof key === 'string' &&
          CLASSIFIER_IDENTIFIER_FIELDS.has(key) &&
          typeof descriptor.value === 'string') ||
        isAuxiliaryAnchor(key, descriptor)
          ? descriptor
          : maskDescriptorValue(descriptor, maskText);
      if (descriptors[key] !== descriptor) changed = true;
    }
    // A non-`Error` cause is masked as a field. An `Error` cause is rewired
    // below: to its clone, or (past the depth cap) kept as it is.
    let cause = Object.getOwnPropertyDescriptor(link, 'cause');
    if (cause && !('value' in cause && cause.value instanceof Error)) {
      const masked = maskDescriptorValue(cause, maskText);
      if (masked !== cause) changed = true;
      cause = masked;
    }
    if (message !== link.message || maskedStack !== stack) changed = true;
    return { message, stack: maskedStack, descriptors, cause };
  });
  if (!changed) return error;

  const clones = new Map<Error, Error>();
  for (const [i, original] of chain.entries()) {
    const { message, stack, descriptors } = links[i]!;
    const clone = Object.create(Object.getPrototypeOf(original) as object, descriptors) as Error;
    Object.defineProperty(clone, 'message', {
      value: message,
      writable: true,
      enumerable: false,
      configurable: true,
    });
    // A masked COPY of the text read through the accessor rather than its
    // descriptor — see the `stack` paragraph above. Absent (not a string) means
    // this object is not an engine-created error and has no trace to carry.
    if (stack !== undefined) {
      Object.defineProperty(clone, 'stack', {
        value: stack,
        writable: true,
        enumerable: false,
        configurable: true,
      });
    }
    clones.set(original, clone);
  }
  for (const [i, original] of chain.entries()) {
    const causeDescriptor = links[i]!.cause;
    if (!causeDescriptor) continue;
    const clone = clones.get(original)!;
    const causeValue = (original as { cause?: unknown }).cause;
    const replacement = causeValue instanceof Error ? clones.get(causeValue) : undefined;
    Object.defineProperty(
      clone,
      'cause',
      replacement
        ? {
            value: replacement,
            writable: true,
            // `=== true` rather than the raw field: under
            // `exactOptionalPropertyTypes` a descriptor's `enumerable` types as
            // `boolean | undefined`, and a real descriptor always has one.
            enumerable: causeDescriptor.enumerable === true,
            configurable: true,
          }
        : causeDescriptor
    );
  }
  return clones.get(error) as T;
}

/**
 * A caller-supplied capability that masks any secret this deploy resolved out
 * of an arbitrary string (issue #1932 item 3).
 *
 * This is the PROVIDER-FACING half of {@link maskSecretsInText}. Masking has
 * historically lived at two boundaries only — the deploy engine's error /
 * reason text and the resolver's own debug line — so a provider that
 * interpolates a RESOLVED property value into its own `logger.warn` sat
 * outside all of it. A provider cannot close that itself: `maskSecretsInText`
 * needs a {@link RecordedSecretValues} bag, and a provider has no way to reach
 * the one its caller's resolution pass produced.
 *
 * **Why a FUNCTION and not the bag itself.** The bag was the obvious threading
 * and was rejected on four counts:
 *
 * 1. **Precedent.** The codebase already answers "the callee needs masked
 *    output" by injecting the masked capability rather than the secrets:
 *    `src/cli/commands/drift.ts` hands `withRetry` a
 *    `{ logger: { debug: (msg) => logger.debug(maskSecretsInText(msg, secrets)) } }`,
 *    and `buildMfaConfigRequest` in the Cognito provider already takes an
 *    injected `logger?: { warn }`. This follows that shape instead of adding a
 *    second one.
 * 2. **Blast radius.** {@link RecordedSecretValues} is keyed by PLAINTEXT, so
 *    handing it over gives every one of ~130 providers the pass's secrets as
 *    iterable DATA — one `[...context.secrets.keys()]` in any of them is a
 *    leak strictly worse than the one being fixed. A `(text) => string` grants
 *    the capability with no read path back to the values.
 * 3. **Layering.** The bag would put a `src/deployment/**` VALUE import and
 *    the `RecordedSecretValues` type into `src/provisioning/**`. The function
 *    keeps both out: a provider imports the {@link SecretMasker} alias from
 *    `src/types/resource.ts` (which re-exports it, as it does `DeleteContext`)
 *    and never names the bag. Stated precisely because an earlier draft
 *    claimed the provider "needs no new import at all", which stopped being
 *    true once the provider took the masker as a helper parameter — and a
 *    structurally re-declared `(text: string) => string` was the wrong way to
 *    keep it true, since it only bought a way to drift from the contract.
 * 4. **It can be WIDENED without touching a provider.** What a masker covers
 *    is the caller's decision, so growing cdkd's notion of "sensitive" — the
 *    `NoEcho` parameter values of go-to-k/cdkd#1998, under gap 3 below, are
 *    the case — changes the deploy engine alone. Threading the
 *    bag would freeze the provider contract to today's secret model.
 *
 * A masked LOGGER (injecting `{ warn }` that masks) was rejected too: providers
 * are registered as SINGLETONS (`registry.register(type, new XProvider())`) and
 * serve concurrent resources, so there is no per-call logger seam to replace
 * and no safe place to stash one. The masker is per-CALL for exactly that
 * reason, which is also why a provider must never cache it on `this`.
 *
 * **What it does NOT cover — THREE gaps, not one.** The first two are about
 * how a caller USES the masker, and both are why {@link SecretMaskingContext}
 * tells providers to mask the VALUE rather than the finished line; the third
 * is about which values are known:
 *
 * 1. **Escaping / stringification.** A masker matches by literal occurrence,
 *    so anything that TRANSFORMS the value before it lands in the text defeats
 *    it. `JSON.stringify` escapes `"`, `\` and newlines — so a Secrets
 *    Manager JSON document, the commonest real secret shape, no longer occurs
 *    in the string being masked and passes through verbatim. Measured, not
 *    theorised. Mask before you stringify.
 * 2. **The needle floor.** {@link maskSecretsInText} masks an exact
 *    whole-value match at any length, but only SCANS for substrings of at
 *    least {@link MIN_NEEDLE_LENGTH} characters. Masking a finished message
 *    can only reach the scan, so a 1-3 character secret survives it.
 * 3. **Where the value is known.** It masks what the pass that owns the bag
 *    RECORDED, and nothing else.
 *
 * What it knows: the dynamic-reference secrets (`{{resolve:secretsmanager:...}}`
 * and `SecureString` ssm resolutions) in the map, and — since go-to-k/cdkd#1998,
 * the widening point 4 of "Why a FUNCTION" was designed for — the value of a `NoEcho: true`
 * template PARAMETER, recorded as a LOG-ONLY needle ({@link logOnlyValuesOf})
 * when a `Ref` or an `Fn::Sub` variable serves it. So
 * `EnabledMfas: {Ref: SomeNoEchoParam}` is masked on a provider's warn line,
 * in the engine's error text and in the `deployments/*.jsonl` event, with no
 * provider edit.
 *
 * What it still does not: the parameter's value is NOT rewritten in anything
 * cdkd persists (maintainer decision on #1998). The map exists to rewrite a
 * plaintext onto the expression it came from, and a `Ref` has none, so the
 * value stays out of the map and {@link redactSecretsForState} never sees it:
 * a resource property or output holding a `NoEcho` value is persisted as
 * before, and an `Export.Name` embedding one is published as before
 * (`outputs-export-alias.ts`). Such a value is masked only on the log, error
 * and event surfaces, and only in a pass that resolved the `Ref`: a rollback
 * replay re-resolving a state record has no parameter to resolve.
 *
 * A DIFFERENT `NoEcho` — the CUSTOM-RESOURCE RESPONSE field of the same name —
 * is covered since issue #2274, through {@link recordMaskOnlyValue}, and IS
 * persisted as a mask: that value is handler-GENERATED and arrives fresh with
 * each invocation, while a parameter's `Ref` must keep resolving from state on
 * every later deploy. The two share only a spelling.
 */
export type SecretMasker = (text: string) => string;

/**
 * Bind a {@link RecordedSecretValues} bag into a {@link SecretMasker} for a
 * caller to hand to a provider.
 *
 * The bag is captured BY REFERENCE and read on every call, and there is
 * deliberately NO `secrets.size === 0` short-circuit here: collapsing an empty
 * bag to the identity function at BIND time would go permanently blind to
 * everything added afterwards. {@link maskSecretsInText} makes that check at
 * CALL time, where it is correct and costs a `Map.size` read.
 *
 * Stated as a property rather than a live requirement, because it is worth
 * being exact about: every caller today FILLS its bag before binding — the
 * rollback executor's arms run `resolveReplayProps` first and only then build
 * the masker, and the deploy engine resolves before it calls the provider — so
 * a bind-time short-circuit would pass every existing integration. It is the
 * ORDER, not the reference capture, that makes them work now, and the order is
 * the kind of thing a later refactor reverses without noticing. The unit test
 * `masks values added to the bag AFTER the masker was built` is what holds the
 * property up on its own.
 */
export function createSecretMasker(secrets: RecordedSecretValues): SecretMasker {
  return (text: string) => maskSecretsInText(text, secrets);
}
