/**
 * Classifier for stray control bytes in committed TEXT files (issue #1587).
 *
 * A raw NUL (U+0000) written literally into a source file — rather than as the
 * `\0` escape — is valid in a JS/TS string literal and behaves identically at
 * runtime, so nothing in typecheck, lint, format or the test suite notices it.
 * What DOES notice is every grep-shaped tool: `grep` and `rg` classify a file
 * containing a NUL as BINARY and skip its contents entirely.
 *
 * That is a silent audit blind spot, not a cosmetic complaint. Measured on this
 * repo while `src/provisioning/providers/efs-provider.ts` carried one at offset
 * 17230:
 *
 *   grep -rn '<term>' src/provisioning/providers/   -> zero hits from the file,
 *                                                      NO notice, exit 0
 *                                                      (system grep is ugrep,
 *                                                      which does not print the
 *                                                      "Binary file matches"
 *                                                      line GNU grep does)
 *   rg -n '<term>' src/provisioning/providers/      -> nothing for the file
 *   rg -n '<term>' <the file>                       -> "binary file matches",
 *                                                      match count only
 *   git grep / git diff                             -> UNAFFECTED (git's binary
 *                                                      heuristic only inspects
 *                                                      the first 8000 bytes)
 *
 * So the blast radius is precisely the ad-hoc `grep` / `rg` sweeps the umbrella
 * audits (#1160, #1225, #609) and `/hunt-bugs` runs are built on — and it is
 * not hypothetical: a `/work-issues` pass audited the #1160 SUSPECT row for
 * `efs-provider.ts` with `grep -rn 'ThroughputMode' src/`, got zero hits, and
 * concluded the efs batch was unshipped when PR #1535 had shipped it days
 * earlier. The expensive direction is the mirror case, where a sweep reports
 * "no provider does X" and a real bug hides in the one file grep cannot read.
 *
 * Because the failure mode is silent BY CONSTRUCTION, a human will never notice
 * it without a gate — which is the whole argument for this checker existing at
 * a measured tree-wide finding count of zero.
 *
 * Scope was chosen by measurement, not prediction: after the one `efs-provider`
 * fix, a sweep of every tracked non-binary file found ZERO C0 control bytes
 * outside TAB / LF. So the checker rejects the whole class rather than NUL
 * alone, and starts from a green tree.
 *
 * This module is a pure classifier so it can be table-tested against synthetic
 * byte shapes rather than only against today's tree; the sweep over the real
 * repo lives in `tests/unit/scripts/source-control-bytes.test.ts`.
 */

/**
 * Extensions whose files are legitimately binary and therefore exempt. Keyed by
 * extension rather than by path so a newly added asset is covered without an
 * allow-list edit; a binary file with an unlisted extension fails loudly, which
 * is the safe direction (add the extension, having looked at the file).
 */
export const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  '.gif',
  '.png',
  '.jpg',
  '.jpeg',
  '.ico',
  '.pdf',
  '.zip',
  '.gz',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.mp4',
  '.mov',
  '.webp',
  '.wasm',
]);

/**
 * Bytes that are legitimate in a text file. LF and TAB only: CR is deliberately
 * NOT here, because this repo is LF-only and a stray CRLF is worth surfacing.
 */
const ALLOWED_CONTROL_BYTES: ReadonlySet<number> = new Set([0x09, 0x0a]);

export interface ControlByteFinding {
  /** The offending byte value. */
  byte: number;
  /** 0-based byte offset within the file. */
  offset: number;
  /** 1-based line number, counting LF. */
  line: number;
}

export function isBinaryPath(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return false;
  return BINARY_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

/**
 * Every C0 control byte (plus DEL) that is not TAB or LF, with its offset and
 * line. Returns them ALL rather than short-circuiting, so one run reports the
 * whole file instead of forcing a fix-and-rerun loop.
 */
export function findControlBytes(content: Uint8Array): ControlByteFinding[] {
  const findings: ControlByteFinding[] = [];
  let line = 1;

  for (let offset = 0; offset < content.length; offset++) {
    const byte = content[offset]!;
    if (byte === 0x0a) {
      line++;
      continue;
    }
    if (ALLOWED_CONTROL_BYTES.has(byte)) continue;
    if (byte < 0x20 || byte === 0x7f) {
      findings.push({ byte, offset, line });
    }
  }

  return findings;
}

/** A one-line, actionable report naming the file, the position and the fix. */
export function describeFinding(path: string, finding: ControlByteFinding): string {
  const hex = `0x${finding.byte.toString(16).padStart(2, '0')}`;
  const escape = finding.byte === 0
    ? '\\0'
    : `\\u${finding.byte.toString(16).padStart(4, '0')}`;
  return (
    `${path}:${finding.line}: raw control byte ${hex} at offset ${finding.offset}. ` +
    `grep and rg treat the whole file as BINARY and silently skip it, so every ` +
    `grep-based audit stops seeing this file. Write it as the escape '${escape}' instead ` +
    `(identical at runtime), or add the extension to BINARY_EXTENSIONS if the file is ` +
    `genuinely binary.`
  );
}
