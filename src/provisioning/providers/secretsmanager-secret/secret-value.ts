import type { SecretsManagerSecretProvider } from '../secretsmanager-secret-provider.js';
import { isDeepStrictEqual } from 'node:util';
import { getCurrentResourceSecrets } from '../../../deployment/resource-secrets-scope.js';
import { redactForState } from '../../../deployment/secret-redaction.js';
import { coerceCfnInteger, requireConfigObject } from '../../config-shape.js';
import {
  asJson,
  generateCharset,
  generateMemberRefusal,
  randomIndex,
  requireSecretStringShape,
} from './shared.js';

/**
 * The bag to RECORD when the generate block was skipped: the desired
 * properties with `GenerateSecretString` restored to the previously-applied
 * value, or with the key dropped when the previous side cannot be vouched
 * for either.
 *
 * Validated through `requireConfigObject` AND `generateMemberRefusal` — the
 * same two predicates the wire read runs, container then members — rather
 * than a hand-written twin, so the two cannot disagree about a blank string,
 * an explicit null, an intrinsic, or (since issue #3056) a malformed member
 * inside a well-formed block: a pre-#3056 record holding
 * `PasswordLength: 'abc'` is dropped, not retained. The retained block is
 * COPIED, not aliased: both engine consumers spread the answer one level
 * deep only (the #1653 review rule).
 *
 * The DROP is announced rather than silent (the #1654 rule: dropping a key
 * moves a hazard unless something still says so). A record carrying
 * neither value source later reaches the reverse-replacement replay-create,
 * where `create()` — which cannot see the record's history — would create
 * the secret with NO version; the warning here is what makes that record
 * diagnosable, and `create()` warns again when it meets one.
 *
 * One shape is announced rather than reconciled: a secret created from a
 * LITERAL whose template then switches to a malformed generate block. The
 * previous side has no block, so the key is dropped, and the record then
 * carries neither source while AWS still holds the literal. Restoring the
 * previous `SecretString` would be the #1612 answer, but it re-records a
 * literal the template has REMOVED; the drop keeps the next deploy of the
 * same template an announced UPDATE (desired block vs absent), which is the
 * loud outcome this arm exists for.
 */
export function retainPreviousGenerateBlock(
  this: SecretsManagerSecretProvider,
  logicalId: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>
): Record<string, unknown> {
  // An ABSENT previous (`undefined` / `null`) takes the same road as an
  // unusable one: the guard answers `undefined` for both, and the drop
  // below is the right answer for both.
  const usableContainer = requireConfigObject(
    previousProperties['GenerateSecretString'],
    'AWS::SecretsManager::Secret GenerateSecretString',
    {
      // No-op: the drop warning below is the one announcement, naming BOTH
      // sides; a second line about the previous block would name a value
      // the user did not just write.
      onUnusable: () => {},
    }
  );
  const usablePrevious =
    usableContainer !== undefined && generateMemberRefusal(usableContainer) === undefined
      ? usableContainer
      : undefined;
  const effective = { ...properties };
  if (usablePrevious === undefined) {
    delete effective['GenerateSecretString'];
    this.logger.warn(
      `AWS::SecretsManager::Secret ${logicalId}: GenerateSecretString is dropped from the ` +
        `recorded properties. The desired block is unusable and the previously recorded one ` +
        `is absent or unusable, so the record now carries no GenerateSecretString; fix the ` +
        `template so the next deploy records one.`
    );
  } else {
    effective['GenerateSecretString'] = { ...usablePrevious };
  }
  return effective;
}

/**
 * The `SecretString` an in-place update must send (as `value`), or
 * `undefined` when the value's SOURCE is unchanged (issue #2472) or when a
 * malformed `GenerateSecretString` block was SKIPPED (issue #3048,
 * `skippedGenerate: true` — the caller records the previous block instead).
 *
 * The source is `GenerateSecretString` when present (CloudFormation gives it
 * precedence over a literal) and `SecretString` otherwise. A generated value
 * is minted only when the `GenerateSecretString` block differs from the
 * previous one — every in-place update re-runs this method, so comparing
 * the block rather than the (never persisted, never read back) value is
 * the only way to keep an unrelated update from re-rolling the password. A
 * literal is sent only when it differs from the previous literal. Switching
 * source in either direction counts as a change (the previous side of the
 * new source is `undefined`), and a bag that carries NEITHER source keeps
 * the live value untouched, as CloudFormation does.
 *
 * One consequence of the precedence: a PREVIOUS bag carrying both a block
 * and an ignored `SecretString: 'x'` masks a block-to-literal switch whose
 * literal is still `'x'` (the literal compares equal, nothing is sent).
 * CloudFormation rejects a template declaring both, so such a record is
 * cdkd-created only and the miss is accepted.
 *
 * THE PREVIOUS BAG IS WHAT STATE PERSISTED, so the block is compared in
 * that spelling. On the deploy path a `{{resolve:...}}` inside
 * `SecretStringTemplate` reaches this method as plaintext while state holds
 * the redacted expression (GHSA-p5qg-v9gv-hc7w); compared raw, such a block
 * ALWAYS differs and every Tags-only update re-rolls the password — the
 * defect this method exists to close, for exactly the shape that embeds a
 * secret. {@link asPersisted} rewrites the desired block through the same
 * redaction the state writer uses, so the two sides meet. A pre-GHSA record
 * still holding plaintext matches the raw comparison instead; either match
 * means "unchanged".
 *
 * The same rewrite means an upstream ROTATION behind an unchanged reference
 * in `SecretStringTemplate` does NOT regenerate (the expression is the same
 * on both sides), where CloudFormation, which re-resolves at update time,
 * would. That is the intended trade for the generated source: the harmful
 * direction is the unrequested re-roll.
 *
 * RESIDUAL, permanent rather than one-shot: two references in the block
 * that resolve to the SAME plaintext. The resolver records one pair per
 * plaintext (last expression wins), so this value scan rewrites BOTH leaves
 * to the survivor expression, while the persisted previous holds each
 * leaf's own expression (the state writer redacts by POSITION, with the
 * template as its source) — the two spellings differ on every in-place
 * update, and that shape re-rolls on every Tags-only deploy. Threading a
 * position source through here would close it, but the only source this
 * method holds is the PREVIOUS block, and substituting its leaves would
 * also erase a genuine reference switch in a secret leaf; left open for a
 * shape that is rare (two secrets with identical plaintext in one block).
 *
 * A LITERAL IS DELIBERATELY NOT REDACTED BEFORE COMPARING. A
 * `SecretString: '{{resolve:...}}'` (a secret mirroring another one) is
 * re-sent on every in-place update: cdkd cannot tell whether the REFERENCED
 * value changed since the last deploy — state holds only the expression —
 * and CloudFormation re-applies it when the resolved value changed. A
 * redundant version is the milder failure; a stale copy is a wrong value.
 *
 * `isDeepStrictEqual` over a JSON round-trip rather than `JSON.stringify`
 * equality: the previous bag comes back from state.json while the new one
 * comes from the resolver, so a key-order difference is not a change, and
 * an explicit `undefined` member (which state.json cannot hold) must not
 * read as one either — that failure direction is a silent re-roll.
 *
 * KNOWN EDGE, accepted: the redaction is a VALUE scan, so a literal in the
 * block that happens to EQUAL a plaintext this resource resolved from a
 * reference elsewhere in its bag is rewritten to that reference's
 * expression too. Replacing a `{{resolve:...}}` in the template with the
 * literal it currently resolves to therefore compares equal and does NOT
 * regenerate, where CloudFormation would. This is the same rewrite the
 * state writer applies to that literal when it persists the record, so the
 * two sides stay consistent, and the miss is in the safe direction (no
 * unrequested re-roll) for an edit that puts a secret's plaintext into a
 * template.
 */
export function changedSecretValue(
  this: SecretsManagerSecretProvider,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  // The desired bag is a cdkd STATE record (a rollback revert arm, or
  // `cdkd drift --revert`), so a malformed `GenerateSecretString` warn-skips;
  // `false` (a template-path update) makes it THROW instead — issue #3740.
  stateBorneDesired: boolean,
  // The update's masked `warn` sink (issue #2177), for the skip warning.
  warn: (message: string) => void
): { value: string | undefined; skippedGenerate: boolean } {
  const rawGenerate = properties['GenerateSecretString'];
  // `!= null`, NOT truthiness: a FALSY malformed container (`''`, `0`) would
  // otherwise skip this branch entirely and fall through to the literal
  // read, which is the #1493 gate-bug shape `config-shape.ts` names —
  // silently ignoring a `GenerateSecretString` the template declared.
  if (rawGenerate != null) {
    const generateConfig = rawGenerate as Record<string, unknown>;
    const previous = previousProperties['GenerateSecretString'];
    const unchanged =
      isDeepStrictEqual(asJson(generateConfig), asJson(previous)) ||
      isDeepStrictEqual(asJson(this.asPersisted(generateConfig)), asJson(previous));
    if (unchanged) return { value: undefined, skippedGenerate: false };
    // A malformed container SKIPS the value rather than throwing (issue
    // #3048) — on the STATE-BORNE paths. `update()` is reached by the
    // rollback executor's revert arms with a cdkd STATE record as the desired
    // bag, which the user cannot edit from the template — so a throw there
    // leaves the secret un-rollbackable (the #1544 hazard). A TEMPLATE-path
    // update (`stateBorneDesired === false`) REFUSES instead (issue #3740):
    // the block is template-borne, it changed (the `unchanged` return above
    // ran first), and one template edit repairs it; `update()` turns the
    // throw into a "nothing was applied" refusal before any call. `cdkd drift --revert` is NOT a
    // caller of this arm: its bag is seeded from the AWS readback plus the
    // DRIFTED keys only, and `getDriftUnknownPaths` keeps this key out of
    // the comparison, so the block never rides a revert (the flag still
    // takes the downgrade, defensively, like every other state-borne bag).
    //
    // The downgrade is a SKIP and NOT `onUnusable`, because at this site
    // proceeding is the harm: `generateSecretString` reads every member off
    // this container, so a malformed one indexes them all to `undefined` and
    // mints a bare default-charset password — and with `GenerateStringKey` /
    // `SecretStringTemplate` gone too, it returns that password RAW instead
    // of the JSON document the template declared. That value becomes the new
    // `AWSCURRENT`, breaking every consumer reading `{"username":…}`.
    // Omitting `SecretString` instead leaves `UpdateSecret`'s merge
    // semantics to keep the value AWS already holds.
    //
    // The downgrade is handed to `generateSecretString` as a callback
    // rather than living inside it, because `create()` calls the same
    // function with none (there is no live secret to fall back to on a
    // create, so it must keep refusing). The container and every MEMBER
    // (issue #3056) take the same road: a refusal on the update path is a
    // SKIP of the whole value, announced once.
    //
    // `requireConfigObject`'s own message already ends with the
    // template-path-create clause, so this one adds only what IS specific to
    // the site: what happens to the live value.
    const skip = (m: string): void =>
      warn(
        `${m} No new secret value is generated; the secret keeps the value AWS ` +
          `currently holds.`
      );
    const downgrade = stateBorneDesired ? { onUnusable: skip } : {};
    const usable = requireConfigObject(
      generateConfig,
      'AWS::SecretsManager::Secret GenerateSecretString',
      downgrade
    );
    const generated =
      usable === undefined ? undefined : this.generateSecretString(usable, downgrade);
    return generated === undefined
      ? { value: undefined, skippedGenerate: true }
      : { value: generated, skippedGenerate: false };
  }
  const literal = properties['SecretString'];
  if (literal === undefined) return { value: undefined, skippedGenerate: false };
  // UNCHANGED is decided before the shape is judged: a record written by a
  // pre-#2472 binary may hold a non-string the old `create()` forwarded via
  // a cast, and an unrelated (Tags-only) update of that record must keep
  // succeeding as it always did — the refusal below applies only to a value
  // that would actually be SENT.
  if (isDeepStrictEqual(asJson(literal), asJson(previousProperties['SecretString']))) {
    return { value: undefined, skippedGenerate: false };
  }
  // An empty string is a VALUE here, not "absent": a literal changed to
  // `''` (or a switch from `GenerateSecretString` to `SecretString: ''`)
  // is a change the user wrote, so it goes on the wire and AWS accepts
  // or rejects it, rather than silently keeping the old value. (`create()`
  // still skips `''` with its truthy gate, so a secret created empty has no
  // version at all; a later change TO `''` then reads as a no-op here.)
  return { value: requireSecretStringShape(literal), skippedGenerate: false };
}

/**
 * `bag` as the state writer would persist it: every plaintext this
 * provider call resolved from a `{{resolve:...}}` reference is rewritten
 * back to its expression. The pairs come from the per-resource scope the
 * deploy engine / rollback executor bind around the provider call
 * (`resource-secrets-scope.ts`); absent (drift `--revert`, import, tests)
 * the bag is returned as-is. The map is handed to the redaction helper
 * only — never enumerated, never logged.
 */
export function asPersisted<T>(this: SecretsManagerSecretProvider, bag: T): T {
  const secrets = getCurrentResourceSecrets();
  return secrets !== undefined && secrets.size > 0
    ? redactForState(bag, { provenance: 'value-scan', secrets: secrets })
    : bag;
}

/**
 * Generate a secret string from a USABLE `GenerateSecretString` block (the
 * caller has already run `requireConfigObject` on the container).
 *
 * Every MEMBER is read through the shared `config-shape.ts` predicate for
 * its type (issue #3056) rather than a cast: CFn is stringly typed, so
 * `PasswordLength: "32"` and `ExcludePunctuation: "true"` are legitimate
 * and coerce, while a malformed member — `null`, a blank, a non-numeric
 * string, an object, an unresolved intrinsic — REFUSES instead of taking a
 * default. The defaults it used to take were not inert: `(x as number) || 32`
 * read `PasswordLength: 'abc'` as a truthy string and `new Uint8Array('abc')`
 * minted an EMPTY password; a truthy `'false'` EXCLUDED punctuation; and a
 * malformed `SecretStringTemplate` fell into the `catch` and returned the
 * bare password RAW where the template declared a JSON document — as the
 * new `AWSCURRENT`.
 *
 * The member rules themselves live in `generateMemberRefusal` (shared with
 * the recording helper); both present means the key is written into the
 * parsed template, both absent means a bare password, which is what the
 * service does.
 *
 * With no `onUnusable` a refusal THROWS (the create path, where the block
 * is template-borne). With one, the message is handed over and `undefined`
 * is returned — the update path's SKIP, decided by the caller, so that this
 * function never mints from a block it could not read. The recipe itself —
 * the four classes, the service's punctuation set, `IncludeSpace`, and the
 * `RequireEachIncludedType` guarantee — lives in `generateCharset` (issue
 * #3068), shared with the predicate so the block it refuses and the block
 * it mints from cannot disagree.
 */
export function generateSecretString(
  this: SecretsManagerSecretProvider,
  config: Record<string, unknown>,
  options?: { onUnusable?: (message: string) => void }
): string | undefined {
  const refusal = generateMemberRefusal(config);
  if (refusal !== undefined) {
    if (options?.onUnusable) {
      options.onUnusable(
        `${refusal}. Leaving this configuration unapplied here; the same value is REFUSED on a ` +
          `template-path create.`
      );
      return undefined;
    }
    throw new Error(refusal);
  }

  const length = coerceCfnInteger(config['PasswordLength']) ?? 32;
  const { required, pool } = generateCharset(config);

  // Draw uniformly from the pool, then satisfy `RequireEachIncludedType` by
  // PLACEMENT rather than by re-drawing: one character of each required
  // class lands at a distinct random position, so the guarantee holds in
  // one pass whatever the length (the refusal above already settled
  // `length >= required.length`).
  const out: string[] = [];
  for (let i = 0; i < length; i++) out.push(pool[randomIndex(pool.length)]!);
  const positions = Array.from({ length }, (_, i) => i);
  for (const classChars of required) {
    const slot = positions.splice(randomIndex(positions.length), 1)[0]!;
    out[slot] = classChars[randomIndex(classChars.length)]!;
  }
  const password = out.join('');

  // Both present (the refusal above settled "both or neither" and that the
  // template parses to an object): write the password into the document.
  const generateStringKey = config['GenerateStringKey'] as string | undefined;
  const secretStringTemplate = config['SecretStringTemplate'] as string | undefined;
  if (generateStringKey === undefined || secretStringTemplate === undefined) return password;
  const template = JSON.parse(secretStringTemplate) as Record<string, unknown>;
  template[generateStringKey] = password;
  return JSON.stringify(template);
}
