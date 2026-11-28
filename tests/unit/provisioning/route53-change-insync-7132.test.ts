import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const { mockSend, warnSpy } = vi.hoisted(() => ({ mockSend: vi.fn(), warnSpy: vi.fn() }));

vi.mock('@aws-sdk/client-route-53', async () => {
  const actual = await vi.importActual('@aws-sdk/client-route-53');
  return {
    ...actual,
    Route53Client: vi.fn(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn(function (this: unknown) {
      return this;
    }),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import {
  GetChangeCommand,
  GetHostedZoneCommand,
  ListResourceRecordSetsCommand,
  type Route53Client,
} from '@aws-sdk/client-route-53';
import { Route53Provider } from '../../../src/provisioning/providers/route53-provider.js';
import { waitForRoute53ChangeInsync } from '../../../src/provisioning/providers/route53/change-wait.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';
import { createMaskedLogSinks } from '../../../src/provisioning/masked-retry-logger.js';
import { withResourceDeadline } from '../../../src/deployment/resource-deadline.js';
import {
  disarmInterruptWatchForTests,
  interruptWatchTestSeam,
  isInterruptedWaitError,
} from '../../../src/provisioning/interrupt-watch.js';

/**
 * go-to-k/cdkd#7132: every Route 53 write answers `ChangeInfo { Status:
 * PENDING }` and reaches `INSYNC` ~25-80 s later (measured us-east-1).
 * CloudFormation waits for it on HostedZone create (~51 s) / delete (~42 s),
 * RecordSet create (~32 s) / delete (~32 s) and a HostedZone VPCs update
 * (~103 s). By maintainer decision only `--full-wait` waits; the default
 * deploy and `--no-wait` send no `GetChange`.
 */

const ZONE = 'Z1234567890';
const name = (c: unknown): string => (c as { constructor: { name: string } }).constructor.name;
const sentNames = (): string[] => mockSend.mock.calls.map((c) => name(c[0]));
const getChangeIds = (): string[] =>
  mockSend.mock.calls
    .map((c) => c[0] as unknown)
    .filter((c): c is GetChangeCommand => c instanceof GetChangeCommand)
    .map((c) => c.input.Id!);

/**
 * Every write answers its own change id (`C<n>`, from `/change/C<n>`); every
 * `GetChange` answers INSYNC unless `pending` says how many PENDING reads
 * precede it.
 */
let issued: Array<[string, string]> = [];
/** The change ids the named write commands answered, in send order. */
const idsOf = (...commands: string[]): string[] =>
  issued.filter(([c]) => commands.includes(c)).map(([, id]) => id);

function route(opts: { pending?: number; vpcs?: Array<Record<string, string>>; live?: unknown[] } = {}): void {
  let n = 0;
  issued = [];
  let pending = opts.pending ?? 0;
  mockSend.mockImplementation(async (cmd: unknown) => {
    if (cmd instanceof GetChangeCommand) {
      const status = pending-- > 0 ? 'PENDING' : 'INSYNC';
      return { ChangeInfo: { Id: `/change/${cmd.input.Id}`, Status: status } };
    }
    if (cmd instanceof GetHostedZoneCommand) {
      return { HostedZone: { Id: `/hostedzone/${ZONE}` }, VPCs: opts.vpcs ?? [] };
    }
    if (cmd instanceof ListResourceRecordSetsCommand) {
      return { ResourceRecordSets: opts.live ?? [], IsTruncated: false };
    }
    n += 1;
    issued.push([name(cmd), `C${n}`]);
    return {
      HostedZone: { Id: `/hostedzone/${ZONE}` },
      DelegationSet: { NameServers: ['ns-1.example.net'] },
      ChangeInfo: { Id: `/change/C${n}`, Status: 'PENDING' },
      QueryLoggingConfigs: [],
    };
  });
}

const A_RECORD = { Name: 'a.example.com.', Type: 'A', TTL: '300', ResourceRecords: ['192.0.2.1'] };
const RECORD = { HostedZoneId: ZONE, ...A_RECORD };
const GROUP = { HostedZoneId: ZONE, RecordSets: [A_RECORD] };
const VPC_A = { VPCId: 'vpc-aaaa1111', VPCRegion: 'us-east-1' };
const VPC_B = { VPCId: 'vpc-bbbb2222', VPCRegion: 'us-east-1' };
const VPC_C = { VPCId: 'vpc-cccc3333', VPCRegion: 'us-east-1' };

describe('Route 53 change INSYNC wait per call site (#7132)', () => {
  let provider: Route53Provider;

  beforeEach(() => {
    mockSend.mockReset();
    warnSpy.mockReset();
    provider = new Route53Provider();
  });
  afterEach(() => vi.unstubAllEnvs());

  // Each call site: what it does, and the change ids `--full-wait` reads.
  const sites: Array<[string, () => Promise<unknown>, string[], Parameters<typeof route>[0]?]> = [
    [
      'HostedZone create (zone + the second VPC association)',
      () =>
        provider.create('Zone', 'AWS::Route53::HostedZone', {
          Name: 'example.internal',
          VPCs: [VPC_A, VPC_B],
        }),
      ['CreateHostedZoneCommand', 'AssociateVPCWithHostedZoneCommand'],
    ],
    [
      'HostedZone VPCs update (associate + disassociate)',
      () =>
        provider.update(
          'Zone',
          ZONE,
          'AWS::Route53::HostedZone',
          { Name: 'example.internal', VPCs: [VPC_A, VPC_C] },
          { Name: 'example.internal', VPCs: [VPC_A, VPC_B] }
        ),
      ['AssociateVPCWithHostedZoneCommand', 'DisassociateVPCFromHostedZoneCommand'],
      { vpcs: [VPC_A, VPC_B] },
    ],
    [
      'HostedZone delete',
      () => provider.delete('Zone', ZONE, 'AWS::Route53::HostedZone', { Name: 'example.com' }),
      ['DeleteHostedZoneCommand'],
    ],
    [
      'RecordSet create',
      () => provider.create('Rec', 'AWS::Route53::RecordSet', RECORD),
      ['ChangeResourceRecordSetsCommand'],
    ],
    [
      'RecordSet update',
      () =>
        provider.update(
          'Rec',
          `${ZONE}|a.example.com.|A`,
          'AWS::Route53::RecordSet',
          { ...RECORD, TTL: '60' },
          RECORD
        ),
      ['ChangeResourceRecordSetsCommand'],
    ],
    [
      'RecordSet delete',
      () => provider.delete('Rec', `${ZONE}|a.example.com.|A`, 'AWS::Route53::RecordSet', RECORD),
      ['ChangeResourceRecordSetsCommand'],
    ],
    [
      'RecordSetGroup create',
      () => provider.create('Group', 'AWS::Route53::RecordSetGroup', GROUP),
      ['ChangeResourceRecordSetsCommand'],
    ],
    [
      'RecordSetGroup update',
      () =>
        provider.update(
          'Group',
          `${ZONE}|Group`,
          'AWS::Route53::RecordSetGroup',
          { ...GROUP, RecordSets: [{ ...A_RECORD, TTL: '60' }] },
          GROUP
        ),
      ['ChangeResourceRecordSetsCommand'],
    ],
    [
      'RecordSetGroup delete',
      () => provider.delete('Group', `${ZONE}|Group`, 'AWS::Route53::RecordSetGroup', GROUP),
      ['ChangeResourceRecordSetsCommand'],
    ],
  ];

  it.each(sites)('%s: --full-wait polls each change until INSYNC', async (_, run, ids, opts) => {
    vi.stubEnv('CDKD_FULL_WAIT', 'true');
    // Polling itself (PENDING, then INSYNC) is covered on the helper below;
    // here each site must read its own change ids.
    route(opts);
    await run();
    expect(idsOf(...ids)).toHaveLength(ids.length);
    expect(getChangeIds()).toEqual(idsOf(...ids));
    expect(warnSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('INSYNC'))).toEqual(
      []
    );
  });

  it.each(sites)('%s: the default deploy sends no GetChange', async (_, run, _ids, opts) => {
    route(opts);
    await run();
    expect(sentNames()).not.toContain('GetChangeCommand');
  });

  it.each(sites)('%s: --no-wait sends no GetChange', async (_, run, _ids, opts) => {
    vi.stubEnv('CDKD_NO_WAIT', 'true');
    route(opts);
    await run();
    expect(sentNames()).not.toContain('GetChangeCommand');
  });

  /**
   * Route the writes as `route` does, but refuse the first `refusals`
   * `ChangeResourceRecordSets` sends with the given errors, in turn.
   */
  function refuseChanges(...refusals: Error[]): void {
    route();
    const inner = mockSend.getMockImplementation()!;
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (name(cmd) === 'ChangeResourceRecordSetsCommand' && refusals.length > 0) {
        throw refusals.shift()!;
      }
      return inner(cmd);
    });
  }
  const mutationRefusal = (): Error =>
    new Error(`HostedZone ${ZONE} is marked disabled for mutation`);
  const notFoundRefusal = (): Error =>
    Object.assign(
      new Error('Tried to delete resource record set [name=x, type=A] but it was not found'),
      { name: 'InvalidChangeBatch' }
    );

  it.each([
    [
      'RecordSet',
      () => provider.delete('Rec', `${ZONE}|a.example.com.|A`, 'AWS::Route53::RecordSet', RECORD),
    ],
    [
      'RecordSetGroup',
      () => provider.delete('Group', `${ZONE}|Group`, 'AWS::Route53::RecordSetGroup', GROUP),
    ],
  ])('%s delete: --full-wait waits on the change the AcceleratedRecovery retry answered', async (_, run) => {
    vi.stubEnv('CDKD_FULL_WAIT', 'true');
    (
      provider as unknown as { waitForAcceleratedRecoveryMutable: () => Promise<void> }
    ).waitForAcceleratedRecoveryMutable = async () => {};
    refuseChanges(mutationRefusal());
    await run();
    expect(idsOf('ChangeResourceRecordSetsCommand')).toHaveLength(1);
    expect(getChangeIds()).toEqual(idsOf('ChangeResourceRecordSetsCommand'));
  });

  it('RecordSetGroup delete: --full-wait waits on every change of the record-by-record fallback', async () => {
    vi.stubEnv('CDKD_FULL_WAIT', 'true');
    const B_RECORD = { ...A_RECORD, Name: 'b.example.com.' };
    const C_RECORD = { ...A_RECORD, Name: 'c.example.com.' };
    const group = { HostedZoneId: ZONE, RecordSets: [A_RECORD, B_RECORD, C_RECORD] };
    // The batch names a record already gone, so it is refused whole; then
    // the first and third record delete, and the second is gone.
    refuseChanges(notFoundRefusal());
    const inner = mockSend.getMockImplementation()!;
    let perRecord = 0;
    mockSend.mockImplementation(async (cmd: unknown) => {
      if (name(cmd) === 'ChangeResourceRecordSetsCommand' && perRecord++ === 2) {
        throw notFoundRefusal();
      }
      return inner(cmd);
    });
    await provider.delete('Group', `${ZONE}|Group`, 'AWS::Route53::RecordSetGroup', group);
    expect(idsOf('ChangeResourceRecordSetsCommand')).toHaveLength(2);
    expect(getChangeIds()).toEqual(idsOf('ChangeResourceRecordSetsCommand'));
  });

  it.each([
    [
      'HostedZone',
      'AWS::Route53::HostedZone',
      { Name: 'example.internal', VPCs: [VPC_A, VPC_B] },
      ZONE,
    ],
    ['RecordSet', 'AWS::Route53::RecordSet', RECORD, `${ZONE}|a.example.com.|A`],
    ['RecordSetGroup', 'AWS::Route53::RecordSetGroup', GROUP, `${ZONE}|X`],
  ])('%s create: a Ctrl-C during the wait names the live record for the journal', async (_, type, props, id) => {
    vi.stubEnv('CDKD_FULL_WAIT', 'true');
    const baseline = process.listeners('SIGINT');
    disarmInterruptWatchForTests();
    interruptWatchTestSeam.commandOwnsInterrupts = () => true;
    interruptWatchTestSeam.forceQuit = vi.fn();
    try {
      route({ pending: 100 });
      const inner = mockSend.getMockImplementation()!;
      mockSend.mockImplementation(async (cmd: unknown) => {
        if (cmd instanceof GetChangeCommand) {
          for (const l of process.listeners('SIGINT').filter((x) => !baseline.includes(x))) {
            (l as unknown as () => void)();
          }
        }
        return inner(cmd);
      });
      const error = await provider.create('X', type, props).then(
        () => new Error('expected the create to fail'),
        (e: unknown) => e
      );
      expect(isInterruptedWaitError(error)).toBe(true);
      expect(createdBeforeFailure(error, 'X', type)).toBe(id);
    } finally {
      disarmInterruptWatchForTests();
      delete interruptWatchTestSeam.commandOwnsInterrupts;
      delete interruptWatchTestSeam.forceQuit;
    }
  });
});

describe('waitForRoute53ChangeInsync (#7132)', () => {
  const send = vi.fn();
  const client = { send } as unknown as Route53Client;
  const warn = vi.fn();
  const log = createMaskedLogSinks({ debug: vi.fn(), warn }, undefined);
  const opts = { pollMs: 0 };
  const pending = { ChangeInfo: { Id: '/change/C1', Status: 'PENDING' } };
  const insync = { ChangeInfo: { Id: '/change/C1', Status: 'INSYNC' } };

  beforeEach(() => {
    send.mockReset();
    warn.mockReset();
    vi.stubEnv('CDKD_FULL_WAIT', 'true');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('polls GetChange with the bare id until INSYNC', async () => {
    send.mockResolvedValueOnce(pending).mockResolvedValueOnce(pending).mockResolvedValueOnce(insync);
    await waitForRoute53ChangeInsync(client, '/change/C1', 'record set R', log, opts);
    expect(send).toHaveBeenCalledTimes(3);
    expect((send.mock.calls[0]![0] as GetChangeCommand).input).toEqual({ Id: 'C1' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('without --full-wait sends nothing', async () => {
    vi.stubEnv('CDKD_FULL_WAIT', '');
    await waitForRoute53ChangeInsync(client, '/change/C1', 'record set R', log, opts);
    expect(send).not.toHaveBeenCalled();
  });

  it('without a change id sends nothing', async () => {
    await waitForRoute53ChangeInsync(client, undefined, 'record set R', log, opts);
    expect(send).not.toHaveBeenCalled();
  });

  it('warns with a pasteable wait command and returns when the cap runs out', async () => {
    send.mockResolvedValue(pending);
    await waitForRoute53ChangeInsync(client, '/change/C1', 'record set R', log, {
      pollMs: 0,
      maxPolls: 3,
    });
    expect(send).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]![0]);
    expect(message).toContain('record set R did not reach INSYNC');
    expect(message).toContain('continuing');
    expect(message).toContain('aws route53 wait resource-record-sets-changed --id C1');
  });

  it('warns and returns once the resource deadline has expired', async () => {
    send.mockResolvedValue(pending);
    let wait: Promise<void> | undefined;
    // The engine's own timeout rejects first; the wait then sees the expired
    // deadline after its shortened sleep, and returns instead of polling on.
    await withResourceDeadline(
      () => (wait = waitForRoute53ChangeInsync(client, '/change/C1', 'record set R', log, { pollMs: 60_000 })),
      { warnAfterMs: 20, timeoutMs: 40, onTimeout: () => new Error('resource deadline fired') }
    ).catch(() => undefined);
    await wait;
    expect(send).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('before the resource timeout');
  });

  it('reads again after a throttled or 5xx read', async () => {
    send
      .mockRejectedValueOnce(
        Object.assign(new Error('Rate exceeded'), {
          name: 'Throttling',
          $metadata: { httpStatusCode: 400 },
        })
      )
      .mockRejectedValueOnce(
        Object.assign(new Error('internal'), {
          name: 'InternalFailure',
          $fault: 'server',
          $metadata: { httpStatusCode: 500 },
        })
      )
      .mockResolvedValueOnce(insync);
    await waitForRoute53ChangeInsync(client, '/change/C1', 'record set R', log, opts);
    expect(send).toHaveBeenCalledTimes(3);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns and returns on any other read failure', async () => {
    send.mockRejectedValueOnce(
      Object.assign(new Error('denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } })
    );
    await waitForRoute53ChangeInsync(client, '/change/C1', 'record set R', log, opts);
    expect(send).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('could not be read');
  });

  it('stops on Ctrl-C with the interrupt error, without another read', async () => {
    const baseline = process.listeners('SIGINT');
    disarmInterruptWatchForTests();
    interruptWatchTestSeam.commandOwnsInterrupts = () => true;
    interruptWatchTestSeam.forceQuit = vi.fn();
    try {
      send.mockImplementation(async () => {
        for (const l of process.listeners('SIGINT').filter((x) => !baseline.includes(x))) {
          (l as unknown as () => void)();
        }
        return pending;
      });
      const error = await waitForRoute53ChangeInsync(client, '/change/C1', 'record set R', log, opts).then(
        () => new Error('expected the wait to fail'),
        (e: unknown) => e
      );
      expect(isInterruptedWaitError(error)).toBe(true);
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      disarmInterruptWatchForTests();
      delete interruptWatchTestSeam.commandOwnsInterrupts;
      delete interruptWatchTestSeam.forceQuit;
    }
  });
});
