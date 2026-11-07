import type { SecretSafeKeyDisplay } from '../../deployment/outputs-export-alias.js';

/**
 * Kind of change for one key of the persisted Outputs bag.
 *
 * Deliberately NOT reusing `ChangeType` (CREATE / UPDATE / DELETE / NO_CHANGE):
 * that vocabulary belongs to resources, where a change implies an AWS API call
 * on a physical resource. An Outputs delta is a pure state / exports-index
 * write, so it gets its own words and never lands in the resource counts.
 */
export type OutputChangeType = 'ADD' | 'MODIFY' | 'REMOVE';

/** One key of the resolved Outputs bag that differs between state and template. */
export interface OutputChange {
  /**
   * The bag KEY, which is either a template `Outputs` logical name or an
   * `Export.Name` alias — see {@link resolveTemplateOutputs} for why both live
   * in one flat map.
   */
  name: string;
  changeType: OutputChangeType;
  /** Value in cdkd state. Absent for `ADD`. */
  oldValue?: unknown;
  /** Value the next deploy would persist. Absent for `REMOVE`. */
  newValue?: unknown;
  /**
   * True when `name` is an `Export.Name` the template publishes — the keys with
   * cross-stack blast radius, since a consumer's `Fn::ImportValue` resolves
   * against exactly these. Always false for a `REMOVE`: the removed key is gone
   * from the template, so there is no `Export.Name` left to match it against
   * (state records the flat bag only, not which key was an alias of which).
   */
  isExport: boolean;
  /**
   * True when {@link oldValue} was WITHHELD because it MAY be legacy secret
   * plaintext (see {@link computeOutputsDiff}). Renderers and the `--json`
   * projection must not emit the value when this is set.
   *
   * Deliberately ONE boolean covering both reasons the value can be withheld —
   * a record judged pre-GHSA (which includes one the no-change merge preview
   * cannot clear, because a value carried from state for a failed output, an
   * export alias included, is not a secret expression, issue #3101), and a
   * stored key today's template cannot account for (issue #1948). Every
   * consumer does the same thing with it (do not print the value), so a reason
   * code would add a `--json` field nothing branches on.
   * "MAY be": both are SUSPICIONS by construction, which is why the rendered
   * stand-in is worded as a possibility.
   */
  oldValueRedacted?: boolean;
  /**
   * How {@link name} may be SHOWN (issue
   * [#4015](https://github.com/go-to-k/cdkd/issues/4015)): the verdict
   * `secretSafeKeyDisplay` returned for this key against the corpus
   * {@link computeOutputsDiff} derived, so a renderer prints the verdict's own
   * text and never a separately sanitised copy of the key.
   *
   * Present only when the verdict is NOT `safe`. Absence loses nothing: the
   * corpus and the force-mask set only ever ADD exposures, and a `safe` text
   * depends on the key alone, so the no-corpus verdict a renderer computes for
   * a change without this field is the same `safe` display.
   */
  nameDisplay?: SecretSafeKeyDisplay;
}

/** Result of resolving a template's `Outputs` section for the diff. */
export interface ResolvedTemplateOutputs {
  /** The bag the next deploy would persist, in `StackState.outputs` shape. */
  outputs: Record<string, unknown>;
  /** Every `Export.Name` key present in {@link outputs}. */
  exportNames: Set<string>;
  /**
   * True when at least one output could not be fully resolved against current
   * state. The caller then reports NO outputs delta, EXCEPT on a stack whose
   * resource diff is empty, whose parameters bind and conditions evaluate, in
   * which no condition verdict can reach an output
   * ({@link templateLetsConditionsReachOutputs}; a condition gating only
   * resources does not count), and where every failure is one
   * {@link failuresMirrorDeploy} certifies: there the deploy
   * takes its NO-CHANGE branch and persists a merge (issue #2771), and
   * `computeStackDiff` previews that same merge (issue #3101). With a resource
   * change pending the failure usually means an output waiting on a resource
   * this deploy creates, which the preview cannot tell from one that will fail
   * again, so the section stays suppressed.
   * (Deploy's changed-resources branch has no gate at all, because by then
   * every resource exists.)
   */
  resolutionFailed: boolean;
  /**
   * The template output NAMES whose VALUE failed in a way the deploy engine's
   * `resolveOutputs` also records as a failure — the resolver threw, or it
   * returned `undefined` — so the deploy, without `--strict-getatt` (which
   * fails for either), keeps them in its bag as `undefined` and its no-change
   * merge treats them as failed keys (issue #3101).
   *
   * Output names only, unlike {@link failedKeys}, which also holds a failed
   * output's literal `Export.Name` alias: the merge derives the alias from the
   * template itself, and an alias key fed in as a failed OUTPUT would be
   * carried under the wrong rule.
   */
  failedOutputKeys: Set<string>;
  /**
   * True when every failure that set {@link resolutionFailed} is named in
   * {@link failedOutputKeys}, so previewing the deploy's no-change merge is
   * sound (issue #3101).
   *
   * False for the failures only this preview reports, and for the ones it
   * cannot name:
   * - a value that came back as a symbol, a surviving intrinsic, an
   *   unsubstituted `Fn::Sub` placeholder, or a container holding any of
   *   those — {@link isUnresolvedValue}'s arms wider than deploy's
   *   `v === undefined`. Such a value is not the deploy's failure signal, so
   *   it says nothing about what the deploy does with the key: it may write
   *   the value, lose it when the bag is serialized (a symbol), or throw where
   *   this best-effort pass kept a placeholder (a structural `Fn::Sub`
   *   failure). The merge would treat as carried a key whose outcome it
   *   cannot see;
   * - an `Export.Name` that did not resolve, or a literal one this preview
   *   cannot decide — the alias key is unknown, so no merge input can name it.
   *
   * Why the wider arms suppress rather than merge: a carried key renders no
   * row, so carrying a key the deploy actually rewrites or drops hides that
   * key's change, and the merged path's warning would not name it either (it
   * lists {@link failedOutputKeys} only), while the suppression omits the
   * section and warns whenever a difference remains beyond the failed outputs.
   */
  failuresMirrorDeploy: boolean;
  /**
   * The bag keys that FAILED to resolve, so they are absent from {@link outputs}
   * rather than present-with-a-bad-value.
   *
   * The deploy side, without `--strict-getatt`, keeps such a key with the
   * value `undefined`; dropping it instead means a naive diff reads it as a
   * REMOVE. Callers deciding whether a
   * suppressed delta is worth WARNING about must exclude these, or the common
   * "references a resource this deploy will create" case warns on every run.
   */
  failedKeys: Set<string>;
  /**
   * Bag keys whose RAW TEMPLATE value is a `{{resolve:...}}` dynamic reference —
   * i.e. keys the template PROVES are secret-bearing, independently of what
   * either side of the comparison currently holds.
   *
   * Collected for EVERY declared output including condition-skipped ones,
   * because a skipped output still appears on the stored side and would
   * otherwise print its value as a REMOVE row. See {@link computeOutputsDiff}.
   *
   * What it CANNOT cover — stated because an earlier revision of this comment
   * claimed the opposite, and a false coverage claim is what lets a reader
   * conclude the case is handled: an output DELETED from today's template
   * contributes nothing to this set, since the set is built from declarations
   * only. That case is answered by {@link declaredKeys} +
   * {@link templateHasSecretReference} instead (issue #1948).
   */
  secretSourceKeys: Set<string>;
  /**
   * Every bag key today's template can ACCOUNT FOR: each declared output name
   * plus each LITERAL `Export.Name`, over all declared outputs including
   * condition-skipped and unresolvable ones.
   *
   * A stored key that is in neither this set nor the resolved bag is one the
   * template no longer explains — a DELETED output. Whether its stored value is
   * pre-GHSA secret plaintext is undecidable from the stored bag alone (a
   * plaintext is just a string), so {@link computeOutputsDiff} withholds it
   * when the template proves the stack handles secrets at all. See issue #1948.
   *
   * An INTRINSIC `Export.Name` is deliberately absent: the alias it resolves to
   * is knowable only when resolution succeeded, and in that case the key is in
   * {@link outputs}, which the consumer checks first.
   *
   * When it does NOT resolve the key is simply unknown, and the arms that give
   * up on it do NOT all record it in {@link failedKeys} — the resolve-failure,
   * secret-spelling and collision arms each skip the alias without adding one.
   * (An earlier revision of this note claimed they did.) The consequence is
   * benign and worth stating rather than fixing: such a key is absent from
   * BOTH sets, so a stored copy of it is treated as unaccountable and has its
   * value withheld — the conservative side, and unreachable in the ordinary
   * case anyway because those arms also set `resolutionFailed`, which
   * suppresses the whole section.
   */
  declaredKeys: Set<string>;
  /**
   * True when ANY string ANYWHERE in the template is a secret-bearing dynamic
   * reference — `Resources` included, not just `Outputs`.
   *
   * This is the "does this stack handle secrets at all?" gate on the
   * deleted-output withholding (issue #1948). Without it, every stack that ever
   * deletes an output loses its REMOVE values; with it, only stacks whose
   * template still proves a secret reference do. The residual is the stack
   * whose ONLY secret reference WAS the deleted output — nothing in the stored
   * bag or in today's template can then tell its plaintext from an ordinary
   * string, and blanket withholding is worse than that gap.
   */
  templateHasSecretReference: boolean;
  /**
   * Each RESOLVED `Export.Name` that still carries a `{{resolve:...}}` token
   * after this resolver's `skipDynamicReferences` pass — a name the deploy
   * substitutes a secret into and refuses (issue #1919), spelled with the
   * `{{resolve:...}}` token where an older binary substituted the plaintext.
   * {@link secretSpanInStoredKey} reads them to find that plaintext in a stored
   * alias key (issue #4015).
   */
  secretBearingExportNames: string[];
  /**
   * Each RESOLVED `Export.Name` this pass refused for a `NoEcho` reason (the
   * positional twin or the `NoEcho` containment verdict, go-to-k/cdkd#4657).
   * The name holds the value, possibly under the containment floor, so a
   * stored alias row under it is shown withheld, never by name.
   */
  refusedNoEchoExportNames: string[];
  /**
   * True when ANY declared output, a condition-skipped one included, has an
   * intrinsic `Export.Name` that can read a `NoEcho` parameter (in a nested
   * child, one the parent fills from a `NoEcho` source) or a `NoEcho`
   * attribute, under ANY `Fn::If` verdict (go-to-k/cdkd#4723). An older binary
   * published that name
   * with the value and the verdicts of THEN, so a stored alias may spell a
   * value since rotated, or come from a branch today's verdict drops, which
   * neither {@link refusedNoEchoExportNames} nor the printing corpus (today's
   * value only) can match: {@link computeOutputsDiff} withholds the name of
   * every stored alias today's template cannot account for.
   */
  exportNameReadsNoEcho: boolean;
}
