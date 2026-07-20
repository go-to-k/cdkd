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
    usesHelpers,
    hasCanonicalHelperBlock: content.includes(CANONICAL_HELPER_BLOCK),
    nonCanonicalNotFoundGreps,
  };
}
