/**
 * A drift readback list in the order the template declares its members
 * (go-to-k/cdkd#6754 - #6757).
 *
 * Each declared key takes the first live entry with that key not taken yet, in
 * declared order (so a repeated key, an Availability Zone two cache nodes
 * share, takes two entries); every live entry no declared key took follows, in
 * the order AWS returned it. A declared key no live entry has is skipped: the
 * list is then shorter, or holds another entry, and differs from the declared
 * one.
 *
 * Why not sort: the drift compare reads a list by position, and a sort inside
 * the readback runs on one side only, so a `properties` baseline in template
 * order would differ from it (`.claude/rules/layout-drift.md`). Taking the
 * declared order instead makes a live list holding exactly the declared
 * members equal to the template, and a deploy-time capture taken through this
 * same readback equal to a later read of an unchanged resource.
 */
export function inDeclaredOrder<T>(
  live: readonly T[],
  keyOf: (entry: T) => string | undefined,
  declaredKeys: readonly unknown[] | undefined
): T[] {
  if (declaredKeys === undefined) return [...live];
  const taken = new Set<number>();
  const out: T[] = [];
  for (const key of declaredKeys) {
    if (typeof key !== 'string') continue;
    const index = live.findIndex((entry, i) => !taken.has(i) && keyOf(entry) === key);
    if (index < 0) continue;
    taken.add(index);
    out.push(live[index]!);
  }
  live.forEach((entry, i) => {
    if (!taken.has(i)) out.push(entry);
  });
  return out;
}
