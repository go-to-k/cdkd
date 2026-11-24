/**
 * go-to-k/cdkd#6659: a project created without a `logsConfig` reads back with
 * no `S3Logs.EncryptionDisabled`, and with `false` after `drift --revert`
 * re-sent the recorded `LogsConfig`. The pair canonicalizer compares that
 * absent / `false` pair as equal, and only that pair.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-codebuild', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-codebuild')>(
    '@aws-sdk/client-codebuild'
  );
  return {
    ...actual,
    CodeBuildClient: vi.fn(() => ({
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

import { CodeBuildProvider } from '../../../src/provisioning/providers/codebuild-provider.js';
import { calculateResourceDrift } from '../../../src/analyzer/drift-calculator.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';

const TYPE = 'AWS::CodeBuild::Project';
const PATH = 'LogsConfig.S3Logs.EncryptionDisabled';

/** A `BatchGetProjects` project as the secrets-array-nested fixture's reads it. */
function project(s3Logs: Record<string, unknown>): Record<string, unknown> {
  return {
    name: 'cdkd-test-array-drift-123456789012',
    arn: 'arn:aws:codebuild:us-east-1:123456789012:project/cdkd-test-array-drift-123456789012',
    source: {
      type: 'NO_SOURCE',
      buildspec: '{"version":"0.2","phases":{"build":{"commands":["true"]}}}',
      insecureSsl: false,
    },
    secondarySources: [],
    secondarySourceVersions: [],
    artifacts: { type: 'NO_ARTIFACTS' },
    secondaryArtifacts: [],
    cache: { type: 'NO_CACHE' },
    environment: {
      type: 'LINUX_CONTAINER',
      image: 'aws/codebuild/amazonlinux2-x86_64-standard:5.0',
      computeType: 'BUILD_GENERAL1_SMALL',
      environmentVariables: [
        { name: 'DB_PASSWORD', value: 'resolved-pw', type: 'PLAINTEXT' },
        { name: 'MODE', value: 'production', type: 'PLAINTEXT' },
      ],
      privilegedMode: false,
      imagePullCredentialsType: 'CODEBUILD',
    },
    serviceRole: 'arn:aws:iam::123456789012:role/cdkd-test-array-drift-123456789012',
    timeoutInMinutes: 60,
    queuedTimeoutInMinutes: 480,
    encryptionKey: 'arn:aws:kms:us-east-1:123456789012:alias/aws/s3',
    tags: [],
    created: new Date('2026-11-20T00:00:00Z'),
    lastModified: new Date('2026-11-20T00:10:00Z'),
    badge: { badgeEnabled: false },
    logsConfig: { cloudWatchLogs: { status: 'ENABLED' }, s3Logs },
    projectVisibility: 'PRIVATE',
  };
}

describe('CodeBuild LogsConfig.S3Logs.EncryptionDisabled drift (go-to-k/cdkd#6659)', () => {
  let provider: CodeBuildProvider;

  beforeEach(() => {
    mockSend.mockReset();
    provider = new CodeBuildProvider();
  });

  async function read(s3Logs: Record<string, unknown>): Promise<Record<string, unknown>> {
    mockSend.mockResolvedValueOnce({ projects: [project(s3Logs)] });
    const bag = await provider.readCurrentState('cdkd-test-array-drift-123456789012', 'P', TYPE);
    expect(bag).not.toBe(RESOURCE_NOT_FOUND);
    return bag as Record<string, unknown>;
  }

  /** Detection's comparison on an observed baseline: the pair pass, then the union walk. */
  async function driftPaths(
    baseline: Record<string, unknown>,
    aws: Record<string, unknown>,
    useObserved = true
  ): Promise<string[]> {
    const paired = await provider.canonicalizeDriftPair(TYPE, baseline, aws);
    return calculateResourceDrift(paired.baseline, paired.aws, {
      ignorePaths: provider.getDriftUnknownPaths(),
      unionWalkObjects: useObserved,
    }).map((d) => d.path);
  }

  it("the fixture's sequence: a baseline seeded before the revert matches the read after it", async () => {
    // `--accept` seeds the baseline from this read; the revert's UpdateProject
    // then makes AWS report `encryptionDisabled: false`.
    const seeded = await read({ status: 'DISABLED' });
    const afterRevert = await read({ status: 'DISABLED', encryptionDisabled: false });
    expect((seeded['LogsConfig'] as { S3Logs: Record<string, unknown> }).S3Logs).toEqual({
      Status: 'DISABLED',
    });
    expect((afterRevert['LogsConfig'] as { S3Logs: Record<string, unknown> }).S3Logs).toEqual({
      Status: 'DISABLED',
      EncryptionDisabled: false,
    });

    // Without the pair pass this is the reported `undefined -> false`.
    expect(
      calculateResourceDrift(seeded, afterRevert, { unionWalkObjects: true }).map((d) => d.path)
    ).toEqual([PATH]);
    expect(await driftPaths(seeded, afterRevert)).toEqual([]);
    // And a baseline that holds `false` against a read that omits it.
    expect(await driftPaths(afterRevert, seeded)).toEqual([]);
  });

  it('the revert sends the completed `false`, so it does not re-send an omitted value', async () => {
    const seeded = await read({ status: 'DISABLED' });
    const afterRevert = await read({ status: 'DISABLED', encryptionDisabled: false });
    const { baseline } = await provider.canonicalizeDriftPair(TYPE, seeded, afterRevert);
    const input = provider.mapProperties(() => 'n', baseline);
    expect(input.logsConfig?.s3Logs).toEqual({
      status: 'DISABLED',
      location: undefined,
      encryptionDisabled: false,
    });
  });

  it('still reports a real change of the setting, in both directions', async () => {
    const absent = await read({ status: 'DISABLED' });
    const off = await read({ status: 'DISABLED', encryptionDisabled: false });
    const on = await read({ status: 'DISABLED', encryptionDisabled: true });

    // Live turned to `true` out of band.
    expect(await driftPaths(absent, on)).toEqual([PATH]);
    expect(await driftPaths(off, on)).toEqual([PATH]);
    // Recorded `true`, live back at the default, read either way.
    expect(await driftPaths(on, off)).toEqual([PATH]);
    expect(await driftPaths(on, absent)).toEqual([PATH]);
    // The same on a template baseline that declares the setting.
    const declared = (value: boolean) => ({
      LogsConfig: { S3Logs: { Status: 'DISABLED', EncryptionDisabled: value } },
    });
    expect(await driftPaths(declared(false), on, false)).toEqual([PATH]);
    expect(await driftPaths(declared(true), off, false)).toEqual([PATH]);
    expect(await driftPaths(declared(true), absent, false)).toEqual([PATH]);
    expect(await driftPaths(declared(false), absent, false)).toEqual([]);
  });

  it('reports the change with the values each side holds', async () => {
    const absent = await read({ status: 'DISABLED' });
    const on = await read({ status: 'DISABLED', encryptionDisabled: true });
    const paired = await provider.canonicalizeDriftPair(TYPE, absent, on);
    const [change] = calculateResourceDrift(paired.baseline, paired.aws, {
      unionWalkObjects: true,
    });
    expect(change).toMatchObject({ path: PATH, stateValue: undefined, awsValue: true });
  });

  it('is identity where nothing applies, and never mutates its inputs', async () => {
    const absent = await read({ status: 'DISABLED' });
    const off = await read({ status: 'DISABLED', encryptionDisabled: false });
    const on = await read({ status: 'DISABLED', encryptionDisabled: true });
    const template = { Name: 'n', Environment: {} };
    const frozen = JSON.stringify([absent, off, on]);

    for (const [baseline, aws] of [
      [absent, absent],
      [off, off],
      [absent, on],
      [on, off],
      [template, off],
      [off, template],
    ] as const) {
      const out = await provider.canonicalizeDriftPair(TYPE, baseline, aws);
      expect(out.baseline).toBe(baseline);
      expect(out.aws).toBe(aws);
    }
    const otherType = await provider.canonicalizeDriftPair('AWS::Other::Thing', absent, off);
    expect(otherType.baseline).toBe(absent);
    expect(otherType.aws).toBe(off);

    await provider.canonicalizeDriftPair(TYPE, absent, off);
    await provider.canonicalizeDriftPair(TYPE, off, absent);
    expect(JSON.stringify([absent, off, on])).toBe(frozen);
  });
});
