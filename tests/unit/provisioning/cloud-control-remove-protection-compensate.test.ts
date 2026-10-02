/**
 * `--remove-protection` compensation on the Cloud Control delete path (issue
 * #2204): the protection-registry types (`cc-protection-properties.ts`) and a
 * Cloud Control-routed `AWS::EC2::Instance`.
 *
 * The registry path had no pre-flip value at all before this (its flip is
 * unconditional), so the readback here is a `GetResource` compared to the
 * entry's `onValue`. Its delete is refused by a handler-reported FAILED at the
 * END of a wait, so `deleteAccepted` is decided per attempt: set on an
 * ABANDONED wait or an ambiguous handler code, cleared by the next
 * `DeleteResource`. Each half gets a row.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const ccSend = vi.hoisted(() => vi.fn());
const ec2Send = vi.hoisted(() => vi.fn());
const ec2Region = vi.hoisted(() => ({ value: 'us-east-1' }));
const ccRegion = vi.hoisted(() => ({ value: 'us-east-1' }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudControl: { send: ccSend, config: { region: () => Promise.resolve(ccRegion.value) } },
    ec2: { send: ec2Send, config: { region: () => Promise.resolve(ec2Region.value) } },
  }),
}));

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  getAccountInfo: () =>
    Promise.resolve({ partition: 'aws', region: 'us-east-1', accountId: '123456789012' }),
}));

const childLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
}));
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    child: () => childLogger,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { CloudControlProvider } from '../../../src/provisioning/cloud-control-provider.js';
import {
  ccProtectionProperty,
  ccProtectionRegistryTypes,
  ccProtectionSite,
} from '../../../src/provisioning/cc-protection-properties.js';
import { WITHHELD_AWS_COMMAND } from '../../../src/provisioning/replacement-protection-advice.js';
import { markWaitAbandoned } from '../../../src/provisioning/wait-abandoned.js';
import { runDeleteAttempt } from '../../../src/provisioning/providers/deletion-protection-compensation.js';

type Cmd = { constructor: { name: string }; input: Record<string, unknown> };

const DSQL = 'AWS::DSQL::Cluster';
const STORE = 'AWS::VerifiedPermissions::PolicyStore';
const ID = 'abc123xyz';
const CTX = { removeProtection: true, expectedRegion: 'us-east-1' };
const DSQL_RESTORE =
  `aws cloudcontrol update-resource --type-name ${DSQL} --identifier ${ID} --region us-east-1 ` +
  `--patch-document '[{"op":"add","path":"/DeletionProtectionEnabled","value":true}]'`;

/** A phrase only the compensation's stand-down warning writes. */
const STAND_DOWN = 'cdkd cannot tell whether AWS had started deleting';
const noStandDown = (): void =>
  expect(childLogger.warn).not.toHaveBeenCalledWith(expect.stringContaining(STAND_DOWN));

/** A handler refusal that matches no retryable pattern: TERMINAL. */
const TERMINAL_MSG = 'Cluster has active peers and cannot be deleted.';

interface Script {
  /** What `GetResource` reports for the protection property; an Error to throw; `absent` for no property. */
  observe?: unknown;
  /** Whether the flip-off `UpdateResource` send rejects. */
  disableRejects?: boolean;
  /** A handler FAILED on the flip-off's wait. */
  disableFails?: { failed: string; code?: string };
  /** Whether the flip-off's WAIT is abandoned (the patch was accepted). */
  disableAbandons?: boolean;
  /** Whether the flip-off / re-enable `UpdateResource` answers with no request token. */
  disableNoToken?: boolean;
  reEnableNoToken?: boolean;
  /** The delete's handler outcome; `conflict` rejects the `DeleteResource` send itself. */
  del?: 'SUCCESS' | { failed: string; code?: string } | 'abandon' | 'conflict';
  /** The re-enable's handler outcome. */
  reEnable?: 'SUCCESS' | { failed: string; code?: string };
}

function patchOf(cmd: Cmd): { path: string; value: unknown } {
  return (JSON.parse(cmd.input['PatchDocument'] as string) as { path: string; value: unknown }[])[0]!;
}

function script(type: string, s: Script): void {
  const entry = ccProtectionProperty(type)!;
  ccSend.mockImplementation(async (cmd: Cmd) => {
    const name = cmd.constructor.name;
    if (name === 'GetResourceCommand') {
      if (s.observe instanceof Error) throw s.observe;
      const props: Record<string, unknown> = { Identifier: ID };
      if (s.observe !== 'absent') props[entry.property] = s.observe;
      return { ResourceDescription: { Identifier: ID, Properties: JSON.stringify(props) } };
    }
    if (name === 'UpdateResourceCommand') {
      const isOff = JSON.stringify(patchOf(cmd).value) === JSON.stringify(entry.offValue);
      if (isOff && s.disableRejects) throw new Error('AccessDeniedException: not authorized');
      if ((isOff && s.disableNoToken) || (!isOff && s.reEnableNoToken)) return { ProgressEvent: {} };
      return { ProgressEvent: { RequestToken: isOff ? 'tok-off' : 'tok-on' } };
    }
    if (name === 'DeleteResourceCommand') {
      if (s.del === 'conflict') {
        const e = new Error('Another request is already in progress for this resource');
        e.name = 'ResourceConflictException';
        throw e;
      }
      return { ProgressEvent: { RequestToken: 'tok-del' } };
    }
    if (name === 'GetResourceRequestStatusCommand') {
      const token = cmd.input['RequestToken'];
      const outcome =
        token === 'tok-del'
          ? (s.del ?? 'SUCCESS')
          : token === 'tok-on'
            ? (s.reEnable ?? 'SUCCESS')
            : s.disableAbandons
              ? 'abandon'
              : (s.disableFails ?? 'SUCCESS');
      if (outcome === 'abandon') {
        // A NON-transient poll failure abandons the wait at once.
        const e = new Error('User is not authorized to read the request status');
        e.name = 'AccessDeniedException';
        throw e;
      }
      if (outcome === 'SUCCESS' || outcome === 'conflict') {
        return { ProgressEvent: { OperationStatus: 'SUCCESS' } };
      }
      return {
        ProgressEvent: {
          OperationStatus: 'FAILED',
          StatusMessage: outcome.failed,
          ErrorCode: outcome.code,
          TypeName: type,
          Identifier: ID,
        },
      };
    }
    throw new Error(`unexpected command ${name}`);
  });
}

const calls = (): Cmd[] => ccSend.mock.calls.map((c) => c[0] as Cmd);
const names = (): string[] => calls().map((c) => c.constructor.name);
function updates(type: string, which: 'on' | 'off'): Cmd[] {
  const entry = ccProtectionProperty(type)!;
  const want = JSON.stringify(which === 'on' ? entry.onValue : entry.offValue);
  return calls().filter(
    (c) => c.constructor.name === 'UpdateResourceCommand' && JSON.stringify(patchOf(c).value) === want
  );
}

function newProvider(): CloudControlProvider {
  const p = new CloudControlProvider();
  (p as unknown as { sleep: (ms: number) => Promise<void> }).sleep = () => Promise.resolve();
  return p;
}
const flipRecords = (p: CloudControlProvider): number =>
  (p as unknown as { protectionFlips: { size: number } }).protectionFlips.size;

const del = (
  provider: CloudControlProvider,
  type: string,
  context: Record<string, unknown> = CTX
) => provider.delete('Res', ID, type, undefined, context);

beforeEach(() => {
  vi.clearAllMocks();
  ccSend.mockReset();
  ec2Send.mockReset();
  ec2Region.value = 'us-east-1';
  ccRegion.value = 'us-east-1';
});

describe('Cloud Control registry types: --remove-protection compensation (issue #2204)', () => {
  it('restores a guard this run turned off when the handler refuses the delete, re-throwing the ORIGINAL error', async () => {
    const provider = newProvider();
    script(DSQL, { observe: true, del: { failed: TERMINAL_MSG } });

    const thrown = await del(provider, DSQL)
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(TERMINAL_MSG);
    expect((thrown as Error).message).not.toMatch(/re-enable/i);
    // Read, flip (waited), delete (waited), then the re-enable (waited).
    expect(names()).toEqual([
      'GetResourceCommand',
      'UpdateResourceCommand',
      'GetResourceRequestStatusCommand',
      'DeleteResourceCommand',
      'GetResourceRequestStatusCommand',
      'UpdateResourceCommand',
      'GetResourceRequestStatusCommand',
    ]);
    const reEnables = updates(DSQL, 'on');
    expect(reEnables).toHaveLength(1);
    expect(reEnables[0]!.input['TypeName']).toBe(DSQL);
    expect(reEnables[0]!.input['Identifier']).toBe(ID);
    expect(patchOf(reEnables[0]!)).toEqual({
      op: 'add',
      path: '/DeletionProtectionEnabled',
      value: true,
    });
    // The re-enable's own wait is what proves it landed.
    expect(calls().at(-1)!.input['RequestToken']).toBe('tok-on');
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        `${DSQL} Res: the delete failed after --remove-protection had turned DeletionProtectionEnabled off, so it was re-enabled on ${ID}`
      )
    );
    expect(childLogger.error).not.toHaveBeenCalled();
    // Restored, so never ALSO the stand-down line.
    noStandDown();
    expect(flipRecords(provider)).toBe(0);
  });

  it('patches back the OBJECT-shaped on value for a VerifiedPermissions policy store', async () => {
    script(STORE, { observe: { Mode: 'ENABLED' }, del: { failed: TERMINAL_MSG } });
    await expect(del(newProvider(), STORE)).rejects.toThrow(TERMINAL_MSG);
    const reEnables = updates(STORE, 'on');
    expect(reEnables).toHaveLength(1);
    expect(patchOf(reEnables[0]!).value).toEqual({ Mode: 'ENABLED' });
  });

  it.each([
    ['already OFF', false],
    ['absent from the model', 'absent'],
    ['some other value', 'maybe'],
  ])('NEGATIVE CONTROL: a guard read %s is not re-enabled', async (_label, observe) => {
    script(DSQL, { observe, del: { failed: TERMINAL_MSG } });
    await expect(del(newProvider(), DSQL)).rejects.toThrow(TERMINAL_MSG);
    expect(updates(DSQL, 'off')).toHaveLength(1);
    expect(updates(DSQL, 'on')).toHaveLength(0);
    expect(childLogger.error).not.toHaveBeenCalled();
  });

  it('a failed readback is "do not know": the flip and delete still run, nothing is re-enabled', async () => {
    script(DSQL, { observe: new Error('read exploded'), del: { failed: TERMINAL_MSG } });
    await expect(del(newProvider(), DSQL)).rejects.toThrow(TERMINAL_MSG);
    expect(updates(DSQL, 'off')).toHaveLength(1);
    expect(names()).toContain('DeleteResourceCommand');
    expect(updates(DSQL, 'on')).toHaveLength(0);
  });

  it('does not compensate a flip Cloud Control rejected', async () => {
    script(DSQL, { observe: true, disableRejects: true, del: { failed: TERMINAL_MSG } });
    await expect(del(newProvider(), DSQL)).rejects.toThrow(TERMINAL_MSG);
    expect(updates(DSQL, 'on')).toHaveLength(0);
  });

  it('an ABANDONED flip-off wait still records the flip: the accepted patch may land, and re-enabling an observed-ON guard is safe', async () => {
    script(DSQL, { observe: true, disableAbandons: true, del: { failed: TERMINAL_MSG } });
    await expect(del(newProvider(), DSQL)).rejects.toThrow(TERMINAL_MSG);
    expect(updates(DSQL, 'on')).toHaveLength(1);
  });

  it('does not compensate a NotStabilized delete: the handler started the delete and stopped waiting', async () => {
    script(DSQL, { observe: true, del: { failed: 'Delete did not stabilize', code: 'NotStabilized' } });
    await expect(del(newProvider(), DSQL)).rejects.toThrow('did not stabilize');
    expect(updates(DSQL, 'on')).toHaveLength(0);
    expect(childLogger.error).not.toHaveBeenCalled();
  });

  it('does not compensate a delete FAILED with an AMBIGUOUS handler code, and SAYS so with the commands', async () => {
    script(DSQL, {
      observe: true,
      del: { failed: 'Deletion protection is enabled for this cluster', code: 'GeneralServiceException' },
    });
    await expect(del(newProvider(), DSQL)).rejects.toThrow('Deletion protection is enabled');
    expect(updates(DSQL, 'on')).toHaveLength(0);
    expect(childLogger.error).not.toHaveBeenCalled();
    // Never silent: the guard may be left off, so the line names both commands.
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        `${DSQL} Res: the delete failed after --remove-protection had turned DeletionProtectionEnabled off, and cdkd cannot tell whether AWS had started deleting ${ID}, so it did not turn the guard back on.`
      )
    );
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`restore it with: ${DSQL_RESTORE}.`)
    );
  });

  it('NEGATIVE CONTROL: the stand-down line is not written when nothing was flipped', async () => {
    script(DSQL, { observe: false, del: { failed: 'Internal error', code: 'InternalFailure' } });
    await expect(del(newProvider(), DSQL)).rejects.toThrow('Internal error');
    expect(childLogger.warn).not.toHaveBeenCalledWith(expect.stringContaining('cannot tell whether'));
  });

  it('a registry FAILED whose message reads like the EC2 termination refusal is NOT exempted from the ambiguous rule', async () => {
    script(DSQL, {
      observe: true,
      del: { failed: 'Cluster may not be terminated now', code: 'InternalFailure' },
    });
    await expect(del(newProvider(), DSQL)).rejects.toThrow('may not be terminated');
    expect(updates(DSQL, 'on')).toHaveLength(0);
  });

  it('a CONFLICT after an earlier attempt that may have been deleting is not compensated (the delete is still running)', async () => {
    const provider = newProvider();
    // Attempt 1: an ambiguous and RETRYABLE handler failure: may be deleting,
    // record kept for the re-entry.
    script(DSQL, {
      observe: true,
      del: { failed: 'ThrottlingException: Rate exceeded', code: 'Throttling' },
    });
    await expect(del(provider, DSQL)).rejects.toThrow('ThrottlingException');
    expect(flipRecords(provider)).toBe(1);

    ccSend.mockReset();
    script(DSQL, { observe: false, del: 'conflict' });
    await expect(del(provider, DSQL)).rejects.toThrow('already in progress');
    expect(updates(DSQL, 'on')).toHaveLength(0);
    expect(childLogger.error).not.toHaveBeenCalled();
    // Never silent: the stand-down names the check and restore commands.
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        `so it did not turn the guard back on. If it still exists, its DeletionProtectionEnabled may be off.`
      )
    );
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`restore it with: ${DSQL_RESTORE}.`)
    );
  });

  it('a CONFLICT on a FIRST attempt stays a refusal and is compensated', async () => {
    script(DSQL, { observe: true, del: 'conflict' });
    await expect(del(newProvider(), DSQL)).rejects.toThrow('already in progress');
    expect(updates(DSQL, 'on')).toHaveLength(1);
  });

  it('decides "accepted" PER ATTEMPT: an ambiguous retryable attempt does not stop a later refused one from being restored', async () => {
    const provider = newProvider();
    // Attempt 1: an ambiguous (and retryable) handler failure -> accepted for
    // THAT attempt, record kept for the re-entry.
    script(DSQL, {
      observe: true,
      del: { failed: 'ThrottlingException: Rate exceeded', code: 'Throttling' },
    });
    await expect(del(provider, DSQL)).rejects.toThrow('ThrottlingException');
    expect(updates(DSQL, 'on')).toHaveLength(0);
    expect(flipRecords(provider)).toBe(1);
    // RETRYABLE, so the sequence is not over: no stand-down line yet.
    noStandDown();

    // Attempt 2: a fresh DeleteResource the handler REFUSES.
    ccSend.mockReset();
    script(DSQL, { observe: false, del: { failed: TERMINAL_MSG } });
    await expect(del(provider, DSQL)).rejects.toThrow(TERMINAL_MSG);
    expect(updates(DSQL, 'on')).toHaveLength(1);
    noStandDown();
    expect(flipRecords(provider)).toBe(0);
  });

  it('a HANDLER ResourceConflict after an earlier attempt that may have been deleting is not compensated', async () => {
    const provider = newProvider();
    script(DSQL, {
      observe: true,
      del: { failed: 'ThrottlingException: Rate exceeded', code: 'Throttling' },
    });
    await expect(del(provider, DSQL)).rejects.toThrow('ThrottlingException');
    expect(flipRecords(provider)).toBe(1);

    ccSend.mockReset();
    script(DSQL, {
      observe: false,
      del: { failed: 'Cluster is being deleted', code: 'ResourceConflict' },
    });
    await expect(del(provider, DSQL)).rejects.toThrow('being deleted');
    expect(updates(DSQL, 'on')).toHaveLength(0);
    expect(childLogger.warn).toHaveBeenCalledWith(expect.stringContaining(STAND_DOWN));
  });

  it('keeps an earlier attempt\'s "may be deleting" across a later attempt whose SEND failed retryably', async () => {
    const provider = newProvider();
    // Call 1: the delete's wait is abandoned (retryably): it may be running.
    (provider as unknown as { POLL_TRANSIENT_GRACE_MS: number }).POLL_TRANSIENT_GRACE_MS = 0;
    script(DSQL, { observe: true });
    const scripted = ccSend.getMockImplementation()!;
    ccSend.mockImplementation(async (cmd: Cmd) => {
      if (
        cmd.constructor.name === 'GetResourceRequestStatusCommand' &&
        cmd.input['RequestToken'] === 'tok-del'
      ) {
        const e = new Error('Rate exceeded');
        e.name = 'ThrottlingException';
        throw e;
      }
      return scripted(cmd);
    });
    await expect(del(provider, DSQL)).rejects.toThrow();
    expect(flipRecords(provider)).toBe(1);

    // Call 2: the DeleteResource SEND itself is throttled; no delete started.
    ccSend.mockReset();
    script(DSQL, { observe: false });
    const scripted2 = ccSend.getMockImplementation()!;
    ccSend.mockImplementation(async (cmd: Cmd) => {
      if (cmd.constructor.name === 'DeleteResourceCommand') {
        const e = new Error('Rate exceeded');
        e.name = 'ThrottlingException';
        throw e;
      }
      return scripted2(cmd);
    });
    await expect(del(provider, DSQL)).rejects.toThrow('Rate exceeded');
    expect(flipRecords(provider)).toBe(1);

    // Call 3: a conflict, most likely with call 1's delete: not a refusal.
    ccSend.mockReset();
    script(DSQL, { observe: false, del: 'conflict' });
    await expect(del(provider, DSQL)).rejects.toThrow('already in progress');
    expect(updates(DSQL, 'on')).toHaveLength(0);
    expect(childLogger.error).not.toHaveBeenCalled();
    expect(childLogger.warn).toHaveBeenCalledWith(expect.stringContaining(STAND_DOWN));
  });

  it('a flip-off FAILED with an ambiguous handler code counts as landed', async () => {
    script(DSQL, {
      observe: true,
      disableFails: { failed: 'Internal error', code: 'InternalFailure' },
      del: { failed: TERMINAL_MSG },
    });
    await expect(del(newProvider(), DSQL)).rejects.toThrow(TERMINAL_MSG);
    expect(updates(DSQL, 'on')).toHaveLength(1);
  });

  it('a flip-off the handler REFUSED is not recorded', async () => {
    script(DSQL, {
      observe: true,
      disableFails: { failed: 'Bad request', code: 'InvalidRequest' },
      del: { failed: TERMINAL_MSG },
    });
    await expect(del(newProvider(), DSQL)).rejects.toThrow(TERMINAL_MSG);
    expect(updates(DSQL, 'on')).toHaveLength(0);
  });

  it('an already-gone resource (handler NotFound on the delete) restores nothing and releases the record', async () => {
    const provider = newProvider();
    script(DSQL, { observe: true, del: { failed: 'Cluster gone', code: 'NotFound' } });
    await expect(del(provider, DSQL)).resolves.toBeUndefined();
    expect(updates(DSQL, 'on')).toHaveLength(0);
    expect(flipRecords(provider)).toBe(0);
  });

  it('names the client region in a printed command when the state records none', async () => {
    script(DSQL, {
      observe: true,
      del: { failed: TERMINAL_MSG },
      reEnable: { failed: 'Update rejected', code: 'InvalidRequest' },
    });
    await expect(del(newProvider(), DSQL, { removeProtection: true })).rejects.toThrow(TERMINAL_MSG);
    expect(childLogger.error).toHaveBeenCalledWith(expect.stringContaining(DSQL_RESTORE));
  });

  it('canonicalizes the Cloud Control client region it falls back to', async () => {
    ccRegion.value = ' US-EAST-1 ';
    script(DSQL, {
      observe: true,
      del: { failed: TERMINAL_MSG },
      reEnable: { failed: 'Update rejected', code: 'InvalidRequest' },
    });
    await expect(del(newProvider(), DSQL, { removeProtection: true })).rejects.toThrow(TERMINAL_MSG);
    expect(childLogger.error).toHaveBeenCalledWith(expect.stringContaining(DSQL_RESTORE));
  });

  it('does not record a flip-off Cloud Control answered with no request token', async () => {
    script(DSQL, { observe: true, disableNoToken: true, del: { failed: TERMINAL_MSG } });
    await expect(del(newProvider(), DSQL)).rejects.toThrow(TERMINAL_MSG);
    expect(updates(DSQL, 'on')).toHaveLength(0);
  });

  it('a re-enable answered with no request token is an ERROR, never a "re-enabled" claim, and keeps the record', async () => {
    const provider = newProvider();
    script(DSQL, { observe: true, reEnableNoToken: true, del: { failed: TERMINAL_MSG } });
    await expect(del(provider, DSQL)).rejects.toThrow(TERMINAL_MSG);
    expect(updates(DSQL, 'on')).toHaveLength(1);
    expect(childLogger.error).toHaveBeenCalledWith(
      expect.stringContaining(`could NOT re-enable DeletionProtectionEnabled on ${ID}`)
    );
    expect(childLogger.warn).not.toHaveBeenCalledWith(expect.stringContaining('so it was re-enabled'));
    expect(flipRecords(provider)).toBe(1);
  });

  it('does not compensate an ABANDONED delete wait: the delete may still be running', async () => {
    script(DSQL, { observe: true, del: 'abandon' });
    await expect(del(newProvider(), DSQL)).rejects.toThrow();
    expect(names()).toContain('DeleteResourceCommand');
    expect(updates(DSQL, 'on')).toHaveLength(0);
    expect(childLogger.error).not.toHaveBeenCalled();
  });

  it('decides "accepted" PER ATTEMPT: an ABANDONED wait, re-dispatched, then refused, is restored', async () => {
    const provider = newProvider();
    // A throttled status poll past the transient grace abandons the wait with
    // a RETRYABLE error, which the destroy runner re-issues.
    (provider as unknown as { POLL_TRANSIENT_GRACE_MS: number }).POLL_TRANSIENT_GRACE_MS = 0;
    script(DSQL, { observe: true });
    const scripted = ccSend.getMockImplementation()!;
    ccSend.mockImplementation(async (cmd: Cmd) => {
      if (
        cmd.constructor.name === 'GetResourceRequestStatusCommand' &&
        cmd.input['RequestToken'] === 'tok-del'
      ) {
        const e = new Error('Rate exceeded');
        e.name = 'ThrottlingException';
        throw e;
      }
      return scripted(cmd);
    });
    await expect(del(provider, DSQL)).rejects.toThrow();
    expect(updates(DSQL, 'on')).toHaveLength(0);
    // The abandoned DELETE is left for the destroy runner to re-issue.
    expect(flipRecords(provider)).toBe(1);

    // The re-dispatch issues a fresh DeleteResource, which the handler REFUSES.
    ccSend.mockReset();
    script(DSQL, { observe: false, del: { failed: TERMINAL_MSG } });
    await expect(del(provider, DSQL)).rejects.toThrow(TERMINAL_MSG);
    expect(updates(DSQL, 'on')).toHaveLength(1);
    expect(flipRecords(provider)).toBe(0);
  });

  /**
   * Issue #4318. The delete's status poll is DENIED with AWS's
   * `not authorized to perform` wording, which the abandoned-wait error
   * withholds from its message and stamps `markRedactedCause`. The destroy
   * loop reads the chain and RETRIES it, so the compensation must too.
   */
  function scriptRedactedAbandon(): void {
    script(DSQL, { observe: true });
    const scripted = ccSend.getMockImplementation()!;
    ccSend.mockImplementation(async (cmd: Cmd) => {
      if (
        cmd.constructor.name === 'GetResourceRequestStatusCommand' &&
        cmd.input['RequestToken'] === 'tok-del'
      ) {
        throw Object.assign(
          new Error(
            'User: arn:aws:iam::123456789012:user/ci is not authorized to perform: cloudformation:GetResourceRequestStatus'
          ),
          { name: 'AccessDeniedException', $metadata: { httpStatusCode: 400 } }
        );
      }
      return scripted(cmd);
    });
  }

  it('a REDACTED abandoned delete wait is retryable: the record is held, so a refused retry is restored (issue #4318)', async () => {
    const provider = newProvider();
    scriptRedactedAbandon();
    const thrown = await del(provider, DSQL)
      .then(() => undefined)
      .catch((e: unknown) => e);
    // The precondition: the message withholds AWS's wording.
    expect((thrown as Error).message).not.toContain('not authorized to perform');
    expect(updates(DSQL, 'on')).toHaveLength(0);
    // Not terminal, so no stand-down line yet and the record is HELD.
    noStandDown();
    expect(flipRecords(provider)).toBe(1);

    ccSend.mockReset();
    script(DSQL, { observe: false, del: { failed: TERMINAL_MSG } });
    await expect(del(provider, DSQL)).rejects.toThrow(TERMINAL_MSG);
    expect(updates(DSQL, 'on')).toHaveLength(1);
    expect(flipRecords(provider)).toBe(0);
  });

  it("a REDACTED abandoned delete wait on the destroy loop's LAST attempt writes the stand-down line once (issue #4318)", async () => {
    const provider = newProvider();
    scriptRedactedAbandon();
    for (let i = 0; i < 3; i += 1) {
      await expect(runDeleteAttempt(false, () => del(provider, DSQL))).rejects.toThrow();
    }
    noStandDown();
    await expect(runDeleteAttempt(true, () => del(provider, DSQL))).rejects.toThrow();
    // The delete may be running, so nothing is written back -- but it SAYS so.
    expect(updates(DSQL, 'on')).toHaveLength(0);
    expect(
      childLogger.warn.mock.calls.filter((c) => String(c[0]).includes(STAND_DOWN))
    ).toHaveLength(1);
    expect(flipRecords(provider)).toBe(0);
  });

  it('holds the flip across a RETRYABLE failure, so the re-entered terminal failure still restores it', async () => {
    const provider = newProvider();
    script(DSQL, { observe: true, del: { failed: 'ThrottlingException: Rate exceeded' } });
    await expect(del(provider, DSQL)).rejects.toThrow('ThrottlingException');
    expect(updates(DSQL, 'on')).toHaveLength(0);
    expect(flipRecords(provider)).toBe(1);

    ccSend.mockReset();
    script(DSQL, { observe: false, del: { failed: TERMINAL_MSG } });
    await expect(del(provider, DSQL)).rejects.toThrow(TERMINAL_MSG);
    expect(updates(DSQL, 'on')).toHaveLength(1);
    expect(flipRecords(provider)).toBe(0);
  });

  it('a re-enable the handler FAILS is an ERROR naming the restore command, and the record is kept', async () => {
    const provider = newProvider();
    script(DSQL, {
      observe: true,
      del: { failed: TERMINAL_MSG },
      reEnable: { failed: 'Update rejected', code: 'InvalidRequest' },
    });
    await expect(del(provider, DSQL)).rejects.toThrow(TERMINAL_MSG);
    expect(flipRecords(provider)).toBe(1);
    expect(childLogger.error).toHaveBeenCalledWith(
      expect.stringContaining(`${DSQL} Res: could NOT re-enable DeletionProtectionEnabled on ${ID}`)
    );
    expect(childLogger.error).toHaveBeenCalledWith(
      expect.stringContaining(`Restore it with: ${DSQL_RESTORE}.`)
    );
  });

  it('a re-enable the handler answers NotFound is a WARN, not an ERROR claiming it is live', async () => {
    script(DSQL, {
      observe: true,
      del: { failed: TERMINAL_MSG },
      reEnable: { failed: 'Cluster gone', code: 'NotFound' },
    });
    await expect(del(newProvider(), DSQL)).rejects.toThrow(TERMINAL_MSG);
    expect(childLogger.error).not.toHaveBeenCalled();
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Cloud Control answered NotFound')
    );
  });

  it('a successful delete restores nothing and releases the record', async () => {
    const provider = newProvider();
    script(DSQL, { observe: true });
    await expect(del(provider, DSQL)).resolves.toBeUndefined();
    expect(updates(DSQL, 'on')).toHaveLength(0);
    expect(flipRecords(provider)).toBe(0);
  });

  it('does not read or flip without --remove-protection', async () => {
    script(DSQL, { observe: true, del: { failed: TERMINAL_MSG } });
    await expect(del(newProvider(), DSQL, { expectedRegion: 'us-east-1' })).rejects.toThrow(
      TERMINAL_MSG
    );
    expect(names()).not.toContain('GetResourceCommand');
    expect(names()).not.toContain('UpdateResourceCommand');
  });

  it('a type with no registry entry never enters the boundary under --remove-protection', async () => {
    const provider = newProvider();
    ccSend.mockImplementation(async (cmd: Cmd) => {
      if (cmd.constructor.name === 'DeleteResourceCommand') {
        return { ProgressEvent: { RequestToken: 'tok-del' } };
      }
      return {
        ProgressEvent: { OperationStatus: 'FAILED', StatusMessage: TERMINAL_MSG },
      };
    });
    await expect(del(provider, 'AWS::SQS::Queue')).rejects.toThrow(TERMINAL_MSG);
    expect(names()).toEqual(['DeleteResourceCommand', 'GetResourceRequestStatusCommand']);
    expect(flipRecords(provider)).toBe(0);
  });
});

describe('Cloud Control-routed EC2 Instance: --remove-protection compensation (issue #2204)', () => {
  const INSTANCE = 'i-0abc';
  const PROTECTION_MSG = `The instance '${INSTANCE}' may not be terminated. Modify its 'disableApiTermination' instance attribute and try again.`;

  type DeleteOutcome =
    | { failed: string; code?: string }
    | 'abandon'
    | 'SUCCESS';
  function wire(
    observe: boolean,
    firstFlipFails = false,
    outcome: DeleteOutcome = { failed: PROTECTION_MSG }
  ): void {
    let flippedOff = false;
    let disables = 0;
    ec2Send.mockImplementation(async (cmd: Cmd) => {
      if (cmd.constructor.name === 'DescribeInstanceAttributeCommand') {
        return { DisableApiTermination: { Value: flippedOff ? false : observe } };
      }
      if (cmd.constructor.name === 'ModifyInstanceAttributeCommand') {
        if ((cmd.input['DisableApiTermination'] as { Value: boolean }).Value === false) {
          disables++;
          if (firstFlipFails && disables === 1) throw new Error('Request limit exceeded.');
          flippedOff = true;
        }
        return {};
      }
      throw new Error(`unexpected EC2 command ${cmd.constructor.name}`);
    });
    ccSend.mockImplementation(async (cmd: Cmd) => {
      if (cmd.constructor.name === 'DeleteResourceCommand') {
        return { ProgressEvent: { RequestToken: 'tok-del' } };
      }
      if (outcome === 'abandon') {
        const e = new Error('User is not authorized to read the request status');
        e.name = 'AccessDeniedException';
        throw e;
      }
      if (outcome === 'SUCCESS') return { ProgressEvent: { OperationStatus: 'SUCCESS' } };
      return {
        ProgressEvent: {
          OperationStatus: 'FAILED',
          StatusMessage: outcome.failed,
          ErrorCode: outcome.code,
          TypeName: 'AWS::EC2::Instance',
          Identifier: INSTANCE,
        },
      };
    });
  }

  const delInstance = (provider = newProvider(), context: Record<string, unknown> = CTX) =>
    provider.delete('Res', INSTANCE, 'AWS::EC2::Instance', undefined, context);

  const ec2Modify = (value: boolean): Cmd[] =>
    ec2Send.mock.calls
      .map((c) => c[0] as Cmd)
      .filter(
        (c) =>
          c.constructor.name === 'ModifyInstanceAttributeCommand' &&
          (c.input['DisableApiTermination'] as { Value: boolean }).Value === value
      );

  it('restores DisableApiTermination through the EC2 client when the retry budget runs out', async () => {
    const provider = newProvider();
    wire(true);
    await expect(
      provider.delete('Res', INSTANCE, 'AWS::EC2::Instance', undefined, CTX)
    ).rejects.toThrow(/may not be terminated/);
    expect(names().filter((n) => n === 'DeleteResourceCommand')).toHaveLength(5);
    expect(ec2Modify(false)).toHaveLength(5);
    const reEnables = ec2Modify(true);
    expect(reEnables).toHaveLength(1);
    expect(reEnables[0]!.input).toEqual({
      InstanceId: INSTANCE,
      DisableApiTermination: { Value: true },
    });
    // Nothing went to Cloud Control for the guard.
    expect(names()).not.toContain('UpdateResourceCommand');
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`EC2 Instance Res: the delete failed after --remove-protection`)
    );
    noStandDown();
    expect(flipRecords(provider)).toBe(0);
  });

  it('records a RE-FLIP that lands after a swallowed first flip', async () => {
    wire(true, true);
    await expect(
      newProvider().delete('Res', INSTANCE, 'AWS::EC2::Instance', undefined, CTX)
    ).rejects.toThrow(/may not be terminated/);
    expect(ec2Modify(true)).toHaveLength(1);
  });

  it('refuses before any flip when the EC2 client targets another region than the vetted Cloud Control one', async () => {
    wire(true);
    ec2Region.value = 'eu-west-1';
    await expect(
      newProvider().delete('Res', INSTANCE, 'AWS::EC2::Instance', undefined, CTX)
    ).rejects.toThrow(
      "the EC2 client targets region 'eu-west-1' but the Cloud Control client targets 'us-east-1', so cdkd cannot show its DisableApiTermination flip would reach this instance."
    );
    expect(ec2Send).not.toHaveBeenCalled();
    expect(names()).not.toContain('DeleteResourceCommand');
  });

  it('still restores when the termination-protection refusal arrives under an AMBIGUOUS handler code', async () => {
    wire(true, false, { failed: PROTECTION_MSG, code: 'GeneralServiceException' });
    await expect(delInstance()).rejects.toThrow(/may not be terminated/);
    expect(ec2Modify(true)).toHaveLength(1);
  });

  it('does not restore an instance whose delete FAILED NotStabilized: the handler is terminating it', async () => {
    wire(true, false, { failed: 'Instance did not reach terminated', code: 'NotStabilized' });
    await expect(delInstance()).rejects.toThrow('did not reach terminated');
    expect(ec2Modify(true)).toHaveLength(0);
    expect(childLogger.error).not.toHaveBeenCalled();
  });

  it('does not restore an instance whose delete wait was ABANDONED', async () => {
    wire(true, false, 'abandon');
    await expect(delInstance()).rejects.toThrow();
    expect(ec2Modify(true)).toHaveLength(0);
  });

  it('a retryable attempt then a refused one restores the guard (per-attempt "accepted")', async () => {
    const provider = newProvider();
    wire(true, false, { failed: 'ThrottlingException: Rate exceeded', code: 'Throttling' });
    await expect(delInstance(provider)).rejects.toThrow('ThrottlingException');
    expect(ec2Modify(true)).toHaveLength(0);
    expect(flipRecords(provider)).toBe(1);

    ec2Send.mockReset();
    ccSend.mockReset();
    wire(false);
    await expect(delInstance(provider)).rejects.toThrow(/may not be terminated/);
    expect(ec2Modify(true)).toHaveLength(1);
    expect(flipRecords(provider)).toBe(0);
  });

  it('an already-gone instance restores nothing and releases the record', async () => {
    const provider = newProvider();
    wire(true, false, { failed: 'Instance not found', code: 'NotFound' });
    await expect(delInstance(provider)).resolves.toBeUndefined();
    expect(ec2Modify(true)).toHaveLength(0);
    expect(flipRecords(provider)).toBe(0);
  });

  it('names the EC2 client region in a printed command when the state records none', async () => {
    wire(true);
    ec2Send.mockImplementation(async (cmd: Cmd) => {
      if (cmd.constructor.name === 'DescribeInstanceAttributeCommand') {
        return { DisableApiTermination: { Value: true } };
      }
      if ((cmd.input['DisableApiTermination'] as { Value: boolean }).Value === true) {
        throw new Error('AccessDenied');
      }
      return {};
    });
    await expect(delInstance(newProvider(), { removeProtection: true })).rejects.toThrow(
      /may not be terminated/
    );
    expect(childLogger.error).toHaveBeenCalledWith(
      expect.stringContaining(
        `aws ec2 modify-instance-attribute --instance-id ${INSTANCE} --region us-east-1 --disable-api-termination`
      )
    );
  });

  it('NEGATIVE CONTROL: an instance whose guard was already off is not re-enabled', async () => {
    wire(false);
    await expect(
      newProvider().delete('Res', INSTANCE, 'AWS::EC2::Instance', undefined, CTX)
    ).rejects.toThrow(/may not be terminated/);
    expect(ec2Modify(true)).toHaveLength(0);
  });
});

describe('ccProtectionSite', () => {
  it('names a restore command for EVERY registry entry, never a withheld one', () => {
    const types = ccProtectionRegistryTypes();
    expect(types.length).toBeGreaterThanOrEqual(7);
    for (const type of types) {
      const commands = ccProtectionSite(type, ID, ccProtectionProperty(type)!, 'us-east-1').commands();
      expect(commands.restoreLive, type).not.toBe(WITHHELD_AWS_COMMAND);
      expect(commands.check, type).not.toBe(WITHHELD_AWS_COMMAND);
      // The literal patch carries the entry's own on value at its own path.
      const doc = /--patch-document '(.*)'$/.exec(commands.restoreLive)![1]!;
      const entry = ccProtectionProperty(type)!;
      expect(JSON.parse(doc), type).toEqual([
        { op: 'add', path: `/${entry.property}`, value: entry.onValue },
      ]);
    }
  });

  it('renders the DSQL commands exactly, with --region when the state records one', () => {
    const commands = ccProtectionSite(DSQL, ID, ccProtectionProperty(DSQL)!, 'us-east-1').commands();
    expect(commands.restoreLive).toBe(DSQL_RESTORE);
    expect(commands.check).toBe(
      `aws cloudcontrol get-resource --type-name ${DSQL} --identifier ${ID} --region us-east-1`
    );
  });

  it('keys not-found on the two Cloud Control spellings, never on an abandoned re-enable wait', () => {
    const site = ccProtectionSite(DSQL, ID, ccProtectionProperty(DSQL)!, undefined);
    const rnf = Object.assign(new Error('gone'), { name: 'ResourceNotFoundException' });
    const handlerNotFound = Object.assign(new Error('gone'), { ccErrorCode: 'NotFound' });
    expect(site.isNotFound(rnf)).toBe(true);
    expect(site.isNotFound(handlerNotFound)).toBe(true);
    expect(site.isNotFound(markWaitAbandoned(Object.assign(new Error('x'), { ccErrorCode: 'NotFound' })))).toBe(false);
    expect(site.isNotFound(new Error('ResourceNotFoundException NotFound'))).toBe(false);
    expect(site.isNotFound(undefined)).toBe(false);
  });

  it('withholds the restore for an entry with no literal spelling rather than approximating one', () => {
    const commands = ccProtectionSite(DSQL, ID, {
      property: 'Protected',
      offValue: 'NO',
      onValue: 'YES',
    }, undefined).commands();
    expect(commands.restoreLive).toBe(WITHHELD_AWS_COMMAND);
    expect(commands.check).not.toBe(WITHHELD_AWS_COMMAND);
  });
});
