/**
 * Pasteable-command SHAPE critic (issue
 * [#3436](https://github.com/go-to-k/cdkd/issues/3436)).
 *
 * WHAT THIS CHECKS
 * ----------------
 * A `cdkd ...` command cdkd tells an operator to PASTE is a shell-injection
 * surface when it is printed inside a prose `'...'` span, because the operator
 * selects the span WITH its quotes. go-to-k/cdkd#3363 measured it: a value
 * carrying `'` inverts the wrapper, and
 * `'cdkd state orphan S --state-bucket 'b; printf X; #''` ran `printf X`. The
 * maintainer reproduced it over 324 arms.
 *
 * go-to-k/cdkd#3499 gave the repo `pasteableCommand`, which gates each value
 * and prints the command LAST and UNWRAPPED on a labelled line. That closed the
 * sites it converted. It does NOT stop the next one being written, and a
 * per-predicate grep cannot find them all — measured on go-to-k/cdkd#3436's
 * record, where `gc.ts` builds a real pasteable `cdkd state show` behind its
 * own gate and is returned by NEITHER of that record's two greps: no
 * `pasteableCommand` call, and no ` with: ` label. **A fence keys on the SHAPE
 * and does not need to know what anyone named the gate**, which is why this
 * exists rather than a third grep.
 *
 * THREE SHAPES, each measured on its own representative
 * -----------------------------------------------------
 * **A — `quoted-command`.** A single-quoted span that holds a `cdkd` verb AND
 * an interpolation. This is go-to-k/cdkd#3363's measured instance. Sanitizing
 * the value does not close it (`displaySafe` keeps `'`), and neither does
 * `displayIdent`, whose JSON quotes escape `'` for JSON and not for the
 * surrounding shell wrapper.
 *
 * **B — `quoted-interpolation`.** A single-quoted span whose content is
 * nothing but interpolations and separators — `` `'${command} ${t}'` `` is
 * `destroy-runner.ts`'s pre-go-to-k/cdkd#3499 `hintFor`. It is shape A with the
 * verb itself interpolated, so a grep for `'cdkd ` misses it entirely, and it
 * ALSO catches the regression this issue most expects: a caller taking
 * `pasteableCommand`'s gated result and wrapping it in quotes by hand, which
 * throws away everything the gate bought.
 *
 * **C — `open-hole`.** A bare `<word>` placeholder with more words after it
 * inside a `cdkd` command. `<name>` is two shell REDIRECTIONS; with a flag
 * appended the `>` gets a target, and
 * `cdkd events S --run <runId> --extra` read stdin from a file `runId`, created
 * a file named `--extra` and swallowed stdout (measured under bash with a stub
 * `cdkd`). A hole that ENDS a command is only a syntax error — which is why
 * `commandHole` renders `'<name>'` and why this shape is about what FOLLOWS.
 *
 * WHAT THIS DOES NOT CHECK
 * ------------------------
 * **Shape C of the issue — a `shellQuote`d value in PROSE whose quote context
 * an English apostrophe already flipped — is out of scope here, deliberately.**
 * It needs no command and no placeholder: `this stack's name` opens a shell
 * quote that closes at the value's own opening quote and leaves the value bare
 * (measured on go-to-k/cdkd#3363's `c5f07636`). Finding it needs the RENDERED
 * message, pasted at sentence and clause granularity — a source shape cannot
 * see it, and the issue says so. The per-site paste cases carry it.
 *
 * REFUSALS, NOT SKIPS
 * -------------------
 * Every unreadable input is a refusal: a file that does not parse, and an
 * exemption whose target no longer exists. A checker that skips what it cannot
 * read is green for the wrong reason, and a stale exemption is how a fence goes
 * quiet without anyone editing it.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript-v6';

/** One shape a site can be in. */
export type PasteableShape = 'quoted-command' | 'quoted-interpolation' | 'open-hole';

/** One site the critic reports. */
export interface PasteableFinding {
  readonly file: string;
  readonly line: number;
  readonly shape: PasteableShape;
  /** The offending span, trimmed and capped, for the report. */
  readonly excerpt: string;
}

/** What {@link checkPasteableCommandShapes} returns. */
export interface PasteableReport {
  readonly findings: readonly PasteableFinding[];
  /** Files parsed. A floor on this is what stops a vacuous green. */
  readonly filesScanned: number;
  /** Quoted spans examined, across every file. The second floor. */
  readonly spansExamined: number;
  /** Command literals examined for shape C. The third floor. */
  readonly commandLiteralsExamined: number;
  /** Exemptions whose target no longer exists — a refusal, not a warning. */
  readonly staleExemptions: readonly string[];
}

/**
 * The marker standing for an interpolation inside a reconstructed literal.
 *
 * `U+0000` because it cannot occur in the SOURCE text of a template literal:
 * a real NUL would be written `\\0` or `\\u0000` and arrive in `node.text` as the
 * character, so this is checked rather than assumed — a file carrying one is a
 * refusal below, not a silent mis-parse.
 */
const HOLE = '\u0000';

/**
 * Sites that are USAGE TEXT rather than a remedy an operator pastes, by
 * `file:shape:excerpt-prefix`. Each needs a reason, and a stale entry is a
 * REFUSAL — an exemption outliving its target is how a fence goes quiet.
 */
export const EXEMPTIONS: ReadonlyArray<{ file: string; shape: PasteableShape; contains: string; why: string }> =
  [];

/** A `cdkd` verb, as it appears at the head of a pasteable command. */
const CDKD_VERB = /\bcdkd\s+[a-z][a-z-]*/;

/**
 * A `<placeholder>` followed by more non-space content — shape C.
 *
 * The trailing `[^\s'"\`]` is what makes this about what FOLLOWS: a hole ENDING
 * the command is only a syntax error when pasted, and `commandHole`'s `'<x>'`
 * form is quoted and inert. Both are correct and must not be reported.
 */
const OPEN_HOLE = /<[A-Za-z][A-Za-z0-9_-]*>\s+[^\s'"`]/;

/**
 * The text of the COMMAND a `cdkd` verb opens, up to what ends it.
 *
 * Shape C is about a hole INSIDE a command, and the literal around it is
 * usually prose. `synthesizer.ts` reads `Pass --state-bucket <name> (cdkd uses
 * the same bucket as cdkd deploy state storage...)`: the hole and the verb are
 * in different sentences, and reporting it because both share a literal is a
 * false positive — measured as this shape's only one across `src/`. A command
 * ends at a sentence end, a quote, a newline, or an opening parenthesis, none
 * of which an operator would paste as part of it.
 */
function commandTail(text: string): string | undefined {
  const at = text.search(CDKD_VERB);
  if (at === -1) return undefined;
  const rest = text.slice(at);
  const end = rest.search(/[.!?]\s|['"`\n(]/);
  return end === -1 ? rest : rest.slice(0, end);
}

/** Parse, or refuse — a file that does not parse is never silently skipped. */
function parseOrRefuse(file: string, text: string): ts.SourceFile {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  // `createSourceFile` does not throw on a syntax error; it records one.
  const diagnostics = (sf as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics;
  if (diagnostics !== undefined && diagnostics.length > 0) {
    throw new Error(
      `check-pasteable-command-shapes: ${file} did not parse (${diagnostics.length} diagnostics). ` +
        `A file this critic cannot read is a refusal, not a skip — fix the file or the critic.`
    );
  }
  return sf;
}

/** Every `.ts` file under a directory, sorted, excluding `.d.ts`. */
export function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
    }
  };
  walk(root);
  return out;
}

/**
 * Every quoted span in a reconstructed literal, with the offset it starts at.
 *
 * Single quotes ONLY. A double-quoted span is not the hazard: the operator
 * pastes what they SELECT, and `"..."` in prose does not open a shell quote the
 * way `'...'` does. `displayIdent`'s JSON quoting is exactly that case, and it
 * is why sanitizing is not a remedy for shape A rather than why it is one.
 */
function quotedSpans(reconstructed: string): Array<{ text: string; at: number }> {
  const out: Array<{ text: string; at: number }> = [];
  let open = -1;
  for (let i = 0; i < reconstructed.length; i++) {
    if (reconstructed[i] !== "'") continue;
    if (open === -1) {
      open = i;
      continue;
    }
    out.push({ text: reconstructed.slice(open + 1, i), at: open });
    open = -1;
  }
  return out;
}

/**
 * Whether a span is the `hintFor` shape: a quoted span ASSEMBLED entirely out
 * of interpolations, with TWO OR MORE of them.
 *
 * The two-hole floor is the whole discriminator and it was measured. A span
 * holding ONE hole and nothing else is `'${stackName}'` — a quoted DISPLAY
 * value in prose, which occurs 944 times in `src/` and is
 * go-to-k/cdkd#3232's class, not this one. Reporting it here would bury the
 * nineteen real sites under a class this fence does not own and cannot fix.
 * Two or more holes with only separators between them is a command being
 * BUILT — `` `'${command} ${t}'` `` is `destroy-runner.ts`'s pre-#3499
 * `hintFor` — and there is no display idiom that spells one that way.
 *
 * What this deliberately does NOT do is key on the interpolated expression's
 * NAME (`pasteableCommand(...)`, `...Command`, `...Hint`). That is the
 * degrading shape go-to-k/cdkd#3436's record measured on `gc.ts`: a list of
 * the predicate names that exist today goes quiet the moment someone coins a
 * new one. The hole COUNT is a property of the shape.
 */
function isAssembledCommand(span: string): boolean {
  const chunks = span.split(HOLE);
  // No early return on the hole COUNT: it would be subsumed. One hole gives
  // `['', '']`, whose interior slice below is empty, so the space test already
  // rejects it — and a line no mutant can red is a line that reads as a guard
  // while guarding nothing. The space test is the single discriminator.
  // Separators only, AND at least one of them a SPACE. The space is what makes
  // this a command rather than a compound display value: argv words are
  // space-separated, while `'${containerId}:${workdir}'` — a real
  // `invoke-agentcore-watch-loop.ts` message naming a docker cp target — is two
  // holes joined by a colon and is not a command at all. Measured: without the
  // space requirement that site is the classifier's only false positive in this
  // shape across `src/`.
  if (!chunks.every((chunk) => /^[\s\-=:,/]*$/.test(chunk))) return false;
  return chunks.slice(1, -1).some((chunk) => /\s/.test(chunk));
}

/** Cap an excerpt so a report line stays readable. */
function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 120 ? `${flat.slice(0, 117)}...` : flat;
}

/**
 * Scan one file's source text.
 *
 * Exported for the fence's own tests, which plant each shape in a fixture
 * rather than relying on the real tree — and then ALSO assert a floor over the
 * real tree, because a synthetic fixture and the classifier can share a blind
 * spot.
 */
export function scanSource(
  file: string,
  text: string
): { findings: PasteableFinding[]; spans: number; commandLiterals: number } {
  if (text.includes(HOLE)) {
    throw new Error(
      `check-pasteable-command-shapes: ${file} contains a literal NUL, which this critic uses as ` +
        `its interpolation marker. Refusing rather than mis-parsing.`
    );
  }
  const sf = parseOrRefuse(file, text);
  const findings: PasteableFinding[] = [];
  let spans = 0;
  let commandLiterals = 0;

  const lineOf = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1;

  const consider = (reconstructed: string, start: number): void => {
    // Shape C first: it is about the command literal, quoted or not.
    const tail = commandTail(reconstructed);
    if (tail !== undefined) {
      commandLiterals++;
      if (OPEN_HOLE.test(tail)) {
        findings.push({
          file,
          line: lineOf(start),
          shape: 'open-hole',
          excerpt: excerpt(tail),
        });
      }
    }
    for (const span of quotedSpans(reconstructed)) {
      spans++;
      if (CDKD_VERB.test(span.text) && span.text.includes(HOLE)) {
        findings.push({
          file,
          line: lineOf(start),
          shape: 'quoted-command',
          excerpt: excerpt(span.text),
        });
        continue;
      }
      if (isAssembledCommand(span.text)) {
        findings.push({
          file,
          line: lineOf(start),
          shape: 'quoted-interpolation',
          excerpt: excerpt(span.text),
        });
      }
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isStringLiteral(node)) {
      consider(node.text, node.getStart(sf));
      return;
    }
    if (ts.isTemplateExpression(node)) {
      const parts = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)];
      consider(parts.join(HOLE), node.getStart(sf));
      // Descend anyway: an interpolated expression can hold its own literal,
      // and that literal is a site in its own right.
      for (const span of node.templateSpans) ts.forEachChild(span.expression, visit);
      node.templateSpans.forEach((s) => visit(s.expression));
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return { findings, spans, commandLiterals };
}

/**
 * Floors, over the REAL tree, so a classifier that stopped matching cannot
 * report "0 findings" and pass.
 *
 * Three of them, one per input SHAPE the parser claims to handle, because an
 * aggregate floor hides one dead shape: `spansExamined` can stay high while the
 * command-literal walk dies, and vice versa. Measured 2026-09-24 at 358 / 1532 /
 * 1047; the floors sit well below so an ordinary deletion does not false-fire.
 */
export const FLOORS = { filesScanned: 300, spansExamined: 1200, commandLiteralsExamined: 800 } as const;

/** One fixed source with a known verdict, analysed BEFORE the real tree. */
export interface ProbeCase {
  readonly label: string;
  readonly source: string;
  /** The shapes this source must produce, in any order. */
  readonly expect: readonly PasteableShape[];
}

/**
 * Sources with known verdicts, INCLUDING negatives.
 *
 * The floors above catch a collapse toward ZERO. These catch the opposite — a
 * classifier that reports everything leaves every floor satisfied and the
 * counts LARGER, so nothing else would see it. The majority are NEGATIVE on
 * purpose, and each accept arm is paired with the near-miss that must not fire.
 */
export const SELF_PROBE_CASES: readonly ProbeCase[] = [
  // --- quoted-command -------------------------------------------------------
  {
    label: 'a quoted cdkd command carrying an interpolation',
    source: 'const m = `Run \'cdkd deploy ${name}\' to migrate it.`;',
    expect: ['quoted-command'],
  },
  {
    label: 'the same command UNWRAPPED on its own line is the remedy, not a defect',
    source: 'const m = `Migrate with: cdkd deploy ${name}`;',
    expect: [],
  },
  {
    label: 'a quoted cdkd command with no interpolation is prose, not a hazard',
    source: "const m = `Run 'cdkd state list --long' and act on the match.`;",
    expect: [],
  },
  // --- quoted-interpolation -------------------------------------------------
  {
    label: "the hintFor shape: a span assembled from two holes",
    source: 'const m = targets.map((t) => `\'${command} ${t}\'`);',
    expect: ['quoted-interpolation'],
  },
  {
    label: 'a gated command re-wrapped in quotes by hand',
    source: 'const m = `\'${pasteableCommand(verb, args).command} ${suffix}\'`;',
    expect: ['quoted-interpolation'],
  },
  {
    label: 'ONE hole in quotes is a display value, not a command',
    source: 'const m = `Stack \'${stackName}\' has no region.`;',
    expect: [],
  },
  {
    label: 'two holes joined by a colon is a display value, not a command',
    source: 'const m = `docker cp into \'${containerId}:${workdir}\' failed`;',
    expect: [],
  },
  // --- open-hole ------------------------------------------------------------
  {
    label: 'a bare hole with a flag after it',
    source: 'const m = `Run cdkd force-unlock <stackName> --stack-region <region>`;',
    expect: ['open-hole'],
  },
  {
    label: 'a QUOTED hole with a flag after it is what commandHole emits',
    source: "const m = `Run cdkd force-unlock '<stackName>' --stack-region '<region>'`;",
    expect: [],
  },
  {
    label: 'a bare hole ENDING the command is a syntax error, not a redirection',
    source: 'const m = `Run cdkd force-unlock <stackName>`;',
    expect: [],
  },
  {
    label: 'a hole and a cdkd verb in different sentences are not one command',
    source: 'const m = `Pass --state-bucket <name> (cdkd deploy uses the same bucket).`;',
    expect: [],
  },
  {
    // The same rule from the OTHER side, and the one the first draft left
    // unpinned: here the verb comes FIRST and the hole follows a sentence end,
    // so only the command's own TAIL bound rejects it. Removing that bound
    // reddens nothing without this case (measured).
    label: 'a hole AFTER the command sentence ends is not inside the command',
    source: 'const m = `Run cdkd deploy MyStack. Then pass --resource <id> --force by hand.`;',
    expect: [],
  },
];

/**
 * Run the self-probes.
 *
 * `CDKD_SELF_PROBE_FORCE_FAIL=1` is the seam proving the BINARY still consults
 * them: the unit suite calls this directly, so `main()` dropping the call would
 * otherwise be unobservable.
 */
export function runSelfProbes(): string[] {
  const failures: string[] = [];
  if (process.env['CDKD_SELF_PROBE_FORCE_FAIL'] === '1') {
    failures.push('forced by CDKD_SELF_PROBE_FORCE_FAIL');
  }
  for (const probe of SELF_PROBE_CASES) {
    const got = scanSource('probe.ts', probe.source)
      .findings.map((f) => f.shape)
      .sort();
    const want = [...probe.expect].sort();
    if (got.join(',') !== want.join(',')) {
      failures.push(`${probe.label}: expected [${want.join(', ')}], got [${got.join(', ')}]`);
    }
  }
  return failures;
}

/** Run the critic over a source root. */
export function checkPasteableCommandShapes(root: string): PasteableReport {
  const files = sourceFiles(root);
  const findings: PasteableFinding[] = [];
  let spansExamined = 0;
  let commandLiteralsExamined = 0;

  for (const file of files) {
    const rel = relative(root, file).split(sep).join('/');
    const result = scanSource(rel, readFileSync(file, 'utf8'));
    findings.push(...result.findings);
    spansExamined += result.spans;
    commandLiteralsExamined += result.commandLiterals;
  }

  const kept: PasteableFinding[] = [];
  const used = new Set<number>();
  for (const finding of findings) {
    const index = EXEMPTIONS.findIndex(
      (e) => e.file === finding.file && e.shape === finding.shape && finding.excerpt.includes(e.contains)
    );
    if (index === -1) kept.push(finding);
    else used.add(index);
  }
  const staleExemptions = EXEMPTIONS.filter((_, i) => !used.has(i)).map(
    (e) => `${e.file}:${e.shape}:${e.contains}`
  );

  return {
    findings: kept,
    filesScanned: files.length,
    spansExamined,
    commandLiteralsExamined,
    staleExemptions,
  };
}
