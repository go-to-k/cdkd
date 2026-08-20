import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

// Issue #2054: a custom resource whose delete handler RAN and answered
// `Status: 'FAILED'` used to be recorded exactly like a successful delete —
// `deleteSkipReason` reads a `void` return as DELETED, so the state record was
// dropped, the row printed as deleted, and the destroy exited 0 over a resource
// the handler had explicitly refused to remove.
//
// Its sibling `custom-resource-provider-thrown-retry.test.ts` covers the arm
// reached through a THROW (issue #2033). Kept in its own file so neither can
// leak a `*Once` primer into the other; no `*Once` primers are used here at all.
const mockLambdaSend = vi.fn();
const mockSnsSend = vi.fn();
const mockS3Send = vi.fn();
/**
 * Stand-in for the STS client `getAccountInfo()` resolves the deploy account
 * through (issue #1866) — the synthetic `StackId` is built from it, so without
 * a stand-in every case here would reach for a real one.
 */
const mockStsSend = vi.fn(() => Promise.resolve({ Account: '123456789012' }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: { send: mockLambdaSend },
    sns: { send: mockSnsSend },
    s3: { send: mockS3Send },
    sts: { send: mockStsSend },
  }),
}));

const warnSpy = vi.fn();
vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: (...args: unknown[]) => warnSpy(...args),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: () => Promise.resolve('https://s3.example.com/presigned-url'),
}));

import {
  CustomResourceProvider,
  CR_DELETE_HANDLER_FAILED_SKIP_REASON,
} from '../../../src/provisioning/providers/custom-resource-provider.js';
import { deleteSkipReason } from '../../../src/deployment/delete-outcome.js';
import { resetAccountInfoCache } from '../../../src/deployment/intrinsic-function-resolver.js';

const SERVICE_TOKEN = 'arn:aws:lambda:us-east-1:123456789012:function:Stack-CrHandler';

/**
 * Wire the Lambda / S3 mocks so the handler's DIRECT payload is `response`.
 * The direct-payload path short-circuits the S3 poll, so one object decides
 * the whole outcome.
 */
function wireHandlerResponse(response: Record<string, unknown>): void {
  mockS3Send.mockImplementation(() => Promise.resolve({}));
  mockLambdaSend.mockImplementation((cmd: { constructor: { name: string } }) => {
    if (cmd.constructor.name === 'InvokeCommand') {
      return Promise.resolve({ Payload: Buffer.from(JSON.stringify(response)) });
    }
    // GetFunction for the delete-path backing-Lambda pre-check.
    return Promise.resolve({ Configuration: { State: 'Active', LastUpdateStatus: 'Successful' } });
  });
}

function makeProvider(): CustomResourceProvider {
  return new CustomResourceProvider({ responseBucket: 'test-bucket' });
}

function warnings(): string {
  return warnSpy.mock.calls.map((call) => String(call[0])).join('\n');
}

describe('CustomResourceProvider delete: a handler that answers FAILED (issue #2054)', () => {
  beforeEach(() => {
    mockLambdaSend.mockReset();
    mockSnsSend.mockReset();
    mockS3Send.mockReset();
    warnSpy.mockReset();
    resetAccountInfoCache();
    // The re-invoke budget re-runs the handler on a TRANSIENT-authz FAILED;
    // every reason used here is a plain refusal, but pinning the budget keeps
    // the invoke counts below meaningful.
    process.env['CDKD_CR_AUTHZ_MAX_RETRIES'] = '0';
  });

  afterEach(() => {
    delete process.env['CDKD_CR_AUTHZ_MAX_RETRIES'];
  });

  it('reports the row as SKIPPED, so the state record is KEPT', async () => {
    // THE discriminator. `undefined` is what `deleteSkipReason` reads as
    // DELETED — the destroy runner then drops the record, prints a deleted row
    // and exits 0. Asserting through that same helper is what makes this a
    // statement about the RECORD rather than about a return shape.
    wireHandlerResponse({ Status: 'FAILED', Reason: 'the upstream API refused the teardown' });
    const provider = makeProvider();

    const result = await provider.delete('CrResource', 'phys-123', 'Custom::CrResource', {
      ServiceToken: SERVICE_TOKEN,
    });

    expect(result).toEqual({
      outcome: 'skipped',
      reason: CR_DELETE_HANDLER_FAILED_SKIP_REASON,
    });
    expect(deleteSkipReason(result)).toBe(CR_DELETE_HANDLER_FAILED_SKIP_REASON);
  });

  it('still reports DELETED when the handler answers SUCCESS', async () => {
    // The polarity. Without it the case above is satisfied by a provider that
    // skips every delete, which would fail every destroy of a custom resource.
    wireHandlerResponse({ Status: 'SUCCESS', PhysicalResourceId: 'phys-123' });
    const provider = makeProvider();

    const result = await provider.delete('CrResource', 'phys-123', 'Custom::CrResource', {
      ServiceToken: SERVICE_TOKEN,
    });

    expect(result).toBeUndefined();
    expect(deleteSkipReason(result)).toBeUndefined();
  });

  it('is UNCONDITIONAL — an already-gone reason is skipped too, with no classifier', async () => {
    // The maintainer's decision (option 1): no already-gone special case. The
    // reason is free text a user's handler writes, so a classifier is a guess
    // and a wrong guess re-introduces the orphan. This case is what a future
    // "just skip the already-gone ones" change would have to break.
    wireHandlerResponse({
      Status: 'FAILED',
      Reason: 'the resource does not exist, nothing to delete',
    });
    const provider = makeProvider();

    const result = await provider.delete('CrResource', 'phys-123', 'Custom::CrResource', {
      ServiceToken: SERVICE_TOKEN,
    });

    expect(deleteSkipReason(result)).toBe(CR_DELETE_HANDLER_FAILED_SKIP_REASON);
  });

  it("keeps the handler's own Reason OUT of the skip reason and ON the warning", async () => {
    // A `reason` is rendered into the `Error` the deploy-side replacement sites
    // throw, and their catch classifies "already deleted" by SUBSTRING — so a
    // handler Reason carrying `does not exist` would drop the record one layer
    // further out. It has to be diagnosable somewhere, hence the warn.
    wireHandlerResponse({
      Status: 'FAILED',
      Reason: 'the resource does not exist, nothing to delete',
    });
    const provider = makeProvider();

    const result = await provider.delete('CrResource', 'phys-123', 'Custom::CrResource', {
      ServiceToken: SERVICE_TOKEN,
    });

    expect(deleteSkipReason(result)).toBeDefined();
    expect(String(deleteSkipReason(result))).not.toContain('does not exist');
    expect(warnings()).toContain('does not exist');
    expect(warnings()).toContain('LEFT IN PLACE');
  });

  it('keeps the skip reason clear of every already-deleted phrase the callers match on', () => {
    for (const phrase of [
      'does not exist',
      'was not found',
      'not found',
      'No policy found',
      'NoSuchEntity',
      'NotFoundException',
      'ResourceNotFoundException',
    ]) {
      expect(CR_DELETE_HANDLER_FAILED_SKIP_REASON.toLowerCase()).not.toContain(
        phrase.toLowerCase()
      );
    }
  });

  it('names the remedy that exists on the DESTROY path, not the deploy-only flag', () => {
    // `--allow-unaddressed` is deploy-only (`src/cli/options.ts`); `cdkd
    // destroy` raises `PartialFailureError` unconditionally. This arm is
    // mostly reached from destroy, so advising the flag alone would send the
    // user after an option that command does not have.
    expect(CR_DELETE_HANDLER_FAILED_SKIP_REASON).not.toContain('--allow-unaddressed');
  });

  it('does not report a skip merely because a warning was logged', async () => {
    // Guards the confluence point: the pre-fix code ALSO warned on this arm,
    // so a test asserting only the warning passes against the defect.
    wireHandlerResponse({ Status: 'FAILED', Reason: 'nope' });
    const provider = makeProvider();

    const result = await provider.delete('CrResource', 'phys-123', 'Custom::CrResource', {
      ServiceToken: SERVICE_TOKEN,
    });

    expect(warnings()).toContain('returned FAILED');
    expect(result).not.toBeUndefined();
  });

  it('the NEXT destroy drops the kept record — the known bound, stated LOUDLY', async () => {
    // Run 1 skips and keeps the record. But `destroy-runner.ts` walks every
    // reverse-DAG level regardless of skips, so that SAME run deletes the
    // backing Lambda. Run 2 therefore reaches the issue-#804 pre-check, finds
    // the function gone, and drops the record — the silent orphan #2054
    // removed one run earlier, reached one run later.
    //
    // It is deliberately still a DELETE (see the in-code note): flipping it to
    // a skip would turn a legitimate shape red too — a shared provider stack
    // destroyed before its consumers, where the ServiceToken points at a
    // Lambda another stack already removed — and that trade is the
    // maintainer's. Closing it properly needs a durable "a prior run skipped
    // this" signal, which lives in the state schema or in `DeleteContext`.
    //
    // So what this pins is the two halves that ARE in reach: the outcome is
    // unchanged, and the run is no longer SILENT about what it just dropped.
    mockS3Send.mockImplementation(() => Promise.resolve({}));
    mockLambdaSend.mockImplementation((cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'GetFunctionCommand') {
        return Promise.reject(
          Object.assign(new Error('Function not found'), { name: 'ResourceNotFoundException' })
        );
      }
      return Promise.resolve({});
    });
    const provider = makeProvider();

    const result = await provider.delete('CrResource', 'phys-123', 'Custom::CrResource', {
      ServiceToken: SERVICE_TOKEN,
    });

    // The bound itself: still reported as deleted, so the record is dropped.
    expect(result).toBeUndefined();
    expect(deleteSkipReason(result)).toBeUndefined();

    // ...but the run says so, and says what it means. Before this it read as a
    // clean success, so a record kept by a skip vanished with no hint at all.
    expect(warnings()).toContain('DROPPING its state record');
    expect(warnings()).toContain('still');
    expect(warnings()).toContain('LIVE');
    expect(warnings()).toContain('2054');
  });

  it('promises no retry it cannot keep on the destroy path', async () => {
    // The warn used to say "cdkd is KEEPING the state record so a re-run can
    // retry it". On `cdkd destroy` that is false for the reason the case above
    // measures, and destroy has no `--allow-unaddressed` to soften it.
    wireHandlerResponse({ Status: 'FAILED', Reason: 'the upstream API refused the teardown' });
    const provider = makeProvider();

    await provider.delete('CrResource', 'phys-123', 'Custom::CrResource', {
      ServiceToken: SERVICE_TOKEN,
    });

    expect(warnings()).not.toContain('a re-run can retry it');
    expect(warnings()).toContain('POINTER, not a retry');
    expect(warnings()).toContain('cdkd state orphan <stack>');
    // ...and it says what that command actually does, which is not a
    // single-record drop.
    expect(warnings()).toContain('EVERY record for the stack');
  });

  it('leaves the create / update FAILED arms throwing, unchanged', async () => {
    // A create has no resource to leave behind, so the honest answer there is
    // still a hard failure — the skip is a DELETE-path statement.
    wireHandlerResponse({ Status: 'FAILED', Reason: 'handler blew up' });
    const provider = makeProvider();

    await expect(
      provider.create('CrResource', 'Custom::CrResource', { ServiceToken: SERVICE_TOKEN })
    ).rejects.toThrow(/handler returned FAILED/);

    await expect(
      provider.update(
        'CrResource',
        'phys-123',
        'Custom::CrResource',
        { ServiceToken: SERVICE_TOKEN },
        { ServiceToken: SERVICE_TOKEN }
      )
    ).rejects.toThrow(/handler returned FAILED/);
  });
});
