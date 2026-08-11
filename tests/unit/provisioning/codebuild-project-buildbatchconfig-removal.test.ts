import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { UpdateProjectCommand, CreateProjectCommand } from '@aws-sdk/client-codebuild';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-codebuild', async () => {
  const actual = await vi.importActual('@aws-sdk/client-codebuild');
  return {
    ...actual,
    CodeBuildClient: vi.fn().mockImplementation(() => ({
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

import { CodeBuildProvider } from '../../../src/provisioning/providers/codebuild-provider.js';

const PROJECT = 'my-project';
const TYPE = 'AWS::CodeBuild::Project';

/** The minimum a CodeBuild project template needs to map cleanly. */
const BASE = {
  ServiceRole: 'arn:aws:iam::0:role/build',
  Artifacts: { Type: 'NO_ARTIFACTS' },
  Environment: {
    Type: 'LINUX_CONTAINER',
    ComputeType: 'BUILD_GENERAL1_SMALL',
    Image: 'aws/codebuild/standard:7.0',
  },
  Source: { Type: 'NO_SOURCE', BuildSpec: 'version: 0.2' },
};

const BATCH_CONFIG = {
  ServiceRole: 'arn:aws:iam::0:role/batch',
  TimeoutInMins: 120,
  CombineArtifacts: true,
};

/**
 * The single UpdateProject input of the update.
 *
 * Asserts exactly ONE was sent: a `.find` would silently hide a second
 * UpdateProject, and returning `undefined` when none was sent would make
 * every `toBeUndefined()` assertion below — including the CFn-parity
 * retention pins — pass vacuously against an implementation that stops
 * issuing the call at all.
 */
function updateProjectInput(): Record<string, unknown> {
  const calls = mockSend.mock.calls.filter((c) => c[0] instanceof UpdateProjectCommand);
  expect(calls).toHaveLength(1);
  return calls[0]![0].input as Record<string, unknown>;
}

/** The single CreateProject input of the create, or undefined. */
function createProjectInput(): Record<string, unknown> | undefined {
  const call = mockSend.mock.calls.find((c) => c[0] instanceof CreateProjectCommand);
  return call?.[0].input as Record<string, unknown> | undefined;
}

describe('CodeBuildProvider BuildBatchConfig removal reset (issue #1160)', () => {
  let provider: CodeBuildProvider;

  beforeEach(() => {
    // clearAllMocks (NOT resetAllMocks) — reset would wipe the module-mock
    // client constructor's implementation and every send would explode.
    vi.clearAllMocks();
    mockSend.mockResolvedValue({ project: { name: PROJECT, arn: `arn:aws:codebuild:::${PROJECT}` } });
    provider = new CodeBuildProvider();
  });

  // ─── The #1157-pattern trio ──────────────────────────────────────────

  it('removed: dropping BuildBatchConfig sends an EMPTY object, the only shape that clears it', async () => {
    const previous = { ...BASE, BuildBatchConfig: BATCH_CONFIG };
    const desired = { ...BASE };

    await provider.update('P', PROJECT, TYPE, desired, previous);

    // Live CFn A/B 2026-08-10: a real CFn removal update left the project
    // reporting `buildBatchConfig: null`, and `--build-batch-config '{}'`
    // is what reproduced that. An OMITTED field is the merge-semantics
    // no-op this issue tracks, so `{}` — not `undefined` — is required.
    const batch = updateProjectInput()['buildBatchConfig'] as Record<string, unknown> | undefined;
    expect(batch).toBeDefined();
    // Every member undefined => the SDK serializes the empty object AWS
    // needs; asserting the members individually pins that nothing from the
    // previous side leaked back in.
    expect(batch?.['serviceRole']).toBeUndefined();
    expect(batch?.['timeoutInMins']).toBeUndefined();
    expect(batch?.['combineArtifacts']).toBeUndefined();
    expect(batch?.['batchReportMode']).toBeUndefined();
    expect(batch?.['restrictions']).toBeUndefined();
  });

  it('never-present: no BuildBatchConfig on either side sends undefined (no reset)', async () => {
    const props = { ...BASE };

    await provider.update('P', PROJECT, TYPE, props, props);

    expect(updateProjectInput()['buildBatchConfig']).toBeUndefined();
  });

  it('kept: a desired BuildBatchConfig passes through with its members mapped', async () => {
    const previous = { ...BASE, BuildBatchConfig: BATCH_CONFIG };
    const desired = {
      ...BASE,
      BuildBatchConfig: { ...BATCH_CONFIG, TimeoutInMins: 240, BatchReportMode: 'REPORT_INDIVIDUAL_BUILDS' },
    };

    await provider.update('P', PROJECT, TYPE, desired, previous);

    expect(updateProjectInput()['buildBatchConfig']).toMatchObject({
      serviceRole: 'arn:aws:iam::0:role/batch',
      timeoutInMins: 240,
      combineArtifacts: true,
      batchReportMode: 'REPORT_INDIVIDUAL_BUILDS',
    });
  });

  // ─── The reset must not leak onto CREATE ─────────────────────────────

  it('create: an absent BuildBatchConfig stays absent (the reset is update-only)', async () => {
    // `{}` on create would declare an empty batch config on a project that
    // never asked for one — the reset exists to mirror a CFn REMOVAL, and
    // a create has no previous side to have removed anything from.
    await provider.create('P', TYPE, { ...BASE });

    expect(createProjectInput()?.['buildBatchConfig']).toBeUndefined();
  });

  // ─── CFn-parity retention pins (live A/B 2026-08-10) ────────────────
  //
  // CloudFormation RETAINS the other seven optional fields on removal:
  // Description / TimeoutInMinutes / QueuedTimeoutInMinutes /
  // ConcurrentBuildLimit / AutoRetryLimit / Cache / LogsConfig all kept
  // their customized values through a real CFn removal update, because
  // CFn's own handler omits them from UpdateProject and CodeBuild merges.
  // cdkd's pass-through is therefore PARITY, not a bug. These pins make a
  // future "reset them too" change a conscious decision requiring a fresh
  // CFn A/B — each of those fields HAS a working clear sentinel (`''`, 60,
  // 480, -1, 0, `NO_CACHE`, cloudWatchLogs ENABLED), so the reset would be
  // easy to write and wrong.
  it('parity: removing the OTHER seven optional fields sends undefined (CFn retains them)', async () => {
    const previous = {
      ...BASE,
      Description: 'a description',
      TimeoutInMinutes: 25,
      QueuedTimeoutInMinutes: 100,
      ConcurrentBuildLimit: 2,
      AutoRetryLimit: 3,
      Cache: { Type: 'LOCAL', Modes: ['LOCAL_CUSTOM_CACHE'] },
      LogsConfig: { CloudWatchLogs: { Status: 'DISABLED' } },
    };
    const desired = { ...BASE };

    await provider.update('P', PROJECT, TYPE, desired, previous);

    const input = updateProjectInput();
    expect(input?.['description']).toBeUndefined();
    expect(input?.['timeoutInMinutes']).toBeUndefined();
    expect(input?.['queuedTimeoutInMinutes']).toBeUndefined();
    expect(input?.['concurrentBuildLimit']).toBeUndefined();
    expect(input?.['autoRetryLimit']).toBeUndefined();
    expect(input?.['cache']).toBeUndefined();
    expect(input?.['logsConfig']).toBeUndefined();
  });

  it('positive polarity: the seven retained fields DO map through when present', async () => {
    // The retention pins above are negative-only assertions on string keys,
    // so a rename or typo in the SDK member name would vacuate them while
    // still "passing". This asserts the same seven keys carry their values
    // on the normal update path, which is what makes those pins meaningful.
    const previous = { ...BASE };
    const desired = {
      ...BASE,
      Description: 'a description',
      TimeoutInMinutes: 25,
      QueuedTimeoutInMinutes: 100,
      ConcurrentBuildLimit: 2,
      AutoRetryLimit: 3,
      Cache: { Type: 'LOCAL', Modes: ['LOCAL_CUSTOM_CACHE'] },
      LogsConfig: { CloudWatchLogs: { Status: 'DISABLED' } },
      BuildBatchConfig: { ...BATCH_CONFIG, Restrictions: { MaximumBuildsAllowed: 7 } },
    };

    await provider.update('P', PROJECT, TYPE, desired, previous);

    const input = updateProjectInput();
    expect(input['description']).toBe('a description');
    expect(input['timeoutInMinutes']).toBe(25);
    expect(input['queuedTimeoutInMinutes']).toBe(100);
    expect(input['concurrentBuildLimit']).toBe(2);
    expect(input['autoRetryLimit']).toBe(3);
    expect(input['cache']).toMatchObject({ type: 'LOCAL', modes: ['LOCAL_CUSTOM_CACHE'] });
    expect(input['logsConfig']).toMatchObject({ cloudWatchLogs: { status: 'DISABLED' } });
    // `restrictions` has no other positive write-side test in the repo, so
    // the removal suite's reference to it would otherwise assert nothing.
    expect(input['buildBatchConfig']).toMatchObject({
      restrictions: { maximumBuildsAllowed: 7 },
    });
  });

  it('rollback replay: reverting to a state without the block clears it', async () => {
    // `rollback-executor.ts` replays with the HISTORICAL bag as the desired
    // side. A failed deploy that ADDED a batch config must have it cleared
    // on the way back, not silently kept.
    const historical = { ...BASE };
    const attempted = { ...BASE, BuildBatchConfig: BATCH_CONFIG };

    await provider.update('P', PROJECT, TYPE, historical, attempted);

    expect(updateProjectInput()['buildBatchConfig']).toBeDefined();
    expect(updateProjectInput()['buildBatchConfig']).toMatchObject({});
  });

  it('the update still targets the existing project by physical id', async () => {
    const previous = { ...BASE, BuildBatchConfig: BATCH_CONFIG };

    await provider.update('P', PROJECT, TYPE, { ...BASE }, previous);

    expect(updateProjectInput()['name']).toBe(PROJECT);
  });
});
