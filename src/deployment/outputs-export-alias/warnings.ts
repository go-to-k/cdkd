import { displayIdent, displayStackName } from '../../utils/display-safe.js';
import { printingCorpusOf, type RecordedSecretValues } from '../secret-redaction.js';
import {
  secretScanHaystacks,
  canonicalNeedle,
  MIN_SECRET_NEEDLE,
  stateKeySecretExposure,
  secretsPresentIn,
  canonicalNeedles,
  maskEveryOccurrence,
  canonicalForSecretScan,
} from './secret-scan.js';

/**
 * Warning for an `Export.Name` that resolved to something containing secret
 * plaintext. Refused rather than published: the name would be a state KEY, and
 * keys are never redacted.
 *
 * The name is shown MASKED, and omitted entirely if masking somehow left it
 * unchanged. stderr is a reader like any other, so the invariant is absolute: a
 * message must never claim a masking it did not perform.
 *
 * `noEchoOnly` (go-to-k/cdkd#4043, from `isNoEchoOnlyExposure` (`secret-scan.ts`)) words
 * the reason for a name refused ONLY because it holds a `NoEcho` parameter's
 * value: the containment floor makes a coincidental match (`prod-VpcId`
 * beside a `NoEcho` value `prod`) a refusal too, and the operator has to be
 * able to tell that apart from a substituted secret.
 */
export function secretBearingExportNameWarning(
  outputKey: string,
  exportName: string,
  exposure: RecordedSecretValues,
  secrets?: RecordedSecretValues,
  noEchoOnly = false
): string {
  // `exposure` is the caller's AUTHORITATIVE set -- what resolution put into
  // THIS EXPORT NAME -- and is the force-mask input for the export name ONLY.
  // `secrets` is the containment corpus. Both are needed and neither
  // substitutes for the other (issue #2874): the authoritative set sees a
  // sub-floor or fragment substitution containment cannot, and containment
  // sees a second recorded secret the resolver did not put here but which this
  // name happens to hold.
  // A PRINTING corpus (go-to-k/cdkd#4049): a `NoEcho` parameter's value
  // embedded beside the secret is masked in this line too, and one that is
  // the refusal's own reason (go-to-k/cdkd#4043) arrives in `exposure`.
  const corpus = printingCorpusOf(secrets ?? exposure);
  const name = secretSafeKeyDisplay(exportName, corpus, exposure);
  const shown = name.kind === 'masked' ? `${maskedLabel(name.text)} ` : '';
  // THE OUTPUT KEY'S FORCE-MASK SET IS BOUNDED; the export name's is not, and
  // the asymmetry is the point. Resolution KNOWS it put `exposure` into the
  // export name, so masking it there at any length is right. It knows nothing
  // about the output key: a sub-floor value appearing in a template-authored
  // name is a coincidence in almost every case, and masking it threshold-free
  // SHREDS the identifier the operator has to act on -- measured, a
  // one-character substituted secret rendered `ApiGatewayEndpoint` as
  // `ApiG***tew***yEndpoint`.
  //
  // So the key's force-mask needles are filtered by the same whole-vs-embedded
  // rule `secretsPresentIn` applies. The residual is stated rather than
  // hidden: a genuinely sub-floor secret embedded in an output key is NOT
  // masked here, which is the identical tradeoff containment already makes.
  const ownerForceMask: RecordedSecretValues = new Map();
  const ownerHaystacks = secretScanHaystacks(outputKey);
  for (const [plaintext, expression] of exposure) {
    // The whole-value comparison is CANONICAL, over both haystacks, or the
    // filter implements part of the rule the sentence above names: a key
    // differing from its needle by one invisible character printed raw, and
    // one whose edge whitespace belongs to the needle printed the needle
    // minus that whitespace (issue #2890). No raw comparison beside it: equal
    // raw strings canonicalise equally, so it could never add a match.
    // Hard to reach through the engine, whose corpus is USUALLY a superset of
    // `exposure` so containment catches the case first -- but not provably so:
    // `recordedSecretValues` is optional on the context, and issue #2563 loses
    // a `nameSecrets` entry a still-pending `Fn::Join` part records. Driven
    // directly by a test rather than left to that argument.
    const needle = canonicalNeedle(plaintext);
    if (
      ownerHaystacks.some((haystack) => haystack === needle) ||
      plaintext.length >= MIN_SECRET_NEEDLE
    ) {
      ownerForceMask.set(plaintext, expression);
    }
  }
  const owner = displayTextOrWithheld(secretSafeKeyDisplay(outputKey, corpus, ownerForceMask));
  if (noEchoOnly) {
    return (
      `Output ${owner} has an Export.Name that resolves to a value containing a secret ` +
      `${shown}— skipping the export alias. ` +
      `The name contains the value of a NoEcho template parameter, or a value derived from ` +
      `one: the whole name at any length, or embedded at 4 or more characters, even where the ` +
      `match is a coincidence. An export name becomes a key in state.json and in the exports ` +
      `index, where the value would be stored in plaintext. An existing Fn::ImportValue of ` +
      `this name stops resolving. Rename the export, or choose a NoEcho value the name does ` +
      `not contain.`
    );
  }
  return (
    `Output ${owner} has an Export.Name that resolves to a value containing a secret ` +
    `${shown}— skipping the export alias. ` +
    `An export name becomes a key in state.json and in the exports index, and redaction rewrites ` +
    `VALUES only, so publishing it would persist the secret in plaintext. ` +
    `Use a non-secret Export.Name.`
  );
}

/**
 * Warning for an `Export.Name` intrinsic that READS a `NoEcho` parameter
 * (go-to-k/cdkd#4657, the positional twin of
 * {@link secretBearingExportNameWarning}'s `NoEcho` arm). Decided from the
 * template, so it holds at any value length, a 1-3 character value embedded
 * in a longer name included, where the containment scan has no floor to
 * stand on.
 *
 * Names the output and the PARAMETERS, never the resolved name: it holds the
 * value, and a sub-floor value cannot be masked out of it without shredding
 * the rest. The output key is masked against `secrets` as the sibling warning
 * masks it.
 */
export function noEchoParameterExportNameWarning(
  outputKey: string,
  parameterNames: readonly string[],
  secrets: RecordedSecretValues
): string {
  const owner = displayTextOrWithheld(secretSafeKeyDisplay(outputKey, printingCorpusOf(secrets)));
  const names = parameterNames.map((name) => displayIdent(name, { listMember: true })).join(', ');
  const noun = parameterNames.length === 1 ? 'parameter' : 'parameters';
  return (
    `Output ${owner} has an Export.Name that reads the NoEcho template ${noun} ${names} ` +
    `— skipping the export alias. An export name becomes a key in state.json and in the ` +
    `exports index, where the value would be stored in plaintext, so a name built from a ` +
    `NoEcho parameter is refused whatever the value's length. An existing Fn::ImportValue ` +
    `of this name stops resolving. Build the Export.Name without the NoEcho parameter.`
  );
}

/**
 * Warning for a no-change deploy that KEEPS the previous outputs whole while
 * they still publish an export alias today's export-name verdict refuses
 * (go-to-k/cdkd#4657). Names the OUTPUTS, masked against `secrets`, never the
 * alias, which holds the value.
 */
export function noEchoKeptAliasWarning(
  outputKeys: readonly string[],
  secrets: RecordedSecretValues
): string {
  const corpus = printingCorpusOf(secrets);
  const owners = outputKeys
    .map((key) => displayTextOrWithheld(secretSafeKeyDisplay(key, corpus)))
    .join(', ');
  return (
    `Keeping the previously persisted outputs whole, which still publish an export alias of ` +
    `output(s) ${owners} that holds a NoEcho parameter's value: today's Export.Name check ` +
    `refuses it, so the next deploy that resolves every output removes it from state.json ` +
    `and the exports index. Until then it stays published.`
  );
}

/**
 * How a state-bag KEY may be SHOWN, once it has been tested for secret content
 * (issue [#2667](https://github.com/go-to-k/cdkd/issues/2667)).
 *
 * An export name IS a key of `state.outputs` and of the exports index, and a
 * key holding secret plaintext is the residue `cdkd scrub` exists to report —
 * so any message naming one has to go through the same test the warnings below
 * apply, not through a control-character strip. `displaySafe` /
 * `stripControlChars` sanitise for a TERMINAL; neither masks a secret.
 *
 * Three outcomes, and the third is the one a caller must not collapse into the
 * first: masking can leave the text UNCHANGED (a recorded value that happens
 * to equal the mask itself, or one that canonicalises to empty beside a
 * force-mask needle the text lacks), and printing it then would publish the secret
 * under a label asserting it had been masked —
 * {@link secretBearingExportNameWarning}'s invariant, applied here.
 */
export type SecretSafeKeyDisplay =
  | { kind: 'safe'; text: string }
  | { kind: 'masked'; text: string }
  | { kind: 'withheld' };

/** The union of two exposures, or `undefined` when both are. */
function mergedExposure(
  a: RecordedSecretValues | undefined,
  b: RecordedSecretValues | undefined
): RecordedSecretValues | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return new Map([...a, ...b]);
}

/**
 * Test `key` for recorded secret plaintext and return how it may be shown.
 *
 * Reuses {@link stateKeySecretExposure} and the same `maskEveryOccurrence` the
 * warnings below use, rather than restating either: two spellings of "is this
 * key safe to print" would disagree on the boundary cases those two encode
 * (the whole-key match for a sub-floor needle, longest-needle-first masking).
 *
 * CANONICAL SPACE, not a composition of the two sanitisers. An earlier
 * revision of this comment described running `stripControlChars` and then
 * `displaySafe`, with a table of what each one touches and a note that the
 * ORDER was load-bearing. That composition WAS the defect (issue
 * [#2874](https://github.com/go-to-k/cdkd/issues/2874)): it leaves three
 * strings in play -- the raw key the verdict came from, the sanitised key that
 * was printed, and the masked one between them -- and `stripControlChars`
 * DELETES, so a plaintext split by one of its characters is absent from the
 * first and contiguous in the second. See `SECRET_SCAN_INVISIBLES` (`secret-scan.ts`) for
 * the class that replaced it and why it is derived rather than enumerated.
 */
export function secretSafeKeyDisplay(
  key: string,
  secrets: RecordedSecretValues,
  forceMask?: RecordedSecretValues
): SecretSafeKeyDisplay {
  // ONE STRING SPACE for the verdict, the masking and the returned text
  // (issue #2874). The bug this replaces was not a missing arm on the check --
  // it was the check, the mask and the print each running over a DIFFERENT
  // string.
  //
  // THE MASK RUNS OVER THE UNTRIMMED STRING and the printed text is its trim
  // (issue #2890). Masking the trimmed `shown` instead reopened #2874 one
  // level down: the verdict can come from the untrimmed haystack, and a
  // needle whose own edge whitespace the trim removed is absent from
  // `shown` -- so a key holding it at the edge AND mid-key masked the mid-key
  // copy and printed the edge copy minus its space, under a `masked` label.
  // For a key no needle touches at its edge the result is `shown` with the
  // same occurrences masked, so the printed shape is unchanged.
  const [shown, untrimmed] = secretScanHaystacks(key);

  // THE VERDICT COMES FROM CONTAINMENT ALONE. `secretsPresentIn` is handed the
  // RAW map, not pre-canonicalised needles, because its four-character floor
  // is keyed to the RECORDED length -- passing canonical needles would apply
  // the floor to the shortened form and drop a secret that only LOOKS
  // degenerate after its invisible characters are removed.
  //
  // The FORCE-MASK set is tested by containment too, and a hit JOINS the
  // exposure (#2889 review): its needles are masked only in the printed
  // space, so a force-mask value split by a nonspacing mark and absent from
  // `secrets` -- an owner key spelling `hunter` + U+09BC + `2pass` beside a
  // substituted `hunter2pass` -- was masked by nothing and printed `safe`.
  // As an exposure it ends `withheld` when masking cannot reach it. A
  // force-mask value simply ABSENT from the text is still no exposure, so
  // the innocent-output-key case below keeps printing.
  const exposure = mergedExposure(
    stateKeySecretExposure(key, secrets),
    forceMask === undefined ? undefined : secretsPresentIn(key, forceMask)
  );

  // The caller's AUTHORITATIVE exposure -- what resolution PUT in this name --
  // is force-masked and deliberately NOT part of the verdict above.
  // `secretsPresentIn` bounds an embedded match at MIN_SECRET_NEEDLE while
  // `maskEveryOccurrence` is threshold-free, so a sub-floor secret the
  // resolver knows it substituted is masked today and would stop being masked
  // if the mask set were recomputed by containment alone (measured). It is not
  // a VERDICT input because that signal is about what resolution DID, not
  // about what is textually here.
  const mask: RecordedSecretValues = canonicalNeedles(forceMask);
  for (const [plaintext, expression] of exposure ?? []) {
    const needle = canonicalNeedle(plaintext);
    if (needle.length > 0) mask.set(needle, expression);
  }
  if (mask.size === 0) return { kind: 'safe', text: shown };

  const masked = maskEveryOccurrence(untrimmed, mask);
  if (masked === untrimmed) {
    // NOTHING CHANGED, and which answer that deserves depends on WHY.
    //
    // With an exposure, a needle really is in this text and masking failed to
    // remove it, so the name is withheld -- fail closed. Every verdict arm with
    // a non-empty needle puts it in `untrimmed` (see `secretScanHaystacks`)
    // EXCEPT the detection arm, so what reaches here is a recorded value equal
    // to the mask itself, an exposure whose needle canonicalised to empty
    // beside an absent force-mask needle, or a secret found only in detection
    // space -- split by a nonspacing mark (issue #2889) or spelled in
    // compatibility characters (issue #4001) -- masking in the printed space
    // cannot reach it, and the name keeps its own characters, so it is
    // withheld rather than printed. With NO exposure the
    // only needles were force-mask ones that are simply absent from the text,
    // which is the ordinary case for the OUTPUT KEY beside a secret-bearing
    // export name: collapsing that into `withheld` withheld an innocent name
    // on the DEFAULT deploy path and printed a placeholder asserting the name
    // "contains a secret", which was false (measured against `main`).
    //
    // `safe` HERE DOES NOT MEAN "containment cleared it". A recorded secret
    // below MIN_SECRET_NEEDLE that is genuinely embedded in this text is not
    // an exposure and is not masked -- the same documented tradeoff that lets
    // it through when the mask set is empty. Named so the next reader does not
    // take this arm for a stronger claim than it makes.
    return exposure ? { kind: 'withheld' } : { kind: 'safe', text: shown };
  }
  // FAIL CLOSED. Masking is a substring replacement, so a name holding the
  // same secret twice -- once contiguous, once split -- used to mask the first
  // occurrence and print the second. In canonical space that cannot happen,
  // and this re-test is what PROVES it rather than asserting it: any needle
  // still present after masking withholds the whole name. It reads the masked
  // UNTRIMMED string, so its trimmed haystack is exactly the text returned
  // below -- the re-test and the print are one string. It also runs the
  // DETECTION arm (issues #2889, #4001), so a second copy split by a
  // nonspacing mark or spelled full-width withholds the name rather than
  // surviving the canonical-space mask.
  if (
    stateKeySecretExposure(masked, secrets) ||
    (forceMask !== undefined && secretsPresentIn(masked, forceMask))
  ) {
    return { kind: 'withheld' };
  }
  return { kind: 'masked', text: canonicalForSecretScan(masked) };
}

/**
 * The display for a name plus the verdict its CALLER needs, as one value.
 *
 * Exists so a caller cannot take the verdict from one call and the text from
 * another — the shape of the bug in {@link secretSafeKeyDisplay}'s own callers
 * (issue #2874), one level up.
 */
export function secretBearing(
  display: SecretSafeKeyDisplay
): display is Exclude<SecretSafeKeyDisplay, { kind: 'safe' }> {
  // A TYPE PREDICATE, so a caller that guards on it can hand the SAME display
  // to {@link secretBearingStateKeyWarning}, whose parameter excludes `safe`.
  // That is what makes "the verdict and the printed text came from one call"
  // a compile-time property at the call site rather than a convention.
  return display.kind !== 'safe';
}

/**
 * What a message prints in place of a name it may not show.
 *
 * Deliberately not name-shaped and never quoted as if it were a key: a reader
 * has to be able to tell this is the tool declining, not an odd export name.
 */
export const WITHHELD_NAME_DISPLAY = '<name withheld: contains a secret>';

/** The text of a display, or {@link WITHHELD_NAME_DISPLAY} when there is none. */
export function displayTextOrWithheld(display: SecretSafeKeyDisplay): string {
  return display.kind === 'withheld' ? WITHHELD_NAME_DISPLAY : display.text;
}

/**
 * The `(masked: ...)` label for a secret-bearing key the verdict already
 * masked, BOUNDED (go-to-k/cdkd#3617): both names are template- or
 * state-chosen, and inside hand-written quotes a `"` in the key closed them and
 * wrote a clause of its own.
 *
 * WITHHELD rather than bounded when the masked text carries anything
 * non-ASCII. `displayIdent` blanks such a character to a space AFTER the
 * verdict's own re-test, so the printed text would no longer be the tested
 * text -- `correct<NBSP>horse` beside a recorded `correct horse` would print
 * the secret byte for byte. Withholding keeps one string tested and printed,
 * the rule #2874 set for this family (its regex is in `secret-scan.ts`).
 */
function maskedLabel(maskedText: string): string {
  return /[^ -~]/.test(maskedText)
    ? '(masked, name withheld: it carries characters this line cannot show as tested)'
    : `(masked: ${displayIdent(maskedText)})`;
}

/**
 * Warning for a state KEY that already holds secret plaintext — the residue an
 * EARLIER binary left when it published an export name that resolved to one.
 *
 * `cdkd scrub` cannot repair this. Every redaction pass rewrites VALUES; a key
 * is the export's identity, so renaming it here would silently retire an export
 * consumers resolve by name, and dropping it would delete a live export. The
 * remedy is in the template: give the output a non-secret `Export.Name` and
 * redeploy, which rewrites `state.outputs` wholesale and republishes the index.
 * Reported so the `--dry-run --fail` CI gate stops calling such a state clean.
 */
export function secretBearingStateKeyWarning(
  stackName: string,
  display: Exclude<SecretSafeKeyDisplay, { kind: 'safe' }>
): string {
  // TAKES THE DISPLAY, NOT THE KEY. The caller has already computed it to
  // decide whether to warn at all, so recomputing here would be a second
  // chance for the verdict and the printed text to disagree -- the exact shape
  // of issue #2874, one level up. The `safe` arm is excluded by the TYPE
  // rather than handled: a safe display reaching this builder is a caller bug,
  // and the previous revision's three-arm version rendered
  // `holds an output KEY that renders a secret (key: "...")` for a key with no
  // recorded secret at all.
  //
  // BOUNDED AFTER MASKING (go-to-k/cdkd#3617): see {@link maskedLabel}.
  const clause =
    display.kind === 'masked'
      ? `${maskedLabel(display.text)} `
      : `(the name is withheld: masking it would leave the secret readable) `;
  // "RENDERS a secret", not "containing a secret": for a key split by an
  // invisible character the key does not literally CONTAIN the plaintext --
  // its rendering reconstitutes it, which is the whole reason this class was
  // invisible to the previous check. A message that overstates what it found
  // is how the previous wording survived being wrong.
  return (
    `State for ${displayStackName(canonicalForSecretScan(stackName))} holds an output KEY that renders a secret ` +
    `${clause}— cdkd scrub cannot rewrite a key, ` +
    `only a value, because the key IS the export name consumers resolve by. ` +
    `Give that output a non-secret Export.Name and redeploy: the next deploy replaces ` +
    `state.outputs and the exports index entirely. ROTATE the exposed secret.`
  );
}

/**
 * Warning for an `Export.Name` colliding with an output NAME it does not own.
 *
 * Names both outputs because the two are equally likely to be the mistake, and
 * says which value survives — the export is skipped, so the key keeps the
 * output's own value.
 *
 * MASKED HERE, and the bound that used to excuse it is named rather than
 * relied on. This message prints a name that MATCHED a declared output name --
 * template text -- and a secret-bearing `Export.Name` is refused by
 * {@link secretBearingExportNameWarning} upstream. But that is SOMEBODY ELSE'S
 * VERDICT, and this site is reached from exactly the arm taken when it MISSED:
 * before issue [#2874](https://github.com/go-to-k/cdkd/issues/2874)
 * canonicalised the containment scan, it missed for eight of ten invisible
 * characters, and this message printed the plaintext verbatim.
 */
export function exportAliasCollisionWarning(
  outputKey: string,
  exportName: string,
  secrets: RecordedSecretValues
): string {
  // THE FOURTH SITE, and the one issue #2874's own grep could not see: it
  // composes `stripControlChars` with NOTHING, so a search for the composed
  // shape missed it while the hazard is identical. `stripControlChars`
  // DELETES, so a recorded plaintext split by one of its characters is
  // reconstituted into this message.
  //
  // Its doc above argues the exposure is bounded because
  // `secretBearingExportNameWarning` refuses a secret-bearing name upstream.
  // That bound is REAL but it is somebody else's verdict, and this site is
  // reached from exactly the `else if` arm taken when that verdict MISSED --
  // which, before #2874 canonicalised the containment scan, it did for eight
  // of ten invisible characters. Measured leaking the plaintext verbatim.
  //
  // So the name is tested HERE too, and `secrets` is REQUIRED rather than
  // optional. An optional corpus was written first and measured printing the
  // plaintext when omitted -- the same foot-gun `exportAliasCollisionScrubWarning`
  // avoids by requiring its own. BOTH names go through the test: `outputKey`
  // is template-controlled and printed three times in this message.
  //
  // The PRINTING corpus (go-to-k/cdkd#4049): the map's entries plus the
  // pass's LOG-ONLY needles, so an `Export.Name` built from a `NoEcho`
  // parameter's value is masked here. The refusal upstream reads those needles
  // too (go-to-k/cdkd#4043), but by containment at the 4-character floor, so
  // a name it published can still embed a 1-3 character value.
  const corpus = printingCorpusOf(secrets);
  const shown = displayTextOrWithheld(secretSafeKeyDisplay(exportName, corpus));
  const from = displayTextOrWithheld(secretSafeKeyDisplay(outputKey, corpus));
  return (
    `Output ${from} exports as "${shown}", which is also the name of another output in this stack — ` +
    `skipping the export alias, so output ${shown} keeps its own value and the export is not published. ` +
    `A consumer's Fn::ImportValue on "${shown}" therefore resolves to output ${shown}, NOT to ${from} ` +
    `(CloudFormation would publish both). Rename the export, or the colliding output.`
  );
}

/**
 * Warning for the same collision seen by `cdkd scrub`, whose remedy differs.
 *
 * Scrub does not resolve outputs — it redacts state written by an EARLIER
 * binary, where the alias may have won the colliding key — so it cannot claim
 * the key belongs to either output. It drops the position source for that key
 * and lets the value scan decide from the plaintext actually stored, which is
 * why this message promises something weaker than the deploy-time one. It can
 * also fire on a template the deploy handled cleanly, per
 * `collectDeclaredOutputNames` (`names.ts`).
 */
export function exportAliasCollisionScrubWarning(
  outputKey: string,
  exportName: string,
  secrets: RecordedSecretValues
): string {
  // A BELT, stated as one rather than as a hazard this mask is known to close
  // (issue #1958 item 9). What actually bounds the exposure is the COLLISION
  // TEST upstream, not this call: {@link scrubStack} warns only for a name that
  // matched a DECLARED output name, and `collectDeclaredOutputNames` (`names.ts`) is
  // `Object.keys(template.Outputs)` — so the string printed here is always one
  // the template itself spells, however the `Export.Name` intrinsic resolved.
  //
  // That leaves the mask REACHABLE but narrow, and the shape is worth naming
  // because it is not the one the argument was originally justified by: it
  // takes a template that NAMES an output with the secret plaintext, which the
  // `MASKS a resolved name that carries plaintext` case in
  // `scrub-export-name-collision.test.ts` builds. The mask still earns its keep
  // there — the template is not stderr, and not a CI log.
  //
  // The argument stays REQUIRED for a reason about scrub rather than about this
  // string. The deploy twin has the bound STRUCTURALLY:
  // {@link secretBearingExportNameWarning} refuses a secret-bearing
  // `Export.Name` before the collision path can see it, which is why
  // {@link exportAliasCollisionWarning} takes no map at all. Scrub publishes no
  // alias, so it runs no such refusal and its bound rests on the collision test
  // alone — one predicate away from a future caller that widens the set of
  // names reaching here.
  //
  // BOTH names are masked, not just the exported one (issue #1958 review). They
  // come from the same place: the collision fired because `exportName` matched a
  // DECLARED output name, so `outputKey` is a declared output name too, and the
  // reachable shape above — a template that NAMES an output with the plaintext —
  // puts the plaintext on whichever of the two is that output. Masking one and
  // printing its neighbour raw is the mask-one-argument-leave-its-neighbour
  // shape issue #2176 found in the providers, one line apart instead of two
  // files.
  // THIS SITE PRINTS EVEN WHEN THE VERDICT MISSES, which is what made it the
  // worst of the three (issue #2874): the other two sit behind a caller that
  // skips the message entirely, so a missed verdict there is a detection gap;
  // here it was a disclosure, and it needed only ONE recorded secret split by
  // an invisible character rather than two. Routing through
  // `secretSafeKeyDisplay` keeps the print-always behaviour — the collision
  // and its remedy are actionable whether or not a name can be shown — while
  // making the printed text and the verdict the same string.
  // The PRINTING corpus, as in {@link exportAliasCollisionWarning}
  // (go-to-k/cdkd#4049): this message only prints, so the log-only needles of
  // scrub's bag take part; its secret-bearing KEY scan does not use this.
  const corpus = printingCorpusOf(secrets);
  const nameDisplay = (name: string): SecretSafeKeyDisplay => secretSafeKeyDisplay(name, corpus);
  const exportDisplay = nameDisplay(exportName);
  const shown = displayTextOrWithheld(exportDisplay);
  // The `stored value under "..."` clause loses its referent when the name is
  // withheld, so it is REWORDED rather than left quoting a placeholder as if
  // it were a key. The pair is still identified: the sibling name and the
  // stack name reach the operator through the rest of the message.
  const storedUnder =
    exportDisplay.kind === 'withheld'
      ? 'the stored value under that name'
      : `the stored value under "${shown}"`;
  // WHEN BOTH NAMES WITHHOLD the two placeholders are identical, and the
  // sentence then reads as a name colliding with ITSELF. Distinguish them:
  // the reader cannot act on either name, but must still be able to tell that
  // there are two.
  const ownerDisplay = nameDisplay(outputKey);
  const owner =
    ownerDisplay.kind === 'withheld' && exportDisplay.kind === 'withheld'
      ? '<the owning output, name withheld: contains a secret>'
      : displayTextOrWithheld(ownerDisplay);
  return (
    `Output ${owner} exports as ${
      exportDisplay.kind === 'withheld' ? shown : `"${shown}"`
    }, which is also the name of another output in this stack — ` +
    `state cannot say which of the two ${storedUnder} came from, so that key is ` +
    `redacted by value match instead of by template position, and two references resolving to the same ` +
    `value could still collapse there. Rename the export, or the colliding output, and redeploy.`
  );
}
