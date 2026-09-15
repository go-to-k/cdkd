import { describe, expect, it } from 'vite-plus/test';
import { redactedDockerCause } from '../../../src/utils/docker-cmd.js';

/**
 * go-to-k/cdkd#2075 threads a `cause` onto the four `AssetError`s the docker
 * asset publisher raises, so the retry classifiers see an error object rather
 * than an interpolated message. Attaching the RAW `execFile` error would
 * reopen the channel go-to-k/cdkd#2440 closed: its `message` is the command
 * line, and `formatError` prints `cause.message` while the CLI's top-level
 * handler walks the whole chain.
 *
 * The argv used here carries `-e` pairs that cdkd does not build TODAY — the
 * publisher's four argv lists are secret-free. That is the point: the rule in
 * `.claude/rules/docker-argv-redaction.md` is explicit that a site whose argv
 * carries no user data today must still redact, because the edit that adds a
 * `-e` later touches the spawn and not the error site.
 */
const SECRET = 'hunter2-SUPER-SECRET-VALUE';
const ARGS = ['run', '-e', `DB_PASSWORD=${SECRET}`, '--rm', 'my-image'];

function execFileLikeError(): Error & Record<string, unknown> {
  // execFile folds the whole command line into `message`, and also hangs it on
  // `cmd` — the field that defeated four rounds of the #2440 fence.
  const err = new Error(
    `Command failed: docker ${ARGS.join(' ')}\nunauthorized: authentication required`
  ) as Error & Record<string, unknown>;
  err.name = 'ExecFileError';
  err.cmd = `docker ${ARGS.join(' ')}`;
  err.code = 125;
  err.errno = -1;
  err.$metadata = { httpStatusCode: 500 };
  return err;
}

describe('redactedDockerCause', () => {
  it('keeps the secret argv value out of the cause message', () => {
    const cause = redactedDockerCause(execFileLikeError(), ARGS);
    expect(cause).toBeInstanceOf(Error);
    expect(cause?.message).not.toContain(SECRET);
    // The KEY survives — it is the diagnostic, and only the value is secret.
    expect(cause?.message).toContain('DB_PASSWORD');
  });

  it('keeps the secret out of EVERY field a printer or a chain-walker reads', () => {
    const cause = redactedDockerCause(execFileLikeError(), ARGS) as Error &
      Record<string, unknown>;
    // Not just `message`: `cmd` carries the same command line, and a copied
    // `stack` names a throw site whose text includes it.
    expect(JSON.stringify({ ...cause, message: cause.message, stack: cause.stack })).not.toContain(
      SECRET
    );
    expect(cause.stack ?? '').not.toContain(SECRET);
    // Nothing further is chained — a `cause` on the cause would re-expose the
    // original verbatim one link down.
    expect(cause.cause).toBeUndefined();
  });

  it('preserves the fields the retry classifiers read', () => {
    const cause = redactedDockerCause(execFileLikeError(), ARGS) as Error &
      Record<string, unknown>;
    // This is what threading a cause BUYS (#2075). A cause that lost these
    // would be a redaction that silently undid the fix it rides on.
    expect(cause.name).toBe('ExecFileError');
    expect(cause.code).toBe(125);
    expect(cause.errno).toBe(-1);
    expect(cause.$metadata).toEqual({ httpStatusCode: 500 });
  });

  it('returns undefined for a non-Error throw rather than fabricating one', () => {
    expect(redactedDockerCause('a string', ARGS)).toBeUndefined();
    expect(redactedDockerCause(undefined, ARGS)).toBeUndefined();
  });

  it('prefers the stderr diagnostic, which is what the user needs', () => {
    const err = new Error('Command failed: docker run …') as Error & Record<string, unknown>;
    err.stderr = 'denied: requested access to the resource is denied';
    const cause = redactedDockerCause(err, ARGS);
    expect(cause?.message).toContain('requested access to the resource is denied');
  });
});
