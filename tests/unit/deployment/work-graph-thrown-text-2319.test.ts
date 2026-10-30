import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * go-to-k/cdkd#2319: the work graph's `N node(s) failed` rejection is thrown,
 * and an asset upload's AWS-authored `AccessDenied` names the caller's ARN. It
 * names that failure by its class plus the `--verbose` pointer; the per-node
 * `Failed:` line keeps AWS's text.
 */
const log = vi.hoisted(() => ({ error: vi.fn(), debug: vi.fn() }));
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    child: () => ({ debug: log.debug, info: vi.fn(), warn: vi.fn(), error: log.error }),
  }),
}));

import { WorkGraph, type WorkNode } from '../../../src/deployment/work-graph.js';
import { awsSdkError } from '../_aws-sdk-error.js';

const CONCURRENCY = { 'asset-build': 4, 'asset-publish': 8, stack: 4 };
const CALLER = 'arn:aws:sts::123456789012:assumed-role/Deployer/session';

function node(id: string): WorkNode {
  return { id, type: 'asset-publish', dependencies: new Set(), state: 'pending', data: null };
}

async function failing(error: Error): Promise<Error> {
  const graph = new WorkGraph();
  graph.addNode(node('asset:A'));
  return graph
    .execute(CONCURRENCY, async () => {
      throw error;
    })
    .then(
      () => {
        throw new Error('expected a rejection');
      },
      (e: unknown) => e as Error
    );
}

describe('WorkGraph failure summary (#2319)', () => {
  beforeEach(() => {
    log.error.mockReset();
  });

  it('names an AWS failure by its class', async () => {
    const rejection = await failing(
      awsSdkError(`User: ${CALLER} is not authorized to perform: s3:PutObject`, 'AccessDenied')
    );

    expect(rejection.message).toBe(
      "1 node(s) failed:\n  - asset:A: AccessDenied. Re-run with --verbose for AWS's own message."
    );
    expect(log.error.mock.calls.map((c) => String(c[0]))).toEqual([
      `Failed: asset:A: User: ${CALLER} is not authorized to perform: s3:PutObject`,
    ]);
  });

  it("keeps cdkd's own text (negative control)", async () => {
    const rejection = await failing(new Error('Stack S failed: boom'));

    expect(rejection.message).toBe('1 node(s) failed:\n  - asset:A: Stack S failed: boom');
  });
});
