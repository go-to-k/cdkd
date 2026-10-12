/**
 * Whether a template parameter's `NoEcho` declares it sensitive
 * (go-to-k/cdkd#4824). CloudFormation accepts the boolean and the string form
 * (`"true"`, as a hand-written or included template spells it, in any case),
 * so every reader of the flag asks here: a reader testing `=== true` alone
 * prints, records or publishes a string-declared value as if it were public.
 * An import-free leaf, so the analyzer, the resolver and the commands can all
 * share it.
 */
export function isNoEchoDeclared(noEcho: unknown): boolean {
  return noEcho === true || (typeof noEcho === 'string' && noEcho.toLowerCase() === 'true');
}

/** {@link isNoEchoDeclared} of a parameter definition's `NoEcho`, whatever its shape. */
export function declaresNoEcho(definition: unknown): boolean {
  return (
    definition !== null &&
    typeof definition === 'object' &&
    isNoEchoDeclared((definition as { NoEcho?: unknown }).NoEcho)
  );
}
