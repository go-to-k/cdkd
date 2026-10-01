/**
 * `--remove-protection` compensation on an SDK-routed `AWS::EC2::Instance`
 * (issue #2204).
 *
 * The same per-site matrix as `emr-cluster-remove-protection-compensate.test.ts`:
 * a site that loses its readback, its `deleteAccepted` latch or its boundary
 * goes red on its own row. The mechanism's own cases are fenced in
 * `dynamodb-remove-protection-compensate.test.ts`; this file fences that the
 * instance is WIRED to it, including through the propagation-race retry loop
 * that is the instance's own shape (the flip is re-sent before every retry).
 *
 * The readback is `DescribeInstanceAttribute(disableApiTermination)`, issued
 * once, before the first flip.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const ec2Send = vi.hoisted(() => vi.fn());
const clientRegion = vi.hoisted(() => ({ value: 'us-east-1' }));

vi.mock('../../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: { send: ec2Send, config: { region: () => Promise.resolve(clientRegion.value) } },
  }),
}));

const childLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
}));
vi.mock('../../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    child: () => childLogger,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { EC2Provider } from '../../../../src/provisioning/providers/ec2-provider.js';
import { ec2InstanceProtectionSite } from '../../../../src/provisioning/ec2-termination-protection.js';

type Cmd = { constructor: { name: string }; input: Record<string, unknown> };

const RESOURCE_TYPE = 'AWS::EC2::Instance';
const INSTANCE = 'i-0123456789abcdef0';
const CTX = { removeProtection: true, expectedRegion: 'us-east-1' };
const RESTORE = `aws ec2 modify-instance-attribute --instance-id ${INSTANCE} --region us-east-1 --disable-api-termination`;
const CHECK = `aws ec2 describe-instance-attribute --instance-id ${INSTANCE} --region us-east-1 --attribute disableApiTermination`;

/** A terminate refusal matching no retryable pattern, and not the propagation race: TERMINAL. */
function terminalRefusal(): Error {
  const e = new Error('The instance is not in a state from which it can be terminated by this caller.');
  e.name = 'OperationNotPermitted';
  return e;
}

/** The propagation-race 400 the delete retries locally under --remove-protection. */
function protectionRefusal(): Error {
  const e = new Error(
    `The instance '${INSTANCE}' may not be terminated. Modify its 'disableApiTermination' instance attribute and try again.`
  );
  e.name = 'OperationNotPermitted';
  return e;
}

function throttle(): Error {
  const e = new Error('Request limit exceeded.');
  e.name = 'RequestLimitExceeded';
  return e;
}

function notFound(): Error {
  const e = new Error(`The instance ID '${INSTANCE}' does not exist`);
  e.name = 'InvalidInstanceID.NotFound';
  return e;
}

interface Script {
  /** The readback's `DisableApiTermination.Value`, or an error for it to throw. */
  observe?: boolean | Error;
  /** The flip-off: resolves unless given an error. */
  disable?: Error;
  /** Only the FIRST flip-off throws; the propagation-race re-flips land. */
  disableFailsOnce?: boolean;
  /** The terminate: an error for EVERY attempt, resolves when absent. */
  del?: () => Error;
  /** The compensating re-enable. */
  reEnable?: Error;
  /** A termination wait that fails after AWS accepted the terminate. */
  waitFails?: boolean;
}

/** Route every command by name, so a case states only what it changes. */
function script(s: Script): void {
  let flippedOff = false;
  let disables = 0;
  ec2Send.mockImplementation(async (cmd: Cmd) => {
    const name = cmd.constructor.name;
    if (name === 'DescribeInstanceAttributeCommand') {
      if (s.observe instanceof Error) throw s.observe;
      return { DisableApiTermination: { Value: flippedOff ? false : (s.observe ?? false) } };
    }
    if (name === 'ModifyInstanceAttributeCommand') {
      const value = (cmd.input['DisableApiTermination'] as { Value: boolean }).Value;
      if (value === false) {
        disables++;
        if (s.disable) throw s.disable;
        if (s.disableFailsOnce && disables === 1) throw throttle();
        flippedOff = true;
        return {};
      }
      if (s.reEnable) throw s.reEnable;
      return {};
    }
    if (name === 'TerminateInstancesCommand') {
      if (s.del) throw s.del();
      return { TerminatingInstances: [{ CurrentState: { Name: 'shutting-down' } }] };
    }
    if (name === 'DescribeInstancesCommand') {
      if (s.waitFails) {
        // `pending` is a FAILURE acceptor of the InstanceTerminated waiter, so
        // the wait rejects at once.
        return {
          Reservations: [{ Instances: [{ InstanceId: INSTANCE, State: { Name: 'pending' } }] }],
        };
      }
      return {
        Reservations: [{ Instances: [{ InstanceId: INSTANCE, State: { Name: 'terminated' } }] }],
      };
    }
    throw new Error(`unexpected command ${name}`);
  });
}

function calls(): Cmd[] {
  return ec2Send.mock.calls.map((c) => c[0] as Cmd);
}

function modifyCalls(value: boolean): Cmd[] {
  return calls().filter(
    (c) =>
      c.constructor.name === 'ModifyInstanceAttributeCommand' &&
      (c.input['DisableApiTermination'] as { Value: boolean }).Value === value
  );
}
const reEnableCalls = (): Cmd[] => modifyCalls(true);
const disableCalls = (): Cmd[] => modifyCalls(false);

function flipRecords(provider: EC2Provider): number {
  return (provider as unknown as { protectionFlips: { size: number } }).protectionFlips.size;
}

function newProvider(): EC2Provider {
  const p = new EC2Provider();
  (p as unknown as { sleep: (ms: number) => Promise<void> }).sleep = () => Promise.resolve();
  return p;
}

const del = (provider = newProvider(), context: Record<string, unknown> = CTX) =>
  provider.delete('Res', INSTANCE, RESOURCE_TYPE, undefined, context);

beforeEach(() => {
  vi.clearAllMocks();
  clientRegion.value = 'us-east-1';
  ec2Send.mockReset();
});

describe('EC2 Instance (SDK route): --remove-protection compensation (issue #2204)', () => {
  it('restores a guard this run turned off when the terminate fails terminally, re-throwing the ORIGINAL error', async () => {
    script({ observe: true, del: terminalRefusal });

    const thrown = await del()
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('Failed to terminate EC2 Instance Res');
    expect((thrown as Error).message).toContain('not in a state from which it can be terminated');
    expect((thrown as Error).message).not.toMatch(/re-enable/i);
    // Read, flip, terminate, then the re-enable AFTER it.
    expect(calls().map((c) => c.constructor.name)).toEqual([
      'DescribeInstanceAttributeCommand',
      'ModifyInstanceAttributeCommand',
      'TerminateInstancesCommand',
      'ModifyInstanceAttributeCommand',
    ]);
    const reEnables = reEnableCalls();
    expect(reEnables).toHaveLength(1);
    // The TARGET, not only the value.
    expect(reEnables[0]!.input).toEqual({
      InstanceId: INSTANCE,
      DisableApiTermination: { Value: true },
    });
    expect(calls()[0]!.input).toEqual({ InstanceId: INSTANCE, Attribute: 'disableApiTermination' });
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('EC2 Instance Res: the delete failed after --remove-protection')
    );
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`DisableApiTermination off, so it was re-enabled on ${INSTANCE}`)
    );
    expect(childLogger.error).not.toHaveBeenCalled();
  });

  it('restores the guard when the propagation-race retry budget runs out (the refusal re-asserted every attempt)', async () => {
    script({ observe: true, del: protectionRefusal });
    await expect(del()).rejects.toThrow(/may not be terminated/);
    expect(calls().filter((c) => c.constructor.name === 'TerminateInstancesCommand')).toHaveLength(5);
    // ONE readback: the re-flips before each retry do not re-read.
    expect(
      calls().filter((c) => c.constructor.name === 'DescribeInstanceAttributeCommand')
    ).toHaveLength(1);
    // 1 initial flip + 4 re-flips.
    expect(disableCalls()).toHaveLength(5);
    expect(reEnableCalls()).toHaveLength(1);
    expect(calls().at(-1)!.constructor.name).toBe('ModifyInstanceAttributeCommand');
  });

  it('records a RE-FLIP that lands after a swallowed first flip, so the terminal failure still restores the guard', async () => {
    script({ observe: true, disableFailsOnce: true, del: protectionRefusal });
    await expect(del()).rejects.toThrow(/may not be terminated/);
    expect(disableCalls()).toHaveLength(5);
    expect(reEnableCalls()).toHaveLength(1);
  });

  it('NEGATIVE CONTROL: a landed re-flip on a guard read OFF is not re-enabled', async () => {
    script({ observe: false, disableFailsOnce: true, del: protectionRefusal });
    await expect(del()).rejects.toThrow(/may not be terminated/);
    expect(reEnableCalls()).toHaveLength(0);
  });

  it('NEGATIVE CONTROL: leaves a guard that was already OFF before the run alone', async () => {
    script({ observe: false, del: terminalRefusal });
    await expect(del()).rejects.toThrow('Failed to terminate');
    expect(disableCalls()).toHaveLength(1);
    expect(reEnableCalls()).toHaveLength(0);
    expect(childLogger.warn).not.toHaveBeenCalled();
    expect(childLogger.error).not.toHaveBeenCalled();
  });

  it('a failed readback is "do not know": the delete proceeds and nothing is re-enabled', async () => {
    script({ observe: new Error('describe exploded'), del: terminalRefusal });
    await expect(del()).rejects.toThrow('Failed to terminate');
    expect(disableCalls()).toHaveLength(1);
    expect(reEnableCalls()).toHaveLength(0);
  });

  it('does not compensate a flip EC2 rejected; the delete still runs and fails as before', async () => {
    script({ observe: true, disable: new Error('flip refused'), del: terminalRefusal });
    await expect(del()).rejects.toThrow('Failed to terminate');
    expect(calls().map((c) => c.constructor.name)).toContain('TerminateInstancesCommand');
    expect(reEnableCalls()).toHaveLength(0);
    expect(childLogger.warn).not.toHaveBeenCalled();
  });

  it('does not compensate once EC2 ACCEPTED the terminate: a failing termination wait is not the delete failing', async () => {
    script({ observe: true, waitFails: true });
    await expect(del()).rejects.toThrow('Failed to terminate');
    expect(calls().map((c) => c.constructor.name)).toContain('TerminateInstancesCommand');
    expect(reEnableCalls()).toHaveLength(0);
    expect(childLogger.error).not.toHaveBeenCalled();
  });

  it('does not read, flip or compensate anything without --remove-protection', async () => {
    script({ observe: true, del: terminalRefusal });
    await expect(del(newProvider(), { expectedRegion: 'us-east-1' })).rejects.toThrow(
      'Failed to terminate'
    );
    expect(calls().map((c) => c.constructor.name)).toEqual(['TerminateInstancesCommand']);
  });

  it('holds the flip across a RETRYABLE failure, so the re-entered terminal failure still restores it', async () => {
    const provider = newProvider();
    script({ observe: true, del: throttle });
    await expect(del(provider)).rejects.toThrow('Request limit exceeded');
    expect(reEnableCalls()).toHaveLength(0);
    expect(flipRecords(provider)).toBe(1);

    // The outer loop's re-entry: the readback now reports OFF (attempt 1 is
    // why), and the terminate fails terminally.
    ec2Send.mockReset();
    script({ observe: false, del: terminalRefusal });
    await expect(del(provider)).rejects.toThrow('Failed to terminate');
    expect(reEnableCalls()).toHaveLength(1);
    expect(flipRecords(provider)).toBe(0);
  });

  it('a FAILED re-enable keeps the record, and is an ERROR line naming the restore command', async () => {
    const provider = newProvider();
    script({ observe: true, del: terminalRefusal, reEnable: new Error('AccessDenied') });
    await expect(del(provider)).rejects.toThrow('Failed to terminate');
    expect(flipRecords(provider)).toBe(1);
    expect(childLogger.error).toHaveBeenCalledWith(
      expect.stringContaining(
        `EC2 Instance Res: could NOT re-enable DisableApiTermination on ${INSTANCE}`
      )
    );
    expect(childLogger.error).toHaveBeenCalledWith(
      expect.stringContaining(`Restore it with: ${RESTORE}. (AccessDenied)`)
    );
  });

  it('names the client region in the restore command when the state records none', async () => {
    script({ observe: true, del: terminalRefusal, reEnable: new Error('AccessDenied') });
    await expect(del(newProvider(), { removeProtection: true })).rejects.toThrow(
      'Failed to terminate'
    );
    expect(childLogger.error).toHaveBeenCalledWith(
      expect.stringContaining(`Restore it with: ${RESTORE}.`)
    );
  });

  it('canonicalizes the client region it falls back to (a profile can spell it in capitals)', async () => {
    clientRegion.value = ' US-EAST-1 ';
    script({ observe: true, del: terminalRefusal, reEnable: new Error('AccessDenied') });
    await expect(del(newProvider(), { removeProtection: true })).rejects.toThrow(
      'Failed to terminate'
    );
    expect(childLogger.error).toHaveBeenCalledWith(
      expect.stringContaining(`Restore it with: ${RESTORE}.`)
    );
  });

  it("prefers the STATE's region over the client's in the restore command", async () => {
    script({ observe: true, del: terminalRefusal, reEnable: new Error('AccessDenied') });
    await expect(
      del(newProvider(), { removeProtection: true, expectedRegion: 'eu-west-1' })
    ).rejects.toThrow('Failed to terminate');
    expect(childLogger.error).toHaveBeenCalledWith(
      expect.stringContaining(
        `aws ec2 modify-instance-attribute --instance-id ${INSTANCE} --region eu-west-1 --disable-api-termination`
      )
    );
  });

  it('an InvalidInstanceID.NotFound re-enable is a WARN naming the check first, not an ERROR claiming it is live', async () => {
    script({ observe: true, del: terminalRefusal, reEnable: notFound() });
    await expect(del()).rejects.toThrow('Failed to terminate');
    expect(childLogger.error).not.toHaveBeenCalled();
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('answered InvalidInstanceID.NotFound')
    );
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`Check with: ${CHECK} and if it is there, restore it with: ${RESTORE}.`)
    );
  });

  it('a successful delete restores nothing and releases the record', async () => {
    const provider = newProvider();
    script({ observe: true });
    await expect(del(provider)).resolves.toBeUndefined();
    expect(reEnableCalls()).toHaveLength(0);
    expect(flipRecords(provider)).toBe(0);
    expect(childLogger.warn).not.toHaveBeenCalled();
  });

  it('an already-gone instance deletes idempotently and releases the record', async () => {
    const provider = newProvider();
    script({ observe: true, del: notFound });
    await expect(del(provider)).resolves.toBeUndefined();
    expect(reEnableCalls()).toHaveLength(0);
    expect(flipRecords(provider)).toBe(0);
  });
});

describe('ec2InstanceProtectionSite', () => {
  it('renders the commands with --region when the state records one', () => {
    expect(ec2InstanceProtectionSite(INSTANCE, 'eu-west-1').commands()).toEqual({
      check: `aws ec2 describe-instance-attribute --instance-id ${INSTANCE} --region eu-west-1 --attribute disableApiTermination`,
      restoreAfterNotFound: `aws ec2 modify-instance-attribute --instance-id ${INSTANCE} --region eu-west-1 --disable-api-termination`,
      restoreLive: `aws ec2 modify-instance-attribute --instance-id ${INSTANCE} --region eu-west-1 --disable-api-termination`,
    });
  });

  it('omits --region when the state carries none', () => {
    expect(ec2InstanceProtectionSite(INSTANCE, undefined).commands().restoreLive).toBe(
      `aws ec2 modify-instance-attribute --instance-id ${INSTANCE} --disable-api-termination`
    );
  });

  it('keys not-found on the EC2 error name only', () => {
    const site = ec2InstanceProtectionSite(INSTANCE, undefined);
    expect(site.isNotFound(notFound())).toBe(true);
    expect(site.isNotFound(new Error('InvalidInstanceID.NotFound'))).toBe(false);
    expect(site.isNotFound(undefined)).toBe(false);
  });
});
