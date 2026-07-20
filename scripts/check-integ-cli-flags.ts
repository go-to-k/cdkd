/**
 * Validates every `cdkd` CLI invocation in the integ fixtures' `verify.sh`
 * against the option set of the subcommand that actually declares the flag.
 *
 * Why this exists (issue #1097): a fixture passed `--region` to `cdkd import`.
 * `import` is the ONE command that never calls `addOption(deprecatedRegionOption)`
 * — `deploy`, `destroy`, `orphan`, `diff`, `drift`, `export`, `events`, `list`,
 * `synth` and every `state` subcommand all do — so the flag looked correct by
 * analogy with its neighbours and was wrong only there. The run died with
 * `error: unknown option '--region'`, which meant the import round-trip the
 * fixture exists to exercise had never executed once. A green typecheck says
 * nothing about whether a shell script's CLI invocations are real.
 *
 * Two existing things do NOT catch it:
 *   - `--help` output omits hidden options, so auditing by hand is unreliable.
 *   - `scripts/build-cli-flag-coverage-matrix.ts` parses `src/cli/options.ts`
 *     as a FLAT GLOBAL set. `--region` IS declared there; it is just never
 *     attached to `import`. Command attachment is exactly the dimension that
 *     matters, and that matrix does not model it.
 *
 * So the option set is read from the real Commander tree via
 * `buildProgram()` (`src/cli/program.ts`), which is the same tree `main()`
 * parses with.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';

export interface CommandSpec {
  /** Space-joined path, e.g. `deploy` or `state destroy`. */
  path: string;
  longFlags: Set<string>;
  shortFlags: Set<string>;
  /** Sub-command names (and aliases) reachable from here. */
  children: Set<string>;
}

/** Flattens a Commander tree into one spec per reachable command path. */
export function collectCommandSpecs(program: Command): Map<string, CommandSpec> {
  const specs = new Map<string, CommandSpec>();

  const walk = (cmd: Command, path: string[]): void => {
    const longFlags = new Set<string>();
    const shortFlags = new Set<string>();

    // `cmd.options` includes hidden options -- the whole point of reading the
    // tree rather than `--help`.
    for (const opt of cmd.options) {
      if (opt.long) {
        longFlags.add(opt.long);
        // Commander accepts `--no-foo` for a `--foo` boolean and vice versa.
        if (opt.long.startsWith('--no-')) longFlags.add(`--${opt.long.slice(5)}`);
        else longFlags.add(`--no-${opt.long.slice(2)}`);
      }
      if (opt.short) shortFlags.add(opt.short);
    }

    const children = new Set<string>();
    for (const sub of cmd.commands) {
      children.add(sub.name());
      for (const alias of sub.aliases()) children.add(alias);
    }

    // Commander's built-in help / version options are NOT in `cmd.options`.
    longFlags.add('--help');
    shortFlags.add('-h');
    if (path.length === 0) {
      longFlags.add('--version');
      shortFlags.add('-V');
    }

    // Program-level options are accepted on every subcommand, so the root is
    // seeded under the empty path and consulted as a fallback by the linter.
    specs.set(path.join(' '), { path: path.join(' '), longFlags, shortFlags, children });

    for (const sub of cmd.commands) {
      walk(sub, [...path, sub.name()]);
      for (const alias of sub.aliases()) {
        walk(sub, [...path, alias]);
      }
    }
  };

  walk(program, []);
  return specs;
}

export interface Invocation {
  /** 1-based line of the invocation's first line. */
  line: number;
  commandPath: string;
  longFlags: string[];
  raw: string;
}

/** Joins `\`-continued lines so a multi-line invocation parses as one. */
export function joinContinuedLines(content: string): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const startLine = i + 1;
    let text = lines[i]!;
    while (text.trimEnd().endsWith('\\') && i + 1 < lines.length) {
      text = `${text.trimEnd().slice(0, -1)} ${lines[++i]!}`;
    }
    out.push({ text, line: startLine });
  }

  return out;
}

/**
 * Names of shell variables in this script that hold a path to (or an
 * invocation of) `dist/cli.js` -- `CLI="node ${REPO_ROOT}/dist/cli.js"`,
 * `CDKD="node ../../../dist/cli.js"`, `LOCAL_DIST="${PWD}/../../../dist/cli.js"`.
 */
export function findCliVariables(content: string): Set<string> {
  const vars = new Set<string>();
  for (const m of content.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(["']?)([^"'\n]*)\2\s*$/gm)) {
    if (/cli\.js/.test(m[3]!)) vars.add(m[1]!);
  }
  return vars;
}

const KNOWN_SUBCOMMAND_START = /^[a-z][a-z0-9-]*$/;

/**
 * Shell context in which a command word may start: line start, a separator, a
 * subshell / command-substitution open paren, or a compound-command keyword.
 *
 * The trailing group absorbs any inline environment prefix — `FOO=bar cmd`,
 * `env -u FOO cmd`, or a run of both. cdkd's UPDATE-mode fixtures are written
 * as `CDKD_TEST_UPDATE=true node ../../dist/cli.js deploy ...`, so without this
 * the lint would silently skip precisely the invocations that exercise UPDATE.
 */
const ENV_PREFIX = String.raw`(?:\s*(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)|env(?:\s+-[iu]?\s*\S+)*)\s+)*`;
const CMD_START =
  String.raw`(?:^|[;&|(]|&&|\|\||\bif\b|\belif\b|\bthen\b|\bdo\b|\bwhile\b|\buntil\b|\$\()` +
  ENV_PREFIX;

/**
 * Strips shell punctuation a naive whitespace split leaves attached to a token
 * -- most commonly the `)` closing a `$( ... )` command substitution, which
 * otherwise reads as part of the flag name (`--json)`).
 */
function stripShellPunctuation(token: string): string {
  return token.replace(/[)\];&|"'`]+$/, '');
}

/**
 * Pulls each `cdkd` invocation out of a verify.sh, resolving the deepest
 * matching command path (so `state destroy` is checked against `state destroy`,
 * not `state`).
 */
export function extractInvocations(content: string, specs: Map<string, CommandSpec>): Invocation[] {
  const cliVars = findCliVariables(content);
  const invocations: Invocation[] = [];

  for (const { text, line } of joinContinuedLines(content)) {
    // Strip comments outside quotes (cheap approximation: a ` #` run).
    const stripped = text.replace(/\s#.*$/, '');

    // Find where the CLI invocation starts.
    let rest: string | null = null;
    const nodeMatch = new RegExp(
      `${CMD_START}\\s*node\\s+(?:"[^"]*"|'[^']*'|\\S+)\\s+(.*)$`,
    ).exec(stripped);
    if (
      nodeMatch &&
      /cli\.js/.test(
        stripped.slice(0, nodeMatch.index + nodeMatch[0].length - nodeMatch[1]!.length),
      )
    ) {
      rest = nodeMatch[1]!;
    } else {
      for (const v of cliVars) {
        const varMatch = new RegExp(
          `${CMD_START}\\s*(?:"?\\$\\{${v}\\}"?|"?\\$${v}"?)\\s+(.*)$`,
        ).exec(stripped);
        if (varMatch) {
          rest = varMatch[1]!;
          break;
        }
      }
    }
    if (rest === null) continue;

    const tokens = rest.split(/\s+/).map(stripShellPunctuation).filter(Boolean);
    if (tokens.length === 0) continue;

    // Resolve the deepest command path that exists in the tree.
    const pathParts: string[] = [];
    let idx = 0;
    while (idx < tokens.length) {
      const token = tokens[idx]!;
      if (!KNOWN_SUBCOMMAND_START.test(token)) break;
      const parent = specs.get(pathParts.join(' '));
      if (!parent || !parent.children.has(token)) break;
      pathParts.push(token);
      idx++;
    }
    if (pathParts.length === 0) continue;

    const longFlags = tokens
      .slice(idx)
      .filter((t) => t.startsWith('--') && t !== '--')
      .map((t) => t.split('=')[0]!)
      // A flag built from a shell variable cannot be checked statically.
      .filter((t) => !t.includes('$'));

    invocations.push({ line, commandPath: pathParts.join(' '), longFlags, raw: stripped.trim() });
  }

  return invocations;
}

export interface Violation {
  fixture: string;
  line: number;
  commandPath: string;
  flag: string;
  /** Other subcommands that DO declare this flag -- the actionable hint. */
  declaredOn: string[];
  raw: string;
}

export function lintScript(
  fixture: string,
  content: string,
  specs: Map<string, CommandSpec>,
): Violation[] {
  const globalFlags = specs.get('')?.longFlags ?? new Set<string>();
  const violations: Violation[] = [];

  for (const inv of extractInvocations(content, specs)) {
    const spec = specs.get(inv.commandPath);
    if (!spec) continue;

    for (const flag of inv.longFlags) {
      if (spec.longFlags.has(flag) || globalFlags.has(flag)) continue;

      const declaredOn = [...specs.entries()]
        .filter(([path, s]) => path !== '' && s.longFlags.has(flag))
        .map(([path]) => path)
        .sort();

      violations.push({
        fixture,
        line: inv.line,
        commandPath: inv.commandPath,
        flag,
        declaredOn,
        raw: inv.raw,
      });
    }
  }

  return violations;
}

export function lintFixtureTree(integRoot: string, specs: Map<string, CommandSpec>): Violation[] {
  return readdirSync(integRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(integRoot, e.name, 'verify.sh')))
    .flatMap((e) =>
      lintScript(e.name, readFileSync(join(integRoot, e.name, 'verify.sh'), 'utf8'), specs),
    );
}

export function formatViolation(v: Violation): string {
  const hint =
    v.declaredOn.length > 0
      ? `declared on: ${v.declaredOn.join(', ')} -- but NOT on \`${v.commandPath}\``
      : `not declared on any subcommand`;
  return `tests/integration/${v.fixture}/verify.sh:${v.line}\n  \`cdkd ${v.commandPath}\` does not accept \`${v.flag}\` (${hint})\n    ${v.raw}`;
}
