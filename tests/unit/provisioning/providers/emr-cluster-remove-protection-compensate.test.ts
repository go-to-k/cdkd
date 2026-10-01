/**
 * `--remove-protection` compensation on `AWS::EMR::Cluster` (issue #2204).
 *
 * The same per-site matrix as `logs-cognito-remove-protection-compensate.test.ts`:
 * a site that loses its readback, its `deleteAccepted` latch or its boundary
 * goes red on its own row. The mechanism's own cases (gates, outcome split,
 * logger-throw) are fenced in `dynamodb-remove-protection-compensate.test.ts`
 * and `rds-family-remove-protection-compensate.test.ts`; this file fences that
 * the EMR cluster is WIRED to it.
 *
 * EMR's readback is the delete's own pre-check `DescribeCluster`, whose
 * `Cluster.TerminationProtected` says whether the guard was on before the flip.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const emrSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-emr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-emr')>();
  return {
    ...actual,
    EMRClient: vi.fn().mockImplementation(() => ({
      send: emrSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

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

import {
  EMRClusterProvider,
  emrClusterProtectionSite,
} from '../../../../src/provisioning/providers/emr-cluster-provider.js';
import { WITHHELD_AWS_COMMAND } from '../../../../src/provisioning/replacement-protection-advice.js';
import { InvalidRequestException } from '@aws-sdk/client-emr';

type Cmd = { constructor: { name: string }; input: Record<string, unknown> };

const RESOURCE_TYPE = 'AWS::EMR::Cluster';
const CLUSTER = 'j-1A2B3C4D5E6F7';
const CTX = { removeProtection: true, expectedRegion: 'us-east-1' };
const RESTORE = `aws emr modify-cluster-attributes --cluster-id ${CLUSTER} --region us-east-1 --termination-protected`;
const CHECK = `aws emr describe-cluster --cluster-id ${CLUSTER} --region us-east-1`;

/**
 * A terminate refusal matching no retryable pattern: TERMINAL. (An IAM
 * `not authorized to perform` would NOT do here: cdkd retries it as IAM
 * propagation, so it is the retryable case.)
 */
function terminalRefusal(): Error {
  const e = new Error('Cluster refused the terminate request.');
  e.name = 'ValidationException';
  return e;
}

function throttle(): Error {
  const e = new Error('Rate exceeded');
  e.name = 'ThrottlingException';
  return e;
}

function invalidRequest(): InvalidRequestException {
  return new InvalidRequestException({
    message: `Cluster id '${CLUSTER}' is not valid.`,
    $metadata: {},
  });
}

interface Script {
  /** The pre-check's `TerminationProtected`, or an error for the pre-check to throw. */
  observe?: boolean | Error;
  /** The flip-off: resolves unless given an error. */
  disable?: Error;
  /** The terminate: resolves unless given an error. */
  del?: Error;
  /** The compensating re-enable. */
  reEnable?: Error;
  /** Whether a poll after an accepted terminate reads TERMINATED (default) or stays TERMINATING. */
  pollState?: 'TERMINATED' | 'TERMINATING';
}

/** Route every command by name, so a case states only what it changes. */
function script(s: Script): void {
  // The live guard as the fake service holds it: a landed flip-off turns it
  // off for every LATER read.
  let flippedOff = false;
  let terminated = false;
  emrSend.mockImplementation(async (cmd: Cmd) => {
    const name = cmd.constructor.name;
    if (name === 'DescribeClusterCommand') {
      if (terminated) {
        return { Cluster: { Id: CLUSTER, Status: { State: s.pollState ?? 'TERMINATED' } } };
      }
      if (s.observe instanceof Error) throw s.observe;
      return {
        Cluster: {
          Id: CLUSTER,
          Status: { State: 'WAITING' },
          TerminationProtected: flippedOff ? false : (s.observe ?? false),
        },
      };
    }
    if (name === 'SetTerminationProtectionCommand') {
      if (cmd.input['TerminationProtected'] === false) {
        if (s.disable) throw s.disable;
        flippedOff = true;
        return {};
      }
      if (s.reEnable) throw s.reEnable;
      return {};
    }
    if (name === 'TerminateJobFlowsCommand') {
      if (s.del) throw s.del;
      terminated = true;
      return {};
    }
    throw new Error(`unexpected command ${name}`);
  });
}

function calls(): Cmd[] {
  return emrSend.mock.calls.map((c) => c[0] as Cmd);
}

function reEnableCalls(): Cmd[] {
  return calls().filter(
    (c) =>
      c.constructor.name === 'SetTerminationProtectionCommand' &&
      c.input['TerminationProtected'] === true
  );
}

function disableCalls(): Cmd[] {
  return calls().filter(
    (c) =>
      c.constructor.name === 'SetTerminationProtectionCommand' &&
      c.input['TerminationProtected'] === false
  );
}

function flipRecords(provider: EMRClusterProvider): number {
  return (provider as unknown as { protectionFlips: { size: number } }).protectionFlips.size;
}

const newProvider = (maxWaitMs = 5000) => new EMRClusterProvider({ pollIntervalMs: 0, maxWaitMs });

const del = (provider = newProvider(), context: Record<string, unknown> = CTX) =>
  provider.delete('Res', CLUSTER, RESOURCE_TYPE, undefined, context);

beforeEach(() => {
  vi.clearAllMocks();
  emrSend.mockReset();
});

describe('EMR Cluster: --remove-protection compensation (issue #2204)', () => {
  it('restores a guard this run turned off when the terminate fails terminally, re-throwing the ORIGINAL error', async () => {
    script({ observe: true, del: terminalRefusal() });

    const thrown = await del()
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(Error);
    // The delete failure stays the outcome, unannotated.
    expect((thrown as Error).message).toContain('Failed to terminate EMR Cluster Res');
    expect((thrown as Error).message).toContain('refused the terminate request');
    expect((thrown as Error).message).not.toMatch(/re-enable/i);
    // The flip went out BEFORE the terminate, and the re-enable AFTER it.
    expect(calls().map((c) => c.constructor.name)).toEqual([
      'DescribeClusterCommand',
      'SetTerminationProtectionCommand',
      'TerminateJobFlowsCommand',
      'SetTerminationProtectionCommand',
    ]);
    const reEnables = reEnableCalls();
    expect(reEnables).toHaveLength(1);
    // The TARGET, not only the value.
    expect(reEnables[0]!.input).toEqual({ JobFlowIds: [CLUSTER], TerminationProtected: true });
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('EMR Cluster Res: the delete failed after --remove-protection')
    );
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`TerminationProtected off, so it was re-enabled on ${CLUSTER}`)
    );
    expect(childLogger.error).not.toHaveBeenCalled();
  });

  it('NEGATIVE CONTROL: leaves a guard that was already OFF before the run alone', async () => {
    script({ observe: false, del: terminalRefusal() });
    await expect(del()).rejects.toThrow('Failed to terminate');
    // The flip itself is still sent (idempotent, unchanged behaviour).
    expect(disableCalls()).toHaveLength(1);
    expect(reEnableCalls()).toHaveLength(0);
    expect(childLogger.warn).not.toHaveBeenCalled();
    expect(childLogger.error).not.toHaveBeenCalled();
  });

  it('does not compensate a flip AWS rejected, and the rejection still fails the delete before any terminate', async () => {
    script({ observe: true, disable: terminalRefusal() });
    await expect(del()).rejects.toThrow('Failed to terminate');
    expect(calls().map((c) => c.constructor.name)).not.toContain('TerminateJobFlowsCommand');
    expect(reEnableCalls()).toHaveLength(0);
    expect(childLogger.warn).not.toHaveBeenCalled();
    expect(childLogger.error).not.toHaveBeenCalled();
  });

  it('does not compensate once AWS ACCEPTED the terminate: a termination-wait timeout is not the delete failing', async () => {
    script({ observe: true, pollState: 'TERMINATING' });
    await expect(del(newProvider(30))).rejects.toThrow(/Timed out waiting for EMR Cluster/);
    expect(calls().map((c) => c.constructor.name)).toContain('TerminateJobFlowsCommand');
    expect(reEnableCalls()).toHaveLength(0);
    expect(childLogger.error).not.toHaveBeenCalled();
  });

  it('does not compensate once AWS ACCEPTED the terminate: a failing termination poll is not the delete failing', async () => {
    let terminated = false;
    emrSend.mockImplementation(async (cmd: Cmd) => {
      const name = cmd.constructor.name;
      if (name === 'DescribeClusterCommand') {
        if (terminated) throw new Error('poll exploded');
        return {
          Cluster: { Id: CLUSTER, Status: { State: 'WAITING' }, TerminationProtected: true },
        };
      }
      if (name === 'TerminateJobFlowsCommand') terminated = true;
      return {};
    });
    await expect(del()).rejects.toThrow(/Failed to poll EMR Cluster/);
    expect(reEnableCalls()).toHaveLength(0);
  });

  it('NEGATIVE CONTROL: a pre-check answer with NO TerminationProtected field is not read as "on"', async () => {
    emrSend.mockImplementation(async (cmd: Cmd) => {
      const name = cmd.constructor.name;
      if (name === 'DescribeClusterCommand') {
        return { Cluster: { Id: CLUSTER, Status: { State: 'WAITING' } } };
      }
      if (name === 'TerminateJobFlowsCommand') throw terminalRefusal();
      return {};
    });
    await expect(del()).rejects.toThrow('Failed to terminate');
    expect(disableCalls()).toHaveLength(1);
    expect(reEnableCalls()).toHaveLength(0);
  });

  it('does not flip or compensate anything without --remove-protection', async () => {
    script({ observe: true, del: terminalRefusal() });
    await expect(del(newProvider(), { expectedRegion: 'us-east-1' })).rejects.toThrow(
      'Failed to terminate'
    );
    expect(calls().map((c) => c.constructor.name)).toEqual([
      'DescribeClusterCommand',
      'TerminateJobFlowsCommand',
    ]);
  });

  it('holds the flip across a RETRYABLE failure, so the re-entered terminal failure still restores it', async () => {
    const provider = newProvider();
    // Attempt 1: guard observed ON, flipped, throttled -> retryable, no compensation.
    script({ observe: true, del: throttle() });
    await expect(del(provider)).rejects.toThrow('Rate exceeded');
    expect(reEnableCalls()).toHaveLength(0);
    expect(flipRecords(provider)).toBe(1);

    // Attempt 2 (the outer loop's re-entry): the pre-check now reports OFF --
    // attempt 1 is why -- and the terminate fails terminally.
    emrSend.mockReset();
    script({ observe: false, del: terminalRefusal() });
    await expect(del(provider)).rejects.toThrow('Failed to terminate');
    expect(reEnableCalls()).toHaveLength(1);
    expect(flipRecords(provider)).toBe(0);
  });

  it('a RESTORED guard releases the record, so a later delete of the same key does not inherit it', async () => {
    const provider = newProvider();
    script({ observe: true, del: terminalRefusal() });
    await expect(del(provider)).rejects.toThrow('Failed to terminate');
    expect(reEnableCalls()).toHaveLength(1);

    emrSend.mockReset();
    script({ observe: false, del: terminalRefusal() });
    await expect(del(provider)).rejects.toThrow('Failed to terminate');
    expect(reEnableCalls()).toHaveLength(0);
  });

  it('a FAILED re-enable keeps the record, so a later delete of the same key retries it', async () => {
    const provider = newProvider();
    script({ observe: true, del: terminalRefusal(), reEnable: new Error('AccessDenied') });
    await expect(del(provider)).rejects.toThrow('Failed to terminate');
    expect(flipRecords(provider)).toBe(1);

    emrSend.mockReset();
    script({ observe: false, del: terminalRefusal() });
    await expect(del(provider)).rejects.toThrow('Failed to terminate');
    expect(reEnableCalls()).toHaveLength(1);
  });

  it('the flip record is keyed by region: a retained record is not inherited in another region', async () => {
    const provider = newProvider();
    script({ observe: true, del: throttle() });
    await expect(del(provider)).rejects.toThrow('Rate exceeded');

    emrSend.mockReset();
    script({ observe: false, del: terminalRefusal() });
    await expect(
      del(provider, { removeProtection: true, expectedRegion: 'eu-west-1' })
    ).rejects.toThrow('Failed to terminate');
    expect(reEnableCalls()).toHaveLength(0);
  });

  it('a successful delete restores nothing and releases the record', async () => {
    const provider = newProvider();
    script({ observe: true });
    await expect(del(provider)).resolves.toBeUndefined();
    expect(reEnableCalls()).toHaveLength(0);
    expect(flipRecords(provider)).toBe(0);
    expect(childLogger.warn).not.toHaveBeenCalled();
    expect(childLogger.error).not.toHaveBeenCalled();
  });

  it('a FAILED re-enable is an ERROR line naming the restore command, and the original error still wins', async () => {
    script({ observe: true, del: terminalRefusal(), reEnable: new Error('AccessDenied') });
    await expect(del()).rejects.toThrow('Failed to terminate');
    expect(childLogger.error).toHaveBeenCalledWith(
      expect.stringContaining(`EMR Cluster Res: could NOT re-enable TerminationProtected on ${CLUSTER}`)
    );
    expect(childLogger.error).toHaveBeenCalledWith(
      expect.stringContaining(`that cluster is LIVE with its deletion protection still off`)
    );
    expect(childLogger.error).toHaveBeenCalledWith(
      expect.stringContaining(`Restore it with: ${RESTORE}. (AccessDenied)`)
    );
  });

  it('an InvalidRequestException re-enable is a WARN that names the check first, not an ERROR claiming it is live', async () => {
    script({ observe: true, del: terminalRefusal(), reEnable: invalidRequest() });
    await expect(del()).rejects.toThrow('Failed to terminate');
    expect(childLogger.error).not.toHaveBeenCalled();
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        `could not re-enable TerminationProtected on ${CLUSTER} after the delete failed`
      )
    );
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('answered InvalidRequestException')
    );
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`Check with: ${CHECK} and if it is there, restore it with: ${RESTORE}.`)
    );
  });

  it.each([
    ['an unknown cluster id (InvalidRequestException)', { observe: invalidRequest() }],
    ['an already TERMINATED cluster', {}],
  ])(
    'a gone cluster still deletes idempotently under --remove-protection: %s',
    async (_label, s) => {
      const provider = newProvider();
      if ('observe' in s) {
        script(s as Script);
      } else {
        emrSend.mockResolvedValue({ Cluster: { Id: CLUSTER, Status: { State: 'TERMINATED' } } });
      }
      await expect(del(provider)).resolves.toBeUndefined();
      expect(disableCalls()).toHaveLength(0);
      expect(reEnableCalls()).toHaveLength(0);
      expect(flipRecords(provider)).toBe(0);
    }
  );
});

describe('emrClusterProtectionSite', () => {
  it('renders the commands with --region when the state records one', () => {
    expect(emrClusterProtectionSite(CLUSTER, 'eu-west-1').commands()).toEqual({
      check: `aws emr describe-cluster --cluster-id ${CLUSTER} --region eu-west-1`,
      restoreAfterNotFound: `aws emr modify-cluster-attributes --cluster-id ${CLUSTER} --region eu-west-1 --termination-protected`,
      restoreLive: `aws emr modify-cluster-attributes --cluster-id ${CLUSTER} --region eu-west-1 --termination-protected`,
    });
  });

  it('omits --region when the state carries none', () => {
    expect(emrClusterProtectionSite(CLUSTER, undefined).commands().check).toBe(
      `aws emr describe-cluster --cluster-id ${CLUSTER}`
    );
  });

  it.each([['j-1 2'], ['j-1\n2']])(
    'WITHHOLDS every command for an identifier that cannot be printed exactly (%j)',
    (id) => {
      expect(emrClusterProtectionSite(id, 'us-east-1').commands()).toEqual({
        check: WITHHELD_AWS_COMMAND,
        restoreAfterNotFound: WITHHELD_AWS_COMMAND,
        restoreLive: WITHHELD_AWS_COMMAND,
      });
    }
  );

  it('keys not-found on the error NAME, so only InvalidRequestException takes the WARN arm', () => {
    const site = emrClusterProtectionSite(CLUSTER, undefined);
    expect(site.isNotFound(invalidRequest())).toBe(true);
    expect(site.isNotFound(Object.assign(new Error('x'), { name: 'InvalidRequestException' }))).toBe(
      true
    );
    expect(site.isNotFound(new Error('AccessDenied'))).toBe(false);
    expect(site.isNotFound(undefined)).toBe(false);
  });
});
