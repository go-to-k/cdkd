/**
 * The SUBJECT a CI convention check runs against: the text a GitHub event
 * carries, already decoded.
 *
 * ## Why this type exists at all
 *
 * The three checks that consume it replace three PreToolUse bash hooks
 * (`gh-body-english-gate.sh`, `issue-classification-label-gate.sh`,
 * `issue-dup-check-gate.sh`). Those hooks were 371-551 lines each and their
 * suites 380-916, and the overwhelming majority of both was ONE problem: a
 * PreToolUse hook is handed the raw SHELL COMMAND TEXT of a `gh` invocation and
 * has to locate the body inside it. That meant reimplementing pieces of a shell
 * parser --
 *
 *   - flag spellings: `--body`, `--body=`, `--body-file`, `--body-file=`,
 *     `-F <p>`, `-F<p>` glued, `-F body=@<p>`, `--field`, `--raw-field`,
 *     `--notes-file`, and the deliberately-unscanned short `-b` / `-t` / `-n`;
 *   - quoting: double, single, none, a quoted path CONTAINING A SPACE, a
 *     backslash-escaped path, ANSI-C `$'...'` in three escape families, and
 *     apostrophe-parity across a whole chained command;
 *   - heredocs: `cat > f <<EOF` and `cat <<EOF > f`, `<<-` with TAB-only
 *     stripping, an indented terminator that is body text, several heredocs
 *     writing one path, an EMPTY heredoc, and `>f<<EOF` / `>f;` / `>f&&`;
 *   - command position: `cd` before vs after the verb, `gh -C` / `-R` global
 *     flags, segment splitting on `&&` / `||` / `;` / `|` / newline /
 *     backslash-continuation, and a quoted MENTION of the gated command;
 *   - the write-vs-append distinction (`>` supersedes the file on disk, `>>`
 *     does not), because the hook runs BEFORE the command and the body file may
 *     not exist yet.
 *
 * NONE of that has a counterpart in CI. A workflow triggered on `issues` /
 * `issue_comment` / `pull_request` receives the body as a JSON string in the
 * event payload; there is no command, no quoting, no file, no heredoc. So all
 * of it is deleted rather than translated, and what is ported is the DETECTION
 * LOGIC each hook applied once it had the text.
 *
 * ## Where the text comes from, and why not from the event payload
 *
 * The payload is available, but `.github/workflows/pr-inherit-issue-labels.yml`
 * established the pattern this follows: PR- and issue-controlled text is
 * fetched SERVER-SIDE with `gh ... --json` and handed to the checker as a file,
 * never interpolated into a shell command with `${{ github.event... }}`. A body
 * containing `"; rm -rf …` is then just bytes in a JSON document. The workflow
 * builds this shape with `gh` + `jq`; the checkers only ever `JSON.parse` it.
 *
 * ## CRLF
 *
 * GitHub returns issue and PR bodies with `\r\n` line endings. The hooks never
 * saw that -- their input was a local file or a heredoc, both LF -- and two of
 * the three ported checks are LINE-anchored (`^…Dup-check:`, and the
 * `Severity:` scan is line-wise because `grep` is). Normalising here rather
 * than in each check keeps the three from drifting on it.
 */

/** Which GitHub object the text came from. Decides which fields are scanned. */
export type SubjectKind = 'issue' | 'issue_comment' | 'pull_request';

export interface Subject {
  kind: SubjectKind;
  /** Issue or PR number. Used only for reporting and for the comment target. */
  number: number;
  /** Absent on `issue_comment` -- a comment has no title. */
  title?: string;
  body: string;
  /** Current label names. Only the classification check reads them. */
  labels: string[];
  /** Optional html_url, for the report line only. */
  url?: string;
}

/** GitHub sends `body: null` for an empty body; `?? ''` is not cosmetic. */
function text(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\r\n?/g, '\n') : '';
}

/**
 * Parse the subject document the workflow builds.
 *
 * Deliberately TOTAL: every field has a defined fallback, because a missing
 * field must not make a check crash and thereby report nothing. "The check
 * silently found nothing" is the failure mode these ports exist to avoid, so an
 * unparseable document throws (loud) while a well-formed document with a null
 * body yields an empty string (checked, and for the dup-check, a violation).
 */
export function parseSubject(json: string): Subject {
  const raw: unknown = JSON.parse(json);
  if (raw === null || typeof raw !== 'object') {
    throw new Error('subject document is not a JSON object');
  }
  const o = raw as Record<string, unknown>;
  const kind = o.kind;
  if (kind !== 'issue' && kind !== 'issue_comment' && kind !== 'pull_request') {
    throw new Error(`subject.kind must be issue | issue_comment | pull_request, got ${String(kind)}`);
  }
  const labels = Array.isArray(o.labels)
    ? o.labels.filter((l): l is string => typeof l === 'string')
    : [];
  const subject: Subject = {
    kind,
    number: typeof o.number === 'number' ? o.number : 0,
    body: text(o.body),
    labels,
  };
  // A comment has no title, and the checks must not invent one: the
  // classification check reads the BODY only, and giving it a title field it
  // would then have to remember not to scan is how that rule gets lost.
  if (kind !== 'issue_comment' && typeof o.title === 'string') {
    subject.title = text(o.title);
  }
  if (typeof o.url === 'string') subject.url = o.url;
  return subject;
}
