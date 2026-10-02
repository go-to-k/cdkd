/**
 * The key-space rules and user-facing messages for the stack-OUTPUTS bag, whose
 * keys come from TWO writers that must agree (issue
 * [#1919](https://github.com/go-to-k/cdkd/issues/1919)).
 *
 * `state.outputs` is keyed by output NAME, and an output carrying `Export:` is
 * additionally ALIASED under its export name in that same bag so a cross-stack
 * `Fn::ImportValue` finds it. Alongside it runs a parallel bag — the redaction
 * POSITION source (issue
 * [#1910](https://github.com/go-to-k/cdkd/issues/1910)) — holding each key's
 * UNRESOLVED template value. Whenever those two bags disagree about which
 * output owns a key, `redactByPath` positions a leaf by a source belonging to a
 * DIFFERENT output and persists that output's `{{resolve:...}}` reference as
 * this one's value. So the rules deciding key ownership live here, in one
 * place, because FOUR writers apply them: `DeployEngine.resolveOutputs` (both of
 * its bags), `cdkd scrub` (which reconstructs the same source bag from the
 * template to redact legacy state), and `analyzer/outputs-diff.ts`, which
 * PREVIEWS the very bag the deploy persists — a count that was wrong here for
 * two rounds, and the missing writer was the one whose divergence surfaces as a
 * phantom diff row on every run. Writers spelling the rule separately is
 * exactly how they drifted apart in the first place.
 *
 * The two writers do NOT share every rule, and the differences are deliberate —
 * each is documented at the rule it applies to. In short: the engine knows
 * which output it just resolved a value from and which outputs its conditions
 * suppressed; scrub knows neither, because its bag was written by an earlier
 * binary under conditions it can only re-evaluate best-effort.
 *
 * THE PARITY TABLE. "These writers agree" is this module's load-bearing claim,
 * and it was carried in review reports rather than in the code until a round
 * traded one divergence for two. Every row is pinned by a test on BOTH sides —
 * `deploy-engine-outputs-export-name-collision.test.ts` and
 * `analyzer/outputs-diff.test.ts` (the pinned SecureString row:
 * `analyzer/outputs-diff-ssm-export-name-4056.test.ts`) — because a row tested
 * on one side only is how the last divergence shipped. One row is NOT yet
 * pinned on the diff side: the unpinned-SecureString intrinsic row (the code
 * refuses: the skip pass keeps the token for any secure answer).
 *
 * | `Export.Name` shape                            | deploy            | diff              |
 * |------------------------------------------------|-------------------|-------------------|
 * | intrinsic, substitutes a secretsmanager ref    | refuse (exact)    | refuse (token)    |
 * | intrinsic, substitutes a PINNED SecureString   | refuse (exact)    | refuse (token)    |
 * | intrinsic, substitutes an unpinned SecureString| refuse (exact)    | refuse (token)    |
 * | LITERAL, spelled as a `{{resolve:...}}` token  | publish           | publish           |
 * | LITERAL, contains a recorded plaintext         | refuse            | decide from STATE |
 * | collides with a published output name          | refuse            | refuse            |
 * | holds a `NoEcho` parameter value               | refuse            | refuse            |
 *
 * The `NoEcho` row (issue [#4043](https://github.com/go-to-k/cdkd/issues/4043))
 * reads two corpora on both sides: the `noEchoParameterValueSeed` (`secret-scan.ts`) of
 * every `NoEcho` value the stack holds, and the outputs pass's LOG-ONLY
 * needles (an `Fn::Base64` encoding, an `Fn::Split` piece). The diff resolves
 * its outputs into bags of their OWN (`resolveTemplateOutputs`'
 * `outputsPass`), never the resource pass's, and decides each alias only
 * after every value and every name has resolved, the deploy's order. Pinned
 * by `export-name-noecho-refusal-4043.test.ts` and
 * `cli/diff-export-name-noecho-4043.test.ts`.
 *
 * The INTRINSIC SecureString rows no longer diverge (issue
 * [#4056](https://github.com/go-to-k/cdkd/issues/4056)): the diff refuses an
 * intrinsic alias whose RESOLVED name still carries a token of a service the
 * deploy resolves (`keepsSecretReferenceToken` in `outputs-diff.ts`), and its
 * `skipDynamicReferences` pass keeps a plain `{{resolve:ssm:...}}` token only
 * for a parameter the lookup finds secure, while a `String` one resolves to
 * its value. The deploy refuses both pinned and unpinned exactly: since issue
 * #1933 an unpinned value is re-resolved and recorded on every pass.
 *
 * A LITERAL name holding a plaintext is decided from STATE whenever the
 * deploy's pass records a secret: an output value spelling
 * `secretsmanager:` / `ssm-secure:`, or a resolved value or intrinsic name
 * keeping a secret token after the skip pass (a plain-`ssm` SecureString, or
 * a `secretsmanager` reference spelled only in a name; issue
 * [#4143](https://github.com/go-to-k/cdkd/issues/4143)), counting only a token
 * the template SPELLS in that output, since one arriving through a `Ref` to a
 * parameter is not recorded. Both sides read the whole pass: the deploy
 * decides every alias after every name has resolved (go-to-k/cdkd#4043).
 *
 * Residual, a reporting defect rather than a disclosure (the preview never
 * substitutes a plaintext):
 *
 * - A plain-`ssm` verdict cached process-wide by token text makes the diff
 *   refuse an alias the deploy publishes for a same-named `String` parameter
 *   in another region (issue
 *   [#4105](https://github.com/go-to-k/cdkd/issues/4105)).
 *
 * Two rows deserve their reason stated, because both look wrong in isolation:
 *
 * - A LITERAL name spelled as an expression is PUBLISHED, not refused. The
 *   deploy short-circuits a string `Export.Name` past the resolver, so nothing
 *   is substituted and the key holds the EXPRESSION — which is what state
 *   stores post-redaction anyway. Refusing it on the diff side alone produced a
 *   phantom REMOVE on every run.
 * - A LITERAL name in a stack that resolves a secret is decided by the DIFF from
 *   the STORED bag (issue [#1942](https://github.com/go-to-k/cdkd/issues/1942)).
 *   Deploy refuses such a name only when it CONTAINS a resolved plaintext, and
 *   the preview never substitutes one, so it cannot evaluate that predicate —
 *   but state holding the alias KEY proves a previous deploy already evaluated
 *   it and published, over the same literal name, so the preview publishes the
 *   same key with today's value. When the key is ABSENT (a first deploy of the
 *   alias or of the stack) there is no recorded verdict, so the diff falls back
 *   to suppressing its whole outputs delta and RECORDING the alias key as
 *   failed, which is this module's twin's existing answer to "cannot reproduce
 *   what deploy will do" and also avoids printing a plaintext-bearing key into
 *   CI logs. The `outputs-diff.ts` branch carries the two residuals (a rotation
 *   flipping deploy's verdict; a key stored by a pre-#1919 binary, which
 *   records no verdict).
 *
 * The message builders live in this family (`outputs-export-alias/warnings.ts`)
 * for the reason `src/provisioning/nested-stack-messages.ts` gives: a test that
 * pins behavior on a warning must not pin it on a hand-copied string, or a
 * reword silently makes the test vacuous.
 *
 * Unlike that module this family is NOT import-free — `secret-scan.ts` and
 * `warnings.ts` take `secret-redaction`, which is itself a documented leaf, so
 * no cycle is reachable through it.
 *
 * KNOWN RESIDUALS of the secret-bearing-name refusal, all of the same shape —
 * it can only see what the RESOLVER recorded — and all inherited rather than
 * introduced here:
 *
 * - (CLOSED by issue [#1933](https://github.com/go-to-k/cdkd/issues/1933),
 *   kept here because the reasoning is worth not re-deriving.) An `ssm`
 *   reference whose `Type` came back unclassifiable is still deliberately never
 *   pinned (issue [#1901](https://github.com/go-to-k/cdkd/issues/1901), so the
 *   next pass re-asks AWS rather than inheriting a transient verdict) — but its
 *   VALUE is no longer cached either, precisely so the two cannot disagree. A
 *   later occurrence therefore RE-RESOLVES and records into its own bag rather
 *   than substituting a plaintext with nothing recorded, so the refusal fires.
 * - A `NoEcho` PARAMETER's value in an export name is refused
 *   (go-to-k/cdkd#4043) by containment, whatever route put it there: the
 *   verdict is seeded with every `NoEcho` value the stack holds
 *   (`noEchoParameterValueSeed` (`secret-scan.ts`)), and every name is resolved before any
 *   alias is decided. These are still published: a value that is not this
 *   stack's (another stack's `NoEcho` value through `Fn::ImportValue`, or a
 *   hand-authored nested child's own); a DERIVED spelling (an `Fn::Split`
 *   piece, an `Fn::Base64` encoding) a resource or nested child computes and
 *   an attribute echoes into the name, since the seed holds raw spellings
 *   only; on a nested child, a parent `NoEcho` value that reached a child
 *   parameter without a `Ref` (an echoed `Fn::GetAtt`), which the deploy's
 *   inherited bag never records while `cdkd diff`'s corpus holds every parent
 *   value up front, so the preview refuses that alias (fail-closed) and the
 *   deploy publishes it; by containment alone, a 1-3 character
 *   value, or a 1-3 character `Fn::Split` piece of a value
 *   (go-to-k/cdkd#4049), embedded in a longer name, even one the resolver
 *   substituted into THIS name. A 4+ character piece is refused like the
 *   value. A failed output's alias the no-change merge carries forward is not
 *   re-decided either. `cdkd diff` previews exactly this verdict. Which phase
 *   closes each of these, or why one stays, is listed in section 5 of
 *   `docs/design/4043-noecho-persistence-redaction.md`.
 * - In the DEPLOY ENGINE, `evaluateConditions` runs before any bag is built and
 *   records into a map that caller discards, while still WARMING the resolver's
 *   dynamic-reference cache — so a PINNED reference (`secretsmanager`, or a
 *   definitive `SecureString`) first reached from a `Conditions` entry is
 *   invisible to every later bag. Narrowed by #1933: an UNPINNED ssm value is
 *   not cached, so it is no longer reachable this way, and a pinned one still
 *   carries its verdict on the cache entry — the residual is now only that the
 *   conditions pass's own recorded VALUES are discarded. Scoped to that ONE
 *   caller: `resolveParameters` routes through `resolveSSMParameter`, not
 *   `resolveDynamicReferences`, so it warms no cache (an earlier revision of
 *   this note claimed otherwise). The fix belongs on the resolver's cache-hit
 *   arm (i.e. with #1901's classification), not here. Named rather than closed.
 *
 *   **NOT true of `cdkd scrub`, and an earlier revision of this bullet said it
 *   was** (corrected with issue #2748). `scrub.ts` hands `evaluateConditions`
 *   its OUTPUTS bag deliberately, so there a condition's secret IS a redaction
 *   needle over outputs — over-redaction of state, which is scrub's purpose,
 *   not the cross-contamination this bullet warns about. Since #2748,
 *   `evaluateConditions` invents a PRIVATE map only when its caller brought
 *   none, so what must not leak is the map this function INVENTS; a caller's
 *   own bag stays that caller's choice.
 * - The refusal errs the other way for `Fn::Select` / `Fn::Split`, whose
 *   DISCARDED elements are still resolved: a secret in an unused element lands
 *   in the name's map and suppresses a working export. Fail-safe and warned, so
 *   it is documented rather than special-cased. (`Fn::If` resolves only the
 *   taken branch and has no such effect.)
 *
 * This module is a barrel: the implementation lives in `outputs-export-alias/*.ts`
 * (issue #4466), and it re-exports exactly the names it always exported,
 * so no importer changes.
 */
export {
  isOutputSuppressedByCondition,
  collectPublishedOutputNames,
  collectDeclaredOutputNames,
  isExportAliasCollision,
} from './outputs-export-alias/names.js';
export {
  exportNameSecretExposure,
  isNoEchoOnlyExposure,
  noEchoParameterValueSeed,
  isWholeDynamicReferenceValue,
} from './outputs-export-alias/secret-scan.js';
export {
  secretBearingExportNameWarning,
  type SecretSafeKeyDisplay,
  secretSafeKeyDisplay,
  secretBearing,
  WITHHELD_NAME_DISPLAY,
  displayTextOrWithheld,
  secretBearingStateKeyWarning,
  exportAliasCollisionWarning,
  exportAliasCollisionScrubWarning,
} from './outputs-export-alias/warnings.js';
