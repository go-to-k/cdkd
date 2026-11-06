import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vite-plus/test';

import {
  clientChannelFiles,
  EXTRA_SURFACE_FILES,
  hasAnnotationAbove,
  isAnnotationCommentLine,
  isCommentLine,
  isInSurface,
  stripComments,
  surfaceFiles,
} from './_local-surface-scope.js';

/**
 * The SIBLING fence to `local-surface-role-identity.test.ts`, guarding the
 * channels that one cannot see (issue
 * [#3130](https://github.com/go-to-k/cdkd/issues/3130), residual
 * [#3250](https://github.com/go-to-k/cdkd/issues/3250)).
 *
 * That fence derives its population from `awsClientDefaults(` call sites, i.e.
 * from the AWS SDK clients this surface builds. But an emulated Lambda / ECS /
 * AgentCore container does not receive an SDK client — it receives three
 * ENVIRONMENT VARIABLES, and, when `--profile` is set, an INI credentials file
 * bind-mounted into it. `applyRoleArnIfSet` overwrites the environment triple
 * with a `--role-arn` assumed role's credentials, and every `cdkd local *`
 * command copies it into the container, so the whole class was reachable
 * through a channel that sat entirely outside the fence claiming to close it: a
 * client could opt out with `ignoreAssumedRole`, and the env copy beside it
 * still handed the workload cdkd's deploy role.
 *
 * So this fence derives its population from those channels themselves and
 * requires each site to declare a verdict. Neither verdict is the default:
 *
 *   - RESTORES — the site copies `process.env` and its enclosing function calls
 *     `applyCallerIdentityCredentials`, which puts the caller's own identity
 *     back over the role's (or strips the triple when there was none).
 *   - READS-CALLER — the site takes the identity from `callerEnvCredentials()`,
 *     which never returns the role.
 *   - ANNOTATED — a `cdkd-local-env-identity: <reason>` comment above the site
 *     saying why whatever it writes there is already the right identity.
 *
 * FIVE SHAPES, not one, and each carries its own floor. The three env-channel
 * shapes are the shared `AWS_CREDENTIAL_ENV_KEYS` population, a direct
 * mention of the quoted key, and a READ of any credential key out of
 * `process.env` in any spelling (issue #5866); the two INI ones are the
 * credentials FILE writer and its call sites. The INI channel was invisible to BOTH fences until issue
 * #3250 item 7: `src/cli/commands/local-profile-credentials-file.ts` writes
 * `aws_access_key_id = ...` in LOWERCASE into a host file the container mounts,
 * so it carries neither the quoted `'AWS_ACCESS_KEY_ID'` this fence looked for
 * nor an `awsClientDefaults(` call the sibling looks for. All four call sites
 * feed it opted-out sources today — which is exactly the state in which a fence
 * is cheap to add and a future call site passing the raw `process.env` triple
 * would otherwise be silent.
 *
 * `_local-surface-scope.ts` owns everything the two fences must agree on: which
 * files are in surface, what counts as a comment, and when an annotation
 * governs a line. It is a module rather than two matching comments because the
 * env copy shipped narrower than the role copy every time it was duplicated.
 */

/**
 * The shared constant naming the credential triple, and the QUOTED key.
 *
 * `AWS_CREDENTIAL_ENV_KEYS` (`src/utils/caller-credentials.ts`) exists so a
 * forwarding site and this fence cannot disagree about the population, and
 * issue #3250 item 4 is that nothing imported it: all three `forwardAwsEnv`
 * bodies hardcoded their own array and this fence hardcoded the literal, so the
 * claim was false in both directions. They are now one binding, which is also
 * why the constant's own spelling has to be a site shape — the three forwarding
 * sites stopped spelling the literal when they adopted it.
 *
 * The quoted form stays because it is how the REMAINING sites name the variable
 * (an index, a single assignment), while a bare mention inside a template
 * literal is an error message telling the user which variable to set. A message
 * delivers no identity, so requiring a verdict on one would be noise the next
 * author learns to paste past.
 */
const CREDENTIAL_KEY_SITE = /'AWS_ACCESS_KEY_ID'|\bAWS_CREDENTIAL_ENV_KEYS\b/;
const CALLER_READ_SITE = /\bcallerEnvCredentials\s*\(/;
/**
 * A READ of the engine's own credential triple out of `process.env`, by any
 * key of the three and in any spelling (issue #5866). The two shapes above
 * miss it: the quoted shape names only the access-key-id, and only quoted, so
 * `process.env.AWS_SESSION_TOKEN` — dot access, the bare identifier — matched
 * nothing. Under `--role-arn` that variable holds the ROLE's token, so a read
 * of it is a decision about whose identity flows onward.
 *
 * Dot (`process.env.X`, `process.env?.X`) and bracket (`process.env['X']`, any
 * quote) are one regex, tested BEFORE the quoted-key shape so the bracket
 * access-key-id read cannot take that shape's `restores` verdict; destructuring
 * (`const { X } = process.env`, one line or many, typed or not, and any
 * `...rest`, which carries the triple) needs the lines above and is
 * `destructuresCredentialFromProcessEnv`.
 *
 * Its only verdict is the annotation: a later `applyCallerIdentityCredentials`
 * rewrites an env COPY, not the value this line already read.
 */
const CREDENTIAL_ENV_NAME = String.raw`AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)`;
const PROCESS_ENV_CREDENTIAL_READ_SOURCE =
  String.raw`\bprocess\.env\s*(?:\?\.|\.)\s*${CREDENTIAL_ENV_NAME}\b` +
  '|' +
  String.raw`\bprocess\.env\s*(?:\?\.)?\s*\[\s*(['"\x60])${CREDENTIAL_ENV_NAME}\1\s*\]`;
const PROCESS_ENV_CREDENTIAL_READ = new RegExp(PROCESS_ENV_CREDENTIAL_READ_SOURCE);
const CREDENTIAL_ENV_NAME_TOKEN = new RegExp(String.raw`\b${CREDENTIAL_ENV_NAME}\b`);
const DESTRUCTURE_FROM_PROCESS_ENV = /\}\s*(?::[^=]*)?=\s*process\.env\b(?!\s*(?:\?\.|\.|\[))/;
/**
 * The WHOLE environment, taken as a value rather than one key read out of it:
 * a spread (`{ ...process.env }`), an alias (`const e = process.env`), an
 * argument (`Object.entries(process.env)`, `env: process.env`), any
 * `process['env']` or `require('process').env`, and the `env` binding taken
 * off the module itself — `const { env } = process` or
 * `import { env } from 'node:process'` (`processEnvBinding`). Every one
 * carries the triple — the role's under `--role-arn` — to wherever the value
 * goes, so it is a site. It is `restores` only when it binds a COPY
 * (`const c = { ...process.env }` / `structuredClone(process.env)`) and the
 * enclosing function restores THAT name; anything else — the live object
 * passed on, a copy restored under another name — takes the annotation. None
 * exists on the surface today, so it has unit cases and no floor.
 *
 * What remains unseeable in this line model (no AST: the repo's `typescript`
 * ships no JS parser API, and both fences share one line model): an `env`
 * binding read back under its new name (`penv.X` — the BINDING is the site,
 * its uses are not), and a computed key — `process.env[key]` over
 * `AWS_CREDENTIAL_ENV_KEYS` is the constant's shape, above.
 */
const PROCESS_ENV_WHOLE = new RegExp(
  [
    String.raw`\bprocess\.env\b(?!\s*(?:\?\.|\.|\[))`,
    String.raw`\bprocess\s*(?:\?\.\s*)?\[\s*['"\x60]env['"\x60]\s*\]`,
    String.raw`\brequire\s*\(\s*['"](?:node:)?process['"]\s*\)\s*(?:\?\.|\.)\s*env\b`,
  ].join('|')
);
/** A destructuring whose right-hand side is the `process` module itself. */
const DESTRUCTURE_FROM_PROCESS =
  /\}\s*(?::[^=]*)?=\s*(?:process|require\s*\(\s*['"](?:node:)?process['"]\s*\))\s*(?:[;,)]|$)/;
/** The closing line of an import from the `process` module. */
const IMPORT_FROM_PROCESS = /\bfrom\s*['"](?:node:)?process['"]/;
/** A whole-env site that binds a COPY, capturing the binding's name. */
const PROCESS_ENV_COPY_BINDING =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:\{\s*\.\.\.\s*process\.env\b|structuredClone\s*\(\s*process\.env\s*\))/;
/**
 * The INI channel. The KEY is the lowercase shared-credentials-file spelling —
 * a different string from the env one, which is precisely why neither fence saw
 * it — and the CALL is every site that hands the writer a credential set. The
 * writer takes its credentials as an ARGUMENT, so the call sites are where the
 * identity is actually chosen and the writer alone would be the wrong subject.
 *
 * BOTH halves of the key pair are matched, unlike the env channel's single
 * quoted key. The asymmetry is deliberate: on the env channel the three keys
 * are always written together by one helper, while an INI writer emits one
 * `key = value` line per key, so keying on the access-key-id alone would leave
 * a future writer that emits only `aws_secret_access_key` invisible — half an
 * identity, and the half that is actually secret. `aws_session_token` is NOT
 * here: on its own it is not an identity, and it never appears without one of
 * these two above it.
 */
const INI_CREDENTIAL_KEY_SITE = /\baws_(access_key_id|secret_access_key)\b/;
const INI_WRITER_CALL_SITE = /\bwriteProfileCredentialsFile\s*\(/;
const INI_WRITER_DECLARATION = /\bfunction\s+writeProfileCredentialsFile\b/;
const RESTORE_CALL = /\bapplyCallerIdentityCredentials\s*\(/;
const ANNOTATION = 'cdkd-local-env-identity:';

type Shape =
  | 'env-keys'
  | 'caller-read'
  | 'process-env-read'
  | 'process-env-whole'
  | 'ini-key'
  | 'ini-writer-call';
type Verdict = 'restores' | 'reads-caller' | 'annotated' | 'undeclared';

interface Site {
  file: string;
  line: number;
  /** The raw line, for the failure message a human reads. */
  text: string;
  /**
   * The same line with comments stripped — what every COUNT below filters on.
   * Reporting the raw text and re-classifying it are different jobs, and the
   * per-spelling sub-floor did the second on the first: a site reverted to a
   * local array while a trailing `// still AWS_CREDENTIAL_ENV_KEYS` survived
   * would have kept its count, defeating the only assertion that reds for that
   * regression.
   */
  code: string;
  shape: Shape;
  verdict: Verdict;
}

/**
 * Does the block CONTAINING this line restore the caller's identity?
 *
 * Scanning forward to the next module-level `}` bounds the search to the
 * enclosing top-level function, which is how every forwarding site here is
 * written. Deliberately not a fixed line window: the restore sits after the
 * whole pass-through loop, far below the key it corrects, and a window wide
 * enough to reach it would also reach into the NEXT function and credit a site
 * that restores nothing.
 *
 * Comments are stripped before the test rather than merely skipped: a trailing
 * `// applyCallerIdentityCredentials(env) not needed` on a CODE line used to
 * mark every credential write above it in the same function as restoring —
 * the exact opposite of what such a comment says (issue #3250 item 2).
 */
function enclosingBlockRestores(lines: string[], index: number, target?: string): boolean {
  // `target` narrows the restore to one binding: a whole-env copy is restored
  // only by a call on ITS name (see `PROCESS_ENV_WHOLE`).
  const restore =
    target === undefined
      ? RESTORE_CALL
      : new RegExp(String.raw`\bapplyCallerIdentityCredentials\s*\(\s*${target.replace(/\$/g, '\\$')}\s*[,)]`);
  for (let i = index; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    if (!isCommentLine(raw) && restore.test(stripComments(raw))) return true;
    if (i > index && /^\}/.test(raw)) return false;
  }
  return false;
}

/**
 * Line indices belonging to an `import` statement.
 *
 * Needed once `AWS_CREDENTIAL_ENV_KEYS` became a site shape: the three
 * forwarding files now IMPORT it, and an import names no identity and writes
 * nothing. Left in, each import would be an undeclared site whose only
 * available verdict is a comment saying "this is an import" — and worse, the
 * forward scan above would reach the function below it and credit the import
 * with that function's restore.
 */
function importLines(lines: string[]): Set<number> {
  const out = new Set<number>();
  let inImport = false;
  lines.forEach((line, i) => {
    // Both details are corrections from review, and BOTH failed in the silent
    // direction — a swallowed line stops being a site, which is the direction
    // `_local-surface-scope.ts`'s own doc calls the wrong one.
    //
    // The terminator is tested on COMMENT-STRIPPED text: `import { X } from
    // 'y'; // note` does not end in `;`, so the scanner latched and swallowed
    // every line up to the next `;`-terminated one.
    //
    // The opener is `^import[\s{'"]`, not `^import\b`: `\b` sits between `t`
    // and `(`, so a line-start DYNAMIC `import(...)` — an EXPRESSION, not a
    // statement — opened a multi-line import that never closed. The character
    // class is every way a real import STATEMENT can continue (` `, `*`, `{`,
    // `'`, `"`) and excludes `(`, so a dynamic import is simply not an opener
    // and cannot latch the scanner at all.
    const trimmed = stripComments(line).trim();
    if (!inImport && /^import[\s{'"]/.test(trimmed)) {
      out.add(i);
      if (!/;\s*$/.test(trimmed)) inImport = true;
      return;
    }
    if (inImport) {
      out.add(i);
      if (/;\s*$/.test(trimmed)) inImport = false;
    }
  });
  return out;
}

/**
 * Does the line at `index` close a destructuring of `process.env` that takes a
 * credential — a credential key by name, or a `...rest`, which carries all
 * three? `const {\n  AWS_SESSION_TOKEN: t,\n} = process.env;` puts the key and
 * `process.env` on different lines, so the pattern is taken from the closing
 * `} = process.env` and walked UP until the braces balance.
 *
 * A walk that never balances within the cap answers TRUE — an unmodelled shape
 * becomes a site a human decides, never a silent miss.
 */
function destructuresCredentialFromProcessEnv(lines: string[], index: number): boolean {
  const pattern = destructuringPattern(lines, index, DESTRUCTURE_FROM_PROCESS_ENV);
  if (pattern === undefined) return false;
  return pattern === UNBALANCED || CREDENTIAL_ENV_NAME_TOKEN.test(pattern) || pattern.includes('...');
}

const UNBALANCED = '\u0000unbalanced';

/**
 * The `{ ... }` pattern of a destructuring whose closing line is `index` and
 * whose right-hand side `closingRe` matches, walked UP until the braces
 * balance; `UNBALANCED` past the cap (callers fail closed to a site), and
 * `undefined` when the line is not such a destructuring.
 */
function destructuringPattern(lines: string[], index: number, closingRe: RegExp): string | undefined {
  const closing = stripComments(lines[index] ?? '');
  const match = closingRe.exec(closing);
  if (match === null) return undefined;
  let pattern = closing.slice(0, match.index + 1);
  const balance = (text: string): number =>
    (text.match(/\}/g)?.length ?? 0) - (text.match(/\{/g)?.length ?? 0);
  for (let i = index - 1; balance(pattern) > 0; i--) {
    if (i < 0 || index - i > 60) return UNBALANCED;
    const raw = lines[i] ?? '';
    pattern = `${isCommentLine(raw) ? '' : stripComments(raw)}\n${pattern}`;
  }
  return pattern;
}

/**
 * Does the line at `index` bind the `env` export of the `process` module —
 * `const { env } = process`, `const { env: e } = require('node:process')`, or
 * the closing line of `import { env as e } from 'node:process'`? `imports` is
 * the file's import-line set, so a multi-line import is joined to its opener.
 */
function processEnvBinding(lines: string[], index: number, imports: Set<number>): boolean {
  const code = stripComments(lines[index] ?? '');
  const pattern = destructuringPattern(lines, index, DESTRUCTURE_FROM_PROCESS);
  if (pattern !== undefined) return pattern === UNBALANCED || /\benv\b/.test(pattern);
  if (!imports.has(index) || !IMPORT_FROM_PROCESS.test(code)) return false;
  let statement = code;
  for (let i = index - 1; i >= 0 && imports.has(i) && !/;\s*$/.test(stripComments(lines[i] ?? '')); i--) {
    statement = `${stripComments(lines[i] ?? '')}\n${statement}`;
  }
  return /\benv\b/.test(statement.replace(IMPORT_FROM_PROCESS, ''));
}

/** The credential keys a line reads out of `process.env`. */
function credentialKeysRead(code: string): Set<string> {
  const keys = new Set<string>();
  for (const m of code.matchAll(new RegExp(PROCESS_ENV_CREDENTIAL_READ_SOURCE, 'g'))) {
    const key = CREDENTIAL_ENV_NAME_TOKEN.exec(m[0])?.[0];
    if (key !== undefined) keys.add(key);
  }
  return keys;
}

/**
 * Does an annotation govern this `process.env` credential read?
 *
 * The triple is read on three consecutive lines and decided once, so a read
 * directly below ANOTHER read inherits the annotation above the first. Only a
 * contiguous run of reads of DIFFERENT keys is skipped — at most the triple: a
 * second read of a key the run already read is a new decision, not the same
 * one, and any other statement in between ends the run, where
 * `hasAnnotationAbove` stops as usual.
 */
function annotationGovernsRead(lines: string[], index: number): boolean {
  const seen = credentialKeysRead(stripComments(lines[index] ?? ''));
  let top = index;
  while (top > 0) {
    const above = lines[top - 1] ?? '';
    if (isCommentLine(above)) break;
    const keys = credentialKeysRead(stripComments(above));
    if (keys.size === 0 || [...keys].some((k) => seen.has(k))) break;
    for (const k of keys) seen.add(k);
    top--;
  }
  return hasAnnotationAbove(lines, top, ANNOTATION);
}

/** The shape of one code line (comments already stripped). */
function shapeOf(code: string): Shape | undefined {
  if (CALLER_READ_SITE.test(code)) return 'caller-read';
  if (PROCESS_ENV_CREDENTIAL_READ.test(code)) return 'process-env-read';
  if (CREDENTIAL_KEY_SITE.test(code)) return 'env-keys';
  if (PROCESS_ENV_WHOLE.test(code)) return 'process-env-whole';
  if (INI_CREDENTIAL_KEY_SITE.test(code)) return 'ini-key';
  if (INI_WRITER_CALL_SITE.test(code) && !INI_WRITER_DECLARATION.test(code)) {
    return 'ini-writer-call';
  }
  return undefined;
}

/**
 * The shape of the line at `index` — the ONE classification `collectSites`
 * uses, so a case driving it drives the walk's own wiring. A destructuring of
 * `process.env` is judged on its pattern: one taking a credential is a read,
 * one naming only other keys is not a whole-env copy either.
 */
function shapeAt(
  lines: string[],
  index: number,
  imports: Set<number> = new Set()
): Shape | undefined {
  const code = stripComments(lines[index] ?? '');
  if (processEnvBinding(lines, index, imports)) return 'process-env-whole';
  if (imports.has(index)) return undefined;
  if (DESTRUCTURE_FROM_PROCESS_ENV.test(code)) {
    if (destructuresCredentialFromProcessEnv(lines, index)) return 'process-env-read';
    // Only THIS destructuring's right-hand side is judged; the rest of the
    // line is still classified as usual.
    return shapeOf(code.replace(DESTRUCTURE_FROM_PROCESS_ENV, '} = DESTRUCTURED'));
  }
  return shapeOf(code);
}

function collectSites(): Site[] {
  const sites: Site[] = [];
  for (const file of surfaceFiles()) {
    if (!isInSurface(file)) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    const imports = importLines(lines);
    lines.forEach((text, i) => {
      // Import lines are not skipped here: `shapeAt` takes the one import that
      // is a site (the `env` export of `process`) and drops every other.
      if (isCommentLine(text)) return;
      const code = stripComments(text);
      const site = siteAt(lines, i, imports);
      if (site === undefined) return;
      sites.push({ file, line: i + 1, text: text.trim(), code, ...site });
    });
  }
  return sites;
}

/** Shape and verdict of the line at `index`: the walk's per-line decision. */
function siteAt(
  lines: string[],
  index: number,
  imports: Set<number> = importLines(lines)
): { shape: Shape; verdict: Verdict } | undefined {
  if (isCommentLine(lines[index] ?? '')) return undefined;
  const shape = shapeAt(lines, index, imports);
  if (shape === undefined) return undefined;
  if (shape === 'caller-read') return { shape, verdict: 'reads-caller' };
  if (shape === 'env-keys' && enclosingBlockRestores(lines, index)) {
    return { shape, verdict: 'restores' };
  }
  const copy = PROCESS_ENV_COPY_BINDING.exec(stripComments(lines[index] ?? ''))?.[1];
  if (shape === 'process-env-whole' && copy !== undefined && enclosingBlockRestores(lines, index, copy)) {
    return { shape, verdict: 'restores' };
  }
  const annotated =
    shape === 'process-env-read'
      ? annotationGovernsRead(lines, index)
      : hasAnnotationAbove(lines, index, ANNOTATION);
  return { shape, verdict: annotated ? 'annotated' : 'undeclared' };
}

function countOf(sites: Site[], verdict: Verdict): number {
  return sites.filter((s) => s.verdict === verdict).length;
}

function shapeCount(sites: Site[], shape: Shape): number {
  return sites.filter((s) => s.shape === shape).length;
}

describe('every identity reaching an emulated workload through process env or a mounted credentials file declares a verdict', () => {
  const sites = collectSites();

  it('sees the population it claims to guard, per shape', () => {
    // Floors, so a broken walk, a renamed helper or a regex that stopped
    // matching reports a failure rather than a vacuous pass. Measured
    // 2026-11-07: 22 sites across 11 files — by VERDICT 3 `restores`, 1
    // `reads-caller`, 18 `annotated`; by SHAPE 12 `env-keys`, 1 `caller-read`,
    // 3 `process-env-read`, 0 `process-env-whole`, 2 `ini-key`, 4
    // `ini-writer-call`. The floors sit below that so ordinary
    // deletions do not trip them, but every shape and every verdict carries its
    // OWN: a whole-population floor stays green while one arm silently empties,
    // and the `restores` arm is the one that actually delivers container
    // credentials. The counts are literals typed from a measurement, not read
    // back out of anything this fence computes.
    expect(sites.length, 'total credential-channel sites').toBeGreaterThanOrEqual(15);
    expect(new Set(sites.map((s) => s.file)).size, 'files with a site').toBeGreaterThanOrEqual(5);
    expect(countOf(sites, 'restores'), '`restores` sites').toBeGreaterThanOrEqual(3);
    expect(countOf(sites, 'reads-caller'), '`reads-caller` sites').toBeGreaterThanOrEqual(1);
    expect(countOf(sites, 'annotated'), '`annotated` sites').toBeGreaterThanOrEqual(11);
    expect(shapeCount(sites, 'env-keys'), '`env-keys` shape').toBeGreaterThanOrEqual(10);
    expect(shapeCount(sites, 'caller-read'), '`caller-read` shape').toBeGreaterThanOrEqual(1);
    // Issue #5866: 3 — the triple `local-host-synthesizer.ts` reads in bracket
    // form. No DOT or DESTRUCTURING read, and no `process-env-whole` site,
    // exists in the tree, so those spellings are held by the `shapeAt` cases
    // below, not by a floor.
    expect(shapeCount(sites, 'process-env-read'), '`process-env-read` shape').toBeGreaterThanOrEqual(
      3
    );
    expect(shapeCount(sites, 'ini-key'), '`ini-key` shape').toBeGreaterThanOrEqual(2);
    expect(shapeCount(sites, 'ini-writer-call'), '`ini-writer-call` shape').toBeGreaterThanOrEqual(
      4
    );
  });

  it('sees BOTH env-channel spellings, so adopting the shared constant did not empty the shape', () => {
    // The three `forwardAwsEnv` bodies now spell the population as
    // `AWS_CREDENTIAL_ENV_KEYS` and the remaining sites as the quoted key. A
    // regex that stopped matching either one would leave the `env-keys` floor
    // above satisfied by the other half alone.
    // Both filters read `s.code`, not `s.text`: a count is a CLASSIFICATION and
    // must not be decided by a comment, which is the same rule `stripComments`
    // exists for one layer down.
    const envKeySites = sites.filter((s) => s.shape === 'env-keys');
    expect(
      envKeySites.filter((s) => /\bAWS_CREDENTIAL_ENV_KEYS\b/.test(s.code)).length,
      'sites naming the shared constant'
    ).toBeGreaterThanOrEqual(3);
    expect(
      envKeySites.filter((s) => /'AWS_ACCESS_KEY_ID'/.test(s.code)).length,
      'sites naming the quoted key'
    ).toBeGreaterThanOrEqual(6);
  });

  it('has no site that leaves the question open', () => {
    const undeclared = sites
      .filter((s) => s.verdict === 'undeclared')
      .map((s) => `${s.file}:${s.line}  [${s.shape}]  ${s.text}`);

    expect(
      undeclared,
      'This writes or reads an AWS credential on the `cdkd local` surface — into the process ' +
        'environment a container inherits, or into the INI credentials file it bind-mounts — ' +
        'and the source it copies from may hold a `--role-arn` assumed role rather than the ' +
        "caller's identity. If the value comes from `process.env`, call " +
        '`applyCallerIdentityCredentials(env)` in the same function (see ' +
        '`src/utils/caller-credentials.ts`). If it comes from the caller, take it from ' +
        '`callerEnvCredentials()`. A READ of a credential variable out of `process.env` ' +
        '(`process.env.X`, `process.env[\'X\']`, or destructuring) holds the `--role-arn` ' +
        'role when one is set, and takes the comment; so does the WHOLE `process.env` taken as ' +
        'a value (a spread, an alias, an argument) unless its function restores the copy. ' +
        'If neither applies — the identity was chosen by ' +
        '`--assume-role` / `--assume-task-role` / `--profile`, or the value is a ' +
        'placeholder — write a `cdkd-local-env-identity: <reason>` comment above it.'
    ).toEqual([]);
  });

  it('keeps the two fences pointed at different channels', () => {
    // The sibling fence derives from SDK-client sites and this one from the
    // credential channels. If a future refactor made one a subset of the other,
    // the narrower one would be dead weight that still reads as coverage.
    //
    // The comparand is the SIBLING's own predicate (`clientChannelFiles`),
    // which covers BOTH client shapes. This case used to re-derive it from
    // `awsClientDefaults(` alone — 21 of the sibling's 24 sites — so the file
    // set it subtracted was too small and the claim was easier to satisfy than
    // the claim it printed (issue #3250 item 2).
    const envChannelFiles = new Set(sites.map((s) => s.file));
    const clientFiles = clientChannelFiles();
    // Floor on the COMPARAND: a set-difference claim is vacuously true when the
    // other operand parses empty, and both walk floors would stay green.
    expect(clientFiles.size, 'files the sibling fence covers').toBeGreaterThanOrEqual(5);
    // And a BINDING on the comparand's width, without which the widening above
    // is unfenced: `local-state-loader.ts` carries three `new AwsClients(` bags
    // and ZERO `awsClientDefaults(` calls, so it is exactly the file the old
    // narrow re-derivation dropped. Reverting to that predicate reds here and
    // nowhere else — the difference is invisible to `envOnly` today, because
    // this file holds no credential-channel site to subtract.
    expect(
      clientFiles,
      'a file whose only client shape is `new AwsClients(` must still count as client-channel'
    ).toContain('src/cli/commands/local-state-loader.ts');
    // BOTH directions. The case title claims the two fences are not subsets of
    // each other, and a one-directional difference only refutes one of the two
    // subset relations: with `clientOnly` uncomputed, the ROLE fence collapsing
    // into a subset of this one passes silently. Measured 2026-09-18: 3
    // env-only files, 4 client-only.
    const envOnly = [...envChannelFiles].filter((f) => !clientFiles.has(f));
    expect(envOnly.length, 'files this fence covers that the client fence cannot').toBeGreaterThan(
      0
    );
    const clientOnly = [...clientFiles].filter((f) => !envChannelFiles.has(f));
    expect(
      clientOnly.length,
      'files the client fence covers that this one cannot'
    ).toBeGreaterThan(0);
  });

  it('refuses a trailing comment as a restore, and an empty reason as an annotation', () => {
    // Guard-the-guard for the two classifiers issue #3250 item 2 named. Both
    // were substring tests over the whole raw line, so prose ABOUT the rule
    // decided the verdict.
    const trailingCommentClaimsARestore = [
      "  env['AWS_ACCESS_KEY_ID'] = process.env['AWS_ACCESS_KEY_ID'] ?? '';",
      '  // applyCallerIdentityCredentials(env) is not needed here',
      '  const x = 1; // applyCallerIdentityCredentials(env) not needed',
      '}',
    ];
    expect(
      enclosingBlockRestores(trailingCommentClaimsARestore, 0),
      'a mention inside a comment must not count as a restore'
    ).toBe(false);
    const realRestore = [
      "  env['AWS_ACCESS_KEY_ID'] = process.env['AWS_ACCESS_KEY_ID'] ?? '';",
      '  applyCallerIdentityCredentials(env);',
      '}',
    ];
    expect(enclosingBlockRestores(realRestore, 0)).toBe(true);

    expect(isAnnotationCommentLine('  // cdkd-local-env-identity:', ANNOTATION)).toBe(false);
    expect(isAnnotationCommentLine('  // cdkd-local-env-identity:   ', ANNOTATION)).toBe(false);
    expect(
      isAnnotationCommentLine("  const tag = 'cdkd-local-env-identity: x';", ANNOTATION)
    ).toBe(false);
    expect(
      isAnnotationCommentLine('  // cdkd-local-env-identity: the caller chose this', ANNOTATION)
    ).toBe(true);
    // And the walk refuses the empty-reason marker as a verdict too, rather
    // than merely refusing it as a LINE.
    expect(
      hasAnnotationAbove(
        ['  // cdkd-local-env-identity:', "  env['AWS_ACCESS_KEY_ID'] = x;"],
        1,
        ANNOTATION
      )
    ).toBe(false);
  });

  it('classifies the INI channel as its own shape, and ignores an import of the writer', () => {
    expect(shapeOf('    `aws_access_key_id = ${creds.accessKeyId}`,')).toBe('ini-key');
    expect(shapeOf('  profileCredsFile = await writeProfileCredentialsFile(p, creds);')).toBe(
      'ini-writer-call'
    );
    // The declaration is the writer itself, not a site choosing an identity.
    expect(shapeOf('export async function writeProfileCredentialsFile(')).toBeUndefined();
    // An `import` names no identity; a multi-line one must be excluded to its
    // closing brace, which is what the forwarding files now carry.
    const multiLineImport = [
      'import {',
      '  applyCallerIdentityCredentials,',
      '  AWS_CREDENTIAL_ENV_KEYS,',
      "} from '../../utils/caller-credentials.js';",
      '',
      "const x = 'AWS_ACCESS_KEY_ID';",
    ];
    const excluded = importLines(multiLineImport);
    expect([...excluded].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    expect(excluded.has(5)).toBe(false);
  });

  it('classifies every spelling of a `process.env` credential read, and nothing else (#5866)', () => {
    // Per SPELLING, and through `shapeAt` — the classification the walk itself
    // calls — so a case reds when an arm is dropped from the WIRING, not only
    // from a helper: the real-tree floor is met by the bracket form alone.
    const one = (line: string) => shapeAt([line], 0);
    for (const key of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']) {
      for (const line of [
        `  const t = process.env.${key};`,
        `  const t = process.env?.${key};`,
        `  const t = process.env['${key}'];`,
        `  const t = process.env["${key}"];`,
        `  const t = process.env[\`${key}\`];`,
      ]) {
        expect(one(line), line).toBe('process-env-read');
      }
    }
    // Not a credential, not `process.env`, or a message naming the variable.
    expect(one("  const r = process.env['AWS_REGION'];")).toBeUndefined();
    expect(one('  const r = process.env.AWS_SESSION_TOKEN_TTL;')).toBeUndefined();
    expect(one("  const t = env['AWS_SESSION_TOKEN'];")).toBeUndefined();
    expect(one('  throw new Error(`set AWS_SESSION_TOKEN first`);')).toBeUndefined();
    expect(one('  x(); // process.env.AWS_SESSION_TOKEN')).toBeUndefined();
    expect(one('  const value = process.env[key];')).toBeUndefined();

    // Destructuring: on one line, typed, across several, and a `...rest`,
    // which carries the triple without naming it.
    expect(one('  const { AWS_SESSION_TOKEN } = process.env;')).toBe('process-env-read');
    expect(one('  const { AWS_SESSION_TOKEN: t }: NodeJS.ProcessEnv = process.env;')).toBe(
      'process-env-read'
    );
    expect(one('  const { AWS_REGION, ...rest } = process.env;')).toBe('process-env-read');
    const multiLine = [
      '  const {',
      '    AWS_REGION: region,',
      '    AWS_SECRET_ACCESS_KEY: secret,',
      '  } = process.env;',
    ];
    expect(shapeAt(multiLine, 3)).toBe('process-env-read');
    // A destructure taking only other keys is no site at all — not a read, and
    // not a whole-env copy either.
    expect(one('  const { AWS_REGION, HOME } = process.env;')).toBeUndefined();
    // A different object, and a member of `process.env`, are not this shape.
    expect(one('  const { AWS_SESSION_TOKEN } = creds;')).toBeUndefined();
    expect(destructuresCredentialFromProcessEnv(['  const { A } = process.env.X;'], 0)).toBe(false);
  });

  it('classifies the WHOLE environment taken as a value, and takes its restore (#5866)', () => {
    const one = (line: string) => shapeAt([line], 0);
    for (const line of [
      '  const env = { ...process.env };',
      '  const env = { ...process.env, FOO: 1 };',
      '  const pe = process.env;',
      '  for (const [k, v] of Object.entries(process.env)) {',
      '  spawn(cmd, args, { env: process.env });',
      '  const copy = structuredClone(process.env);',
      "  const t = process['env'].AWS_SESSION_TOKEN;",
    ]) {
      expect(one(line), line).toBe('process-env-whole');
    }
    // A copy the enclosing function corrects is `restores`, like the constant's
    // forwarding sites; a READ beside the same restore is not (it took the
    // value before any correction), which is why the bracket access-key-id
    // read is no longer the `env-keys` shape.
    const restored = [
      '  const env = { ...process.env };',
      "  const leaked = process.env['AWS_ACCESS_KEY_ID'];",
      '  applyCallerIdentityCredentials(env);',
      '}',
    ];
    expect(siteAt(restored, 0)).toEqual({ shape: 'process-env-whole', verdict: 'restores' });
    expect(siteAt(restored, 1)).toEqual({ shape: 'process-env-read', verdict: 'undeclared' });
    // A restore of ANOTHER object does not correct this one: the live object
    // passed on, and a copy restored under a different name, stay undecided.
    const unrelated = [
      '  spawn(cmd, args, { env: process.env });',
      '  const copy = { ...process.env };',
      '  applyCallerIdentityCredentials(env);',
      '}',
    ];
    expect(siteAt(unrelated, 0)?.verdict).toBe('undeclared');
    expect(siteAt(unrelated, 1)?.verdict).toBe('undeclared');
    // A non-credential destructuring on the line does not hide a copy beside it.
    expect(one('  const { HOME } = process.env, env2 = { ...process.env };')).toBe(
      'process-env-whole'
    );
  });

  it('classifies the `env` export of `process` bound under any name (#5866)', () => {
    const at = (lines: string[], i = 0) => siteAt(lines, i)?.shape;
    expect(at(['  const { env } = process;'])).toBe('process-env-whole');
    expect(at(['  const { env: penv } = process;'])).toBe('process-env-whole');
    expect(at(["  const { env: penv } = require('node:process');"])).toBe('process-env-whole');
    expect(at(["  const penv = require('process').env;"])).toBe('process-env-whole');
    expect(at(["import { env as penv } from 'node:process';"])).toBe('process-env-whole');
    expect(at(['import {', '  argv,', '  env as penv,', "} from 'node:process';"], 3)).toBe(
      'process-env-whole'
    );
    // Other exports of `process`, and `env` from another module, are not.
    expect(at(['  const { argv, platform } = process;'])).toBeUndefined();
    expect(at(["import { argv } from 'node:process';"])).toBeUndefined();
    expect(at(["import { env } from './config.js';"])).toBeUndefined();
    // An ordinary import naming the shared constant stays excluded.
    expect(at(["import { AWS_CREDENTIAL_ENV_KEYS } from '../../utils/caller-credentials.js';"])).toBeUndefined();
  });

  it('lets a contiguous run of `process.env` reads share one annotation, and no further', () => {
    const triple = [
      '  // cdkd-local-env-identity: the triple is the role, for cdkd itself',
      "  const a = process.env['AWS_ACCESS_KEY_ID'];",
      "  const s = process.env['AWS_SECRET_ACCESS_KEY'];",
      '  const t = process.env.AWS_SESSION_TOKEN;',
    ];
    expect(annotationGovernsRead(triple, 3)).toBe(true);
    const interrupted = [
      '  // cdkd-local-env-identity: the triple is the role, for cdkd itself',
      "  const a = process.env['AWS_ACCESS_KEY_ID'];",
      '  doSomething(a);',
      '  const t = process.env.AWS_SESSION_TOKEN;',
    ];
    expect(annotationGovernsRead(interrupted, 3)).toBe(false);
    // A second read of a key the run already read is a NEW decision: it does
    // not inherit the triple's reason.
    const duplicate = [...triple, '  leak = process.env.AWS_SESSION_TOKEN;'];
    expect(annotationGovernsRead(duplicate, 4)).toBe(false);
    expect(siteAt(duplicate, 4)?.verdict).toBe('undeclared');
  });

  it('keeps a nested `src/cli/commands/local/**` file and the emulator shim in scope', () => {
    // The twin of the sibling fence's own predicate case, and it is here for a
    // measured reason rather than for symmetry: this fence shipped with the
    // NARROW pattern, and reverting to it reds no other case in this file --
    // every floor, the `undeclared` assertion and the disjointness case are
    // byte-identical either way, because no file exercising the difference
    // exists yet. So the widening was unfenced, which is the shape where a
    // later "simplification" silently takes the surface back. The predicate now
    // lives in `_local-surface-scope.ts`, so these cases and the sibling's
    // watch ONE definition -- but they stay duplicated deliberately, so this
    // fence reds on its own terms rather than only through its sibling.
    expect(isInSurface('src/cli/commands/local/foo.ts')).toBe(true);
    // A split command's directory: `local start-api`'s handler lives there.
    expect(isInSurface('src/cli/commands/local-start-api/command.ts')).toBe(true);
    expect(isInSurface('src/cli/commands/local-start-api/nested/deep.ts')).toBe(true);
    expect(isInSurface('src/cli/commands/local-invoke.ts')).toBe(true);
    expect(isInSurface('src/cli/commands/local-profile-credentials-file.ts')).toBe(true);
    expect(isInSurface('src/cli/commands/ecs-service-emulator.ts')).toBe(true);
    expect(isInSurface('src/local/nested/deep/thing.ts')).toBe(true);
    expect(isInSurface('src\\local\\nested\\thing.ts')).toBe(true);
    // Still NOT the whole command tree.
    expect(isInSurface('src/cli/commands/deploy.ts')).toBe(false);
    expect(isInSurface('src/cli/commands/localish.ts')).toBe(false);
    expect(isInSurface('src/local/notes.md')).toBe(false);
  });

  it('presents an EXTRA_SURFACE_FILES entry to the predicate even from outside a ROOT', () => {
    // `isInSurface` accepting a path buys nothing if the walk never offers it.
    // Both collectors go through `surfaceFiles()` for that reason; this pins
    // the seeding, which is invisible while every extra entry happens to live
    // under a ROOT -- as today's single entry does.
    expect(surfaceFiles()).toContain('src/cli/commands/ecs-service-emulator.ts');
    for (const extra of EXTRA_SURFACE_FILES) {
      expect(isInSurface(extra), `${extra} must be in surface`).toBe(true);
    }
  });
});
