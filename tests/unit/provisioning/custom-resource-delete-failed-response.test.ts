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
  CR_BACKING_LAMBDA_GONE_SKIP_REASON,
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

  it.each([
    ['handler-FAILED', CR_DELETE_HANDLER_FAILED_SKIP_REASON],
    ['backing-Lambda-gone', CR_BACKING_LAMBDA_GONE_SKIP_REASON],
  ])(
    'keeps the %s skip reason clear of every already-deleted phrase the callers match on',
    (_label, reason) => {
      for (const phrase of [
        'does not exist',
        'was not found',
        'not found',
        'No policy found',
        'NoSuchEntity',
        'NotFoundException',
        'ResourceNotFoundException',
      ]) {
        expect(reason.toLowerCase()).not.toContain(phrase.toLowerCase());
      }
    }
  );

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

  it('the NEXT stack destroy, with the backing Lambda gone, skips again and KEEPS the record (issue #2115)', async () => {
    // Run 1 skips and keeps the record. But `destroy-runner.ts` walks every
    // reverse-DAG level regardless of skips, so that SAME run deletes the
    // backing Lambda. Run 2 therefore reaches the issue-#804 pre-check and
    // finds the function gone. It used to answer DELETED there — dropping the
    // record and exiting 0 over the resource the handler had refused to remove.
    // The maintainer's decision on #2115 (option 1): a skip, unconditionally.
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

    const result = await provider.delete(
      'CrResource',
      'phys-123',
      'Custom::CrResource',
      { ServiceToken: SERVICE_TOKEN },
      // What `destroy-runner.ts` passes: the skip is scoped to a stack destroy.
      { stackDestroy: true }
    );

    // THE discriminator, read through the helper the destroy runner uses: a
    // `void` here is what dropped the record.
    expect(result).toEqual({ outcome: 'skipped', reason: CR_BACKING_LAMBDA_GONE_SKIP_REASON });
    expect(deleteSkipReason(result)).toBe(CR_BACKING_LAMBDA_GONE_SKIP_REASON);

    // Still fail-fast (issue #804): the one GetFunction, no waiter, no invoke.
    expect(mockLambdaSend).toHaveBeenCalledTimes(1);
    expect(
      (mockLambdaSend.mock.calls[0]![0] as { constructor: { name: string } }).constructor.name
    ).toBe('GetFunctionCommand');

    // The warning tells the truth about the record and names the escape.
    expect(warnings()).not.toContain('DROPPING');
    expect(warnings()).toContain('KEEPING the state record');
    expect(warnings()).toContain('LIVE');
    expect(warnings()).toContain('DELETE_FAILED');
    expect(warnings()).toContain("'cdkd state orphan <stack> --stack-region <region>'");
    expect(warnings()).toContain('drops every record the stack still has in that region');
    expect(warnings()).toContain("add '--resource CrResource' to drop only this one");
    // Reached only from a destroy, so it carries no deploy-side caveat.
    expect(warnings()).not.toContain('ALSO reached from cdkd deploy');
  });

  it.each([
    ['no context', undefined],
    ['a deploy-engine context', { expectedRegion: 'us-east-1', deletionPolicy: 'Delete' }],
    ['stackDestroy: false', { stackDestroy: false }],
  ])(
    'outside a stack destroy (%s) the gone-Lambda pre-check keeps the LOUD warn-and-drop',
    async (_label, context) => {
      // A deploy-engine delete (template removal, replacement, rollback): a
      // kept record there would fail every later deploy, and CloudFormation
      // ignores delete failures in an update's cleanup phase (issue #2115).
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

      const result = await provider.delete(
        'CrResource',
        'phys-123',
        'Custom::CrResource',
        { ServiceToken: SERVICE_TOKEN },
        context
      );

      expect(result).toBeUndefined();
      expect(deleteSkipReason(result)).toBeUndefined();
      expect(mockLambdaSend).toHaveBeenCalledTimes(1);
      expect(warnings()).toContain('DROPPING its state record');
      expect(warnings()).toContain('LIVE');
      expect(warnings()).toContain("update's cleanup phase");
      expect(warnings()).not.toContain('KEEPING the state record');
    }
  );

  it('names the backing-Lambda-gone reason apart from every sibling CR skip', () => {
    expect(CR_BACKING_LAMBDA_GONE_SKIP_REASON).not.toBe(CR_DELETE_HANDLER_FAILED_SKIP_REASON);
    expect(CR_BACKING_LAMBDA_GONE_SKIP_REASON).toMatch(/not invoked/);
    expect(CR_BACKING_LAMBDA_GONE_SKIP_REASON.length).toBeLessThanOrEqual(64);
  });

  it('promises no retry it cannot keep on the destroy path', async () => {
    // The warn used to say "cdkd is KEEPING the state record so a re-run can
    // retry it". On `cdkd destroy` that is false for the reason the case above
    // measures — the re-run skips at the pre-check and never reaches the
    // handler — and destroy has no `--allow-unaddressed` to soften it.
    wireHandlerResponse({ Status: 'FAILED', Reason: 'the upstream API refused the teardown' });
    const provider = makeProvider();

    await provider.delete(
      'CrResource',
      'phys-123',
      'Custom::CrResource',
      { ServiceToken: SERVICE_TOKEN },
      // The destroy-side remedy is scoped to a stack destroy (go-to-k/cdkd#4596).
      { stackDestroy: true }
    );

    expect(warnings()).not.toContain('a re-run can retry it');
    expect(warnings()).toContain('POINTER, not a retry');
    // ...and no longer claims the next destroy drops the record (issue #2115).
    expect(warnings()).not.toContain('DROPS this record');
    expect(warnings()).toContain('skips this resource again and keeps the record');
    expect(warnings()).toContain('cdkd state orphan <stack> --stack-region <region>');
    // ...and it says what that command actually does, which is not a
    // single-record drop.
    expect(warnings()).toContain('drops every record the stack still has in that region');
    expect(warnings()).toContain("add '--resource CrResource' to drop only this one");
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
