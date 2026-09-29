import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Command } from 'commander';
import { describe, expect, it } from 'vite-plus/test';
import { buildProgram } from '../../../src/cli/program.js';

/**
 * A `parse(argv, { from: 'user' })` call must not carry an argv[0]/argv[1]
 * prefix.
 *
 * `from: 'user'` tells Commander the array is USER arguments — everything
 * after the script name. Handing it an argv-shaped array makes the leading
 * `node` / `cdkd` OPERANDS. Measured on commander 12.1.0 against a command
 * declaring `<target>`:
 *
 *     parse(['node', 'cdkd', 'My/Dist', '--tls'], { from: 'user' })
 *       -> processedArgs = ["node"]        args = ["node","cdkd","My/Dist"]
 *     parse(['My/Dist', '--tls'], { from: 'user' })
 *       -> processedArgs = ["My/Dist"]     args = ["My/Dist"]
 *
 * So the case believed it was targeting `My/Dist` while the command received
 * `node`. Every such site asserted only `opts()`, which parses identically
 * either way, so the whole family passed while exercising a target no user
 * would ever type.
 *
 * The second cost is forward-looking: a command declaring no `.argument()`
 * tolerated the excess operands on commander 12 but ERRORS from 14 on
 * ("too many arguments"). Under `tests/setup.ts`, whose stream fence drops a
 * passing test's stderr, that arrives as a silent `error()` — 19 such sites
 * were found this way while evaluating the bump (go-to-k/cdkd#2533), each in
 * a test reporting green.
 *
 * Both failure modes are invisible from reading the assertion, which is why
 * this is a source-shape lint rather than a runtime one.
 *
 * Out of scope by construction: a call with NO `from` option (or
 * `from: 'node'`) is argv-shaped BY DEFINITION and must keep its prefix —
 * `program.parseAsync(['node', 'cdkd', 'deploy'])` is correct and common.
 *
 * Per "a checker must prove it sees its input" (.claude/rules/testing.md),
 * the scan carries a file-count floor and a floor on the number of
 * `from: 'user'` sites it actually recognized, so a walker or matcher
 * regression cannot pass vacuously.
 */

const TESTS_ROOT = join(import.meta.dirname, '..', '..');

/**
 * One `parse(...)` / `parseAsync(...)` call, matched across line breaks:
 * the sites in this repo wrap in three different shapes (all on one line,
 * array on its own line, options object on its own line), and a line-anchored
 * needle silently misses the wrapped ones — which is exactly how the first
 * sweep of this family left 7 sites behind.
 */
const PARSE_CALL_RE = /\.parse(?:Async)?\s*\(\s*(\[[\s\S]*?\])\s*,\s*(\{[\s\S]*?\})\s*,?\s*\)/g;

/** An argv[0]/argv[1] prefix: a runtime, then this repo's binary names. */
const ARGV_PREFIX_RE = /^\[\s*(['"])(?:node|npx|tsx)\1\s*,\s*(['"])(?:cdkd|cdkl|cdk)\2/;

const FROM_USER_RE = /\bfrom\s*:\s*(['"])user\1/;

/**
 * Blank out comments, preserving offsets and line structure.
 *
 * Not optional hygiene — measured. `local-start-cloudfront.test.ts:23` carries
 * the prose ``// `cmd.parse([...])` runs the registered `.action(handler)`
 * body``, and {@link PARSE_CALL_RE}'s non-greedy array ran from that `[` to
 * the first `]` SIXTY-THREE lines later, swallowing the real violating call at
 * line 86 inside one match. The scan reported six sites and zero violations
 * for a file that had one, and only a real-code probe (re-introducing the
 * prefix and watching the lint stay green) exposed it.
 *
 * Quote-aware, because blanking `//` inside a string would corrupt any URL a
 * fixture carries and shift the very offsets this exists to keep honest.
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }
    if (c === '/' && next === '*') {
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += '  ';
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < source.length) {
        out += source[i];
        if (source[i] === '\\') {
          i++;
          if (i < source.length) out += source[i];
          i++;
          continue;
        }
        if (source[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function walkTestFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'cdk.out') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkTestFiles(full, out);
    } else if (
      entry.endsWith('.test.ts') &&
      // Skip this lint itself — its doc comment spells the banned shape out
      // as prose, and its synthetic sources hold `.parse(` inside string
      // literals, which the arity scan would read as real sites.
      entry !== 'commander-parse-from-user-convention.test.ts'
    ) {
      out.push(full);
    }
  }
}

interface Site {
  readonly file: string;
  readonly array: string;
}

function collectFromUserSites(files: string[]): { sites: Site[]; violations: Site[] } {
  const sites: Site[] = [];
  const violations: Site[] = [];
  for (const file of files) {
    const source = stripComments(readFileSync(file, 'utf8'));
    for (const match of source.matchAll(PARSE_CALL_RE)) {
      const [, array, options] = match as unknown as [string, string, string];
      if (!FROM_USER_RE.test(options)) continue;
      const site: Site = { file: file.replace(`${TESTS_ROOT}/`, 'tests/'), array };
      sites.push(site);
      if (ARGV_PREFIX_RE.test(array)) violations.push(site);
    }
  }
  return { sites, violations };
}

describe("commander parse(argv, { from: 'user' }) must not carry an argv prefix", () => {
  const files: string[] = [];
  walkTestFiles(TESTS_ROOT, files);
  const { sites, violations } = collectFromUserSites(files);

  it('scans a plausible number of test files (walker coverage floor)', () => {
    expect(files.length).toBeGreaterThan(400);
  });

  it("recognizes the repo's from: 'user' parse sites (matcher coverage floor)", () => {
    // ~50 such calls at the time of writing, across the local-* CLI suites.
    // A matcher that stops recognizing the wrapped call shapes drops well
    // below this, which is the regression that would make the check vacuous.
    expect(sites.length).toBeGreaterThan(30);
  });

  it('matches the wrapped call shapes, not just the single-line one', () => {
    // The single-line and array-on-its-own-line spellings both occur in this
    // repo. Deriving the check from a synthetic pair keeps it honest about
    // the multi-line half even if every real site were reformatted.
    const probe = [
      "cmd.parse(['--flag'], { from: 'user' });",
      "cmd.parse(\n  ['node', 'cdkd', 'Target', '--flag'],\n  { from: 'user' }\n);",
    ].join('\n');
    const matches = [...probe.matchAll(PARSE_CALL_RE)].filter((m) =>
      FROM_USER_RE.test(m[2] as string)
    );
    expect(matches).toHaveLength(2);
    expect(ARGV_PREFIX_RE.test(matches[0]![1] as string)).toBe(false);
    expect(ARGV_PREFIX_RE.test(matches[1]![1] as string)).toBe(true);
  });

  it('a commented-out parse call cannot swallow the real one after it', () => {
    // The exact shape that defeated the first cut of this check, reduced:
    // prose whose `[` opens 60-odd lines before the first `]`. Without
    // `stripComments` the two calls below collapse into ONE match whose array
    // starts in the comment, so the violation goes unseen.
    const probe = [
      "// `cmd.parse([...])` runs the registered `.action(handler)` body.",
      "cmd.parse(['node', 'cdkd', 'My/Dist', '--tls'], { from: 'user' });",
    ].join('\n');

    const rawViolations = [...probe.matchAll(PARSE_CALL_RE)].filter(
      (m) => FROM_USER_RE.test(m[2] as string) && ARGV_PREFIX_RE.test(m[1] as string)
    );
    expect(rawViolations, 'unstripped: the comment hides it — this is the defect').toHaveLength(0);

    const strippedViolations = [...stripComments(probe).matchAll(PARSE_CALL_RE)].filter(
      (m) => FROM_USER_RE.test(m[2] as string) && ARGV_PREFIX_RE.test(m[1] as string)
    );
    expect(strippedViolations, 'stripped: the real call is visible').toHaveLength(1);
  });

  it('blanks comments without touching a // inside a string literal', () => {
    const probe = `const url = 'https://example.com/x'; // trailing\ncmd.parse(['a'], { from: 'user' });`;
    const stripped = stripComments(probe);
    expect(stripped).toContain("'https://example.com/x'");
    expect(stripped).not.toContain('trailing');
    // Offsets are preserved, so a reported position still points at the source.
    expect(stripped).toHaveLength(probe.length);
  });

  it("no from: 'user' parse passes an argv[0]/argv[1] prefix", () => {
    expect(
      violations.map((v) => `${v.file}: ${v.array.replace(/\s+/g, ' ').slice(0, 80)}`),
      "`from: 'user'` means the array is USER arguments — drop the leading runtime/binary names, or remove the `from` option if the array really is argv"
    ).toEqual([]);
  });
});

/*
 * Operand count against declared arity.
 *
 * The prefix check above only recognizes `node` / `npx` / `tsx`, and cannot
 * see a surplus operand at all (a target plus a stack name handed to a command
 * fixed at one). From commander 14 on, `allowExcessArguments` defaults to
 * false, so either shape is a hard parse failure — which a test mocking
 * `process.exit` and asserting a non-zero exit reads as its OWN verdict.
 *
 * Each site's operands are counted by replaying commander's option grammar
 * against the REAL command the site parses, built from the factory the
 * receiver was initialized from. Bounds, all biased toward UNRESOLVED rather
 * than a false verdict: the receiver is the nearest preceding declaration of
 * that name (no scope analysis); an identifier argument is resolved one hop,
 * through the enclosing function's same-file call sites; a spread ends the
 * count, so what is reported is a lower bound.
 */

interface Token {
  readonly kind: 'lit' | 'val' | 'spread';
  readonly text: string;
}

interface Resolved {
  readonly path: string;
  readonly max: number;
  readonly operands: string[];
}

/** Max operands a command accepts; a group with no positional of its own takes none. */
function maxOperands(cmd: Command): number {
  const args = cmd.registeredArguments;
  if (args.some((a) => a.variadic)) return Number.POSITIVE_INFINITY;
  return args.length;
}

function allCommands(root: Command): Command[] {
  return [root, ...root.commands.flatMap((c) => allCommands(c as Command))];
}

/** Index of the bracket closing the one at `open`, skipping string contents. */
function closingIndex(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const c = source[i]!;
    if (c === "'" || c === '"' || c === '`') {
      for (i++; i < source.length && source[i] !== c; i++) if (source[i] === '\\') i++;
    } else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c) && --depth === 0) return i;
  }
  return -1;
}

/** Split the inside of a bracket pair on its top-level commas. */
function splitTopLevel(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (c === "'" || c === '"' || c === '`') {
      for (i++; i < inner.length && inner[i] !== c; i++) if (inner[i] === '\\') i++;
    } else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(inner.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}

/** `const NAME = '...'` declared exactly once in the file. */
function stringConstants(source: string): Map<string, string> {
  const seen = new Map<string, string | undefined>();
  for (const m of source.matchAll(/\bconst\s+(\w+)\s*(?::\s*string\s*)?=\s*('[^'\\\n]*'|"[^"\\\n]*")\s*;/g)) {
    seen.set(m[1]!, seen.has(m[1]!) ? undefined : m[2]!);
  }
  return new Map([...seen].flatMap(([k, v]) => (v === undefined ? [] : [[k, v] as [string, string]])));
}

function toToken(element: string, constants = new Map<string, string>()): Token {
  if (element.startsWith('...')) return { kind: 'spread', text: element.slice(3).trim() };
  const quoted = /^(['"`])([\s\S]*)\1$/.exec(constants.get(element) ?? element);
  if (quoted && !(quoted[1] === '`' && quoted[2]!.includes('${'))) {
    return { kind: 'lit', text: quoted[2]!.replace(/\\(['"`\\])/g, '$1') };
  }
  return { kind: 'val', text: element };
}

/**
 * Replay commander's grammar: an option consumes its value per its flags
 * (looked up through the ancestors, as commander does without positional
 * options), the first operand of a command with subcommands selects one when
 * it names one, and everything else is an operand. A spread or an unresolved
 * value ends the count — a loop variable may hold an option name — so the
 * result is a lower bound.
 */
function countOperands(root: Command, tokens: Token[]): Resolved | string {
  let cmd = root;
  const chain = [root];
  const operands: string[] = [];
  // commander's `maybeOption`: a bare `-` is a value, not an option.
  const isOption = (t: Token) => t.kind === 'lit' && t.text.length > 1 && t.text.startsWith('-');
  const done = (stoppedOn?: Token): Resolved | string => {
    // An opaque token may expand to any number of operands, so a count that
    // stops on one is a usable lower bound only where the arity is unbounded,
    // or where what was read already exceeds a finite one. In between, the
    // tail could carry the surplus.
    const max = maxOperands(cmd);
    if (stoppedOn && (operands.length === 0 || (Number.isFinite(max) && operands.length <= max))) {
      return `opaque ${stoppedOn.text}`;
    }
    return { path: chain.map((c) => c.name()).join(' '), max, operands };
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind === 'val' && operands.length === 0 && cmd.commands.length > 0) {
      return `subcommand named by a non-literal ${t.text}`;
    }
    if (t.kind !== 'lit') return done(t);
    if (t.text === '--') {
      const next = tokens[i + 1];
      // At a command with subcommands commander still dispatches the operand after `--`.
      const dispatches =
        operands.length === 0 &&
        next?.kind === 'lit' &&
        cmd.commands.some((c) => c.name() === next.text || c.aliases().includes(next.text));
      if (dispatches) continue;
      for (const rest of tokens.slice(i + 1)) {
        if (rest.kind === 'spread') return done(rest);
        operands.push(rest.text);
      }
      return done();
    }
    if (isOption(t)) {
      const name = t.text.split('=')[0]!;
      const opt = [...chain]
        .reverse()
        .flatMap((c) => c.options)
        .find((o) => o.long === name || o.short === name);
      if (!opt) return `unknown option ${name}`;
      if (t.text.includes('=') || !(opt.required || opt.optional)) continue;
      // Whether an optional or further variadic value is consumed depends on
      // the token's own text, so a non-literal there ends the count.
      const next = tokens[i + 1];
      if (opt.required) {
        if (next === undefined) return done();
        if (next.kind === 'spread') return done(next);
        i++;
      } else if (next !== undefined && !isOption(next)) {
        if (next.kind !== 'lit') return done(next);
        i++;
      }
      while (opt.variadic && tokens[i + 1] !== undefined && !isOption(tokens[i + 1]!)) {
        if (tokens[i + 1]!.kind !== 'lit') return done(tokens[i + 1]);
        i++;
      }
      continue;
    }
    if (operands.length === 0 && cmd.commands.length > 0) {
      if (t.text === 'help') return 'implicit help subcommand';
      const sub = cmd.commands.find((c) => c.name() === t.text || c.aliases().includes(t.text));
      if (sub) {
        cmd = sub as Command;
        chain.push(cmd);
        continue;
      }
    }
    operands.push(t.text);
  }
  return done();
}

interface ArgFunction {
  readonly name: string;
  readonly params: string[];
  /** Each parameter's default expression, as written. */
  readonly defaults: (string | undefined)[];
  readonly rest: boolean[];
  readonly headerAt: number;
  /** Offsets of the body's braces; an expression-bodied arrow has none. */
  readonly body?: readonly [number, number];
}

/** The `{...}` body after a parameter list, stepping over a return type's generics and type literals. */
function bodyRange(source: string, paramsClose: number): [number, number] | undefined {
  let angle = 0;
  for (let i = paramsClose + 1; i < source.length; i++) {
    const c = source[i]!;
    if (c === '=' && source[i + 1] === '>') i++;
    else if (c === '<') angle++;
    else if (c === '>') angle--;
    else if (c === '{' && angle === 0) {
      const close = closingIndex(source, i);
      if (close < 0) return undefined;
      if (!/[:|&]\s*$/.test(source.slice(paramsClose + 1, i))) return [i, close];
      i = close;
    } else if ((c === ';' || c === '(') && angle === 0) return undefined;
  }
  return undefined;
}

/** Named functions: `function f(...)` and `const f = (async) (...) =>`. */
function functionHeaders(source: string): ArgFunction[] {
  const out: ArgFunction[] = [];
  const re =
    /\bfunction\s+(\w+)\s*(?:<[^>(]*>)?\s*\(|\b(?:const|let)\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s*)?\(/g;
  for (const m of source.matchAll(re)) {
    const open = m.index + m[0].length - 1;
    const close = closingIndex(source, open);
    if (close < 0) continue;
    if (m[2] !== undefined && !/^\s*(?::[^=]*?)?=>/.test(source.slice(close + 1, close + 200))) {
      continue;
    }
    const parsed = splitTopLevel(source.slice(open + 1, close)).map((p) =>
      /^(\.\.\.)?(\w+)\??\s*(?::(?:[^=]|=>)*)?(?:=(?!>)\s*([\s\S]*))?$/.exec(p)
    );
    out.push({
      name: (m[1] ?? m[2])!,
      params: parsed.map((p) => p?.[2] ?? ''),
      rest: parsed.map((p) => p?.[1] !== undefined),
      // A rest parameter left empty is `[]`.
      defaults: parsed.map((p) => (p?.[1] ? '[]' : p?.[3]?.trim())),
      headerAt: m.index,
      body: bodyRange(source, close),
    });
  }
  return out;
}

/** Factory name -> the command it builds, over every exported `create*Command` plus `buildProgram`. */
const FACTORIES = new Map<string, () => Command>([['buildProgram', buildProgram]]);
const COMMANDS_DIR = join(TESTS_ROOT, '..', 'src', 'cli', 'commands');
for (const entry of readdirSync(COMMANDS_DIR, { recursive: true, encoding: 'utf8' })) {
  if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
  const mod = (await import(pathToFileURL(join(COMMANDS_DIR, entry)).href)) as Record<
    string,
    unknown
  >;
  for (const [name, value] of Object.entries(mod)) {
    if (/^create\w+Command$/.test(name) && typeof value === 'function') {
      FACTORIES.set(name, value as () => Command);
    }
  }
}

/**
 * Calls after a factory that return the SAME command with the same arity rule.
 * `.command('x')` returns a new child, and `.allowExcessArguments()` changes
 * the very rule checked here, so neither resolves.
 */
const SELF_CHAIN =
  '(?:\\s*\\.\\s*(?:exitOverride|configureOutput|allowUnknownOption|showHelpAfterError|hook|action)\\s*\\([^()]*\\))*';

interface Receiver {
  readonly factory: string;
  readonly via: 'direct' | 'chained' | 'helper';
}

/**
 * The factory a receiver was built from: a factory call chained into the
 * parse, the receiver's nearest preceding declaration calling one, or one hop
 * through a same-file helper whose body calls one.
 */
function resolveReceiver(
  source: string,
  before: string,
  headers: ArgFunction[]
): Receiver | undefined {
  const chained = new RegExp(`\\b(\\w+)\\s*\\(\\s*\\)${SELF_CHAIN}\\s*$`).exec(before);
  if (chained && FACTORIES.has(chained[1]!)) return { factory: chained[1]!, via: 'chained' };
  const recv = /(\w+)\s*$/.exec(before)?.[1];
  const at = before.length;
  const enclosing = headers.filter((h) => h.body && h.body[0] < at && at < h.body[1]).at(-1);
  // A parameter is a binding too, and its argument is not traced.
  if (recv !== undefined && enclosing?.params.includes(recv)) return undefined;
  const called = recv === undefined ? undefined : factoryCalled(initializerOf(before, recv));
  if (called === undefined) return undefined;
  if (FACTORIES.has(called)) return { factory: called, via: 'direct' };
  const body = headers.find((h) => h.name === called)?.body;
  if (!body) return undefined;
  // What the helper RETURNS, not the first factory it calls: a helper can
  // build a root and `addCommand` a factory's command under it.
  const inner = source.slice(body[0] + 1, body[1]);
  const returned = [...inner.matchAll(/\breturn\s+([^;]*);/g)].map((m) => m[1]!.trim());
  if (returned.length !== 1) return undefined;
  const expr = returned[0]!;
  const factory = factoryCalled(/^\w+$/.test(expr) ? initializerOf(inner, expr) : expr);
  return factory !== undefined && FACTORIES.has(factory) ? { factory, via: 'helper' } : undefined;
}

/**
 * The initializer of `name`'s nearest preceding binding, or undefined when
 * that binding is an initializer-less declaration or a reassignment.
 */
function initializerOf(text: string, name: string): string | undefined {
  const binding = new RegExp(
    `\\b(?:const|let|var)\\s+${name}\\b[^=;]*(?:=\\s*([^;]*))?;|(?<![.\\w])${name}\\s*=(?![=>])`,
    'g'
  );
  return [...text.matchAll(binding)].at(-1)?.[1];
}

function factoryCalled(init: string | undefined): string | undefined {
  // Only the factory's own command, optionally through `this`-returning
  // calls: `createX().commands[0]` holds a CHILD, which must not be replayed
  // from the factory's root.
  const call = new RegExp(`^(?:await\\s+)?(\\w+)\\s*\\(\\s*\\)${SELF_CHAIN}\\s*$`);
  return init === undefined ? undefined : call.exec(init)?.[1];
}

interface AritySite {
  readonly where: string;
  readonly receiver: Receiver;
  readonly tokens: Token[];
  /** Line of the enclosing function's call the tokens were substituted from. */
  readonly callLine?: number;
}

/** `const NAME = [...];` declared exactly once in the file, as its elements. */
function arrayConstants(source: string): Map<string, string[]> {
  const seen = new Map<string, string[] | undefined>();
  for (const m of source.matchAll(/\bconst\s+(\w+)\s*(?::[^=;]*)?=\s*\[/g)) {
    const open = m.index + m[0].length - 1;
    const close = closingIndex(source, open);
    const whole = close >= 0 && /^\s*(?:as\s+const\s*)?;/.test(source.slice(close + 1));
    const value = whole ? splitTopLevel(source.slice(open + 1, close)) : undefined;
    seen.set(m[1]!, seen.has(m[1]!) ? undefined : value);
  }
  return new Map([...seen].flatMap(([k, v]) => (v === undefined ? [] : [[k, v] as [string, string[]]])));
}

/** Hops through enclosing functions' callers before a parameter stays opaque. */
const MAX_HOPS = 3;

/**
 * Expand one site's first argument into token lists. A parameter of the
 * enclosing function (bare, spread, or as an element) is substituted from each
 * same-file call of that function, repeatedly while the substituted text is
 * itself the caller's parameter, up to {@link MAX_HOPS}; a spread of a
 * file-level array constant is inlined. Anything else stays opaque.
 */
function expandSite(
  source: string,
  at: number,
  arg: string,
  headers: ArgFunction[]
): { tokens: Token[]; callLine?: number }[] {
  const constants = stringConstants(source);
  const arrays = arrayConstants(source);
  // `live`: text taken from the previous hop's argument, so it is written in
  // the scope now being searched and may be the caller's parameter. `frozen`:
  // a parameter the scan stopped tracing, which stays opaque.
  interface Element {
    readonly text: string;
    readonly live: boolean;
    readonly frozen?: boolean;
  }
  const inline = (elements: Element[]): Element[] =>
    elements.flatMap((e) => {
      const name = e.text.startsWith('...') ? e.text.slice(3).trim() : undefined;
      const spread = e.frozen || name === undefined ? undefined : arrays.get(name);
      return spread ? inline(spread.map((text) => ({ text, live: false }))) : [e];
    });
  const token = (e: Element): Token => {
    if (!e.frozen) return toToken(e.text, constants);
    const spread = e.text.startsWith('...');
    return { kind: spread ? 'spread' : 'val', text: spread ? e.text.slice(3).trim() : e.text };
  };
  const start = (arg.startsWith('[') ? splitTopLevel(arg.slice(1, -1)) : [`...${arg}`]).map(
    (text) => ({ text, live: true })
  );

  const expand = (
    elements: Element[],
    pos: number,
    hops: number,
    callLine: number | undefined
  ): { elements: Element[]; callLine?: number }[] => {
    const fn = headers.filter((h) => h.body && h.body[0] < pos && pos < h.body[1]).at(-1);
    const param = (e: Element) =>
      e.live && !e.frozen ? (fn?.params.indexOf(e.text.replace(/^\.\.\./, '')) ?? -1) : -1;
    if (!fn || !elements.some((e) => param(e) >= 0)) return [{ elements, callLine }];
    if (hops === MAX_HOPS) {
      const capped = elements.map((e) => (param(e) >= 0 ? { ...e, frozen: true } : e));
      return [{ elements: capped, callLine }];
    }
    const out: { elements: Element[]; callLine?: number }[] = [];
    for (const call of source.matchAll(new RegExp(`(?<![.\\w])${fn.name}\\s*\\(`, 'g'))) {
      if (source.slice(fn.headerAt, call.index).trim() === 'function') continue;
      const open = call.index + call[0].length - 1;
      const close = closingIndex(source, open);
      if (close < 0) continue;
      const callArgs = splitTopLevel(source.slice(open + 1, close));
      const next = elements.flatMap((e): Element[] => {
        const index = param(e);
        if (index < 0) return [{ ...e, live: false }];
        // A rest parameter collects every argument from its position on.
        const given = fn.rest[index]
          ? callArgs.length > index
            ? `[${callArgs.slice(index).join(', ')}]`
            : undefined
          : callArgs[index];
        // An omitted argument takes the parameter's default, which is written
        // in the callee's scope, not the caller's; with no default it is opaque.
        const value = given ?? fn.defaults[index];
        if (value === undefined) return [{ ...e, frozen: true }];
        const live = given !== undefined;
        if (!e.text.startsWith('...')) return [{ text: value, live }];
        return value.startsWith('[')
          ? splitTopLevel(value.slice(1, -1)).map((text) => ({ text, live }))
          : [{ text: `...${value}`, live }];
      });
      const line = source.slice(0, call.index).split('\n').length;
      out.push(...expand(next, call.index, hops + 1, line));
    }
    return out;
  };

  return expand(start, at, 0, undefined).map(({ elements, callLine }) => ({
    tokens: inline(elements).map(token),
    ...(callLine === undefined ? {} : { callLine }),
  }));
}

function collectAritySites(files: string[]): { sites: AritySite[]; unresolved: string[] } {
  const sites: AritySite[] = [];
  const unresolved: string[] = [];
  for (const file of files) {
    const source = stripComments(readFileSync(file, 'utf8'));
    if (!FROM_USER_RE.test(source)) continue;
    const headers = functionHeaders(source);
    for (const m of source.matchAll(/\.\s*parse(?:Async)?\s*\(/g)) {
      const open = m.index + m[0].length - 1;
      const close = closingIndex(source, open);
      const args = close < 0 ? [] : splitTopLevel(source.slice(open + 1, close));
      if (args.length < 2 || !FROM_USER_RE.test(args[1]!)) continue;
      const line = source.slice(0, m.index).split('\n').length;
      const where = `${file.replace(`${TESTS_ROOT}/`, 'tests/')}:${line}`;
      const receiver = resolveReceiver(source, source.slice(0, m.index), headers);
      if (receiver === undefined) {
        unresolved.push(`${where}: receiver`);
        continue;
      }
      const variants = expandSite(source, m.index, args[0]!, headers);
      if (variants.length === 0) unresolved.push(`${where}: no call site`);
      for (const v of variants) sites.push({ where, receiver, ...v });
    }
  }
  return { sites, unresolved };
}

/**
 * Sites the arity check cannot see, per file. Any dark site not listed here
 * fails, and so does an entry that no longer matches: fix the shape or
 * record it with its reason. Counted per file, not per line, so an edit does
 * not churn it; one change that resolves a dark site and adds another in the
 * same file keeps the count and passes.
 */
const KNOWN_DARK: Record<string, number> = {
  // `...baseArgs()` and `...nestedTree(...)`: spreads of a call's result.
  'tests/unit/cli/export-non-interactive-confirm.test.ts': 1,
  // `dryRunArgs()` / `realRunArgs()` call results passed to `runExport`.
  'tests/unit/cli/export-plan-record-display.test.ts': 1,
  // `STACK` is a template literal, which may begin with `-`.
  'tests/unit/cli/force-unlock-display.test.ts': 1,
  // `realArgs`, a conditional slice of the wrapper's parameter.
  'tests/unit/cli/import.test.ts': 1,
  // The subcommand is named by a loop variable.
  'tests/unit/cli/local-assume-role-negation.test.ts': 1,
  // `...(watch ? ['--watch'] : [])` after the target: a conditional spread.
  'tests/unit/cli/local-invoke-agentcore-stdout-stream.test.ts': 1,
  // A receiver built by `make()`, a factory passed in as a parameter, and
  // `invoke(args)` called with a loop variable after the target operand.
  'tests/unit/cli/local-invoke-assume-role-entry.test.ts': 2,
  // Three `shim()` receivers built with `new Command`, and one subcommand
  // named by a loop variable.
  'tests/unit/cli/local-shim-region-fold.test.ts': 4,
  // `...(argv as string[])`: a cast parameter fed from `it.each` rows.
  'tests/unit/cli/local-start-cloudfront.test.ts': 1,
  // A receiver built per case, and a spread of a loop variable.
  'tests/unit/cli/options.test.ts': 2,
  // Stack paths built as `${HOSTILE...}/A` templates, which may begin with `-`.
  'tests/unit/cli/orphan-display-safe.test.ts': 1,
  // The removed `--path` option, passed on purpose to assert its rejection.
  'tests/unit/cli/publish-assets.test.ts': 1,
  // A `forged` variable and `argv.slice(2)` as operands.
  'tests/unit/cli/state-orphan.test.ts': 1,
  // `...flags` from `it.each` rows, after the stack operand.
  'tests/unit/cli/state-record-shape.test.ts': 1,
  // Stack names read off fixture records (`ref.stackName`).
  'tests/unit/cli/state-ref-display-boundary.test.ts': 1,
  // A `forged` variable as the stack name.
  'tests/unit/cli/state-resources.test.ts': 1,
  // `...(await argv(app))`: a spread of an awaited call.
  'tests/unit/local/engine-docker-context.test.ts': 1,
  // A bare `new Command()` receiver.
  'tests/unit/state/lock-contention-message.test.ts': 1,
};

describe("commander parse(argv, { from: 'user' }) passes no more operands than its target accepts", () => {
  const program = buildProgram();
  const tree = allCommands(program);

  it('reaches every command in the tree and reads its arity, not just the leaves', () => {
    // Drive the checker itself to each node by its path plus one operand past
    // its arity. A leaf-only walk would miss a command carrying a positional
    // AND a subcommand (`events`), so the sum is taken against the whole tree.
    const reached = tree.map((cmd) => {
      const path: string[] = [];
      for (let c: Command | null = cmd; c && c !== program; c = c.parent) path.unshift(c.name());
      const max = maxOperands(cmd);
      const extra = Array.from({ length: Number.isFinite(max) ? max + 1 : 2 }, (_, i) => `operand-${i}`);
      const r = countOperands(program, [...path, ...extra].map((x) => toToken(`'${x}'`)));
      return typeof r === 'string' ? r : `${r.path} ${r.operands.length > r.max || !Number.isFinite(max)}`;
    });
    expect(reached).toEqual(tree.map((cmd) => {
      const names: string[] = [];
      for (let c: Command | null = cmd; c; c = c.parent) names.unshift(c.name());
      return `${names.join(' ')} true`;
    }));
    const byArity = (want: number) => tree.filter((c) => maxOperands(c) === want).length;
    expect(byArity(0)).toBeGreaterThan(0);
    expect(byArity(1)).toBeGreaterThan(0);
    expect(byArity(Number.POSITIVE_INFINITY)).toBeGreaterThan(0);
    expect(tree.some((c) => c.commands.length > 0 && maxOperands(c) === 1)).toBe(true);
  });

  const files: string[] = [];
  walkTestFiles(TESTS_ROOT, files);
  const collected = collectAritySites(files);
  const resolved = collected.sites.map((s) => ({
    s,
    r: countOperands(FACTORIES.get(s.receiver.factory)!(), s.tokens),
  }));
  const counted = resolved.flatMap(({ s, r }) => (typeof r === 'string' ? [] : [{ s, r }]));
  const unresolved = [
    ...new Set([
      ...collected.unresolved,
      ...resolved.flatMap(({ s, r }) => (typeof r === 'string' ? [`${s.where}: ${r}`] : [])),
    ]),
  ];
  const sitesWhere = (keep: (c: (typeof counted)[number]) => boolean) =>
    new Set(counted.filter(keep).map(({ s }) => s.where)).size;

  it('resolves sites of every shape to a real command (coverage floors per shape)', () => {
    // A floor per shape the resolver claims, counted in distinct sites that
    // yielded at least one operand, so a shape that resolves but reads nothing
    // does not hold its floor up. An aggregate floor would hide one dead shape.
    const read = (c: (typeof counted)[number]) => c.r.operands.length > 0;
    expect(sitesWhere((c) => read(c) && c.s.callLine === undefined), 'literal array').toBeGreaterThan(15);
    expect(sitesWhere((c) => read(c) && c.s.callLine !== undefined), 'wrapper call').toBeGreaterThan(15);
    expect(sitesWhere((c) => read(c) && c.r.path.includes(' ')), 'group descent').toBeGreaterThan(5);
    expect(sitesWhere((c) => c.s.receiver.via === 'direct'), 'direct receiver').toBeGreaterThan(30);
    expect(sitesWhere((c) => c.s.receiver.via === 'helper'), 'helper receiver').toBeGreaterThan(5);
    // A liveness floor, not a count: the synthetic case pins the shape itself.
    expect(sitesWhere((c) => c.s.receiver.via === 'chained'), 'chained receiver').toBeGreaterThan(0);
    // A site is dark when ANY of its token lists went uncounted: one trivially
    // counted call (`run([])`) says nothing about the surplus behind another.
    const dark = [...new Set(unresolved.map((u) => u.split(': ')[0]!))];
    const darkPerFile: Record<string, number> = {};
    for (const where of dark) {
      const file = where.slice(0, where.lastIndexOf(':'));
      darkPerFile[file] = (darkPerFile[file] ?? 0) + 1;
    }
    expect(darkPerFile, `dark sites:\n${dark.join('\n')}\nunresolved:\n${unresolved.join('\n')}`).toEqual(
      KNOWN_DARK
    );
  });

  it('counts a surplus operand, including one behind a non-node runtime prefix', () => {
    const cmd = FACTORIES.get('createLocalRunTaskCommand')!();
    const tokens = (a: string[]) => a.map((x) => toToken(`'${x}'`));
    const ok = countOperands(cmd, tokens(['TD', '--stack-region', 'us-west-2', '--no-pull']));
    expect(ok).toMatchObject({ max: 1, operands: ['TD'] });
    expect(countOperands(cmd, tokens(['TD', 'Other']))).toMatchObject({ operands: ['TD', 'Other'] });
    expect(countOperands(cmd, tokens(['bun', 'cdkd', 'TD']))).toMatchObject({
      operands: ['bun', 'cdkd', 'TD'],
    });
    const viaGroup = countOperands(buildProgram(), tokens(['local', 'run-task', 'TD', 'X']));
    expect(viaGroup).toMatchObject({ path: 'cdkd local run-task', max: 1, operands: ['TD', 'X'] });
  });

  it('resolves an identifier argument through the enclosing function’s call sites', () => {
    const source = [
      'async function run(args: string[]) {',
      '  const cmd = createLocalRunTaskCommand();',
      "  await cmd.parseAsync(args, { from: 'user' });",
      '}',
      "await run(['TD', 'Extra']);",
    ].join('\n');
    const headers = functionHeaders(source);
    const at = source.indexOf('.parseAsync');
    expect(resolveReceiver(source, source.slice(0, at), headers)).toEqual({
      factory: 'createLocalRunTaskCommand',
      via: 'direct',
    });
    expect(expandSite(source, at, 'args', headers)).toEqual([
      {
        tokens: [
          { kind: 'lit', text: 'TD' },
          { kind: 'lit', text: 'Extra' },
        ],
        callLine: 5,
      },
    ]);
  });

  it('resolves a helper-built receiver within the helper body, and a closed sibling is not enclosing', () => {
    const source = [
      'function tree(): Command {',
      '  const local = createLocalCommand();',
      '  return local;',
      '}',
      'function sibling(args: string[]) {',
      '  return args;',
      '}',
      "sibling(['X', 'Y']);",
      'it.each([[1]])((args) => {',
      '  const cmd = tree();',
      "  cmd.parse(args, { from: 'user' });",
      '});',
      'const later = createDeployCommand();',
    ].join('\n');
    const headers = functionHeaders(source);
    const at = source.indexOf('.parse(');
    expect(resolveReceiver(source, source.slice(0, at), headers)).toEqual({
      factory: 'createLocalCommand',
      via: 'helper',
    });
    expect(expandSite(source, at, 'args', headers)).toEqual([
      { tokens: [{ kind: 'spread', text: 'args' }] },
    ]);
    // The helper is the last named function and calls no factory itself, so
    // only its body bound keeps the scan off the file's later factory call.
    const trailing = [
      'function tree(): Command {',
      "  return new Command('x');",
      '}',
      'const cmd = tree();',
      'cmd',
      'const later = createDeployCommand();',
    ].join('\n');
    const recvAt = trailing.indexOf('\ncmd\n') + 4;
    expect(resolveReceiver(trailing, trailing.slice(0, recvAt), functionHeaders(trailing))).toBeUndefined();
    const typed = 'let cmd: Command;\nconst other = createDeployCommand();\ncmd = x;\ncmd';
    expect(resolveReceiver(typed, typed, functionHeaders(typed))).toBeUndefined();
  });

  it('traces a parameter through a second wrapper and inlines a file-level array', () => {
    const source = [
      "const ARGS = ['TestStack', '--region', 'us-east-1'];",
      'async function inRegion(region: string, extra: string[] = []) {',
      '  const cmd = createGcCommand();',
      "  await cmd.parseAsync(['--region', region, ...extra], { from: 'user' });",
      '}',
      'async function run(extra: string[] = []) {',
      "  await inRegion('r', extra);",
      '}',
      "await run(['--yes', 'Stray']);",
      'await run([...ARGS]);',
    ].join('\n');
    const variants = expandSite(
      source,
      source.indexOf('.parseAsync'),
      "['--region', region, ...extra]",
      functionHeaders(source)
    );
    expect(variants.map((v) => [v.callLine, v.tokens.map((t) => t.text)])).toEqual([
      [9, ['--region', 'r', '--yes', 'Stray']],
      [10, ['--region', 'r', 'TestStack', '--region', 'us-east-1']],
    ]);
    const gc = () => FACTORIES.get('createGcCommand')!();
    expect(countOperands(gc(), variants[0]!.tokens)).toMatchObject({ max: 0, operands: ['Stray'] });
  });

  it('substitutes only what the previous hop passed in, and an omitted argument by its default', () => {
    const texts = (source: string, arg: string) =>
      expandSite(source, source.indexOf('.parse('), arg, functionHeaders(source)).map((v) =>
        v.tokens.map((t) => `${t.kind}:${t.text}`)
      );
    // `extra` is inner's own local; the caller's same-named parameter must not replace it.
    const scoped = [
      'function inner(stack: string) {',
      "  const extra = ['--yes'];",
      "  cmd.parse([stack, ...extra], { from: 'user' });",
      '}',
      'function outer(extra: string[]) {',
      "  inner('S');",
      '}',
      "outer(['A', 'B']);",
    ].join('\n');
    expect(texts(scoped, '[stack, ...extra]')).toEqual([['lit:S', 'lit:--yes']]);
    // A non-empty default is used; no default at all is opaque.
    const defaults = [
      "function run(stack = 'MyStack', more?: string[]) {",
      "  cmd.parse([stack, ...more], { from: 'user' });",
      '}',
      'run();',
    ].join('\n');
    expect(texts(defaults, '[stack, ...more]')).toEqual([['lit:MyStack', 'spread:more']]);
    // A default is written in the callee's scope, so a caller's same-named
    // parameter must not replace it.
    const scopedDefault = [
      "const DEFAULT_ARGS = ['S'];",
      'function inner(extra = DEFAULT_ARGS) {',
      "  cmd.parse([...extra], { from: 'user' });",
      '}',
      'function outer(DEFAULT_ARGS: string[]) {',
      '  inner();',
      '}',
      "outer(['A', 'B']);",
    ].join('\n');
    expect(texts(scopedDefault, '[...extra]')).toEqual([['lit:S']]);
    // A rest parameter takes every argument from its position on, and a
    // function-typed parameter's `=>` is not read as a default.
    const rest = [
      'function run(cb: () => void, ...args: string[]) {',
      "  cmd.parse([...args], { from: 'user' });",
      '}',
      "run(() => {}, 'A', 'B');",
    ].join('\n');
    expect(texts(rest, '[...args]')).toEqual([['lit:A', 'lit:B']]);
    expect(functionHeaders(rest)[0]!.defaults).toEqual([undefined, '[]']);
    // A parameter still untraced at the hop cap stays opaque even when a
    // file-level array shares its name.
    const capped = [
      "const ARGS = ['X'];",
      "function f0(ARGS: string[]) { cmd.parse([...ARGS], { from: 'user' }); }",
      'function f1(ARGS: string[]) { f0(ARGS); }',
      'function f2(ARGS: string[]) { f1(ARGS); }',
      'function f3(ARGS: string[]) { f2(ARGS); }',
    ].join('\n');
    expect(texts(capped, '[...ARGS]')).toEqual([['spread:ARGS']]);
  });

  it('reports an opaque token instead of a clean count when it could hide operands', () => {
    const lit = (x: string) => toToken(`'${x}'`);
    const val = (x: string): Token => ({ kind: 'val', text: x });
    const spread = (x: string): Token => ({ kind: 'spread', text: x });
    const runTask = () => FACTORIES.get('createLocalRunTaskCommand')!();
    // A finite arity can be exceeded by whatever an opaque tail expands to.
    expect(countOperands(runTask(), [lit('TD'), spread('extra')])).toBe('opaque extra');
    // A surplus already read stays a verdict, whatever the tail holds.
    expect(countOperands(runTask(), [lit('TD'), lit('X'), spread('extra')])).toMatchObject({
      operands: ['TD', 'X'],
    });
    // An unbounded one cannot, so the operands read are a usable lower bound.
    expect(
      countOperands(FACTORIES.get('createDestroyCommand')!(), [lit('A'), spread('extra')])
    ).toMatchObject({ operands: ['A'] });
    // Opaque from the first token: nothing was read, so nothing is known.
    expect(countOperands(runTask(), [spread('argv')])).toBe('opaque argv');
    expect(countOperands(FACTORIES.get('createGcCommand')!(), [lit('--region'), lit('r'), spread('extra')])).toBe(
      'opaque extra'
    );
    // An optional option's value decides whether the next token is consumed,
    // so a non-literal there ends the count rather than being eaten as a value.
    expect(countOperands(runTask(), [lit('--assume-task-role'), val('flag'), lit('A'), lit('B')])).toBe(
      'opaque flag'
    );
    expect(countOperands(runTask(), [lit('TD'), lit('--assume-task-role'), val('flag'), lit('X')])).toBe(
      'opaque flag'
    );
    // A bare `-` is a value to commander, so an optional option takes it.
    expect(countOperands(runTask(), [lit('TD'), lit('--assume-task-role'), lit('-')])).toMatchObject({
      operands: ['TD'],
    });
    // `--` at a command with subcommands still dispatches to the one it names.
    expect(countOperands(FACTORIES.get('createLocalCommand')!(), ['--', 'run-task', 'TD'].map(lit))).toMatchObject({
      path: 'local run-task',
      operands: ['TD'],
    });
  });

  it('leaves a receiver unresolved when its binding or helper does not name one factory', () => {
    const resolve = (source: string) =>
      resolveReceiver(source, source.slice(0, source.lastIndexOf('\ncmd') + 4), functionHeaders(source));
    // A helper that builds a root and nests a factory's command under it.
    expect(
      resolve(
        [
          'function tree(): Command {',
          "  const root = new Command('cdkd');",
          '  root.addCommand(createLocalCommand());',
          '  return root;',
          '}',
          'const cmd = tree();',
          'cmd',
        ].join('\n')
      )
    ).toBeUndefined();
    // An initializer-less redeclaration shadows an earlier factory binding.
    expect(resolve('const cmd = createDeployCommand();\nlet cmd: Command;\ncmd')).toBeUndefined();
    // A child of the factory's command is not the factory's command.
    expect(
      resolve("const cmd = buildProgram().commands.find((c) => c.name() === 'deploy');\ncmd")
    ).toBeUndefined();
    expect(
      resolve(
        [
          'function tree(): Command {',
          '  return createLocalCommand().commands[0]!;',
          '}',
          'const cmd = tree();',
          'cmd',
        ].join('\n')
      )
    ).toBeUndefined();
    expect(resolve('const cmd = createLocalCommand().commands[0]!;\ncmd')).toBeUndefined();
    // A parameter shadows an earlier factory binding.
    expect(
      resolve('const cmd = createDeployCommand();\nfunction run(cmd: Command) {\ncmd\n}')
    ).toBeUndefined();
    expect(
      resolveReceiver('createDiffCommand().exitOverride()', 'createDiffCommand().exitOverride()', [])
    ).toEqual({ factory: 'createDiffCommand', via: 'chained' });
    // `.command('x')` returns a new child, not the factory's command.
    expect(resolve("const cmd = createLocalCommand().command('x');\ncmd")).toBeUndefined();
    expect(resolve('const cmd = createLocalCommand().allowExcessArguments();\ncmd')).toBeUndefined();
    expect(resolveReceiver("createLocalCommand().command('x')", "createLocalCommand().command('x')", [])).toBeUndefined();
    expect(resolve('const cmd = createDeployCommand().exitOverride();\ncmd')).toEqual({
      factory: 'createDeployCommand',
      via: 'direct',
    });
    expect(resolve('const cmd = createDeployCommand();\ncmd')).toEqual({
      factory: 'createDeployCommand',
      via: 'direct',
    });
  });

  it("no from: 'user' parse passes more operands than its target declares", () => {
    const over = resolved.flatMap(({ s, r }) =>
      typeof r !== 'string' && r.operands.length > r.max
        ? [`${s.where}${s.callLine === undefined ? '' : ` (called at line ${s.callLine})`}: '${r.path}' accepts ${r.max}, got [${r.operands.join(', ')}]`]
        : []
    );
    expect(
      over,
      'commander 14 rejects surplus operands (allowExcessArguments=false) — drop the extra operand or an argv prefix the array should not carry'
    ).toEqual([]);
  });
});
