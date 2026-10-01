/**
 * The provider's collision text as the name-collision refusals quote it on
 * their own `Underlying collision:` line: the rollback executor's three
 * reverse-replacement refusals and the deploy engine's `--replace` twin
 * (go-to-k/cdkd#4291). One module so both refusals render it the same way.
 */
import { displayAwsMessage, displaySafe } from '../utils/display-safe.js';

/**
 * The deploy engine's own name-collision refusals whose every line break is
 * cdkd's: the provider text is JSON-escaped on its `Underlying collision:`
 * line and the diagnosis is display-safe. Keyed on the error OBJECT, never on
 * its code or text, so a provider message cannot claim it. The deploy engine
 * records such an error with `ownLines: true`, so `cdkd events` keeps its
 * lines apart (go-to-k/cdkd#4291; the rollback executor's own refusals use
 * `OWN_REMEDY_ERRORS` for the same purpose).
 */
const OWN_LINES_ERRORS = new WeakSet<Error>();

/** Register one of those refusals, and return it. */
export function markOwnLines<E extends Error>(error: E): E {
  OWN_LINES_ERRORS.add(error);
  return error;
}

/** Whether `error` is one of those refusals. */
export function hasOwnLines(error: unknown): boolean {
  return error instanceof Error && OWN_LINES_ERRORS.has(error);
}

/**
 * The AWS rejection text quoted in the collision refusal: sanitized, every
 * run of BLANK-RENDERING characters collapsed to one space, and capped (M8 and
 * M10 of the go-to-k/cdkd#3764 review). The refusal's labelled `To orphan it:`
 * line comes straight after this text, and `displaySafe` keeps runs of spaces
 * AND the invisible formatters (its header records them as a residual), so a
 * message padded with either could wrap on screen into a lookalike row
 * directly above the genuine one — the terminal-wrap route `plainIdent` closes
 * for a stack name. A blank-rendering character is matched by CATEGORY, not
 * by a list (the M10 follow-up measured a four-code-point list leaving about
 * forty blank columns): whitespace (`\s`), a default-ignorable code point
 * (`\p{Default_Ignorable_Code_Point}`: the zero-width and bidi marks,
 * U+2061-U+2064, U+061C, U+00AD, U+180E, U+034F, and the Hangul fillers
 * U+115F / U+1160 / U+3164 / U+FFA0, which render one column wide), a format
 * character (`\p{Cf}`, for the ones that are NOT default-ignorable, such as
 * the interlinear annotation anchors U+FFF9-U+FFFB), and U+2800, the braille
 * blank, which is in neither category. The class overlaps the one
 * `outputs-export-alias.ts` scans with, but is not the same. Collapsing
 * removes the padding; the cap is `displayAwsMessage`'s.
 */
export function collisionText(msg: string): string {
  // The caller MASKS `msg` first: `maskSecretsInText` matches a secret's exact
  // spelling, so collapsing a whitespace run or cutting the text before it ran
  // would turn an echoed secret into a spelling the mask no longer finds.
  return displayAwsMessage(
    displaySafe(msg).replace(/[\s\p{Cf}\p{Default_Ignorable_Code_Point}\u2800]{2,}/gu, ' ')
  );
}

/**
 * {@link collisionText} inside a JSON string boundary, for the refusals'
 * `Underlying collision:` line (go-to-k/cdkd#4214). That line carries no
 * command, but the provider's text can echo a payload logical id or name, and
 * printed bare a `$( )` or a `;` in it ran when the line was pasted. Inside
 * the boundary it is the classified display residual every `displayIdent`
 * render shares (go-to-k/cdkd#3950), and JSON escaping keeps an embedded `"`
 * from closing it.
 */
export function collisionLine(maskedMsg: string): string {
  return JSON.stringify(collisionText(maskedMsg));
}
