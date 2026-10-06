/**
 * The orphan-adoption pre-pass's `Adopting ... as <physicalId>` line masks a
 * physical name derived from a secret (go-to-k/cdkd#3869). It is logged before
 * provisioning binds any printing bag, so a resource a rollback kept (Retain)
 * whose name came from a secret printed its name when a later deploy
 * re-adopted it. The record still spells the name as its `{{resolve:`
 * reference, which is the evidence the judge reads.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const quiet = vi.hoisted(() => {
  const q = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    child: (): unknown => q,
  };
  return q;
});
vi.mock('../../../src/utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/logger.js')>();
  return { ...actual, logger: quiet, getLogger: () => quiet };
});

import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';

const REF = '{{resolve:secretsmanager:team:SecretString:queue::}}';
const NAME = 'team-secret-queue';
const URL = `https://sqs.us-east-1.amazonaws.com/123456789012/${NAME}`;

describe('the orphan-adoption line masks a name derived from a secret (go-to-k/cdkd#3869)', () => {
  beforeEach(() => quiet.info.mockClear());

  async function infoLines(opts: {
    type: string;
    nameKey: string;
    name: string;
    physicalId: string;
    /** The template no longer names it: the deploy generates the name. */
    templateDropsName?: boolean;
  }): Promise<string[]> {
    const provider = { import: vi.fn(async () => ({ physicalId: opts.physicalId })) };
    const engine = new DeployEngine(
      { getState: vi.fn(), listStacks: vi.fn().mockResolvedValue([]) } as unknown as never,
      {} as unknown as never,
      {} as unknown as never,
      {} as unknown as never,
      {
        getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' as const }),
      } as unknown as never,
      {},
      'us-east-1'
    );
    const state = {
      version: 9,
      stackName: 'MyStack',
      region: 'us-east-1',
      resources: {},
      outputs: {},
      orphans: [
        {
          logicalId: 'Kept',
          orphanedAt: 1,
          state: {
            physicalId: opts.physicalId,
            resourceType: opts.type,
            properties: { [opts.nameKey]: opts.name },
            deletionPolicy: 'Retain',
          },
        },
      ],
      lastModified: 1,
    } as StackState;
    await (
      engine as unknown as {
        adoptRollbackOrphans: (s: StackState, t: CloudFormationTemplate) => Promise<unknown>;
      }
    ).adoptRollbackOrphans(state, {
      Resources: {
        Kept: {
          Type: opts.type,
          Properties: opts.templateDropsName === true ? {} : { [opts.nameKey]: opts.name },
        },
      },
    } as unknown as CloudFormationTemplate);
    return quiet.info.mock.calls.map((c) => String(c[0]));
  }

  const BUCKET = 'team-secret-bucket';

  it.each([
    ['a record naming it by its reference', REF, false],
    ['negative control, a literal name', BUCKET, true],
  ])('on the Adopting line: %s', async (_l, name, shown) => {
    // The template dropped the explicit name, so the deploy would create it
    // under a name it generates and re-adopts the kept bucket; the record still
    // spells the name it was created under.
    const lines = (
      await infoLines({
        type: 'AWS::S3::Bucket',
        nameKey: 'BucketName',
        name,
        physicalId: BUCKET,
        templateDropsName: true,
      })
    ).filter((l) => l.startsWith('Adopting '));
    // Premise: the record was adopted and its line logged.
    expect(lines).toEqual([
      expect.stringContaining('Adopting Kept (AWS::S3::Bucket) left in AWS by an earlier rollback as '),
    ]);
    expect(lines[0]!.includes(BUCKET)).toBe(shown);
  });

  it.each([
    ['a record naming it by its reference', REF, false],
    ['negative control, a literal name', NAME, true],
  ])('on a notice about a record it leaves alone: %s', async (_l, name, shown) => {
    // A queue's id is its URL, which this deploy does not request by name, so
    // the record is left alone with a notice naming the id.
    const lines = (
      await infoLines({ type: 'AWS::SQS::Queue', nameKey: 'QueueName', name, physicalId: URL })
    ).filter((l) => l.includes('from an earlier rollback'));
    // Premise: the notice was logged.
    expect(lines).toEqual([expect.stringContaining('Kept (AWS::SQS::Queue) is still in AWS as ')]);
    expect(lines[0]!.includes(NAME)).toBe(shown);
  });
});
