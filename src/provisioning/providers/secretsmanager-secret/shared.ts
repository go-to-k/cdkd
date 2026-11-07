import {
  coerceCfnBoolean,
  coerceCfnInteger,
  configBooleanRefusal,
  configIntegerRefusal,
  configStringRefusal,
} from '../../config-shape.js';

/**
 * `value` after a JSON round-trip: `undefined` members dropped, exactly the
 * shape state.json can hold. Used so the two sides of the issue-#2472
 * comparison in {@link SecretsManagerSecretProvider.changedSecretValue} are
 * spelled the same way, and so a null-prototype object (what
 * `redactSecretsForState` builds) compares equal to a plain one —
 * `isDeepStrictEqual` checks prototypes. `undefined` round-trips to `undefined`.
 */
export function asJson(value: unknown): unknown {
  return value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as unknown);
}

/**
 * A `SecretString` about to go on the wire must be a string. Pre-#2472 a
 * non-string was forwarded through a cast and left to AWS; a silent drop is
 * the worse failure for a value the user wrote, so the SHAPE is named — never
 * the value. Shared by `create()` and `update()` so the two cannot disagree.
 */
export function requireSecretStringShape(literal: unknown): string {
  if (typeof literal === 'string') return literal;
  const shape = literal === null ? 'null' : Array.isArray(literal) ? 'array' : typeof literal;
  throw new Error(`SecretString must be a string, got ${shape}`);
}

/**
 * The character classes a `GenerateSecretString` block leaves available,
 * after the `Exclude*` switches and `ExcludeCharacters` (issue #3068), or the
 * refusal that says why no password can be minted from it. ONE function for
 * the predicate and the generator, so the shapes the predicate refuses are
 * exactly the shapes the generator cannot serve.
 *
 * The caller has already run the member SHAPE predicates (`ExcludeCharacters`
 * is a string or absent, the booleans coerce, `PasswordLength` is an integer
 * in range) — this function reads the block by cast on that precondition.
 *
 * Three refusals, each MEASURED on CloudFormation (us-east-1, 2026-09-14): the
 * docs give the default (`RequireEachIncludedType` on) and the four-type
 * wording, but none of the refusal shapes or their messages:
 *
 * - `RequireEachIncludedType` defaults to TRUE and covers the four classes
 *   (upper, lower, number, punctuation) that are not switched off; a space is
 *   never required, only admitted. With it on, a class the `Exclude*` switch
 *   keeps but `ExcludeCharacters` empties is refused: `All characters of the
 *   desired type have been excluded`. With it OFF the same template CREATES
 *   (measured), so the refusal is scoped to REQUIRED classes.
 * - With it on, `PasswordLength` below the number of required classes is
 *   refused: `Password length is too short based on the required types`.
 * - A pool with no character at all is refused: `All characters have been
 *   excluded from selection`. The old local fallback to lowercase invented a
 *   charset the template had excluded.
 */
export function generateCharset(config: Record<string, unknown>): {
  readonly required: readonly string[];
  readonly pool: string;
  readonly refusal?: string;
} {
  // Secrets Manager's own punctuation set for `GetRandomPassword` (32
  // characters, from the API reference's `ExcludePunctuation` description).
  // The local recipe used a 26-character subset until issue #3068, so an
  // `ExcludeCharacters` aimed at one of the missing six (double quote,
  // apostrophe, slash, backslash, backtick, tilde) was inert here while it
  // meant something to the service. A LOCAL const (the #2212 fence refuses
  // module-level bindings by spelling), with the backtick built from its
  // char code: that fence's string stripper takes template literals FIRST,
  // so a raw backtick inside a quoted literal desyncs its brace walk -- and
  // prettier rewrites a \u escape back into the raw character.
  const PUNCTUATION = '!"#$%&\'()*+,-./:;<=>?@[\\]^_' + String.fromCharCode(0x60) + '{|}~';
  const off = (key: string): boolean => coerceCfnBoolean(config[key]) ?? false;
  const excluded = new Set((config['ExcludeCharacters'] as string | undefined) ?? '');
  const strip = (chars: string): string => [...chars].filter((c) => !excluded.has(c)).join('');
  // [type name, its characters after ExcludeCharacters, the switch that turns
  // the whole type off] — the switch travels with the row so the refusal can
  // name it without re-deriving it from the type name.
  const classes: ReadonlyArray<readonly [name: string, chars: string, switchKey: string]> = [
    ['uppercase', strip('ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'ExcludeUppercase'],
    ['lowercase', strip('abcdefghijklmnopqrstuvwxyz'), 'ExcludeLowercase'],
    ['number', strip('0123456789'), 'ExcludeNumbers'],
    ['punctuation', strip(PUNCTUATION), 'ExcludePunctuation'],
  ];
  const requireEach = coerceCfnBoolean(config['RequireEachIncludedType']) ?? true;
  const included = classes.filter(([, , switchKey]) => !off(switchKey));
  const required: string[] = [];
  if (requireEach) {
    for (const [name, chars, switchKey] of included) {
      if (chars.length === 0) {
        return {
          required: [],
          pool: '',
          refusal: `all characters of the ${name} type have been excluded while RequireEachIncludedType requires one (exclude the type with ${switchKey} instead)`,
        };
      }
      required.push(chars);
    }
  }
  const space =
    (coerceCfnBoolean(config['IncludeSpace']) ?? false) && !excluded.has(' ') ? ' ' : '';
  const pool = included.map(([, chars]) => chars).join('') + space;
  if (pool.length === 0) {
    return {
      required: [],
      pool: '',
      refusal: 'all characters have been excluded from selection, so no password can be generated',
    };
  }
  const length = coerceCfnInteger(config['PasswordLength']) ?? 32;
  if (required.length > length) {
    return {
      required: [],
      pool: '',
      refusal: `PasswordLength ${length} is too short for the ${required.length} character types RequireEachIncludedType requires`,
    };
  }
  return { required, pool };
}

/**
 * A uniformly distributed index below `n`, by rejection: a raw draw taken
 * modulo `n` biases toward the low indexes whenever the draw's range is not
 * a multiple of `n` (2^32 never is for a 26- or 32-character class), and a
 * password generator should not.
 * The rejection IS fenced, deterministically: the unit suite stubs
 * `crypto.getRandomValues` to hand back a draw at or above `limit` and then
 * one below it, and asserts the first is thrown away (a `% n` shortcut would
 * mint from it). The bias itself is about 1 part in 2^32 / n per index at
 * this width — negligible either way; the rejection makes it zero.
 */
export function randomIndex(n: number): number {
  // An empty range is a caller bug, and it must FAIL rather than spin: with
  // `n === 0` the limit is `NaN`, no draw is ever below it, and the loop never
  // returns. Measured while probing the too-short refusal above -- with that
  // refusal removed, a 3-character password under four required classes ran
  // out of positions and the test process hung instead of failing.
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`randomIndex: range must be a positive integer (got ${n})`);
  }
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  const draw = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(draw);
    if (draw[0]! < limit) return draw[0]! % n;
  }
}

/**
 * The refusal for the MEMBERS of a `GenerateSecretString` block whose container
 * has already passed `requireConfigObject` (issue #3056), or `undefined` when
 * every member is usable. ONE predicate for two readers — the generator, which
 * mints from the block, and `retainPreviousGenerateBlock`, which decides
 * whether the PREVIOUS block is worth recording — per the #1653 rule that the
 * retention runs the same predicate the wire does. A module-level function
 * rather than a method so the recording helper can call it without reaching
 * `this`, which the #2212 fence confines to one logger call.
 *
 * Per member, the shared `config-shape.ts` predicate for its type: CFn is
 * stringly typed, so `PasswordLength: "32"` and `ExcludePunctuation: "true"`
 * coerce, while `null`, a blank, a non-numeric string, an object or an
 * unresolved intrinsic refuse. `PasswordLength` is capped at 4096, the
 * service's documented maximum, so a runaway length is refused before
 * `new Uint8Array` allocates it. `GenerateStringKey` / `SecretStringTemplate`
 * must be declared TOGETHER — the docs pin only key -> template; measured on
 * CloudFormation (us-east-1, 2026-09-13), a template with
 * `SecretStringTemplate` alone fails with `SecretStringTemplate and
 * GenerateStringKey must both be set or removed`, the service's own message
 * naming both directions (only that one was exercised) — the template must
 * parse to a JSON OBJECT (an array or a scalar parses and cannot take a key),
 * and the key may not be `__proto__`, which `template[key] = password` would
 * hand to the prototype setter, silently dropping the password from the
 * document. The messages name shapes only, never a value: the template can
 * carry a secret.
 */
export function generateMemberRefusal(config: Record<string, unknown>): string | undefined {
  const P = 'AWS::SecretsManager::Secret GenerateSecretString';
  const shape =
    configIntegerRefusal(config, 'PasswordLength', P, 1, 4096) ??
    configBooleanRefusal(config, 'ExcludeUppercase', P) ??
    configBooleanRefusal(config, 'ExcludeLowercase', P) ??
    configBooleanRefusal(config, 'ExcludeNumbers', P) ??
    configBooleanRefusal(config, 'ExcludePunctuation', P) ??
    configBooleanRefusal(config, 'IncludeSpace', P) ??
    configBooleanRefusal(config, 'RequireEachIncludedType', P) ??
    // A blank fallback is what lets a declared `''` pass (legitimate: exclude
    // nothing); the non-blank sentinel on the next two is never TAKEN — it
    // only makes a blank value refuse, since a blank key or template is not
    // a declaration.
    configStringRefusal(config, 'ExcludeCharacters', '', P) ??
    configStringRefusal(config, 'GenerateStringKey', 'required', P) ??
    configStringRefusal(config, 'SecretStringTemplate', 'required', P);
  if (shape !== undefined) return shape;
  const charset = generateCharset(config);
  if (charset.refusal !== undefined) return `${P}: ${charset.refusal}`;
  const key = config['GenerateStringKey'];
  const template = config['SecretStringTemplate'];
  if (key === undefined && template === undefined) return undefined;
  if (key === undefined || template === undefined) {
    return `${P}.GenerateStringKey and ${P}.SecretStringTemplate must be declared together (got only ${key === undefined ? 'SecretStringTemplate' : 'GenerateStringKey'})`;
  }
  if (key === '__proto__') {
    return `${P}.GenerateStringKey must not be __proto__ (the password would be written to the prototype, not the document)`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(template as string);
  } catch {
    return `${P}.SecretStringTemplate must be a JSON object (got a string that does not parse as JSON)`;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return `${P}.SecretStringTemplate must be a JSON object (got JSON that is not an object)`;
  }
  return undefined;
}
