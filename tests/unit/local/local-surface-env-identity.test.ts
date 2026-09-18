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
 * FOUR SHAPES, not one, and each carries its own floor. The two env-channel
 * shapes are the shared `AWS_CREDENTIAL_ENV_KEYS` population and a direct
 * mention of the quoted key; the two INI ones are the credentials FILE writer
 * and its call sites. The INI channel was invisible to BOTH fences until issue
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

type Shape = 'env-keys' | 'caller-read' | 'ini-key' | 'ini-writer-call';
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
function enclosingBlockRestores(lines: string[], index: number): boolean {
  for (let i = index; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    if (!isCommentLine(raw) && RESTORE_CALL.test(stripComments(raw))) return true;
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

function shapeOf(code: string): Shape | undefined {
  if (CALLER_READ_SITE.test(code)) return 'caller-read';
  if (CREDENTIAL_KEY_SITE.test(code)) return 'env-keys';
  if (INI_CREDENTIAL_KEY_SITE.test(code)) return 'ini-key';
  if (INI_WRITER_CALL_SITE.test(code) && !INI_WRITER_DECLARATION.test(code)) {
    return 'ini-writer-call';
  }
  return undefined;
}

function collectSites(): Site[] {
  const sites: Site[] = [];
  for (const file of surfaceFiles()) {
    if (!isInSurface(file)) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    const imports = importLines(lines);
    lines.forEach((text, i) => {
      if (isCommentLine(text) || imports.has(i)) return;
      const code = stripComments(text);
      const shape = shapeOf(code);
      if (shape === undefined) return;
      const annotated = hasAnnotationAbove(lines, i, ANNOTATION);
      let verdict: Verdict;
      if (shape === 'caller-read') verdict = 'reads-caller';
      else if (shape === 'env-keys' && enclosingBlockRestores(lines, i)) verdict = 'restores';
      else if (annotated) verdict = 'annotated';
      else verdict = 'undeclared';
      sites.push({ file, line: i + 1, text: text.trim(), code, shape, verdict });
    });
  }
  return sites;
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
    // 2026-09-18: 19 sites across 7 files — by VERDICT 3 `restores`, 1
    // `reads-caller`, 15 `annotated`; by SHAPE 12 `env-keys`, 1 `caller-read`,
    // 2 `ini-key`, 4 `ini-writer-call`. The floors sit below that so ordinary
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
        '`callerEnvCredentials()`. If neither applies — the identity was chosen by ' +
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
