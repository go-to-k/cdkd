import { dynamicReferenceTokens } from '../../../deployment/secret-redaction.js';
import { canonicalizeRegion } from '../../../utils/aws-partition.js';
import type { StateImportEntry, StateOutputReadEntry } from '../../../types/state.js';
import { escapeRegExp } from '../../../utils/regexp.js';

/** What one stack's cross-stack pre-pass recorded that is not a refusal. */
export interface CrossStackPrePassFindings {
  /**
   * References cdkd DECLINED to resolve BY DESIGN (issue #2133 review) — today
   * only the cross-account `Fn::GetStackOutput` of a redacted value, which
   * `resolveGetStackOutput` refuses so a producer account's secret is never
   * looked up with the consumer's credentials. Reported as a FINDING rather
   * than a stack refusal: see {@link makeCrossStackPrePass}.
   */
  unverifiable: string[];
  /**
   * The SUBSET of {@link unverifiable} caused by a PRODUCER record whose own
   * `outputs` map could not be read (go-to-k/cdkd#3192 review).
   *
   * A separate list because the two halves of `unverifiable` earn DIFFERENT
   * EXIT CODES, and folding them lost one. A by-design refusal is a FINDING:
   * exit 1, and only under `--fail`, per issue #2133. A damaged producer
   * record exited **2 unconditionally** before this class was guarded — the
   * array shape through `plaintextProducerCrossStackReadError`, the string
   * shape through an escaping `TypeError` — because it means "cdkd could not
   * finish", not "cdkd looked and found something". Counting it only in
   * `unverifiable` made a plain `cdkd scrub` exit 0 over a consumer record
   * still holding the imported plaintext, and made even the `--fail` path exit
   * 1, which `docs/cli-reference.md` teaches as the opposite remedy.
   */
  damagedProducerRecords: string[];
  /**
   * Every cross-stack read today's template PERFORMED this run, as the
   * resolver recorded it (plaintext names), with whether its position can
   * refuse (go-to-k/cdkd#3382). Read by {@link findUnrepairedCrossStackReadNames}.
   */
  performedReads: PerformedCrossStackReads;
}

/**
 * The cross-stack reads one stack's template performed during this scrub.
 * `canRefuse: false` marks a position the deploy may never have read from (a
 * condition-suppressed output, a malformed `Fn::If`): such a read still counts
 * as REPRODUCING a stored entry, but is never the secret-bearing read a stored
 * entry is flagged against, for the reason a finding is never recorded there.
 */
export interface PerformedCrossStackReads {
  imports: Array<{ entry: StateImportEntry; canRefuse: boolean }>;
  outputReads: Array<{ entry: StateOutputReadEntry; canRefuse: boolean }>;
}

/** A stored cross-stack read entry {@link findUnrepairedCrossStackReadNames} flagged. */
export interface UnrepairedCrossStackReadName {
  list: 'imports' | 'outputReads';
  index: number;
  /** The entry as stored. Its names may hold a secret this run cannot mask: never print them. */
  entry: StateImportEntry | StateOutputReadEntry;
}

/**
 * How a stored name relates to the REDACTED spelling of a name today's
 * template produced, with every `{{resolve:...}}` token standing for a
 * non-empty run of characters: `wildcard` when the stored name matches and at
 * least one token position holds TEXT rather than a whole token; `equal` when
 * it is that spelling exactly; `no` otherwise.
 */
/** The text between (and around) `tokens`, which are `value`'s own tokens in order. */
function literalParts(value: string, tokens: readonly string[]): string[] {
  const parts: string[] = [];
  let cursor = 0;
  for (const token of tokens) {
    const at = value.indexOf(token, cursor);
    parts.push(value.slice(cursor, at));
    cursor = at + token.length;
  }
  parts.push(value.slice(cursor));
  return parts;
}

function crossStackNameFit(stored: unknown, currentRedacted: string): 'equal' | 'wildcard' | 'no' {
  if (typeof stored !== 'string') return 'no';
  const tokens = dynamicReferenceTokens(currentRedacted);
  if (tokens.length === 0) return stored === currentRedacted ? 'equal' : 'no';
  // A stored name made of today's literal parts and WHOLE tokens holds no
  // text, whatever tokens they are. Decided before the regex, whose greedy
  // groups can split a token that contains a literal separator (a secret id
  // with `-`) and read half of it as text.
  const storedTokens = dynamicReferenceTokens(stored);
  if (
    storedTokens.length === tokens.length &&
    literalParts(stored, storedTokens).join('\u0000') ===
      literalParts(currentRedacted, tokens).join('\u0000')
  ) {
    return storedTokens.every((t, i) => t === tokens[i]) ? 'equal' : 'no';
  }
  let pattern = '^';
  let cursor = 0;
  for (const token of tokens) {
    // `dynamicReferenceTokens` returns the matches in order and without
    // overlap, so the first occurrence at or after the cursor IS that match.
    const at = currentRedacted.indexOf(token, cursor);
    pattern += `${escapeRegExp(currentRedacted.slice(cursor, at))}([\\s\\S]+)`;
    cursor = at + token.length;
  }
  pattern += `${escapeRegExp(currentRedacted.slice(cursor))}$`;
  const match = new RegExp(pattern).exec(stored);
  if (!match) return 'no';
  // A position the stored name fills with a whole `{{resolve:...}}` token is
  // REPAIRED; one filled with anything else still holds text. Refusing every
  // stored name that carries a token missed a name built from two secrets with
  // only one of them rotated: the walk repairs the current one, and the old
  // value beside it survived as clean.
  const filled = match.slice(1).map((f) => f ?? '');
  const holdsText = filled.some((f) => {
    const inner = dynamicReferenceTokens(f);
    return !(inner.length === 1 && inner[0] === f);
  });
  // Every position holding one whole token is the all-token shape the check
  // above already decided, so this arm answers only for a name it did not.
  return holdsText ? 'wildcard' : 'no';
}

/**
 * The stored cross-stack read entries that still hold a plaintext this run
 * could not repair because the secret behind it has ROTATED (go-to-k/cdkd#3382).
 *
 * Scrub's needles are the secret's CURRENT value, so a name stored while the
 * secret held an earlier value matches none of them and the repair walk leaves
 * it alone. Nothing in the record says the name was secret-bearing, so the
 * verdict is taken from today's template instead. An entry is flagged when ALL
 * of these hold:
 *
 * - no read today's template performed REPRODUCES it (same identity key the
 *   deploy's union uses, on the redacted spelling). This is what keeps an
 *   ordinary import green even when it shares a producer — and even a name
 *   shape — with a secret-bearing one: this run re-read it and it matched;
 * - a read today's template performed from a position that can refuse has a
 *   name that carries a secret (its redacted spelling holds a token), reads
 *   the same producer (`imports[].sourceStack`, which is never redacted) in
 *   the same region;
 * - the stored entry FITS that read's name: every literal part equal, every
 *   token position filled by a non-empty run, and at least one position
 *   holding text rather than a whole token (a name built from two secrets with
 *   one rotated keeps its old half as text after the walk repairs the other).
 *   Every other field must equal the read's spelling.
 *
 * Residual, in the over-reporting direction: a stale entry left by a REMOVED
 * ordinary reference to the same producer whose name happens to fit a
 * secret-bearing read's shape is flagged too. Stale entries survive only a
 * deploy that changed nothing or failed — a deploy that updates the stack
 * replaces both lists — so that needs a removed read, no successful change
 * since, and a coincident shape. Reads made while evaluating `Conditions`
 * count as reproducing (the deploy records them too) but are never flagged
 * against, since the pre-pass does not walk conditions.
 *
 * `stored` is the POST-repair list, so an entry this run just rewrote carries
 * its token and is never flagged. `redact` is the same function the repair
 * walk used, so a performed read's spelling and a repaired stored one agree.
 */
export function findUnrepairedCrossStackReadNames(
  stored: {
    imports?: readonly StateImportEntry[] | undefined;
    outputReads?: readonly StateOutputReadEntry[] | undefined;
  },
  performed: PerformedCrossStackReads,
  redact: (name: string) => string
): UnrepairedCrossStackReadName[] {
  const found: UnrepairedCrossStackReadName[] = [];
  const region = (r: unknown): string => canonicalizeRegion(String(r));

  const currentImports = performed.imports.map(({ entry, canRefuse }) => ({
    sourceStack: entry.sourceStack,
    sourceRegion: region(entry.sourceRegion),
    exportName: redact(entry.exportName),
    canRefuse,
  }));
  // `JSON.stringify` of a tuple rather than a separator join: injective for
  // any field content (`src/state/record-keys.ts` explains why that matters).
  const importKey = (e: {
    sourceStack: unknown;
    sourceRegion: unknown;
    exportName: unknown;
  }): string => JSON.stringify([e.sourceStack, region(e.sourceRegion), e.exportName]);
  const reproducedImports = new Set(currentImports.map(importKey));
  const secretImports = currentImports.filter(
    (c) => c.canRefuse && dynamicReferenceTokens(c.exportName).length > 0
  );
  (stored.imports ?? []).forEach((entry, index) => {
    if (reproducedImports.has(importKey(entry))) return;
    const flagged = secretImports.some(
      (c) =>
        c.sourceStack === entry.sourceStack &&
        c.sourceRegion === region(entry.sourceRegion) &&
        crossStackNameFit(entry.exportName, c.exportName) === 'wildcard'
    );
    if (flagged) found.push({ list: 'imports', index, entry });
  });

  const currentOutputReads = performed.outputReads.map(({ entry, canRefuse }) => ({
    sourceStack: redact(entry.sourceStack),
    sourceRegion: region(entry.sourceRegion),
    outputName: redact(entry.outputName),
    canRefuse,
  }));
  const outputReadKey = (e: {
    sourceStack: unknown;
    sourceRegion: unknown;
    outputName: unknown;
  }): string => JSON.stringify([e.sourceStack, region(e.sourceRegion), e.outputName]);
  const reproducedOutputReads = new Set(currentOutputReads.map(outputReadKey));
  const secretOutputReads = currentOutputReads.filter(
    (c) =>
      c.canRefuse &&
      (dynamicReferenceTokens(c.sourceStack).length > 0 ||
        dynamicReferenceTokens(c.outputName).length > 0)
  );
  (stored.outputReads ?? []).forEach((entry, index) => {
    if (reproducedOutputReads.has(outputReadKey(entry))) return;
    const flagged = secretOutputReads.some((c) => {
      if (c.sourceRegion !== region(entry.sourceRegion)) return false;
      const fits = [
        crossStackNameFit(entry.sourceStack, c.sourceStack),
        crossStackNameFit(entry.outputName, c.outputName),
      ];
      return !fits.includes('no') && fits.includes('wildcard');
    });
    if (flagged) found.push({ list: 'outputReads', index, entry });
  });
  return found;
}
