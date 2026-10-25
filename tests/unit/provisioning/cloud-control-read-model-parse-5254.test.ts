import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * Issue [#5254](https://github.com/go-to-k/cdkd/issues/5254), its last site:
 * `CloudControlProvider.readCurrentState` parsed the Cloud Control resource
 * model with `JSON.parse` and rethrew V8's `SyntaxError`, which quotes a window
 * of the model, so a plaintext property value could reach `cdkd drift`'s and
 * `cdkd state refresh-observed`'s warn lines. The case first proves V8 quotes
 * the token for the body it feeds, then pins the token as absent from the
 * thrown error, its cause chain, `formatError` and every log level above
 * `debug`, and present at `debug`.
 */

const { mockCloudControlSend, loggerSpies } = vi.hoisted(() => ({
  mockCloudControlSend: vi.fn(),
  loggerSpies: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudControl: {
      send: mockCloudControlSend,
      config: { region: () => Promise.resolve('us-east-1') },
    },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({ ...loggerSpies, child: () => loggerSpies }),
}));

import { CloudControlProvider } from '../../../src/provisioning/cloud-control-provider.js';
import { formatError } from '../../../src/utils/error-handler.js';
import {
  LEAK_BODY,
  LEAK_BODY_BYTES,
  LEAK_TOKEN,
  causeChainText,
  expectLeakTokenOnlyAtDebug,
  expectV8QuotesLeakToken,
} from '../_json-parse-leak.js';

describe('CloudControlProvider.readCurrentState: an unparseable model quotes no body (issue #5254)', () => {
  beforeEach(() => {
    for (const fn of Object.values(loggerSpies)) fn.mockReset();
    mockCloudControlSend.mockReset();
    expectV8QuotesLeakToken();
  });

  it('throws a snippet-free SyntaxError naming the type and size, with V8 text at debug only', async () => {
    mockCloudControlSend.mockResolvedValue({
      ResourceDescription: { Identifier: 'b', Properties: LEAK_BODY },
    });

    const err = await new CloudControlProvider()
      .readCurrentState('b', 'MyBucket', 'AWS::S3::Bucket')
      .catch((e: unknown) => e);

    // A real `SyntaxError`: `cdkd state refresh-observed`'s catch routes that
    // class to its class-only line (`state.ts`, pinned end to end in
    // `state-refusal-boundary.test.ts`).
    expect(err).toBeInstanceOf(SyntaxError);
    expect((err as Error).message).toBe(
      'Cloud Control returned a resource model for AWS::S3::Bucket that is not valid JSON: ' +
        `invalid JSON; ${LEAK_BODY_BYTES} byte(s) read`
    );
    expect((err as Error).cause).toBeUndefined();
    expect(causeChainText(err)).not.toContain(LEAK_TOKEN);
    expect(formatError(err)).not.toContain(LEAK_TOKEN);
    expectLeakTokenOnlyAtDebug(loggerSpies);
  });
});
