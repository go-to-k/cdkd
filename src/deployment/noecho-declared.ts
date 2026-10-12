/**
 * Whether a template parameter's `NoEcho` declares it sensitive
 * (go-to-k/cdkd#4824). CloudFormation accepts the boolean and the string
 * `"true"` (as a hand-written or included template spells it), so every reader
 * of the flag asks here: a reader testing `=== true` alone prints, records or
 * publishes a string-declared value as if it were public.
 *
 * EXACTLY these two spellings, the ones the schema-v11 positional persist arm
 * (`noEchoParameterNamesOf`) has honoured since it shipped. A wider rule (a
 * case-folded `"True"`) must not reach the arms that persist or compare: a
 * record those arms never marked would then hold plaintext where today's
 * template asks for `***`, and the comparison reads that as a change, a
 * create-only REPLACEMENT included. An import-free leaf, so the analyzer, the
 * resolver and the commands can all share it.
 */
export function isNoEchoDeclared(noEcho: unknown): boolean {
  return noEcho === true || noEcho === 'true';
}

/** {@link isNoEchoDeclared} of a parameter definition's `NoEcho`, whatever its shape. */
export function declaresNoEcho(definition: unknown): boolean {
  return (
    definition !== null &&
    typeof definition === 'object' &&
    isNoEchoDeclared((definition as { NoEcho?: unknown }).NoEcho)
  );
}
