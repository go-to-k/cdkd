import { describe, it, expect, vi } from 'vite-plus/test';
import type { S3Client } from '@aws-sdk/client-s3';
import type { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';

vi.mock('../../../src/utils/logger.js', () => {
  const l = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    child: () => l,
  };
  return { getLogger: () => l };
});

import {
  makeSiblingClaimReader,
  planOrphanAdoption,
} from '../../../src/deployment/orphan-adoption.js';
import { dropNestedChildJournals } from '../../../src/deployment/nested-child-journal.js';
import { WorkGraph, type WorkNode } from '../../../src/deployment/work-graph.js';
import { probeStatefulRecreateTargetsAsync } from '../../../src/deployment/recreate-targets/probe.js';
import type { RecreateTarget } from '../../../src/deployment/recreate-targets/validate.js';
import type { ResourceProvider } from '../../../src/types/resource.js';
import type { StackOrphanRecord } from '../../../src/types/state.js';

/**
 * Issue [#3361](https://github.com/go-to-k/cdkd/issues/3361), the
 * `src/deployment` slice outside the deploy engine: a handler that
 * stringified its caught value with `x instanceof Error ? x.message :
 * String(x)` threw from inside itself when the value could not be converted
 * -- `String(Object.create(null))` throws `TypeError: Cannot convert object to
 * primitive value` -- and turned its degradation into a hard failure.
 *
 * Every case rejects with exactly that value and asserts the DEGRADATION still
 * happens (the record is kept, the walk goes on, the call resolves, the probe
 * answers), never merely "it did not throw". The placeholder is asserted too,
 * so a fix that swallowed the failure without reporting it would not pass.
 */

/** What `describeAwsFailure(x).detail` renders for a value `String()` cannot convert. */
const PLACEHOLDER = 'a value that could not be converted to text';

/** A rejection whose `String()` throws. */
const unconvertible = (): unknown => Object.create(null) as unknown;

const REGION = 'us-east-1';

describe('planOrphanAdoption (#3361)', () => {
  const record: StackOrphanRecord = {
    logicalId: 'KeptRole',
    orphanedAt: 1,
    state: {
      physicalId: 'cdkd-sandbox-KeptRole',
      resourceType: 'AWS::IAM::Role',
      properties: {},
      attributes: {},
      deletionPolicy: 'Retain',
    },
  };

  const plan = (getProvider: () => ResourceProvider) =>
    planOrphanAdoption({
      records: [record],
      managedLogicalIds: new Set(),
      template: { Resources: { KeptRole: { Type: 'AWS::IAM::Role', Properties: {} } } },
      stackName: 'MyStack',
      region: REGION,
      getProvider,
      nameProperties: () => ['RoleName'],
      readSiblingClaims: async () => new Set(),
      logger: { debug: vi.fn() },
    });

  it('a provider lookup throwing an unconvertible value keeps the record and notices it', async () => {
    // The routing catch keeps the record so the deploy is not bricked by a
    // type this build cannot route. Built with `String(error)`, its notice
    // threw and the whole pre-pass -- and so the deploy -- rejected.
    const outcome = await plan(() => {
      throw unconvertible();
    });

    expect(outcome.remaining).toEqual([record]);
    expect(outcome.refusals).toEqual([]);
    expect(outcome.notices).toHaveLength(1);
    expect(outcome.notices[0]).toContain('cannot route that type');
    expect(outcome.notices[0]).toContain(PLACEHOLDER);
  });

  it('an existence check rejecting with an unconvertible value keeps the record and notices it', async () => {
    // A throw is NOT absence: the record must survive for the next run.
    const outcome = await plan(
      () =>
        ({
          import: () => Promise.reject(unconvertible()),
        }) as unknown as ResourceProvider
    );

    expect(outcome.remaining).toEqual([record]);
    expect(outcome.adopted).toEqual({});
    expect(outcome.notices).toHaveLength(1);
    expect(outcome.notices[0]).toContain('could not confirm it exists');
    expect(outcome.notices[0]).toContain(PLACEHOLDER);
  });
});

describe('makeSiblingClaimReader (#3361)', () => {
  it('a sibling listing rejecting with an unconvertible value answers an empty claim set', async () => {
    const debug = vi.fn();
    const read = makeSiblingClaimReader({
      stateBackend: {
        listStacks: () => Promise.reject(unconvertible()),
        getState: vi.fn(),
      },
      selfStackName: 'Me',
      selfRegion: REGION,
      logger: { debug },
    });

    await expect(read()).resolves.toEqual(new Set());
    const lines = debug.mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => l.includes('could not list sibling stacks'))).toEqual([
      expect.stringContaining(PLACEHOLDER),
    ]);
  });

  it('one sibling read rejecting unconvertibly is skipped and the next sibling still claims', async () => {
    // Each sibling's read is best-effort. Built with `String(error)`, the skip
    // line threw out of the loop and the claim scan rejected instead.
    const debug = vi.fn();
    const read = makeSiblingClaimReader({
      stateBackend: {
        listStacks: async () => [
          { stackName: 'Broken', region: REGION },
          { stackName: 'Other', region: REGION },
        ],
        getState: async (stackName: string) => {
          if (stackName === 'Broken') throw unconvertible();
          return { state: { resources: { Role: { physicalId: 'other-role' } } } };
        },
      },
      selfStackName: 'Me',
      selfRegion: REGION,
      logger: { debug },
    });

    await expect(read()).resolves.toEqual(new Set(['other-role']));
    const lines = debug.mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => l.includes('skipping unreadable state for'))).toEqual([
      expect.stringContaining(PLACEHOLDER),
    ]);
  });
});

describe('dropNestedChildJournals (#3361)', () => {
  it('a child state read rejecting unconvertibly warns and still deletes that child journal', async () => {
    // Documented "best-effort and never throws": the deploy that calls it
    // already succeeded. Its warning was built with `String(error)`, so the
    // catch threw, the sweep rejected, and the child's own journal delete
    // after it never ran.
    const deleted: string[] = [];
    const warn = vi.fn();
    const sweep = dropNestedChildJournals({
      stateBackend: {
        getState: () => Promise.reject(unconvertible()),
        deleteRollbackJournal: async (name: string) => {
          deleted.push(name);
        },
      } as never,
      lockManager: {
        acquireLockWithRetry: async () => true,
        releaseLock: async () => {},
      } as never,
      parentStackName: 'Root',
      region: REGION,
      resources: { Child: { resourceType: 'AWS::CloudFormation::Stack' } } as never,
      logger: { debug: vi.fn(), warn },
    });

    await expect(sweep).resolves.toBeUndefined();
    expect(deleted).toEqual(['Root~Child']);
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines).toEqual([expect.stringContaining(PLACEHOLDER)]);
    expect(lines[0]).toContain('Could not clear the rollback journal');
  });

  it('a child lock release rejecting unconvertibly warns and the sweep still resolves', async () => {
    const warn = vi.fn();
    const sweep = dropNestedChildJournals({
      stateBackend: {
        getState: async () => null,
        deleteRollbackJournal: async () => {},
      } as never,
      lockManager: {
        acquireLockWithRetry: async () => true,
        releaseLock: () => Promise.reject(unconvertible()),
      } as never,
      parentStackName: 'Root',
      region: REGION,
      resources: { Child: { resourceType: 'AWS::CloudFormation::Stack' } } as never,
      logger: { debug: vi.fn(), warn },
    });

    await expect(sweep).resolves.toBeUndefined();
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines).toEqual([expect.stringContaining(PLACEHOLDER)]);
    expect(lines[0]).toContain('Failed to release the lock of nested stack');
  });
});

describe('WorkGraph.execute (#3361)', () => {
  const node = (id: string, deps: string[] = []): WorkNode => ({
    id,
    type: 'stack',
    dependencies: new Set(deps),
    state: 'pending',
    data: undefined,
  });

  it('a node rejecting with an unconvertible value still settles execute with the failure summary', async () => {
    // The node chain is never awaited, so an out-throw in its `.catch` (or in
    // the summary built from the collected errors) became an unhandled
    // rejection and `execute()` never settled -- the dependent's skip and the
    // independent node's run were never reported.
    const graph = new WorkGraph();
    graph.addNode(node('Broken'));
    graph.addNode(node('Dependent', ['Broken']));
    graph.addNode(node('Independent'));
    const ran: string[] = [];

    await expect(
      graph.execute({ 'asset-build': 1, 'asset-publish': 1, stack: 2 }, async (n) => {
        ran.push(n.id);
        if (n.id === 'Broken') throw unconvertible();
      })
    ).rejects.toThrow(`1 node(s) failed, 1 skipped:\n  - Broken: ${PLACEHOLDER}`);
    expect(ran.sort()).toEqual(['Broken', 'Independent']);
  });
});

describe('probeStatefulRecreateTargetsAsync (#3361)', () => {
  const target = (overrides: Partial<RecreateTarget>): RecreateTarget => ({
    logicalId: 'Target',
    resourceType: 'AWS::S3::Bucket',
    physicalId: 'pid',
    statefulReason: null,
    direction: 'to-cc-api',
    ...overrides,
  });

  const logger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

  const rejecting = <T>(): T => ({ send: () => Promise.reject(unconvertible()) }) as unknown as T;

  it('an S3 probe rejecting unconvertibly keeps the fail-OPEN verdict and marks it unresolved', async () => {
    // The probe's contract is that it never throws. Its warning was built with
    // `String(e)`, so the catch threw and the whole recreate pre-flight
    // rejected instead of answering for every target.
    const log = logger();
    const out = await probeStatefulRecreateTargetsAsync(
      [target({ resourceType: 'AWS::S3::Bucket' })],
      {
        s3: rejecting<S3Client>(),
        cloudWatchLogs: rejecting<CloudWatchLogsClient>(),
        sleep: async () => {},
      },
      log as never
    );

    expect(out).toEqual([expect.objectContaining({ statefulReason: null, probeUnresolved: true })]);
    const lines = log.warn.mock.calls.map((c) => String(c[0]));
    expect(lines).toEqual([expect.stringContaining(`Underlying error: ${PLACEHOLDER}`)]);
    expect(lines[0]).toContain('live S3 probe failed');
  });

  it('a log-group probe rejecting unconvertibly fails CLOSED and warns', async () => {
    const log = logger();
    const out = await probeStatefulRecreateTargetsAsync(
      [target({ resourceType: 'AWS::Logs::LogGroup' })],
      {
        s3: rejecting<S3Client>(),
        cloudWatchLogs: rejecting<CloudWatchLogsClient>(),
        sleep: async () => {},
      },
      log as never
    );

    expect(out).toEqual([expect.objectContaining({ statefulReason: 'has-log-events' })]);
    const lines = log.warn.mock.calls.map((c) => String(c[0]));
    expect(lines).toEqual([expect.stringContaining(`Underlying error: ${PLACEHOLDER}`)]);
    expect(lines[0]).toContain('live CloudWatch Logs probe failed');
  });
});
