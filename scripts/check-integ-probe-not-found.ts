/**
 * Classifier for the integ-fixture `verify.sh` gone-probe convention (#1097
 * pattern 2).
 *
 * A "resource is gone after destroy" assertion built on a silenced AWS CLI
 * read probe cannot distinguish not-found from any other failure:
 *
 *   if aws lambda get-function ... >/dev/null 2>&1; then
 *     echo "FAIL: ... still exists" >&2; exit 1
 *   fi
 *
 * reads ANY probe failure (throttle, expired credentials, network) as "gone"
 * and silently passes the leak assertion. The inverse spelling
 * `if ! aws <probe> ...; then <conclude gone>` is the same bug, and so are the
 * list-operator spellings `aws <probe> ... && { FAIL still exists; }` and
 * `aws <probe> ... || { GONE=1; break; }`. The correct form routes the probe
 * through the canonical helpers, which grep the error
 * text for a not-found signature and hard-FAIL on anything else:
 *
 *   assert_gone "<leak description>" aws <service> <read-verb> [args...]
 *   if ! gone_probe aws <service> <read-verb> [args...]; then ...; fi
 *
 * Only READ-verb probes used as existence checks are in scope
 * (describe|get|head|list|batch-get, plus `aws s3 ls`): a mutation like
 * `if ! aws fsx delete-backup ...` legitimately treats non-zero as "the
 * delete failed" and must not be flagged. The one exception: a silenced
 * `aws <service> \${var}` in condition / list-operator position cannot be
 * verb-classified at all and is flagged outright (variableVerbProbes) --
 * route it through the helpers or use literal verbs.
 *
 * This module is separate from the test so the classifier can be table-tested
 * against synthetic script shapes rather than only against today's tree.
 */

/**
 * The ONE not-found signature every fixture must use verbatim (case-insensitive
 * grep -qiE). It matches the not-found error families of the services the
 * fixtures probe: `NotFound` / `Not Found` (generic, EC2 `*.NotFound`, S3 404
 * body), `NoSuch*` (S3, IAM NoSuchEntity, CloudFront, Route53), `does not
 * exist` / `*DoesNotExist*` (CloudFormation ValidationError, CodeDeploy,
 * Step Functions), `NonExistent*` (SQS NonExistentQueue), and `\(404` (s3api
 * head-object/head-bucket, whose error the AWS CLI spells "An error occurred
 * (404)" -- the open paren anchors it so a bare `404` embedded in an ARN or
 * request id inside a NON-not-found error text cannot match). Throttle / auth /
 * network error texts match none of these, so they surface as a hard FAIL
 * instead of a silent pass.
 */
export const CANONICAL_NOT_FOUND_REGEX =
  "'not ?found|no ?such|does ?not ?exist|non ?existent|\\(404'";

/**
 * The canonical helper block inserted into every fixture that asserts
 * "gone after destroy". Byte-identical across the tree so this checker can
 * verify it verbatim; edit it here and in every verify.sh together or the
 * `usesCanonicalHelperBlock` assertion fails.
 */
export const CANONICAL_HELPER_BLOCK = `# --- issue #1097 pattern 2: strict gone-probe helpers -----------------------
# A destroy/leak assertion must distinguish "not found" from any other probe
# failure (throttle, auth, network); a blind \`if aws ...; then\` reads ANY
# failure as "gone" and silently passes the leak check.
# gone_probe returns 0 when the probe fails with a not-found error (resource
# confirmed gone), 1 when the probe succeeds (resource still exists), and
# hard-FAILs the run on any other probe failure (undetermined result).
# The first-arg guard catches a forgotten assert_gone description: without it,
# \`assert_gone aws ...\` would exec \`lambda get-function ...\` and the shell's
# "command not found" error would match the signature -- a silent pass.
gone_probe() { # usage: gone_probe aws <service> <read-verb> [args...]
  [ "\${1:-}" = "aws" ] || { echo "FAIL: gone_probe: probe must start with aws (got: \${1:-<empty>})" >&2; exit 1; }
  local out
  if out="$("$@" 2>&1)"; then
    return 1
  fi
  if ! printf '%s' "\${out}" | grep -qiE ${CANONICAL_NOT_FOUND_REGEX}; then
    echo "FAIL: gone-probe undetermined ($*): \${out}" >&2
    exit 1
  fi
  return 0
}
assert_gone() { # usage: assert_gone "<leak description>" aws <service> <read-verb> [args...]
  local desc="\$1"
  shift
  if ! gone_probe "$@"; then
    echo "FAIL: \${desc}" >&2
    exit 1
  fi
}
# ---------------------------------------------------------------------------`;

/** A silenced blind probe the classifier flagged, with its 1-based line. */
export interface FlaggedProbe {
  line: number;
  text: string;
}

export interface ProbeClassification {
  /**
   * Form B: `if/elif aws <read-probe> ... [stderr discarded]; then` whose
   * then-branch is a leak assertion (matches leak wording). The probe's error
   * path falls into the else-branch and reports "gone" on a throttle.
   */
  blindLeakAsserts: FlaggedProbe[];
  /**
   * Form A: `if/elif ! aws <read-probe> ... [stderr discarded]; then` whose
   * then-branch concludes "gone" (no fail/exit/return-nonzero) -- ANY probe
   * failure is read as success.
   */
  blindGoneConcludes: FlaggedProbe[];
  /**
   * A `while` / `until` loop driven directly by a silenced read probe -- a
   * wait-until-gone poll that a throttle terminates as "gone". Loops must go
   * through `gone_probe` (or capture + inspect the error text) instead.
   */
  blindProbeLoops: FlaggedProbe[];
  /**
   * A silenced `aws <service> \${var}` / `aws "$var" ...` in condition or
   * list-operator position: the verb cannot be classified statically, so the
   * probe must go through the helpers (or use literal verbs) regardless of
   * what the branch concludes.
   */
  variableVerbProbes: FlaggedProbe[];
  /**
   * Capture form (issue #1120 item 1): a `$(aws <read-verb> ...)` command
   * substitution whose probe error cannot fail loudly, so a throttle is
   * indistinguishable from "0 remaining" / "None" / empty -- the same
   * silent-pass defect as a blind gone-probe, in statement positions the
   * condition-oriented categories never scan. The signature: an
   * error-swallowing fallback (`|| echo <literal>` / `|| true`) attached to
   * the capture (inside the substitution or immediately after it) without
   * routing stderr INTO the capture.
   *
   * NOT flagged:
   *
   * - a plain `VAR=$(aws ... 2>/dev/null)` assignment with no fallback --
   *   `set -e` hard-fails the script on a probe error (loudly, if mutely;
   *   only the diagnostic is lost), and a silenced `for x in $(aws ...)`
   *   cleanup sweep -- best-effort cleanup is out of scope per the existing
   *   convention;
   * - the strict stderr-capture idiom (`$(cmd 2>&1 >/dev/null || true)` /
   *   `$(aws s3 ls ... 2>&1 || true)`), where the error text lands IN the
   *   value for inspection.
   *
   * Captures inside a best-effort `set +e` cleanup span are exempt (see
   * {@link computeExemptLines}).
   */
  blindCaptureProbes: FlaggedProbe[];
  /**
   * Function-wrapper form (issue #1120 item 2, the cheap variant -- no
   * call-site dataflow): a function body containing a silenced
   * `aws <read-verb>` probe in bare-statement position whose error cannot
   * fail loudly at any call site. Two wrapper shapes:
   *
   * - the exit-status wrapper (`ssm_exists() { aws ssm get-parameter ...
   *   >/dev/null 2>&1; }`): stdout AND stderr discarded, so the only
   *   consumable is the exit status -- at the call site a throttle reads as
   *   "gone" (the shape #1110 fixed by hand six times);
   * - the value wrapper with a swallow tail (`find_x() { aws ... --output
   *   text 2>/dev/null || true; }`): a probe error yields empty output and
   *   exit 0, so `$(find_x)` silently returns "" for a throttle.
   *
   * A tail-less value wrapper (`aws ... --output text 2>/dev/null` as the
   * body) is NOT flagged: `$(fn)` propagates the probe's non-zero exit and
   * `set -e` fails the script loudly. Condition / `&&`-branch spellings
   * inside functions are left to the condition-oriented categories; the
   * canonical helper block and `set +e` cleanup spans are exempt.
   */
  silencedFunctionProbes: FlaggedProbe[];
  /** Calls assert_gone or gone_probe somewhere. */
  usesHelpers: boolean;
  /** Contains CANONICAL_HELPER_BLOCK verbatim. */
  hasCanonicalHelperBlock: boolean;
  /**
   * Occurrences of the `not ?found` grep alternation OUTSIDE the canonical
   * regex string -- a drifted / partial copy of the not-found signature.
   */
  nonCanonicalNotFoundGreps: FlaggedProbe[];
}

/**
 * Joins backslash-continuation lines so a multi-line probe condition cannot
 * hide from a line-oriented scan (the pattern-1 sweep learned this the hard
 * way with a multi-line `trap`). Line numbers reported for a joined statement
 * are the number of its FIRST physical line.
 */
export function joinContinuationLines(content: string): Array<{ line: number; text: string }> {
  const lines = content.split('\n');
  const joined: Array<{ line: number; text: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const start = i;
    let text = lines[i]!;
    while (/\\$/.test(text) && i + 1 < lines.length) {
      i++;
      text = text.replace(/\\$/, ' ') + lines[i]!.trim();
    }
    joined.push({ line: start + 1, text });
  }
  return joined;
}

const READ_VERB = /^(describe|get|head|list|batch-get)/;

/**
 * The statement discards stderr (`2>&1` after `>/dev/null`, `2>/dev/null`, or
 * `&>/dev/null`, each with optional space before `/dev/null`) -- the property
 * that makes not-found indistinguishable from a throttle.
 */
function isSilenced(cmd: string): boolean {
  return /(>\s*\/dev\/null\s+2>&1|2>\s*\/dev\/null|&>\s*\/dev\/null|2>&1\s*>\s*\/dev\/null)/.test(
    cmd,
  );
}

/**
 * Matches `aws <service> <verb> ...` where the verb is a read probe and the
 * statement is silenced (see {@link isSilenced}).
 */
function isSilencedReadProbe(cmd: string): boolean {
  const m = /^aws\s+([a-z0-9-]+)\s+([a-z0-9-]+)\b/.exec(cmd);
  if (!m) return false;
  const isRead = m[1] === 's3' ? m[2] === 'ls' : READ_VERB.test(m[2]!);
  if (!isRead) return false;
  return isSilenced(cmd);
}

/**
 * Matches a silenced `aws` invocation whose service or verb position is a
 * shell VARIABLE (`aws glue \${chk} ...`, `aws "$svc" describe ...`): the
 * probe cannot be verb-classified statically, so using it silenced in a
 * condition / list-operator position is banned outright -- route it through
 * gone_probe / assert_gone or restructure with literal verbs instead
 * (glue-update-hardening's destroy loop evaded the classifier exactly this
 * way).
 */
function isSilencedVariableVerbProbe(cmd: string): boolean {
  if (!/^aws\s/.test(cmd)) return false;
  if (!isSilenced(cmd)) return false;
  return /^aws\s+(?:"?\$|[a-z0-9-]+\s+"?\$)/.test(cmd);
}

/** `aws <service> <verb>` with a literal read verb (or `aws s3 ls`). */
function isReadVerbAwsCommand(cmd: string): boolean {
  const m = /^aws\s+([a-z0-9-]+)\s+([a-z0-9-]+)\b/.exec(cmd);
  if (!m) return false;
  return m[1] === 's3' ? m[2] === 'ls' : READ_VERB.test(m[2]!);
}

/** An `|| echo ...` / `|| true` / `|| printf ...` / `|| :` swallow tail. */
function hasSwallowFallback(cmd: string): boolean {
  return /\|\|\s*(echo\b|true\b|printf\b|:)/.test(cmd);
}

/** Stderr is routed into the capture (bare `2>&1`, not redirected onward). */
function capturesStderr(cmd: string): boolean {
  return /2>&1/.test(cmd) && !/>\s*\/dev\/null\s+2>&1/.test(cmd);
}

/**
 * Extracts every `$( ... )` command-substitution body from a (joined) line,
 * balancing parentheses so nested substitutions and JMESPath calls like
 * `length(Items)` do not truncate the extraction. Nested `$( ... )` regions
 * are masked out of the RETURNED text so an inner capture's redirections are
 * never attributed to the outer one (each nested body is also returned as its
 * own entry).
 */
export function extractCommandSubstitutions(
  text: string,
): Array<{ body: string; end: number }> {
  const bodies: Array<{ body: string; end: number }> = [];
  for (let i = 0; i < text.length - 1; i++) {
    if (text[i] !== '$' || text[i + 1] !== '(') continue;
    let depth = 1;
    let j = i + 2;
    for (; j < text.length && depth > 0; j++) {
      if (text[j] === '(') depth++;
      else if (text[j] === ')') depth--;
    }
    if (depth !== 0) continue;
    const body = text.slice(i + 2, j - 1);
    // Mask nested substitutions (they are scanned as their own entries).
    let masked = '';
    let d = 0;
    for (let k = 0; k < body.length; k++) {
      if (d === 0 && body[k] === '$' && body[k + 1] === '(') {
        d = 1;
        k++;
        masked += '__NESTED__';
        continue;
      }
      if (d > 0) {
        if (body[k] === '(') d++;
        else if (body[k] === ')') d--;
        continue;
      }
      masked += body[k];
    }
    bodies.push({ body: masked, end: j });
  }
  return bodies;
}


/**
 * Function-definition ranges: `name() {` (optionally `function name() {`)
 * through the closing `}` at the header's indent. Returns [start, end]
 * INDEX pairs into the joined-lines array (inclusive, header and close).
 */
export function findFunctionRanges(
  joined: Array<{ line: number; text: string }>,
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < joined.length; i++) {
    const m = /^(\s*)(?:function\s+)?[A-Za-z_][A-Za-z0-9_-]*\s*\(\)\s*\{/.exec(joined[i]!.text);
    if (!m) continue;
    const indent = m[1]!;
    for (let j = i + 1; j < joined.length; j++) {
      if (new RegExp(`^${indent}\\}\\s*(#.*)?$`).test(joined[j]!.text)) {
        ranges.push({ start: i, end: j });
        break;
      }
    }
  }
  return ranges;
}

/**
 * Lines exempt from the capture-form / function-wrapper categories:
 *
 * - Best-effort `set +e[u]` ... `set -e[u]` spans (the cleanup convention:
 *   probe errors legitimately must not kill the script there). A span opened
 *   inside a function is bounded by that function's closing brace, so an
 *   unrestored `set +e` in a cleanup handler that ends with `exit` cannot
 *   exempt the live-phase code after the function.
 * - The canonical helper block's own lines (located verbatim, per the
 *   byte-identical contract).
 */
export function computeExemptLines(
  content: string,
  joined: Array<{ line: number; text: string }>,
  functionRanges: Array<{ start: number; end: number }>,
): boolean[] {
  const exempt = new Array<boolean>(joined.length).fill(false);

  const enclosingEnd = (idx: number): number => {
    let best = joined.length - 1;
    for (const { start, end } of functionRanges) {
      if (idx > start && idx < end && end < best) best = end;
    }
    return best;
  };
  for (let i = 0; i < joined.length; i++) {
    if (!/^\s*set\s+\+[a-zA-Z]*e/.test(joined[i]!.text)) continue;
    const bound = enclosingEnd(i);
    for (let j = i; j <= bound; j++) {
      exempt[j] = true;
      if (j > i && /^\s*set\s+-[a-zA-Z]*e/.test(joined[j]!.text)) break;
    }
  }

  const blockStart = content.indexOf(CANONICAL_HELPER_BLOCK);
  if (blockStart !== -1) {
    const firstLine = content.slice(0, blockStart).split('\n').length; // 1-based
    const blockLines = CANONICAL_HELPER_BLOCK.split('\n').length;
    for (let i = 0; i < joined.length; i++) {
      const n = joined[i]!.line;
      if (n >= firstLine && n < firstLine + blockLines) exempt[i] = true;
    }
  }
  return exempt;
}

/** Wording that marks a then-branch as a leak/gone assertion. */
const LEAK_WORDING =
  /still (exists|present|remains|reachable|alive)|\bremains\b|orphan|leak(ed|s)?\b|appeared|survived|was created|should not (exist|happen)/i;

/** Body signals that a branch fails loudly rather than concluding success. */
const FAILS_LOUDLY = /\bexit 1\b|\bfail\b|\bFAIL\b|\breturn 1\b/;

export function classifyVerifyScript(content: string): ProbeClassification {
  const joined = joinContinuationLines(content);
  const blindLeakAsserts: FlaggedProbe[] = [];
  const blindGoneConcludes: FlaggedProbe[] = [];
  const blindProbeLoops: FlaggedProbe[] = [];
  const variableVerbProbes: FlaggedProbe[] = [];

  for (let i = 0; i < joined.length; i++) {
    const { line, text } = joined[i]!;

    // Statement forms: `aws <probe> ... && <leak assert>` (Form B) and
    // `aws <probe> ... || <conclude gone>` (Form A). The probe must be in
    // statement position (line starts with it), so probes inside an
    // `if [ ... ] && { aws ...; }` compound guard are not matched here.
    const sm =
      /^\s*(aws\s.*?(?:>\s*\/dev\/null\s+2>&1|2>\s*\/dev\/null|&>\s*\/dev\/null|2>&1\s*>\s*\/dev\/null))\s*(&&|\|\|)\s*(.*)$/.exec(
        text,
      );
    if (sm && isSilencedVariableVerbProbe(sm[1]!.trim())) {
      variableVerbProbes.push({ line, text: text.trim() });
      continue;
    }
    if (sm && isSilencedReadProbe(sm[1]!.trim())) {
      // Branch text: the rest of the line, plus the `{ ... }` block when the
      // line opens one.
      let branch = sm[3]!;
      if (/\{\s*$/.test(branch)) {
        for (let j = i + 1; j < joined.length; j++) {
          branch += '\n' + joined[j]!.text;
          if (/^\s*\}/.test(joined[j]!.text)) break;
        }
      }
      if (sm[2] === '&&') {
        if (LEAK_WORDING.test(branch)) blindLeakAsserts.push({ line, text: text.trim() });
      } else {
        const concludesGone = /\b[A-Za-z_]+=1\b|\bbreak\b|\bcontinue\b/.test(branch) || LEAK_WORDING.test(branch);
        if (concludesGone && !FAILS_LOUDLY.test(branch)) {
          blindGoneConcludes.push({ line, text: text.trim() });
        }
      }
      continue;
    }

    const m = /^\s*(if|elif|while|until)\s+(!\s+)?(aws\s.*?);?\s*(then|do)\s*$/.exec(text);
    if (!m) continue;
    const [, kw, neg, cmd] = m;
    if (!isSilencedReadProbe(cmd!.trim())) {
      if (isSilencedVariableVerbProbe(cmd!.trim())) {
        variableVerbProbes.push({ line, text: text.trim() });
      }
      continue;
    }

    if (kw === 'while' || kw === 'until') {
      blindProbeLoops.push({ line, text: text.trim() });
      continue;
    }

    // Collect the then-branch: up to the matching `else` / `elif` / `fi`,
    // tracking nested if/fi so an inner block cannot end the scan early.
    const body: string[] = [];
    let depth = 0;
    for (let j = i + 1; j < joined.length; j++) {
      const t = joined[j]!.text;
      if (/^\s*if\b/.test(t)) depth++;
      if (/^\s*fi\b/.test(t)) {
        if (depth === 0) break;
        depth--;
      }
      if (depth === 0 && /^\s*(else|elif)\b/.test(t)) break;
      body.push(t);
      if (body.length > 30) break;
    }
    const bodyStr = body.join('\n');

    if (!neg) {
      if (LEAK_WORDING.test(bodyStr)) blindLeakAsserts.push({ line, text: text.trim() });
    } else {
      if (!FAILS_LOUDLY.test(bodyStr)) blindGoneConcludes.push({ line, text: text.trim() });
    }
  }

  // --- Capture-form + function-wrapper categories (issue #1120) ------------
  const functionRanges = findFunctionRanges(joined);
  const exempt = computeExemptLines(content, joined, functionRanges);

  const blindCaptureProbes: FlaggedProbe[] = [];
  for (let i = 0; i < joined.length; i++) {
    if (exempt[i]) continue;
    const { line, text } = joined[i]!;
    for (const { body, end } of extractCommandSubstitutions(text)) {
      const cmd = body.trim();
      if (!isReadVerbAwsCommand(cmd)) continue;
      // A swallow tail either inside the substitution or attached right
      // after it (`V=$(aws ...) || true`) makes the probe error unfailable.
      const tailAfter = /^\s*\|\|\s*(echo\b|true\b|printf\b|:)/.test(text.slice(end));
      const swallowed = (hasSwallowFallback(cmd) || tailAfter) && !capturesStderr(cmd);
      if (swallowed) {
        blindCaptureProbes.push({ line, text: text.trim() });
        break; // one flag per line is enough
      }
    }
  }

  const silencedFunctionProbes: FlaggedProbe[] = [];
  for (const { start, end } of functionRanges) {
    for (let i = start + 1; i < end; i++) {
      if (exempt[i]) continue;
      const { line, text } = joined[i]!;
      // Bare-statement position only: condition (`if`/`while`/...) and
      // `&&` / `|| {` branch spellings inside functions belong to the
      // condition-oriented categories above.
      const m = /^\s*(aws\s.*)$/.exec(text);
      if (!m) continue;
      let cmd = m[1]!.trim();
      // Peel a trailing swallow tail so `aws ... 2>/dev/null || true` is
      // still seen as a bare silenced probe; compound `&&` / `|| {` branch
      // forms are skipped (handled with branch semantics elsewhere).
      let hasSwallowTail = false;
      const tail = /^(.*?)(\|\||&&)(.*)$/.exec(cmd);
      if (tail) {
        if (tail[2] === '&&' || !/^\s*(true\b|echo\b|printf\b|:)/.test(tail[3]!)) continue;
        hasSwallowTail = true;
        cmd = tail[1]!.trim();
      }
      if (!isReadVerbAwsCommand(cmd)) continue;
      // Exit-status wrapper: fully silenced (stdout AND stderr discarded).
      const statusWrapper =
        /(>\s*\/dev\/null\s+2>&1|&>\s*\/dev\/null|2>&1\s*>\s*\/dev\/null)/.test(cmd) ||
        (/2>\s*\/dev\/null/.test(cmd) && /(?<![2&])>\s*\/dev\/null/.test(cmd));
      // Value wrapper: stderr silenced; only a swallow tail makes it
      // unfailable (tail-less value wrappers die loudly via set -e).
      const swallowedValueWrapper = /2>\s*\/dev\/null/.test(cmd) && hasSwallowTail;
      if (statusWrapper || swallowedValueWrapper) {
        silencedFunctionProbes.push({ line, text: text.trim() });
      }
    }
  }

  // Any not-found grep alternation must be the one canonical string.
  const nonCanonicalNotFoundGreps: FlaggedProbe[] = [];
  for (const { line, text } of joined) {
    if (/not \?found/.test(text) && !text.includes(CANONICAL_NOT_FOUND_REGEX)) {
      nonCanonicalNotFoundGreps.push({ line, text: text.trim() });
    }
  }

  const usesHelpers = /\b(assert_gone|gone_probe)\s/.test(content);
  return {
    blindLeakAsserts,
    blindGoneConcludes,
    blindProbeLoops,
    variableVerbProbes,
    blindCaptureProbes,
    silencedFunctionProbes,
    usesHelpers,
    hasCanonicalHelperBlock: content.includes(CANONICAL_HELPER_BLOCK),
    nonCanonicalNotFoundGreps,
  };
}
