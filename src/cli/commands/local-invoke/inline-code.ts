import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  displayAssemblyPath,
  renderAssemblyPathEscape,
  resolveAssemblyPath,
} from '../../../utils/assembly-path.js';

/**
 * Where an inline `Code.ZipFile` body is written inside `dir`, refusing a
 * `Handler` whose module path escapes it (issue
 * [#3489](https://github.com/go-to-k/cdkd/issues/3489)).
 *
 * `Handler` is template-supplied, and `materializeInlineCode` turned it into a
 * FILENAME and then `mkdirSync(dirname, { recursive: true })` + `writeFileSync`
 * — so `Handler: '../../victim/evil.handler'` wrote attacker-chosen JavaScript
 * to an arbitrary host path. Measured: the file was created outside the temp
 * directory. That is a write, not the "we run their handler in a container"
 * trade cdkd already accepts.
 *
 * `dir` is a temp directory cdkd just created rather than the assembly, but
 * the containment question is identical and `resolveAssemblyPath` answers it
 * unchanged: `mkdtemp` sits under `/var/folders/...`, reached through macOS's
 * `/var -> /private/var` link, and the helper realpaths BOTH sides so that is
 * a no-op. Only the refusal's provenance differs, so it is passed explicitly.
 *
 * Exported for unit testing.
 */
export function resolveInlineCodeFilePath(
  dir: string,
  modulePath: string,
  fileExtension: string,
  handler: string
): string {
  const resolved = resolveAssemblyPath(dir, `${modulePath}${fileExtension}`);
  if (!resolved.contained) {
    // cdkd-raw-beside-safe: `renderAssemblyPathEscape` is a safe RENDERER, not
    // a value — it renders every path through `displayAssemblyPath` and the
    // rest of its text is this file's own literal. The population fence sees a
    // bare call beside a `displaySafe(...)` and cannot tell the two apart.
    throw new Error(
      `Handler ${displayAssemblyPath(handler)} names a module path that ` +
        `${renderAssemblyPathEscape(
          resolved,
          dir,
          'materialize it',
          `A Handler's module path names a file inside the function's own code directory; ` +
            `one that leaves it would write the inline Code.ZipFile body to an arbitrary ` +
            `path on this machine. Refusing to materialize it.`
        )}`
    );
  }
  return resolved.path;
}

/**
 * Materialize an inline Lambda body (`Code.ZipFile`) to a tmpdir and
 * return the directory the container should mount at /var/task. The
 * filename is derived from the function's Handler property and the
 * runtime's source-file extension (`.js` for Node.js, `.py` for Python):
 *
 *   Handler "index.handler" + ext ".js"   → tmpdir/index.js
 *   Handler "index.handler" + ext ".py"   → tmpdir/index.py
 *   Handler "lib/handler.main" + ext ".js" → tmpdir/lib/handler.js
 *
 * (Drop the last segment, append the extension to the rest.)
 *
 * The Handler grammar is `<modulePath>.<funcName>` for both Node.js and
 * Python (the dot is the same module-vs-function separator), so the
 * parsing logic is identical across runtimes — only the file extension
 * varies.
 */
export function materializeInlineCode(
  handler: string,
  source: string,
  fileExtension: string
): string {
  const lastDot = handler.lastIndexOf('.');
  if (lastDot <= 0) {
    throw new Error(`Handler '${handler}' is malformed: expected '<modulePath>.<exportName>'.`);
  }
  const modulePath = handler.substring(0, lastDot);
  const dir = mkdtempSync(path.join(tmpdir(), 'cdkd-local-invoke-'));
  // The directory exists before the guard can refuse, and this twin returns
  // the path rather than registering it with a caller's cleanup set (the
  // `start-api` twin's `tmpDirsOut` does that BEFORE its own guard), so a
  // refusal here would leak it. Empty and 0700, but a refused run should
  // leave nothing behind (go-to-k/cdkd#3489).
  try {
    const filePath = resolveInlineCodeFilePath(dir, modulePath, fileExtension, handler);
    // Inside the `try` as well: a module path that is CONTAINED can still
    // fail the write -- a >255-byte component is ENAMETOOLONG, an embedded NUL
    // is ERR_INVALID_ARG_VALUE -- and both come from the same
    // template-supplied `Handler` the guard exists for.
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, source, 'utf-8');
  } catch (e) {
    // The cleanup must not replace the error: an EACCES/EBUSY here would
    // otherwise hide the containment refusal that is the point of the throw.
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    throw e;
  }
  return dir;
}
