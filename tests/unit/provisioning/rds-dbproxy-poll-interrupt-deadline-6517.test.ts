import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const { mockSend, watches } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  /** One entry per watch a poll started, counting its dispose() calls. */
  watches: [] as { disposed: number }[],
}));

vi.mock('../../../src/provisioning/interrupt-watch.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/provisioning/interrupt-watch.js')>(
    '../../../src/provisioning/interrupt-watch.js'
  );
  return {
    ...actual,
    startInterruptWatch: (what: string) => {
      const watch = actual.startInterruptWatch(what);
      const entry = { disposed: 0 };
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
import { pauseBeforeNextPoll } from '../../../src/provisioning/providers/rds-dbproxy/shared.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';
import {
  disarmInterruptWatchForTests,
  interruptWatchTestSeam,
  isInterruptedWaitError,
  startInterruptWatch,
} from '../../../src/provisioning/interrupt-watch.js';
import { withResourceDeadline } from '../../../src/deployment/resource-deadline.js';

const PROXY_TYPE = 'AWS::RDS::DBProxy';
const PROXY_NAME = 'AuroraProxy';
const PROXY_PROPS = {
  DBProxyName: PROXY_NAME,
  EngineFamily: 'MYSQL',
  Auth: [{ AuthScheme: 'SECRETS', SecretArn: 'arn:aws:secretsmanager:us-east-1:123:secret:db' }],
  RoleArn: 'arn:aws:iam::123456789012:role/AuroraProxyRole',
  VpcSubnetIds: ['subnet-a', 'subnet-b'],
};

const EP_TYPE = 'AWS::RDS::DBProxyEndpoint';
const EP_NAME = 'MyEndpoint';
const EP_PROPS = {
  DBProxyName: PROXY_NAME,
  DBProxyEndpointName: EP_NAME,
  VpcSubnetIds: ['subnet-a', 'subnet-b'],
  VpcSecurityGroupIds: ['sg-old'],
};

const proxyStatus = (status: string) => ({ DBProxies: [{ Status: status }] });
const endpointStatus = (status: string) => ({ DBProxyEndpoints: [{ Status: status }] });

/** Fires the SIGINT listeners the interrupt watch installed since `baseline`. */
function pressCtrlC(baseline: Array<(...args: never[]) => unknown>): void {
  const ours = process.listeners('SIGINT').filter((l) => !baseline.includes(l));
  expect(ours.length).toBeGreaterThan(0);
  for (const l of ours) (l as unknown as () => void)();
}

/** Each case below calls one of these; each runs one poll site to its error. */
const sites: {
  name: string;
  /** The poll's status read, answering "still in progress". */
  pending: () => unknown;
  /** Mocks the calls before the poll, then runs the operation. */
  run: () => Promise<unknown>;
  /** The create sites mark the error with the id their create call returned. */
  marked?: () => [string, string, string];
}[] = [
  {
    name: 'DBProxy create',
    pending: () => proxyStatus('creating'),
    run: () => {
      mockSend.mockResolvedValueOnce({}); // CreateDBProxy
      return new RDSDBProxyProvider().create('Proxy', PROXY_TYPE, PROXY_PROPS);
    },
    marked: () => ['Proxy', PROXY_TYPE, PROXY_NAME],
  },
  {
    name: 'DBProxy wait after modify',
    pending: () => proxyStatus('modifying'),
    run: () =>
      new RDSDBProxyProvider().waitForAvailableAfterModify(
        PROXY_NAME,
        PROXY_TYPE,
        'Proxy',
        (s: string) => s
      ),
  },
  {
    name: 'DBProxyEndpoint create',
    pending: () => endpointStatus('creating'),
    run: () => {
      mockSend.mockResolvedValueOnce({}); // CreateDBProxyEndpoint
      return new RDSDBProxyEndpointProvider().create('Endpoint', EP_TYPE, EP_PROPS);
    },
    marked: () => ['Endpoint', EP_TYPE, EP_NAME],
  },
  {
    name: 'DBProxyEndpoint wait after modify',
    pending: () => endpointStatus('modifying'),
    run: () => {
      mockSend.mockResolvedValueOnce({}); // ModifyDBProxyEndpoint
      return new RDSDBProxyEndpointProvider().update('Endpoint', EP_NAME, EP_TYPE, {
        ...EP_PROPS,
        VpcSecurityGroupIds: ['sg-new'],
      }, EP_PROPS);
    },
  },
];

const statusReads = () =>
  mockSend.mock.calls.filter((c) => /^DescribeDBProx(ies|yEndpoints)Command$/.test(c[0].constructor.name))
    .length;

describe('DBProxy / DBProxyEndpoint status polls stop on Ctrl-C and at the resource deadline (#6517)', () => {
  let baseline: Array<(...args: never[]) => unknown>;

  beforeEach(() => {
    mockSend.mockReset();
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
    vi.restoreAllMocks();
  });

  for (const site of sites) {
    describe(site.name, () => {
      it('ends with the interrupt error, without another read, on a Ctrl-C during the poll', async () => {
        mockSend.mockImplementation(async (command: { constructor: { name: string } }) => {
          if (!command.constructor.name.startsWith('Describe')) return {};
          pressCtrlC(baseline);
          return site.pending();
        });
        const error = await site.run().then(
          () => {
            throw new Error('expected the poll to fail');
          },
          (e: unknown) => e
        );
        expect(isInterruptedWaitError(error)).toBe(true);
        expect(statusReads()).toBe(1);
        if (site.marked) {
          const [logicalId, type, physicalId] = site.marked();
          // go-to-k/cdkd#4583 / #2169: the created resource is still named.
          expect(createdBeforeFailure(error, logicalId, type)).toBe(physicalId);
        }
        // The poll's one watch is disposed.
        expect(watches).toEqual([{ disposed: 1 }]);
      });

      it('throws its own timeout, after one read, when the resource deadline leaves no room', async () => {
        mockSend.mockImplementation(async (command: { constructor: { name: string } }) =>
          command.constructor.name.startsWith('Describe') ? site.pending() : {}
        );
        // 20s is under the poll's 30s margin, so it must stop after its read
        // rather than sleep on toward the deadline.
        const error = await withResourceDeadline(() => site.run(), {
          warnAfterMs: 10_000,
          timeoutMs: 20_000,
          onTimeout: () => new Error('resource deadline fired'),
        }).then(
          () => {
            throw new Error('expected the poll to fail');
          },
          (e: unknown) => e
        );
        expect(String(error)).toContain('Timed out waiting for');
        expect(String(error)).not.toContain('resource deadline fired');
        expect(statusReads()).toBe(1);
        if (site.marked) {
          const [logicalId, type, physicalId] = site.marked();
          expect(createdBeforeFailure(error, logicalId, type)).toBe(physicalId);
        }
        expect(watches).toEqual([{ disposed: 1 }]);
      });
    });
  }
});

describe('pauseBeforeNextPoll (#6517)', () => {
  beforeEach(() => {
    disarmInterruptWatchForTests();
    interruptWatchTestSeam.commandOwnsInterrupts = () => true;
    interruptWatchTestSeam.forceQuit = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    disarmInterruptWatchForTests();
    delete interruptWatchTestSeam.commandOwnsInterrupts;
    delete interruptWatchTestSeam.forceQuit;
  });

  it('wakes within a second of a Ctrl-C during the sleep', async () => {
    vi.useFakeTimers();
    const baseline = process.listeners('SIGINT') as Array<(...args: never[]) => unknown>;
    const watch = startInterruptWatch('test wait');
    try {
      const paused = pauseBeforeNextPoll(Date.now() + 60_000, watch).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(1_500);
      pressCtrlC(baseline);
      await vi.advanceTimersByTimeAsync(1_000);
      // Well short of the 5s poll interval.
      const outcome = await Promise.race([paused, Promise.resolve('still sleeping')]);
      expect(isInterruptedWaitError(outcome)).toBe(true);
    } finally {
      watch.dispose();
    }
  });

  it('sleeps the poll interval and answers true with budget left', async () => {
    vi.useFakeTimers();
    const watch = startInterruptWatch('test wait');
    try {
      let done: unknown = 'still sleeping';
      const paused = pauseBeforeNextPoll(Date.now() + 60_000, watch).then((v) => (done = v));
      await vi.advanceTimersByTimeAsync(4_000);
      expect(done).toBe('still sleeping');
      await vi.advanceTimersByTimeAsync(1_000);
      await paused;
      expect(done).toBe(true);
    } finally {
      watch.dispose();
    }
  });

  it("answers false, without sleeping, once the poll's own cap has passed", async () => {
    const watch = startInterruptWatch('test wait');
    try {
      await expect(pauseBeforeNextPoll(Date.now() - 1, watch)).resolves.toBe(false);
    } finally {
      watch.dispose();
    }
  });

  it('answers a Ctrl-C seen before the pause with the interrupt, not a timeout', async () => {
    const baseline = process.listeners('SIGINT') as Array<(...args: never[]) => unknown>;
    const watch = startInterruptWatch('test wait');
    try {
      pressCtrlC(baseline);
      const outcome = await pauseBeforeNextPoll(Date.now() - 1, watch).catch((e: unknown) => e);
      expect(isInterruptedWaitError(outcome)).toBe(true);
    } finally {
      watch.dispose();
    }
  });
});
