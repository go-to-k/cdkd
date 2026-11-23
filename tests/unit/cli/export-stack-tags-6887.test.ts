/**
 * go-to-k/cdkd#6887: the stack tags (`StackProps.tags`) of a stack `cdkd export`
 * hands to CloudFormation. The CloudFormation stack the export creates gets the
 * manifest's stack tags, as `cdk deploy` passes them, by a tag-only update after
 * its last change set: an IMPORT change set creating a stack refuses stack tags
 * (measured us-east-1, 2026-11-24). The nested-tree wiring is fenced in
 * `export-nested-loop.test.ts`; this file fences the helpers and the
 * single-stack command path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { setStdinIsTty } from '../../stdin-tty.js';

const errorSpy = vi.hoisted(() => vi.fn());
const infoSpy = vi.hoisted(() => vi.fn());
const warnSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: infoSpy,
    warn: warnSpy,
    error: errorSpy,
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
  resolveApp: vi.fn(() => undefined),
  resolveUseCdkBootstrapAssets: vi.fn(() => false),
}));

const waiters = vi.hoisted(() => ({
  changeSetCreate: vi.fn(async () => undefined),
  stackImport: vi.fn(async () => undefined),
  stackUpdate: vi.fn(async () => undefined),
}));
vi.mock('@aws-sdk/client-cloudformation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aws-sdk/client-cloudformation')>()),
  waitUntilChangeSetCreateComplete: waiters.changeSetCreate,
  waitUntilStackImportComplete: waiters.stackImport,
  waitUntilStackUpdateComplete: waiters.stackUpdate,
}));

interface SentCommand {
  constructor: { name: string };
  input: Record<string, unknown>;
}
const cfnCalls = vi.hoisted(() => [] as { name: string; input: Record<string, unknown> }[]);
const updateStackResult = vi.hoisted(() => ({ fail: undefined as Error | undefined }));
const cfnSend = vi.hoisted(() =>
  vi.fn(async (cmd: SentCommand) => {
    cfnCalls.push({ name: cmd.constructor.name, input: cmd.input });
    if (cmd.constructor.name === 'DescribeStacksCommand') {
      throw new Error('Stack with id Exported does not exist');
    }
    if (cmd.constructor.name === 'UpdateStackCommand' && updateStackResult.fail) {
      throw updateStackResult.fail;
    }
    return {};
  })
);
vi.mock('../../../src/utils/aws-clients.ts', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({
    get s3() {
      return {};
    },
    get cloudFormation() {
      return { send: cfnSend };
    },
    get ssm() {
      return { send: vi.fn() };
    },
    get ec2() {
      return { send: vi.fn() };
    },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(() => ({ sts: { send: vi.fn() } })),
}));

const mockSynthesize = vi.hoisted(() => vi.fn());
vi.mock('../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn().mockImplementation(() => ({ synthesize: mockSynthesize })),
  synthesisStatusMessage: (_app: unknown, msg: string) => msg,
}));

const mockDeleteState = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    destroyClient: vi.fn(),
    verifyBucketExists: vi.fn(async () => undefined),
    listStacks: vi.fn(async () => [{ stackName: 'Exported', region: 'us-east-1' }]),
    getState: vi.fn(async () => ({
      state: {
        version: 9,
        stackName: 'Exported',
        region: 'us-east-1',
        resources: {
          MyBucket: {
            physicalId: 'my-bucket-phys',
            resourceType: 'AWS::S3::Bucket',
            properties: {},
            attributes: {},
            dependencies: [],
          },
        },
        outputs: {},
        lastModified: 1,
      },
      etag: 'e0',
    })),
    loadRollbackJournal: vi.fn(async () => null),
    deleteState: mockDeleteState,
    saveState: vi.fn(async () => 'etag-1'),
  })),
}));

vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    acquireLock: vi.fn(async () => true),
    getLockInfo: vi.fn(async () => null),
    releaseLock: vi.fn(async () => undefined),
  })),
}));

import { createExportCommand } from '../../../src/cli/commands/export.js';
import {
  applyExportedStackTags,
  flipStackToUpdateComplete,
} from '../../../src/cli/commands/export/changeset.js';
import { exportedStackTagsByStack } from '../../../src/cli/commands/export/exported-stack-tags.js';
import { readDeployedStackTags } from '../../../src/cli/commands/import/deployed-properties.js';

function client(send: (cmd: SentCommand) => Promise<unknown>) {
  return { send } as never;
}

describe('flipStackToUpdateComplete carries the stack tags (go-to-k/cdkd#6887)', () => {
  it('sends the stack tags before the flip tag: the update REPLACES the tag set', async () => {
    const sent: SentCommand[] = [];
    await flipStackToUpdateComplete(
      client(async (cmd) => {
        sent.push(cmd);
        return {};
      }),
      'Child',
      [],
      { team: 'core', own: 'row' }
    );

    const tags = sent[0]!.input['Tags'] as { Key: string; Value: string }[];
    expect(tags.slice(0, 2)).toEqual([
      { Key: 'team', Value: 'core' },
      { Key: 'own', Value: 'row' },
    ]);
    expect(tags).toHaveLength(3);
    expect(tags[2]!.Key).toBe('cdkd:nested-export-flip');
  });
});

describe('applyExportedStackTags (go-to-k/cdkd#6887)', () => {
  beforeEach(() => {
    warnSpy.mockReset();
    waiters.stackUpdate.mockClear();
  });

  it.each([
    ['no stack tags', undefined],
    ['an empty map', {}],
  ])('makes no call for %s', async (_label, tags) => {
    const send = vi.fn(async () => ({}));
    await applyExportedStackTags(client(send), 'S', [], tags);
    expect(send).not.toHaveBeenCalled();
  });

  it('sets them with a tag-only update re-supplying the parameters, awaited', async () => {
    const sent: SentCommand[] = [];
    await applyExportedStackTags(
      client(async (cmd) => {
        sent.push(cmd);
        return {};
      }),
      'S',
      [{ ParameterKey: 'P', ParameterValue: 'v' }],
      { team: 'core' }
    );

    expect(sent.map((c) => c.constructor.name)).toEqual(['UpdateStackCommand']);
    expect(sent[0]!.input).toEqual({
      StackName: 'S',
      UsePreviousTemplate: true,
      Parameters: [{ ParameterKey: 'P', ParameterValue: 'v' }],
      Tags: [{ Key: 'team', Value: 'core' }],
      Capabilities: ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND'],
    });
    expect(waiters.stackUpdate).toHaveBeenCalledTimes(1);
  });

  it('WARNS and returns when the update fails: the export itself completed', async () => {
    await expect(
      applyExportedStackTags(
        client(async () => {
          throw new Error('AccessDenied: not allowed');
        }),
        'S',
        [],
        { team: 'core' }
      )
    ).resolves.toBeUndefined();

    const warned = warnSpy.mock.calls.flat().join('\n');
    expect(warned).toContain("The stack tags of CloudFormation stack 'S' were not set");
    expect(warned).toContain('AccessDenied: not allowed');
  });
});

describe('exportedStackTagsByStack (go-to-k/cdkd#6887)', () => {
  const row = (tags?: unknown) => ({
    Type: 'AWS::CloudFormation::Stack',
    Properties: { TemplateURL: 'u', ...(tags !== undefined && { Tags: tags }) },
  });

  it("gives each descendant its parent's tags with its row's own winning", () => {
    const warn = vi.fn();
    const result = exportedStackTagsByStack(
      [
        {
          cdkdName: 'R~M~G',
          template: { Resources: {} },
          nestedStackRows: [],
        },
        {
          cdkdName: 'R~M',
          template: { Resources: { G: row([{ Key: 'g', Value: '1' }]) } },
          nestedStackRows: [{ logicalId: 'G', childStackName: 'R~M~G' }],
        },
        {
          cdkdName: 'R',
          template: { Resources: { M: row([{ Key: 'team', Value: 'mid' }]) } },
          nestedStackRows: [{ logicalId: 'M', childStackName: 'R~M' }],
        },
      ],
      'R',
      { team: 'root', a: 'b' },
      warn
    );

    expect(result.get('R')).toEqual({ team: 'root', a: 'b' });
    expect(result.get('R~M')).toEqual({ team: 'mid', a: 'b' });
    expect(result.get('R~M~G')).toEqual({ team: 'mid', a: 'b', g: '1' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('gives every stack an empty map when nothing carries tags', () => {
    const result = exportedStackTagsByStack(
      [
        { cdkdName: 'R~C', template: { Resources: {} }, nestedStackRows: [] },
        {
          cdkdName: 'R',
          template: { Resources: { C: row() } },
          nestedStackRows: [{ logicalId: 'C', childStackName: 'R~C' }],
        },
      ],
      'R',
      undefined,
      vi.fn()
    );
    expect(result.get('R')).toEqual({});
    expect(result.get('R~C')).toEqual({});
  });

  it("warns on a non-literal row Tags and gives its child the parent's tags alone", () => {
    const warn = vi.fn();
    const result = exportedStackTagsByStack(
      [
        { cdkdName: 'R~C', template: { Resources: {} }, nestedStackRows: [] },
        {
          cdkdName: 'R',
          template: { Resources: { C: row([{ Key: 'k', Value: { Ref: 'P' } }]) } },
          nestedStackRows: [{ logicalId: 'C', childStackName: 'R~C' }],
        },
      ],
      'R',
      { team: 'root' },
      warn
    );
    expect(result.get('R~C')).toEqual({ team: 'root' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain(
      "The Tags of nested stack row C in 'R' are not literal"
    );
  });
});

describe('readDeployedStackTags (go-to-k/cdkd#6887)', () => {
  it("reads the named stack's tags, dropping CloudFormation's own aws: keys", async () => {
    const sent: SentCommand[] = [];
    const tags = await readDeployedStackTags(
      client(async (cmd) => {
        sent.push(cmd);
        return {
          Stacks: [
            {
              Tags: [
                { Key: 'team', Value: 'core' },
                { Key: 'aws:cloudformation:stack-name', Value: 'S' },
                { Key: 'blank' },
              ],
            },
          ],
        };
      }),
      'arn:aws:cloudformation:x',
      'NOTHING WRITTEN.'
    );

    expect(sent[0]!.constructor.name).toBe('DescribeStacksCommand');
    expect(sent[0]!.input).toEqual({ StackName: 'arn:aws:cloudformation:x' });
    expect(tags).toEqual({ team: 'core' });
  });

  it('reads a stack without tags as none', async () => {
    await expect(
      readDeployedStackTags(client(async () => ({ Stacks: [{}] })), 'S', 'NOTHING WRITTEN.')
    ).resolves.toEqual({});
  });

  it.each([
    ['a failed call', async () => Promise.reject(new Error('Throttling: slow down'))],
    ['no stack returned', async () => ({ Stacks: [] })],
  ])('refuses %s, ending in the caller\'s consequence', async (_label, send) => {
    const thrown = await readDeployedStackTags(client(send), 'S', 'NOTHING WRITTEN.').catch(
      (err: unknown) => err as Error
    );
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(
      /^--migrate-from-cloudformation: reading the stack tags of the CloudFormation stack failed: .* NOTHING WRITTEN\.$/
    );
  });
});

describe('cdkd export gives the CloudFormation stack its stack tags (go-to-k/cdkd#6887)', () => {
  let originalIsTTY: boolean | undefined;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    cfnCalls.length = 0;
    updateStackResult.fail = undefined;
    errorSpy.mockReset();
    warnSpy.mockReset();
    mockDeleteState.mockClear();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit-mock');
    }) as never);
    originalIsTTY = process.stdin.isTTY;
    setStdinIsTty(true);
  });
  afterEach(() => {
    exitSpy.mockRestore();
    setStdinIsTty(originalIsTTY);
  });

  function synthesize(tags: Record<string, string> | undefined): void {
    mockSynthesize.mockResolvedValue({
      stacks: [
        {
          stackName: 'Exported',
          displayName: 'Exported',
          artifactId: 'Exported',
          template: {
            Resources: { MyBucket: { Type: 'AWS::S3::Bucket', Properties: {} } },
          },
          dependencyNames: [],
          region: 'us-east-1',
          ...(tags !== undefined && { tags }),
        },
      ],
    });
  }

  async function runExport(): Promise<void> {
    const cmd = createExportCommand();
    cmd.exitOverride();
    await cmd
      .parseAsync(
        [
          'Exported',
          '--app',
          'x',
          '--state-bucket',
          'test-bucket',
          '--stack-region',
          'us-east-1',
          '--skip-import-support-preflight',
          '-y',
        ],
        { from: 'user' }
      )
      .catch((e: unknown) => {
        if (!(e instanceof Error) || e.message !== 'process.exit-mock') throw e;
      });
    expect(errorSpy.mock.calls.map((c) => String(c[0])).join('\n')).toBe('');
  }

  it('sets the manifest stack tags after the IMPORT change set, which carries none', async () => {
    synthesize({ team: 'core' });

    await runExport();

    const names = cfnCalls.map((c) => c.name);
    const create = cfnCalls.find((c) => c.name === 'CreateChangeSetCommand')!;
    expect(create.input['ChangeSetType']).toBe('IMPORT');
    expect(create.input['Tags']).toBeUndefined();
    const update = cfnCalls.find((c) => c.name === 'UpdateStackCommand')!;
    expect(update.input).toMatchObject({
      StackName: 'Exported',
      UsePreviousTemplate: true,
      Tags: [{ Key: 'team', Value: 'core' }],
    });
    expect(names.indexOf('UpdateStackCommand')).toBeGreaterThan(
      names.indexOf('ExecuteChangeSetCommand')
    );
    expect(mockDeleteState).toHaveBeenCalled();
  });

  it('makes no tag update for a stack without stack tags', async () => {
    synthesize(undefined);

    await runExport();

    expect(cfnCalls.map((c) => c.name)).toContain('ExecuteChangeSetCommand');
    expect(cfnCalls.map((c) => c.name)).not.toContain('UpdateStackCommand');
  });

  it('still completes the export, WARNED, when the tag update fails', async () => {
    synthesize({ team: 'core' });
    updateStackResult.fail = new Error('AccessDenied: no UpdateStack');

    await runExport();

    expect(warnSpy.mock.calls.flat().join('\n')).toContain(
      "The stack tags of CloudFormation stack 'Exported' were not set"
    );
    expect(mockDeleteState).toHaveBeenCalled();
  });
});
