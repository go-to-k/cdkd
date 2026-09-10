/**
 * Make an untrusted value safe to render in a terminal or persist into a log.
 *
 * A LEAF module with no imports, and deliberately in `src/utils/` rather than
 * beside its first caller: issue [#2170](https://github.com/go-to-k/cdkd/issues/2170)'s
 * review found the same rule being widened BY HAND one module at a time and
 * missing an instance every round — the change sanitized 1 of 5 readers of
 * `LockInfo.owner`. One shared definition, imported by everything that renders
 * such a value, is what stops the next reader from inheriting nothing.
 *
 * The stripped class is wider than C0 + DEL, which a first cut used and which
 * misses every mechanism that actually forges a line:
 *
 * - `U+0085` (NEL) and the C1 range — xterm reads `U+009B` as CSI in UTF-8;
 * - `U+2028` / `U+2029` — this text is PERSISTED and re-rendered by JSON and
 *   web log viewers, where both are line terminators;
 * - `U+202A`-`U+202E` / `U+2066`-`U+2069` — the Trojan-Source bidi overrides
 *   and isolates, which visually REORDER the command being pasted.
 *
 * Known residual, recorded rather than implied away: the invisible formatters
 * (`U+200B`-`U+200D`, `U+FEFF`) and the bidi MARKS (`U+200E` / `U+200F` /
 * `U+061C`) survive, as do bare RTL letters, which no denylist can reach. All
 * of them can only make a rendered name differ visually from its bytes — the
 * command a user pastes still acts on exactly what is shown, and the blast
 * radius stays the attacker's own stack name.
 *
 * A caller whose value has a KNOWN ASCII charset (a stack name, an AWS region)
 * should pass `asciiOnly`, which is a positive allowlist and therefore has no
 * such residual at all.
 *
 * ONE CALLER DELIBERATELY GOES WIDER, and it is recorded here so an editor of
 * the residual note above knows a second module now disagrees with it.
 * `src/deployment/outputs-export-alias.ts` deletes a class derived from
 * `\p{Cc}` / `\p{Cf}` / `\p{Zl}` / `\p{Zp}` /
 * `\p{Default_Ignorable_Code_Point}`, because on THAT path the subject is a possibly
 * secret-bearing name in an operator's log: a plaintext split by a zero-width
 * character is READ as if it were contiguous, so it is disclosed without any
 * paste, and the command-forgery reasoning above does not transfer (issue
 * [#2874](https://github.com/go-to-k/cdkd/issues/2874)). Nothing here changes
 * -- widening this helper would alter every caller that merely wants a
 * terminal-safe string.
 */
export function displaySafe(value: unknown, opts?: { asciiOnly?: boolean }): string {
  // ABSENT means nothing to display, not the WORD. `String(undefined)` is
  // `'undefined'` — a truthy string — so a caller keying its
  // "is there anything here?" decision on the result was silently answered
  // "yes" for a lock.json with no `owner`, printing `held by undefined` while
  // certifying that the holder was live. Every caller of this helper keys some
  // decision on emptiness, so the rule belongs here rather than at each of
  // them.
  if (value === undefined || value === null) return '';
  const text = String(value);
  const stripped = opts?.asciiOnly
    ? // Printable ASCII only. Correct for a stack name or an AWS region, both
      // of which have a known charset.
      text.replace(/[^ -~]/g, ' ')
    : text.replace(
        // eslint-disable-next-line no-control-regex
        /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
        ' '
      );
  return stripped.trim();
}
