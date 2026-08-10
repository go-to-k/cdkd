/**
 * Classifier for issue 1485: integ fixtures that shell out to the upstream
 * `cdk` CLI must be hermetic about WHICH cdk they get.
 *
 * The failure class: a fixture pins `aws-cdk` in its package.json but its
 * verify.sh runs a bare `cdk deploy` (or an `npx cdk ...` with no local
 * install), so the pin is dead weight and the run silently takes whatever
 * global `cdk` the machine has. When the global CLI lags the fixture's
 * aws-cdk-lib, synth dies with a cloud-assembly schema-version mismatch —
 * `import-nested-stack` failed exactly this way on the 2026-08-10 staleness
 * sweep, seven weeks after PR 1253 fixed the same trap in three other
 * fixtures individually.
 *
 * A fixture that invokes the upstream cdk CLI is compliant when ALL of:
 *   1. its package.json pins `aws-cdk` at a real version range (`*` /
 *      `latest` re-admit the very skew this lint exists for, so they are
 *      rejected);
 *   2. its verify.sh installs the FIXTURE's own deps — a repo-root
 *      `(cd "${REPO_ROOT}" && pnpm install)`, which nearly every verify.sh
 *      already has, does not count;
 *   3. a conditional install carries a guard that tests for the cdk bin
 *      itself, so a `node_modules` left over from before the pin (present,
 *      but with no cdk) cannot skip the install. An UNCONDITIONAL install
 *      needs no guard — it is strictly more hermetic; and
 *   4. every invocation resolves the fixture-local CLI: either the script
 *      PATH-prepends `<fixture>/node_modules/.bin`, or every invocation goes
 *      through a `${...CDK_BIN...}` variable defined to a
 *      `node_modules/.bin/cdk`.
 *
 * Everything is evaluated on CODE, never on prose. The scanner strips
 * heredoc bodies and comments (including trailing ones), then splits each
 * line into command-position segments with a quote-aware walk, so a
 * `cdk deploy` inside an `echo "..."` / `grep "..."` argument — or a
 * `; cdk deploy` inside such a string — is not an invocation, and an
 * `npm install` mentioned in prose does not satisfy the install requirement.
 * `cdkd` / `cdk-local` are different binaries and are out of scope.
 */

const CDK_VERBS =
  'deploy|synth|synthesize|bootstrap|destroy|diff|migrate|import|watch|ls|list|context|acknowledge|doctor|version|gc|rollback|init|drift|notices|metadata|--version';

/** Commands whose arguments are prose/data rather than nested commands. */
const PROSE_COMMANDS =
  /^(?:echo|printf|grep|egrep|fgrep|cat|sed|awk|jq|python3?|node|comm|diff|read)\b/;

/** Join backslash continuations so one logical command is one line. */
function joinContinuations(script: string): string {
  return script.replace(/\\\n\s*/g, ' ');
}

/**
 * Drop heredoc bodies. A body is data — a `cdk deploy` line inside one is
 * not an invocation by this script, and an `npm install` inside one does not
 * install anything now.
 */
function stripHeredocs(script: string): string {
  const out: string[] = [];
  const lines = script.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    out.push(line);
    const m = line.match(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/);
    if (!m) continue;
    const terminator = m[1];
    const endRe = new RegExp(`^\\s*${terminator}\\s*$`);
    i += 1;
    while (i < lines.length && !endRe.test(lines[i])) i += 1;
    if (i < lines.length) out.push(lines[i]); // keep the terminator line
  }
  return out.join('\n');
}

/** Remove a `#` comment, honoring quote state (so `"a # b"` survives). */
function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '\\' && inDouble) {
      i += 1;
      continue;
    }
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble) {
      // `#` starts a comment only at the start of a word.
      if (i === 0 || /\s/.test(line[i - 1])) return line.slice(0, i);
    }
  }
  return line;
}

/**
 * Split a line into segments that start in COMMAND position, honoring quote
 * state so a separator inside a quoted argument does not open a new segment.
 */
function commandSegments(line: string): string[] {
  const segments: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '\\' && inDouble) {
      current += ch + (line[i + 1] ?? '');
      i += 1;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      continue;
    }
    if (!inSingle && !inDouble && /[;&|()`]/.test(ch)) {
      segments.push(current);
      current = '';
      continue;
    }
    if (!inSingle && !inDouble && ch === '$' && line[i + 1] === '(') {
      segments.push(current);
      current = '';
      i += 1;
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Strip leading tokens that keep the rest of the segment in command
 * position: shell keywords (`if ! cdk deploy`, `then cdk deploy`, ...),
 * negation, `time` / `timeout <n>` wrappers, and inline env-var assignments
 * (quoted values included: `FOO="a b" cdk deploy`).
 */
function stripToCommandWord(segment: string): string {
  let s = segment;
  let prev;
  do {
    prev = s;
    s = s.replace(/^\{\s+/, '');
    s = s.replace(/^(?:!|if|then|else|elif|do|while|until|time)\s+/, '');
    s = s.replace(/^timeout\s+(?:-\S+\s+)*\d+\S*\s+/, '');
    s = s.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, '');
  } while (s !== prev);
  return s;
}

export interface CdkCliUsage {
  /** bare `cdk <verb>` invocations in command position */
  bareInvocations: number;
  /** `npx cdk <verb>` / `pnpm exec cdk <verb>` / `yarn cdk <verb>` invocations */
  npxInvocations: number;
  /** `"${...CDK_BIN...}" <verb>` invocations */
  explicitBinInvocations: number;
  /** `export PATH="<...>/node_modules/.bin:${PATH}"` in code (not prose) */
  hasPathPrepend: boolean;
  /** an install of the FIXTURE's own deps (a repo-root install does not count) */
  hasFixtureInstall: boolean;
  /** the install is conditional (guarded / inside an `if`) rather than unconditional */
  installIsConditional: boolean;
  /** a guard testing for `<...>/node_modules/.bin/cdk` itself */
  hasCdkBinGuard: boolean;
  /** every `*CDK_BIN*` variable used is defined to a node_modules/.bin/cdk */
  cdkBinPointsAtLocalBin: boolean;
}

export function classifyCdkCliUsage(script: string): CdkCliUsage {
  const lines = stripHeredocs(joinContinuations(script))
    .split('\n')
    .map(stripComment)
    .filter((l) => l.trim().length > 0);

  let bare = 0;
  let npx = 0;
  let explicitBin = 0;
  let hasPathPrepend = false;
  let hasFixtureInstall = false;
  let installIsConditional = false;
  let hasCdkBinGuard = false;
  const binVarsUsed = new Set<string>();
  const binVarsLocal = new Set<string>();
  /** vars assigned a `<...>/node_modules/.bin` directory, e.g. BIN="${TEST_DIR}/node_modules/.bin" */
  const binDirVars = new Set<string>();

  // Global flags may sit between `cdk` and the verb, and their values may be
  // quoted with spaces (`cdk --app "node bin/app.ts" synth`).
  const verbRe = new RegExp(
    `^cdk\\s+(?:[-\\w]+\\s+(?:"[^"]*"|'[^']*'|\\S+)\\s+)*?(?:${CDK_VERBS})\\b`,
  );
  const npxRe = new RegExp(
    `^(?:npx(?:\\s+--\\S+)*|pnpm\\s+(?:exec|dlx)|npm\\s+exec|yarn(?:\\s+run)?)\\s+(?:aws-cdk@\\S+|cdk)\\s+(?:${CDK_VERBS})\\b`,
  );
  const binRe = new RegExp(`^"?\\$\\{?(\\w*CDK_BIN\\w*)\\}?"?\\s+(?:${CDK_VERBS})\\b`);

  /** Does this text reference a fixture-local node_modules/.bin[/cdk]? */
  const namesLocalBin = (text: string, suffix: string): boolean => {
    if (new RegExp(`node_modules/\\.bin${suffix}`).test(text)) return true;
    return [...binDirVars].some((v) =>
      new RegExp(`\\$\\{?${v}\\}?${suffix}`).test(text),
    );
  };

  for (const line of lines) {
    for (const rawSegment of commandSegments(line)) {
      const segment = stripToCommandWord(rawSegment);
      if (PROSE_COMMANDS.test(segment)) continue;

      // --- variable definitions -------------------------------------------
      const binDef = segment.match(/^(\w*CDK_BIN\w*)=["']?[^"'\n]*node_modules\/\.bin\/cdk/);
      if (binDef) binVarsLocal.add(binDef[1]);
      const dirDef = segment.match(/^(\w+)=["']?[^"'\n]*node_modules\/\.bin["']?\s*$/);
      if (dirDef) binDirVars.add(dirDef[1]);

      // --- hermeticity signals (code only) --------------------------------
      if (/^export\s+PATH=/.test(segment) && namesLocalBin(segment, ':')) {
        hasPathPrepend = true;
      }
      if (/^(?:\[\[?|test)\s/.test(segment) && /-[xfe]\s/.test(segment) && namesLocalBin(segment, '/cdk')) {
        hasCdkBinGuard = true;
      }
      if (/^command\s+-v\s+cdk\b/.test(segment)) hasCdkBinGuard = true;

      if (/^(?:npm|pnpm|yarn|vp)\s+(?:install|i)\b/.test(segment)) {
        // A repo-root install (the `(cd "${REPO_ROOT}" && pnpm install)` nearly
        // every verify.sh carries) installs the CLI's deps, not the fixture's.
        const rootScoped = /REPO_ROOT|ROOT_DIR/.test(rawSegment) || /REPO_ROOT|ROOT_DIR/.test(line);
        if (!rootScoped) {
          hasFixtureInstall = true;
          // Conditional when the install is the RHS of a `||`/`&&` guard or sits
          // inside an `if`/`while` block opener on the same logical line.
          if (/\|\||&&|^\s*(?:if|while|until)\b|;\s*then\b/.test(line)) {
            installIsConditional = true;
          }
        }
      }

      // --- invocations -----------------------------------------------------
      if (npxRe.test(segment)) {
        npx += 1;
      } else if (verbRe.test(segment)) {
        bare += 1;
      } else {
        const m = segment.match(binRe);
        if (m) {
          explicitBin += 1;
          binVarsUsed.add(m[1]);
        }
      }
    }
  }

  const cdkBinPointsAtLocalBin =
    binVarsUsed.size > 0 && [...binVarsUsed].every((v) => binVarsLocal.has(v));

  return {
    bareInvocations: bare,
    npxInvocations: npx,
    explicitBinInvocations: explicitBin,
    hasPathPrepend,
    hasFixtureInstall,
    installIsConditional,
    hasCdkBinGuard,
    cdkBinPointsAtLocalBin,
  };
}

export interface FixtureVerdict extends CdkCliUsage {
  invokesUpstreamCdk: boolean;
  hasAwsCdkPin: boolean;
  /** empty when compliant (or when the fixture never invokes upstream cdk) */
  violations: string[];
}

/** `*` / `latest` / `x` re-admit the version skew this lint exists for. */
function isRealVersionRange(spec: unknown): boolean {
  if (typeof spec !== 'string') return false;
  const s = spec.trim();
  if (s === '' || s === '*' || s === 'latest' || /^x(\.x)*$/i.test(s)) return false;
  return /\d/.test(s);
}

export function checkFixture(
  verifySh: string,
  packageJson: string | undefined,
): FixtureVerdict {
  const usage = classifyCdkCliUsage(verifySh);
  const invokes =
    usage.bareInvocations + usage.npxInvocations + usage.explicitBinInvocations > 0;

  let hasAwsCdkPin = false;
  if (packageJson !== undefined) {
    try {
      const pkg = JSON.parse(packageJson) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      hasAwsCdkPin = isRealVersionRange(
        pkg.dependencies?.['aws-cdk'] ?? pkg.devDependencies?.['aws-cdk'],
      );
    } catch {
      hasAwsCdkPin = false;
    }
  }

  const violations: string[] = [];
  if (invokes) {
    if (!hasAwsCdkPin) {
      violations.push(
        'invokes the upstream cdk CLI but package.json does not pin aws-cdk at a real version range',
      );
    }
    if (!usage.hasFixtureInstall) {
      violations.push(
        "no install of the FIXTURE's own deps — node_modules is gitignored and a repo-root install does not populate fixture dirs, so the pin stays inert",
      );
    } else if (usage.installIsConditional && !usage.hasCdkBinGuard) {
      violations.push(
        'the fixture install is conditional but its guard does not test for node_modules/.bin/cdk — a node_modules left over from before the pin skips the install',
      );
    }
    if (usage.bareInvocations + usage.npxInvocations > 0 && !usage.hasPathPrepend) {
      violations.push(
        'bare/npx cdk invocation without `export PATH="<fixture>/node_modules/.bin:${PATH}"` — resolution can fall through to a stale global cdk',
      );
    }
    // No PATH-prepend escape here: a CDK_BIN holding an absolute path is
    // resolved directly, so a prepended PATH does not redeem it.
    if (usage.explicitBinInvocations > 0 && !usage.cdkBinPointsAtLocalBin) {
      violations.push(
        'CDK_BIN-style invocation whose variable is not defined to a node_modules/.bin/cdk',
      );
    }
  }

  return { ...usage, invokesUpstreamCdk: invokes, hasAwsCdkPin, violations };
}
