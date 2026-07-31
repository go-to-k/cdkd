/**
 * Classifier for hardcoded Lambda published-version literals in integ-fixture
 * `verify.sh` scripts (issue #1324).
 *
 * Lambda version counters are monotonic per function NAME (and per layer
 * name) and never reset — not even across a delete + re-create. A fixture
 * with a fixed function name that probes `"${FN}:1"` or asserts an alias's
 * `FunctionVersion` equals `"2"` therefore passes exactly once (the first run
 * ever in the account) and fails on every re-run with
 * ResourceNotFoundException while the deploy itself is clean. Three fixtures
 * shipped this trap (`lambda-versioning`, `lambda-layer-version-update`,
 * `lambda-snapstart`); the convention lived only in session memory, which
 * does not protect new fixtures — hence this lint.
 *
 * The correct shapes (see `codedeploy-lambda-deployment-group/verify.sh` and
 * `lambda-snapstart/verify.sh` for reference implementations):
 *
 *   - read the published version N from the live alias
 *     (`--query 'FunctionVersion'`), guard it is numeric, and qualify probes
 *     with `"${FN}:${N}"`;
 *   - assert rotation relatively: `EXPECTED=$((N + 1))`, compare against
 *     `"${EXPECTED}"` — never against a numeric literal.
 *
 * What this classifier flags (violations):
 *   1. `literal-qualifier` — an `aws lambda` invocation whose
 *      `--function-name` / `--qualifier` value carries an all-digits literal
 *      qualifier (`"${FN}:1"`, `arn:...:function:fn:3`, `--qualifier 5`).
 *   2. `literal-version-number` — an `aws lambda` invocation passing a
 *      digits-literal `--version-number` (layer versions are monotonic per
 *      layer name the same way).
 *   3. `literal-compare` — a test-bracket comparison of a variable captured
 *      from a version-ish `aws lambda --query` (e.g. `FunctionVersion`)
 *      against an integer literal (`[ "${V}" != "2" ]`, `[ "$V" -eq 1 ]`).
 *
 * What stays legal:
 *   - variable qualifiers (`"${FN}:${V}"`) and alias-name qualifiers
 *     (`"${FN}:live"`, `"${FN}:$LATEST"`) — alias names are stable;
 *   - relative compares (`!= "${EXPECTED_V2}"`) and numeric-format guards
 *     (`case "${V}" in ''|*[!0-9]*)`);
 *   - non-lambda commands (`aws appconfig ... --version-number "${v}"` uses
 *     an API whose version ids the fixture itself enumerated);
 *   - a line carrying `# allow-version-literal: <reason>` — the escape hatch
 *     for genuinely fixed versions (e.g. a public cross-account layer ARN
 *     whose version is pinned by its owner, not by this account's counter).
 *
 * This module is separate from the test so the classifier can be table-tested
 * against synthetic script shapes rather than only against today's tree, per
 * the checker rules in `.claude/rules/testing.md`.
 */

const ALLOW_COMMENT = 'allow-version-literal';

export type VersionLiteralKind =
  | 'literal-qualifier'
  | 'literal-version-number'
  | 'literal-compare';

export interface VersionLiteralFinding {
  kind: VersionLiteralKind;
  /** The joined statement the finding was made on (for the failure report). */
  text: string;
}

export interface VersionLiteralClassification {
  findings: VersionLiteralFinding[];
  /**
   * Coverage counters — "0 violations" and "parsed nothing" are
   * indistinguishable without them (see `.claude/rules/testing.md`,
   * "A checker must prove it sees its input").
   */
  /** `aws lambda` args carrying ANY qualifier (`--function-name "x:q"` / `--qualifier q`). */
  lambdaQualifierArgs: number;
  /** ...of which the qualifier is variable-driven (`:${V}`, `:$LATEST`). */
  variableQualifierArgs: number;
  /** ...of which the qualifier is a non-numeric literal (alias names like `:live`). */
  aliasLiteralQualifierArgs: number;
  /** `aws lambda ... --version-number` args seen (variable or literal). */
  versionNumberArgs: number;
  /** Variables captured from a version-ish `aws lambda --query`. */
  versionCaptureVars: string[];
  /** Test-bracket comparisons involving a captured version variable. */
  versionCaptureCompares: number;
}

/**
 * Joins backslash-continued lines into single statements so a line-oriented
 * scan cannot miss a qualifier or `--query` that lands on a continuation
 * line (the dominant multi-line shape in the fixture tree).
 */
export function joinContinuedLines(content: string): string[] {
  const lines = content.split('\n');
  const joined: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    while (line.endsWith('\\') && i + 1 < lines.length) {
      line = `${line.slice(0, -1).trimEnd()} ${lines[++i]!.trim()}`;
    }
    joined.push(line);
  }
  return joined;
}

/** The value token following a long option: `--opt value` or `--opt "value"`. */
function optionValue(statement: string, option: string): string | null {
  const m = new RegExp(`${option}[= ]+("([^"]*)"|'([^']*)'|([^\\s'"]+))`).exec(statement);
  if (!m) return null;
  return m[2] ?? m[3] ?? m[4] ?? null;
}

const ALL_DIGITS = /^[0-9]+$/;
const HAS_VARIABLE = /\$/;

/**
 * Version-ish `--query` expressions. `FunctionVersion` (get-alias /
 * get-function-configuration), a trailing `Version` field (publish-version,
 * get-layer-version), or `LatestMatchingVersion.Version`-style paths. A
 * `length(...)` query is a COUNT, not a version — excluded so asserting
 * "exactly 2 versions exist" stays legal.
 */
function isVersionishQuery(query: string): boolean {
  if (/length\s*\(/.test(query)) return false;
  return /(^|\.|\[)FunctionVersion($|\W)|(^|\.)Version($|\W)/.test(query);
}

export function classifyVerifyScript(content: string): VersionLiteralClassification {
  const statements = joinContinuedLines(content);
  const findings: VersionLiteralFinding[] = [];

  let lambdaQualifierArgs = 0;
  let variableQualifierArgs = 0;
  let aliasLiteralQualifierArgs = 0;
  let versionNumberArgs = 0;
  const versionCaptureVars: string[] = [];
  let versionCaptureCompares = 0;

  const classifyQualifier = (statement: string, qualifier: string) => {
    lambdaQualifierArgs++;
    if (ALL_DIGITS.test(qualifier)) {
      if (!statement.includes(ALLOW_COMMENT)) {
        findings.push({ kind: 'literal-qualifier', text: statement.trim() });
      }
    } else if (HAS_VARIABLE.test(qualifier)) {
      variableQualifierArgs++;
    } else {
      aliasLiteralQualifierArgs++;
    }
  };

  for (const statement of statements) {
    if (!/\baws\s+lambda\s/.test(statement)) continue;

    const functionName = optionValue(statement, '--function-name');
    if (functionName && functionName.includes(':')) {
      // The qualifier is the segment after the LAST colon — this reads both
      // `"${FN}:1"` and a full ARN `arn:...:function:name:1` correctly. A
      // colon inside a variable expansion (`"${FN:-x}"`) is not a qualifier.
      const qualifier = functionName.slice(functionName.lastIndexOf(':') + 1);
      const beforeQualifier = functionName.slice(0, functionName.lastIndexOf(':'));
      const insideExpansion = /\$\{[^}]*$/.test(beforeQualifier);
      if (qualifier.length > 0 && !insideExpansion) classifyQualifier(statement, qualifier);
    }

    const qualifierOpt = optionValue(statement, '--qualifier');
    if (qualifierOpt) classifyQualifier(statement, qualifierOpt);

    const versionNumber = optionValue(statement, '--version-number');
    if (versionNumber) {
      versionNumberArgs++;
      if (ALL_DIGITS.test(versionNumber) && !statement.includes(ALLOW_COMMENT)) {
        findings.push({ kind: 'literal-version-number', text: statement.trim() });
      }
    }

    // Track variables captured from version-ish queries:
    //   VAR="$(aws lambda get-alias ... --query 'FunctionVersion' ...)"
    const capture = /^\s*(?:local\s+)?([A-Za-z_][A-Za-z0-9_]*)=["']?\$\(\s*aws\s+lambda\s/.exec(
      statement,
    );
    if (capture) {
      const query = optionValue(statement, '--query');
      if (query && isVersionishQuery(query)) versionCaptureVars.push(capture[1]!);
    }
  }

  // Second pass: comparisons of captured version variables.
  for (const statement of statements) {
    for (const varName of versionCaptureVars) {
      const varRef = `"?\\$\\{?${varName}\\}?"?`;
      const compare = new RegExp(
        `\\[\\[?\\s+${varRef}\\s+(!=|==|=|-eq|-ne|-gt|-ge|-lt|-le)\\s+("?)([^\\s\\]]+)\\2\\s+\\]?\\]`,
      ).exec(statement);
      if (!compare) continue;
      versionCaptureCompares++;
      if (ALL_DIGITS.test(compare[3]!) && !statement.includes(ALLOW_COMMENT)) {
        findings.push({ kind: 'literal-compare', text: statement.trim() });
      }
    }
  }

  return {
    findings,
    lambdaQualifierArgs,
    variableQualifierArgs,
    aliasLiteralQualifierArgs,
    versionNumberArgs,
    versionCaptureVars,
    versionCaptureCompares,
  };
}
