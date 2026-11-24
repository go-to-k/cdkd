import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { DBProxyEndpointNotFoundFault, DBProxyNotFoundFault } from '@aws-sdk/client-rds';

const { mockSend, watches } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  /** One entry per watch a wait started, counting its dispose() calls. */
  watches: [] as { what: string; disposed: number }[],
}));

vi.mock('../../../src/provisioning/interrupt-watch.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/provisioning/interrupt-watch.js')>(
    '../../../src/provisioning/interrupt-watch.js'
  );
  return {
    ...actual,
    startInterruptWatch: (what: string) => {
      const watch = actual.startInterruptWatch(what);
      const entry = { what, disposed: 0 };
      watches.push(entry);
      return {
        ...watch,
        dispose: () => {
          entry.disposed++;
          watch.dispose();
        },
      };
    },
  };
});

vi.mock('@aws-sdk/client-rds', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-rds')>('@aws-sdk/client-rds');
  return {
    ...actual,
    RDSClient: vi.fn(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(function (this: unknown) { return this; }),
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

import { RDSDBProxyProvider } from '../../../src/provisioning/providers/rds-dbproxy-provider.js';
import { RDSDBProxyEndpointProvider } from '../../../src/provisioning/providers/rds-dbproxy-endpoint-provider.js';
import {
  disarmInterruptWatchForTests,
  interruptWatchTestSeam,
} from '../../../src/provisioning/interrupt-watch.js';
import { isWaitAbandonedError } from '../../../src/provisioning/wait-abandoned.js';
import { withResourceDeadline } from '../../../src/deployment/resource-deadline.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import { getLogger } from '../../../src/utils/logger.js';

/** A physical name standing in for a secret-derived one: every line must mask it. */
const SECRET_NAME = 'SecretDerivedProxyName';
const maskSecrets = (text: string): string => text.split(SECRET_NAME).join('***');

const logger = getLogger().child('test');
const warnLines = (): string[] => vi.mocked(logger.warn).mock.calls.map((c) => String(c[0]));
const allLogLines = (): string[] =>
  [logger.warn, logger.debug, logger.info].flatMap((fn) =>
    vi.mocked(fn).mock.calls.map((c) => String(c[0]))
  );

/** Fires the SIGINT listeners the interrupt watch installed since `baseline`. */
function pressCtrlC(baseline: Array<(...args: never[]) => unknown>): void {
  const ours = process.listeners('SIGINT').filter((l) => !baseline.includes(l));
  expect(ours.length).toBeGreaterThan(0);
  for (const l of ours) (l as unknown as () => void)();
}

const sites: {
  name: string;
  deleteCommand: string;
  describeCommand: string;
  /** The status read's answer for `status`. */
  status: (status: string) => unknown;
  /** The status read's answer once the resource is gone. */
  gone: () => Error;
  run: () => Promise<unknown>;
}[] = [
  {
    name: 'DBProxy delete',
    deleteCommand: 'DeleteDBProxyCommand',
    describeCommand: 'DescribeDBProxiesCommand',
    status: (status) => ({ DBProxies: [{ DBProxyName: SECRET_NAME, Status: status }] }),
    gone: () => new DBProxyNotFoundFault({ message: 'gone', $metadata: {} }),
    run: () =>
      new RDSDBProxyProvider().delete('Proxy', SECRET_NAME, 'AWS::RDS::DBProxy', undefined, {
        expectedRegion: 'us-east-1',
        maskSecrets,
      }),
  },
  {
    name: 'DBProxyEndpoint delete',
    deleteCommand: 'DeleteDBProxyEndpointCommand',
    describeCommand: 'DescribeDBProxyEndpointsCommand',
    status: (status) => ({
      DBProxyEndpoints: [{ DBProxyEndpointName: SECRET_NAME, Status: status }],
    }),
    gone: () => new DBProxyEndpointNotFoundFault({ message: 'gone', $metadata: {} }),
    run: () =>
      new RDSDBProxyEndpointProvider().delete(
        'Endpoint',
        SECRET_NAME,
        'AWS::RDS::DBProxyEndpoint',
        undefined,
        { expectedRegion: 'us-east-1', maskSecrets }
      ),
  },
];

/** Answers the delete call, then each status read in turn (the last repeats). */
function answer(site: (typeof sites)[number], reads: Array<() => unknown>, onRead?: () => void) {
  let read = 0;
  mockSend.mockImplementation(async (command: { constructor: { name: string } }) => {
    if (command.constructor.name === site.deleteCommand) return {};
    if (command.constructor.name !== site.describeCommand) {
      throw new Error(`unexpected ${command.constructor.name}`);
    }
    onRead?.();
    const next = reads[Math.min(read++, reads.length - 1)]!();
    if (next instanceof Error) throw next;
    return next;
  });
}

const statusReads = (site: (typeof sites)[number]) =>
  mockSend.mock.calls.filter((c) => c[0].constructor.name === site.describeCommand).length;

/** Runs `site` under fake timers, advancing the clock until it settles. */
async function settle(site: (typeof sites)[number]): Promise<unknown> {
  let outcome: unknown = 'pending';
  const done = site.run().then(
    () => (outcome = 'resolved'),
    (e: unknown) => (outcome = e)
  );
  for (let i = 0; i < 20 && outcome === 'pending'; i++) {
    await vi.advanceTimersByTimeAsync(5_000);
  }
  await done;
  return outcome;
}

describe('DBProxy / DBProxyEndpoint delete waits (#6522)', () => {
  let baseline: Array<(...args: never[]) => unknown>;

  beforeEach(() => {
    mockSend.mockReset();
    vi.mocked(logger.warn).mockClear();
    vi.mocked(logger.debug).mockClear();
    vi.mocked(logger.info).mockClear();
    watches.length = 0;
    disarmInterruptWatchForTests();
    interruptWatchTestSeam.commandOwnsInterrupts = () => true;
    interruptWatchTestSeam.forceQuit = vi.fn();
    baseline = process.listeners('SIGINT') as Array<(...args: never[]) => unknown>;
  });

  afterEach(() => {
    vi.useRealTimers();
    disarmInterruptWatchForTests();
    delete interruptWatchTestSeam.commandOwnsInterrupts;
    delete interruptWatchTestSeam.forceQuit;
  });

  for (const site of sites) {
    describe(site.name, () => {
      it('returns once the read reports the resource gone', async () => {
        vi.useFakeTimers();
        answer(site, [() => site.status('deleting'), site.gone]);
        expect(await settle(site)).toBe('resolved');
        expect(statusReads(site)).toBe(2);
        expect(warnLines()).toEqual([]);
        // The gone line names the resource too, masked.
        expect(allLogLines().some((l) => l.includes('*** is gone'))).toBe(true);
        for (const line of allLogLines()) expect(line).not.toContain(SECRET_NAME);
        expect(watches).toHaveLength(1);
        expect(watches[0]!.disposed).toBe(1);
      });

      it('stops on a Ctrl-C during the wait: warns and returns, as every accepted delete does', async () => {
        vi.useFakeTimers();
        answer(site, [() => site.status('deleting')], () => pressCtrlC(baseline));
        expect(await settle(site)).toBe('resolved');
        // No read after the one the Ctrl-C landed in.
        expect(statusReads(site)).toBe(1);
        const warns = warnLines();
        expect(warns).toHaveLength(1);
        expect(warns[0]).toContain('(interrupted)');
        expect(warns[0]).toContain('the delete was ACCEPTED by AWS');
        expect(watches).toHaveLength(1);
        expect(watches[0]!.disposed).toBe(1);
      });

      it('stops after one read, before the resource deadline fires, when the deadline leaves no room', async () => {
        answer(site, [() => site.status('deleting')]);
        // 20s is under the 30s margin, so the wait must stop after its read
        // rather than sleep on toward the deadline.
        const outcome = await withResourceDeadline(() => site.run(), {
          warnAfterMs: 10_000,
          timeoutMs: 20_000,
          onTimeout: () => new Error('resource deadline fired'),
        }).then(
          () => 'resolved',
          (e: unknown) => e
        );
        expect(outcome).toBe('resolved');
        expect(statusReads(site)).toBe(1);
        const warns = warnLines();
        expect(warns).toHaveLength(1);
        expect(warns[0]).toContain('stopped waiting for it to disappear after 0s');
        expect(warns[0]).toContain('(last status: deleting)');
      });

      it('masks the physical name in every line it logs', async () => {
        answer(site, [() => site.status('deleting')]);
        await withResourceDeadline(() => site.run(), {
          warnAfterMs: 10_000,
          timeoutMs: 20_000,
          onTimeout: () => new Error('resource deadline fired'),
        });
        const lines = allLogLines();
        expect(lines.some((l) => l.includes('***'))).toBe(true);
        for (const line of lines) expect(line).not.toContain(SECRET_NAME);
        // The watch's own label is masked too.
        expect(watches.map((w) => w.what).join('\n')).not.toContain(SECRET_NAME);
      });

      it('warns, masked, and returns when the status cannot be read', async () => {
        const denied = Object.assign(new Error('User is not authorized near ' + SECRET_NAME), {
          name: `Denied${SECRET_NAME}Exception`,
          $fault: 'client',
          $metadata: { httpStatusCode: 403 },
        });
        answer(site, [() => site.status('deleting'), () => denied]);
        vi.useFakeTimers();
        expect(await settle(site)).toBe('resolved');
        expect(statusReads(site)).toBe(2);
        const warns = warnLines();
        expect(warns).toHaveLength(1);
        expect(warns[0]).toContain('its status could not be read');
        expect(warns[0]).toContain('Denied***Exception');
        for (const line of allLogLines()) expect(line).not.toContain(SECRET_NAME);
      });

      it('throws, keeping the state record, when the resource leaves deleting for another status', async () => {
        vi.useFakeTimers();
        answer(site, [() => site.status('deleting'), () => site.status('available')]);
        const outcome = await settle(site);
        expect(outcome).toBeInstanceOf(ProvisioningError);
        expect(isWaitAbandonedError(outcome)).toBe(true);
        const message = (outcome as Error).message;
        expect(message).toContain('left the deleting state for available');
        expect(message).toContain('***');
        expect(message).not.toContain(SECRET_NAME);
        expect(statusReads(site)).toBe(2);
      });

      it('masks the already-gone line when the delete call finds nothing', async () => {
        mockSend.mockImplementation(async () => {
          throw site.gone();
        });
        await site.run();
        expect(statusReads(site)).toBe(0);
        const lines = allLogLines();
        expect(lines.some((l) => l.includes('already gone') && l.includes('***'))).toBe(true);
        for (const line of lines) expect(line).not.toContain(SECRET_NAME);
      });

      it('throws, keeping the state record, when the wait ends without ever reading deleting', async () => {
        answer(site, [() => site.status('available')]);
        const outcome = await withResourceDeadline(() => site.run(), {
          warnAfterMs: 10_000,
          timeoutMs: 20_000,
          onTimeout: () => new Error('resource deadline fired'),
        }).then(
          () => 'resolved',
          (e: unknown) => e
        );
        expect(outcome).toBeInstanceOf(ProvisioningError);
        expect(isWaitAbandonedError(outcome)).toBe(true);
        const message = (outcome as Error).message;
        expect(message).toContain('still read available, never deleting');
        expect(message).toContain('***');
        expect(message).not.toContain(SECRET_NAME);
        expect(statusReads(site)).toBe(1);
      });

      it('returns when the resource goes without a deleting read in between', async () => {
        vi.useFakeTimers();
        answer(site, [() => site.status('available'), site.gone]);
        expect(await settle(site)).toBe('resolved');
        expect(statusReads(site)).toBe(2);
      });

      it('does not count a read with no status as the last status when the wait stops', async () => {
        answer(site, [() => ({})]);
        const outcome = await withResourceDeadline(() => site.run(), {
          warnAfterMs: 10_000,
          timeoutMs: 20_000,
          onTimeout: () => new Error('resource deadline fired'),
        }).then(
          () => 'resolved',
          (e: unknown) => e
        );
        expect(outcome).toBe('resolved');
        expect(statusReads(site)).toBe(1);
        expect(warnLines()).toHaveLength(1);
      });

      it('throws on a Ctrl-C too when no read has shown deleting yet', async () => {
        vi.useFakeTimers();
        answer(site, [() => site.status('available')], () => pressCtrlC(baseline));
        const outcome = await settle(site);
        expect(isWaitAbandonedError(outcome)).toBe(true);
        expect((outcome as Error).message).toContain('still read available, never deleting');
        expect(statusReads(site)).toBe(1);
      });

      it('stops at its own 30-minute cap outside any resource deadline', async () => {
        vi.useFakeTimers();
        answer(site, [() => site.status('deleting')]);
        let outcome: unknown = 'pending';
        const done = site.run().then(
          () => (outcome = 'resolved'),
          (e: unknown) => (outcome = e)
        );
        await vi.advanceTimersByTimeAsync(29 * 60_000);
        expect(outcome).toBe('pending');
        await vi.advanceTimersByTimeAsync(2 * 60_000);
        await done;
        expect(outcome).toBe('resolved');
        const warns = warnLines();
        expect(warns).toHaveLength(1);
        expect(warns[0]).toContain('stopped waiting for it to disappear after 1800s');
      });

      it('does not trust a status read before the first deleting one', async () => {
        vi.useFakeTimers();
        answer(site, [
          () => site.status('available'),
          () => site.status('available'),
          () => site.status('deleting'),
          site.gone,
        ]);
        expect(await settle(site)).toBe('resolved');
        expect(statusReads(site)).toBe(4);
      });

      it('keeps waiting on a read that carries no status', async () => {
        vi.useFakeTimers();
        answer(site, [
          () => site.status('deleting'),
          () => ({}),
          site.gone,
        ]);
        expect(await settle(site)).toBe('resolved');
        expect(statusReads(site)).toBe(3);
      });
    });
  }
});
