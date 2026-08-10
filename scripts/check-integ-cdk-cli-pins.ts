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
 *   1. its package.json pins `aws-cdk` (dependencies or devDependencies);
 *   2. its verify.sh has an install step (`npm install` / `pnpm install` /
 *      `vp install`), so a gitignored node_modules cannot leave the pin
 *      inert; and
 *   3. every invocation resolves the fixture-local CLI: either the script
 *      PATH-prepends `<fixture>/node_modules/.bin`, or every invocation goes
 *      through an explicit `${...CDK_BIN...}` variable that is defined to
 *      point at a `node_modules/.bin/cdk`.
 *
 * Out of scope (not upstream-cdk invocations): `cdkd`, `cdk-local`, prose in
 * comments and echo/printf strings (matching is command-position only).
 */

const CDK_VERBS =
  'deploy|synth|synthesize|bootstrap|destroy|diff|migrate|import|watch|ls|list|context|acknowledge|doctor|version|--version';

/** Segments of a line that sit in command position (after ; & | ( ` and $( ). */
function commandSegments(line: string): string[] {
  return line
    .split(/(?:\$\(|[;&|()`])+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Strip leading inline env-var assignments (`FOO=bar BAZ=qux cmd ...`). */
function stripEnvAssignments(segment: string): string {
  return segment.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+)+/, '');
}

export interface CdkCliUsage {
  /** bare `cdk <verb>` invocations in command position */
  bareInvocations: number;
  /** `npx cdk <verb>` invocations */
  npxInvocations: number;
  /** `"${...CDK_BIN...}" <verb>` invocations */
  explicitBinInvocations: number;
  /** `export PATH="<...>/node_modules/.bin:${PATH}"` present */
  hasPathPrepend: boolean;
  /** an `npm install` / `pnpm install` / `vp install` step present */
  hasInstallStep: boolean;
  /** every `*CDK_BIN*` variable used is defined to a node_modules/.bin/cdk */
  cdkBinPointsAtLocalBin: boolean;
}

export function classifyCdkCliUsage(script: string): CdkCliUsage {
  const joined = script.replace(/\\\n\s*/g, ' ');
  const lines = joined.split('\n').filter((l) => !/^\s*#/.test(l));

  let bare = 0;
  let npx = 0;
  let explicitBin = 0;
  const binVarsUsed = new Set<string>();
  const binVarsLocal = new Set<string>();

  const verbRe = new RegExp(`^cdk\\s+(?:${CDK_VERBS})\\b`);
  const npxRe = new RegExp(`^npx\\s+cdk\\s+(?:${CDK_VERBS})\\b`);
  const binRe = new RegExp(`^"?\\$\\{?(\\w*CDK_BIN\\w*)\\}?"?\\s+(?:${CDK_VERBS})\\b`);

  for (const line of lines) {
    const defMatch = line.match(/(\w*CDK_BIN\w*)=["']?[^"'\n]*node_modules\/\.bin\/cdk/);
    if (defMatch) binVarsLocal.add(defMatch[1]);

    for (const rawSegment of commandSegments(line)) {
      const segment = stripEnvAssignments(rawSegment);
      // echo/printf arguments are prose, not invocations
      if (/^(echo|printf)\b/.test(segment)) continue;
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

  const hasPathPrepend = /export\s+PATH=["']?[^"'\n]*node_modules\/\.bin:/.test(joined);
  const hasInstallStep = /\b(?:npm|pnpm|vp)\s+install\b/.test(joined);
  const cdkBinPointsAtLocalBin =
    binVarsUsed.size > 0 && [...binVarsUsed].every((v) => binVarsLocal.has(v));

  return {
    bareInvocations: bare,
    npxInvocations: npx,
    explicitBinInvocations: explicitBin,
    hasPathPrepend,
    hasInstallStep,
    cdkBinPointsAtLocalBin,
  };
}

export interface FixtureVerdict extends CdkCliUsage {
  invokesUpstreamCdk: boolean;
  hasAwsCdkPin: boolean;
  /** empty when compliant (or when the fixture never invokes upstream cdk) */
  violations: string[];
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
      hasAwsCdkPin =
        typeof (pkg.dependencies?.['aws-cdk'] ?? pkg.devDependencies?.['aws-cdk']) ===
        'string';
    } catch {
      hasAwsCdkPin = false;
    }
  }

  const violations: string[] = [];
  if (invokes) {
    if (!hasAwsCdkPin) {
      violations.push('invokes the upstream cdk CLI but package.json does not pin aws-cdk');
    }
    if (!usage.hasInstallStep) {
      violations.push('no install step (npm/pnpm/vp install) — a gitignored node_modules leaves the pin inert');
    }
    const bareOrNpx = usage.bareInvocations + usage.npxInvocations > 0;
    if (bareOrNpx && !usage.hasPathPrepend) {
      violations.push(
        'bare/npx cdk invocation without `export PATH="<fixture>/node_modules/.bin:${PATH}"` — resolution can fall through to a stale global cdk',
      );
    }
    if (!bareOrNpx && usage.explicitBinInvocations > 0 && !usage.cdkBinPointsAtLocalBin && !usage.hasPathPrepend) {
      violations.push('CDK_BIN-style invocation whose variable is not defined to a node_modules/.bin/cdk');
    }
  }

  return { ...usage, invokesUpstreamCdk: invokes, hasAwsCdkPin, violations };
}
