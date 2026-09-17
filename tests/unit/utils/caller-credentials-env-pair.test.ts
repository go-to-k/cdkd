import { describe, expect, it } from 'vite-plus/test';

import { readEnvCredentials } from '../../../src/utils/caller-credentials.js';

/**
 * The both-halves-required guard.
 *
 * `readEnvCredentials` decides what counts as "the caller had static
 * credentials", and that answer picks between two very different outcomes one
 * layer up: a RESTORE (the caller's triple goes back onto the container's
 * environment) or a STRIP (all three keys are removed and the container falls
 * back to its own resolution). Returning a half-pair would produce a third
 * outcome that is worse than either -- the container is handed an access key id
 * with no secret, reads as credentialed, and fails at its first signature with
 * an error naming neither cdkd nor the missing half.
 *
 * Driven through the `source` parameter rather than `process.env`, so no case
 * here can leak into another file.
 */

const AKID = 'AKIACALLEROWNCREDS000';
const SECRET = 'caller-secret';
const TOKEN = 'caller-token';

describe('readEnvCredentials: an access key without its secret is not an identity', () => {
  it('returns the pair when both halves are present', () => {
    expect(readEnvCredentials({ AWS_ACCESS_KEY_ID: AKID, AWS_SECRET_ACCESS_KEY: SECRET })).toEqual({
      accessKeyId: AKID,
      secretAccessKey: SECRET,
    });
  });

  it('carries the session token when there is one, and omits the key when there is not', () => {
    expect(
      readEnvCredentials({
        AWS_ACCESS_KEY_ID: AKID,
        AWS_SECRET_ACCESS_KEY: SECRET,
        AWS_SESSION_TOKEN: TOKEN,
      })
    ).toEqual({ accessKeyId: AKID, secretAccessKey: SECRET, sessionToken: TOKEN });

    // Absent, not `sessionToken: undefined` -- a present-but-undefined key
    // survives an object spread and reaches the SDK as a declared field.
    expect(
      readEnvCredentials({ AWS_ACCESS_KEY_ID: AKID, AWS_SECRET_ACCESS_KEY: SECRET })
    ).not.toHaveProperty('sessionToken');
  });

  it('REFUSES an access key id with no secret', () => {
    expect(readEnvCredentials({ AWS_ACCESS_KEY_ID: AKID })).toBeUndefined();
  });

  it('REFUSES a secret with no access key id', () => {
    // The mirror of the case above. Dropping either half of the guard leaves
    // one of these two green, which is why both are here.
    expect(readEnvCredentials({ AWS_SECRET_ACCESS_KEY: SECRET })).toBeUndefined();
  });

  it('treats an EMPTY value as absent, not as a supplied half', () => {
    // `AWS_ACCESS_KEY_ID=` in a shell is a set-but-empty variable, so a
    // presence test (`in`, `!== undefined`) would accept it and produce the
    // unusable pair this guard exists to prevent.
    expect(
      readEnvCredentials({ AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: SECRET })
    ).toBeUndefined();
    expect(
      readEnvCredentials({ AWS_ACCESS_KEY_ID: AKID, AWS_SECRET_ACCESS_KEY: '' })
    ).toBeUndefined();
  });

  it('returns undefined for an environment carrying neither half', () => {
    expect(readEnvCredentials({})).toBeUndefined();
    expect(readEnvCredentials({ AWS_PROFILE: 'dev' })).toBeUndefined();
  });
});
