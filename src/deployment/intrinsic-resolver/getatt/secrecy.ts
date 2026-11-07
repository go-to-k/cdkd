import type { IntrinsicFunctionResolver } from '../../intrinsic-function-resolver.js';
import { displayMasked } from '../masking-display.js';
import { type RedactedAttributeRead, type ResolverContext } from '../support.js';
import {
  carriesSecretMask,
  recordFreshNoEchoValuesIn,
  MIN_NEEDLE_LENGTH,
  recordLogOnlyValue,
  wholeStringLeavesOf,
} from '../../secret-redaction.js';
import {
  hasPassProvenance,
  passProvenanceFor,
  recordReferenceProvenanceEntry,
} from '../../secret-redaction/reference-provenance.js';

/**
 * The ONE writer of {@link ResolverContext.redactedAttributeReads}, so the
 * bag's absent-context check and its de-duplication rule live in one place
 * rather than being re-spelled at each of the three pushing branches.
 *
 * DE-DUPES ON THE WHOLE TUPLE, not on `display` alone, and that is the last
 * decision this file moved out of string space (issue #2847 round-5 review).
 * An earlier revision compared renderings, which is where two of this PR's
 * blockers came from: a decision keyed on a joined human-readable string.
 * Here it gated entry EXISTENCE while `DeployEngine`'s Outputs guard filters
 * the surviving entries by `kind`, so an `attribute` entry whose `display`
 * collided with a later `ref-state-key` one suppressed the refusal outright.
 * Reachable only through an adversarial logical id (`Ref Foo (state key Table`
 * with an attribute named `Name)`) — `main`'s string bag is equally
 * contrived, which is why review called it a cleanup rather than a defect —
 * but the class is the point, not this instance.
 *
 * `key` carries its weight here: for the `attribute` kind it is the
 * ALREADY-MASKED attribute name, so two names differing only ABOVE the mask
 * still render and compare identically and still collapse, exactly as they
 * did when the bag held strings. Nothing else reads it, and comparing it is
 * what keeps it from being a field written by two producers and read by none.
 */
export function pushRedactedAttributeRead(
  _resolver: IntrinsicFunctionResolver,
  context: ResolverContext,
  read: RedactedAttributeRead
): void {
  const bag = context.redactedAttributeReads;
  if (bag === undefined) return;
  const duplicate = bag.some(
    (entry) =>
      entry.kind === read.kind &&
      entry.logicalId === read.logicalId &&
      entry.key === read.key &&
      entry.display === read.display
  );
  if (duplicate) return;
  bag.push(read);
}

/**
 * Values state already holds in the clear that a `NoEcho` handler can echo
 * back (go-to-k/cdkd#2453): the region, the stack name, and — for a named
 * producer — its `ServiceToken` plus each `:`-separated segment of it (the
 * account id, the function name) and every literal string of its template
 * `Properties`. {@link recordFreshNoEchoValuesIn} keeps a
 * value EQUAL to one of them out of the containment arm, so an echoed region
 * or account id does not flatten every ARN of the reading resource.
 */
export function publicNoEchoTokens(
  resolver: IntrinsicFunctionResolver,
  context: ResolverContext,
  producer?: string
): ReadonlySet<string> {
  const tokens = new Set<string>([resolver.resolverRegion]);
  if (context.stackName !== undefined) tokens.add(context.stackName);
  const serviceToken =
    producer === undefined || !Object.hasOwn(context.resources, producer)
      ? undefined
      : context.resources[producer]?.properties?.['ServiceToken'];
  if (typeof serviceToken === 'string') {
    tokens.add(serviceToken);
    for (const segment of serviceToken.split(':')) tokens.add(segment);
  }
  // The producer's LITERAL template inputs: a handler echoing
  // `event.ResourceProperties` returns them verbatim, and the template is
  // public. A literal carrying a `{{resolve:` is skipped: what the handler
  // saw was its resolved secret, not this text.
  const resources = context.template.Resources ?? {};
  if (producer !== undefined && Object.hasOwn(resources, producer)) {
    const walk = (node: unknown): void => {
      if (typeof node === 'string') {
        if (!node.includes('{{resolve:')) tokens.add(node);
        return;
      }
      if (node === null || typeof node !== 'object') return;
      for (const child of Object.values(node as Record<string, unknown>)) walk(child);
    };
    walk(resources[producer]?.Properties);
  }
  return tokens;
}

/**
 * Note what SECRECY the attribute just read carries, then hand it back
 * UNCHANGED (issue [#2274](https://github.com/go-to-k/cdkd/issues/2274)).
 *
 * Two independent notes, in the two directions a `NoEcho` custom-resource
 * `Data` value travels, and they are on one function because both are read
 * off the same value at the same instant:
 *
 * 1. **This run's fresh value.** If a provider declared this resource's
 *    attributes `NoEcho` earlier in THIS deploy, every string leaf becomes a
 *    MASK-ONLY needle in the CONSUMER's own bag, so the plaintext this
 *    resolution is about to substitute into the dependent's properties is
 *    masked when that record is persisted. Registering into
 *    `context.recordedSecretValues` — the consumer's bag — rather than the
 *    producer's is what makes it work at all: `perResourceSecrets` is keyed by
 *    LOGICAL ID, so a needle recorded under the custom resource's own id is
 *    not in the bag the DEPENDENT's record is scrubbed with.
 * 2. **A previous run's masked value.** If what came back IS the mask, this
 *    attribute was redacted into `state.json` by an earlier deploy and cdkd
 *    cannot recover it (there is no durable `NoEcho` flag and no expression to
 *    re-resolve — issue #2449). It is recorded as a redacted READ so the
 *    deploy engine can refuse to push the literal `***` to AWS.
 *
 * IT RETURNS THE VALUE, and passing through rather than mutating in place is
 * the point: a new attribute-serving branch is written as `return
 * noteAttributeSecrecy(resolver,...)` by imitation of the two that have it.
 * `Fn::GetAtt` must keep delivering the REAL value (CloudFormation does,
 * measured), so this can never rewrite what it is handed.
 *
 * IT IS NOT A GUARANTEE, and an earlier revision claimed it was ("impossible
 * to add a third branch that silently skips the note"). Nothing in the type
 * system stops a branch returning a value it never passed through here, and
 * one already did: the Route 53 `NameServers` legacy-shape normalization,
 * which reads the SAME persisted `attributes` bag and shipped without the
 * note (it takes it now). The rule the note actually needs is about the
 * SOURCE of the value — every branch serving one out of a PERSISTED
 * `attributes` bag must call this, and so must one serving (or embedding) a
 * persisted `properties` leaf, which a mask-only needle masks whole
 * (go-to-k/cdkd#2936: the VPC `CidrBlock` and Events rule `Arn` arms) — and
 * that is not a shape a compiler can enforce. A branch serving `attributes`
 * also hands what it serves through {@link reresolveRecordedReferences}
 * (go-to-k/cdkd#4800); the VPC `CidrBlock` and Events rule `Arn` arms do not,
 * since no physical id proves which generation of their value AWS holds. `constructGuardedAttribute`'s return is deliberately outside it:
 * that value is fetched from AWS in this run, not read back from state, so
 * it can be neither a stale mask nor a value a provider declared `NoEcho`.
 *
 * A context supplying NEITHER field — the diff / no-op resolver, `cdkd
 * scrub`, `cdkd import` — pays two undefined checks and gets its value back.
 *
 * ORDERING: call it BEFORE any log line that prints the value
 * (go-to-k/cdkd#3659). Note 1 is what puts a `NoEcho` value into the bag
 * `displayMasked` masks against, so a line logged first prints the plaintext
 * at `--verbose`.
 */
export function noteAttributeSecrecy(
  resolver: IntrinsicFunctionResolver,
  logicalId: string,
  attributeName: string,
  value: unknown,
  context: ResolverContext
): unknown {
  // go-to-k/cdkd#4043 §3.3: a held producer's declared attribute, read back
  // from AWS for this resolution, in place of the mask its record holds.
  const override = carriesSecretMask(value)
    ? context.noEchoAttributeOverrides?.get(logicalId)
    : undefined;
  const served = override !== undefined && Object.hasOwn(override, attributeName);
  if (served) value = override[attributeName];
  recordSecretNamedRead(logicalId, value, context);
  recordProducerSecretPairs(logicalId, value, context);
  const declared = context.noEchoAttributeResources?.get(logicalId);
  const attributeIsDeclared =
    served || declared === true || (declared !== undefined && declared.has(attributeName));
  if (attributeIsDeclared && context.recordedSecretValues) {
    // FRESH (go-to-k/cdkd#3662): declared by a provider in THIS deploy.
    recordFreshNoEchoValuesIn(
      value,
      context.recordedSecretValues,
      undefined,
      publicNoEchoTokens(resolver, context, logicalId)
    );
  }
  // The bag test stays HERE as well as inside `pushRedactedAttributeRead`:
  // a bagless context (the diff / no-op resolver, `cdkd scrub`, `cdkd
  // import`) must not pay for `displayMasked` on the hot path.
  if (context.redactedAttributeReads !== undefined && carriesSecretMask(value)) {
    // Masked for the reason the `origin` pusher states (issue #2827 review
    // round 2): `attributeName` is `resolveGetAtt`'s resolved one, and this
    // array is joined into a default-verbosity throw by the deploy engine.
    // THE FIELD AND THE DISPLAY NOW DIVERGE, deliberately (go-to-k/cdkd#3432).
    //
    // `logicalId` the FIELD stays raw: it is the routing key
    // `DeployEngine.maskedRecordRemedyFor` partitions on and the id its
    // `--resource <id>=` command interpolates, so a sanitized copy there
    // would be a different id.
    //
    // `display` is SANITIZED, which go-to-k/cdkd#3426 review round 3 raised
    // and deferred. The deferral rested on two claims, and BOTH were
    // re-measured before this change rather than inherited:
    //
    //  - "`displayIdent` quotes an id containing a space, breaking
    //    `intrinsic-ref-state-mask.test.ts`'s deliberate collision with
    //    `noteRefStateMask`'s rendering" — TRUE, which is why the remedy here
    //    is `displayMasked`, not `displayIdent`. The builder strips and
    //    `displaySafe`s without quoting or bounding, so `Ref Foo` and
    //    `Foo.Bar` render byte-identically to before and that fixture's
    //    collision survives. Both sites take it, so the two halves stay
    //    comparable.
    //  - "the sibling's spelling is PARSED by
    //    `DeployEngine.maskedRecordRemedyFor`" — NO LONGER TRUE, and that is
    //    what unblocks the pair. That helper's round-4 review moved its
    //    partition off a regex over `display` and onto the `kind` /
    //    `logicalId` FIELDS ("THE ROUTING KEY IS THE FIELD, not a capture
    //    group"); `targetOf` reads `read.logicalId`. Re-derived from the
    //    READERS rather than from the call graph: the only readers of
    //    `display` in `src` are this file's whole-tuple de-dup comparison and
    //    two `.join(', ')` message builders in `deploy-engine.ts`. Nothing
    //    re-parses it.
    const maskedAttributeName = displayMasked(resolver, attributeName, context);
    // go-to-k/cdkd#2449: the record says whether its producer DECLARED this
    // attribute `NoEcho`, which makes the refusal exact. Still refused: cdkd
    // never re-runs the producer to recover the value.
    const record = Object.hasOwn(context.resources, logicalId)
      ? context.resources[logicalId]
      : undefined;
    const names = record?.noEchoAttributeNames as unknown;
    const declaredNoEcho = Array.isArray(names) && names.includes(attributeName);
    pushRedactedAttributeRead(resolver, context, {
      kind: 'attribute',
      logicalId,
      key: maskedAttributeName,
      ...(declaredNoEcho && { declaredNoEcho: true as const }),
      display: `${displayMasked(resolver, logicalId, context)}.${maskedAttributeName}`,
    });
  }
  return value;
}

/**
 * go-to-k/cdkd#4802: a producer resolved in THIS run (created or updated)
 * returns its attributes from the provider, in plaintext, and the reader is
 * served that value. Record into the READER's bag each of the producer's own
 * (plaintext, reference) pairs whose plaintext the value carries, so the
 * reader persists the reference form, as a reader of an UNCHANGED producer
 * does (go-to-k/cdkd#4800, whose re-resolution records the same pairs) and as
 * the next deploy's diff reads it. Without it the reader stored the plaintext
 * and the next deploy updated it once more.
 *
 * Only pairs whose value is a reference (never a mask-only entry, which the
 * `NoEcho` arms answer), whose plaintext clears {@link MIN_NEEDLE_LENGTH}, and
 * that the reader's bag does not already key. The producer's bag is read,
 * never written.
 *
 * And only for the SAME GENERATION: the producer keeps the physical id this
 * run loaded, and that id embeds the plaintext
 * ({@link ResolverContext.producerPreRunPhysicalId}). A reference says nothing
 * of which value it stood for, so a reader of a producer REPLACED under a
 * rotated secret would compare its recorded reference equal to the new one and
 * be skipped, left pointing at the deleted resource. A created or replaced
 * producer copies nothing: its reader stores the plaintext once, as before.
 */
function recordProducerSecretPairs(
  logicalId: string,
  value: unknown,
  context: ResolverContext
): void {
  const bag = context.recordedSecretValues;
  if (bag === undefined || context.producerSecrets === undefined) return;
  const producer = context.producerSecrets(logicalId);
  if (producer === undefined || producer === bag || producer.size === 0) return;
  // State schema v12 (go-to-k/cdkd#4852): the producer's PASS provenance of
  // each reference whose plaintext the served value carries, on the `read`
  // route, whatever the generation gate below decides for the pair: the value
  // is this run's, so its version is too. Only what clears the needle floor,
  // as for the pairs, so a short plaintext matching by chance adds nothing.
  if (hasPassProvenance(producer)) {
    const served = [...wholeStringLeavesOf(value)];
    for (const [plaintext, expression] of producer) {
      if (plaintext.length < MIN_NEEDLE_LENGTH || !expression.startsWith('{{resolve:')) continue;
      if (!served.some((leaf) => leaf.includes(plaintext))) continue;
      const entry = passProvenanceFor(producer, expression);
      if (entry === undefined) continue;
      recordReferenceProvenanceEntry(bag, expression, entry, 'read');
      if (context.provenanceSink !== undefined) {
        recordReferenceProvenanceEntry(context.provenanceSink, expression, entry, 'read');
      }
    }
  }
  const preRun = context.producerPreRunPhysicalId?.(logicalId);
  const record = Object.hasOwn(context.resources, logicalId)
    ? context.resources[logicalId]
    : undefined;
  if (typeof preRun !== 'string' || record?.physicalId !== preRun) return;
  const physicalId = preRun.toLowerCase();
  const leaves = [...wholeStringLeavesOf(value)];
  if (leaves.length === 0) return;
  for (const [plaintext, expression] of producer) {
    if (plaintext.length < MIN_NEEDLE_LENGTH || bag.has(plaintext)) continue;
    if (typeof expression !== 'string' || !expression.startsWith('{{resolve:')) continue;
    if (!physicalId.includes(plaintext.toLowerCase())) continue;
    if (leaves.some((leaf) => leaf.includes(plaintext))) bag.set(plaintext, expression);
  }
}

/**
 * Record what a `Ref` / `Fn::GetAtt` read from a resource NAMED from a secret
 * (go-to-k/cdkd#3869) as LOG-ONLY needles of the reading pass's bag: the
 * resource's own physical-id needles ({@link ResolverContext.secretNameNeedles})
 * and each string leaf of `value`. A name derived from a secret, or an ARN /
 * URL embedding one, is no recorded plaintext, so without them the reader's
 * provider masker, the engine's error and event masking and the resolver's
 * `resolved to` line all print it.
 *
 * LOG-ONLY: the value is the reader's real input and is persisted and sent
 * as it is. Call it BEFORE any line printing `value`. A context without the
 * callback or a bag records nothing.
 */
export function recordSecretNamedRead(
  logicalId: string,
  value: unknown,
  context: ResolverContext
): void {
  // A context carrying a print-only bag records there instead: the deploy
  // engine gives one to every context whose own bag DECIDES something from
  // its log-only needles (a nested-stack row, the masked-input fingerprint
  // pass, the outputs pass; the list is at `secretNameNeedles` in
  // `deploy-engine/resolver-context.ts`). A command resolving against state
  // names a sink of its own (`secretNameSink`), which wins over both.
  const bag = context.secretNameSink ?? context.printingSecrets ?? context.recordedSecretValues;
  if (bag === undefined || context.secretNameNeedles === undefined) return;
  const needles = context.secretNameNeedles(logicalId);
  if (needles === undefined) return;
  for (const needle of needles) recordLogOnlyValue(bag, needle);
  // A leaf only when it carries a needle (an ARN or URL around the name), so
  // an unrelated attribute (`Endpoint.Port`'s `5432`) masks nothing. A leaf
  // EQUAL to a needle is already recorded above.
  for (const leaf of wholeStringLeavesOf(value)) {
    for (const needle of needles) {
      if (needle.length >= MIN_NEEDLE_LENGTH && leaf.includes(needle)) {
        recordLogOnlyValue(bag, leaf);
        break;
      }
    }
  }
}
