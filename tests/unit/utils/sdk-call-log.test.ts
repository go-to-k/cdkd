/**
 * The SDK call log (`CDKD_SDK_CALL_LOG`, state schema v12's measurement
 * harness): off by default, so client configs are unchanged; on, every
 * command a REAL SDK client sends through its own logger middleware is counted
 * once per client and command, success or failure, and nothing of the input
 * or output is kept.
 */
import { Readable } from 'node:stream';
import { describe, it, expect, afterEach } from 'vite-plus/test';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { awsClientDefaults } from '../../../src/utils/aws-client-defaults.js';
import {
  SDK_CALL_LOG_ENV,
  resetSdkCallCounts,
  sdkCallCounts,
} from '../../../src/utils/sdk-call-log.js';

/** A request handler that answers every request without a network. */
function fakeHandler(status: number, firstStatus?: number): { handle: () => Promise<unknown> } {
  let first = firstStatus;
  return {
    handle: () => {
      const code = first ?? status;
      first = undefined;
      return Promise.resolve({
        response: {
          statusCode: code,
          headers: { 'content-type': 'text/xml' },
          body: Readable.from([
            Buffer.from(
              code === 200
                ? '<GetCallerIdentityResponse><GetCallerIdentityResult><Account>123456789012</Account><Arn>arn:aws:iam::123456789012:user/x</Arn><UserId>X</UserId></GetCallerIdentityResult></GetCallerIdentityResponse>'
                : '<ErrorResponse><Error><Code>AccessDenied</Code><Message>no</Message></Error></ErrorResponse>'
            ),
          ]),
        },
      });
    },
  };
}

const client = (status: number, firstStatus?: number): STSClient =>
  new STSClient({
    ...awsClientDefaults(),
    region: 'us-east-1',
    credentials: { accessKeyId: 'AKIAFAKE', secretAccessKey: 'fake' },
    requestHandler: fakeHandler(status, firstStatus) as never,
    maxAttempts: firstStatus === undefined ? 1 : 3,
  });

afterEach(() => {
  delete process.env[SDK_CALL_LOG_ENV];
  resetSdkCallCounts();
});

describe('the SDK call log', () => {
  it('is off by default: the defaults carry no logger and nothing is counted', async () => {
    expect(Object.hasOwn(awsClientDefaults(), 'logger')).toBe(false);
    await client(200).send(new GetCallerIdentityCommand({}));
    expect(sdkCallCounts()).toEqual({});
  });

  it('counts each command once per client and command, success and failure alike', async () => {
    process.env[SDK_CALL_LOG_ENV] = '/dev/null';
    await client(200).send(new GetCallerIdentityCommand({}));
    await client(200).send(new GetCallerIdentityCommand({}));
    await client(403)
      .send(new GetCallerIdentityCommand({}))
      .catch(() => undefined);
    expect(sdkCallCounts()).toEqual({ 'STSClient.GetCallerIdentityCommand': 3 });
  });

  it('a retried command counts once, and only the two names are kept', async () => {
    process.env[SDK_CALL_LOG_ENV] = '/dev/null';
    // A 500 first, retried by the SDK, then a success: one command.
    await client(200, 500).send(new GetCallerIdentityCommand({}));
    const counts = sdkCallCounts();
    expect(counts).toEqual({ 'STSClient.GetCallerIdentityCommand': 1 });
    expect(JSON.stringify(counts)).not.toContain('123456789012');
  });
});
