/**
 * Issue #1815: the two Glue ARN builders — `GlueWorkflowProvider`'s workflow
 * ARN and the shared `buildGlueResourceArn` behind Job / Crawler / Trigger —
 * derive the partition from the Glue client's region instead of hardcoding
 * `arn:aws:`. The ARN is the `GetTags` target of every drift read and the
 * `TagResource` / `UntagResource` target of every tag update, so in `aws-cn` /
 * `aws-us-gov` a commercial literal aimed both at an ARN naming no resource.
 *
 * Each case asserts the WHOLE ARN handed to AWS, and the commercial row is the
 * exact pre-fix string, so commercial output is pinned byte-identical.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  GetCrawlerCommand,
  GetJobCommand,
  GetTagsCommand,
  GetTriggerCommand,
  GetWorkflowCommand,
  TagResourceCommand,
  UntagResourceCommand,
} from '@aws-sdk/client-glue';

const mockSend = vi.fn();
let clientRegion = 'us-east-1';

vi.mock('@aws-sdk/client-glue', async () => {
  const actual =
    await vi.importActual<typeof import('@aws-sdk/client-glue')>('@aws-sdk/client-glue');
  return {
    ...actual,
    GlueClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve(clientRegion) },
    })),
  };
});

vi.mock('@aws-sdk/client-sts', () => {
  return {
    STSClient: vi.fn().mockImplementation(() => ({
      send: vi.fn().mockResolvedValue({ Account: '123456789012' }),
    })),
    GetCallerIdentityCommand: vi.fn(),
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

import {
  GlueCrawlerProvider,
  GlueJobProvider,
  GlueTriggerProvider,
  GlueWorkflowProvider,
} from '../../../src/provisioning/providers/glue-provider.js';

const REGIONS: ReadonlyArray<{ region: string; partition: string }> = [
  { region: 'us-east-1', partition: 'aws' },
  { region: 'cn-north-1', partition: 'aws-cn' },
  { region: 'us-gov-west-1', partition: 'aws-us-gov' },
];

function answerReads(): void {
  mockSend.mockImplementation((cmd: unknown) => {
    if (cmd instanceof GetWorkflowCommand) return Promise.resolve({ Workflow: { Name: 'my-wf' } });
    if (cmd instanceof GetJobCommand) return Promise.resolve({ Job: { Name: 'my-job' } });
    if (cmd instanceof GetCrawlerCommand) {
      return Promise.resolve({ Crawler: { Name: 'my-crawler' } });
    }
    if (cmd instanceof GetTriggerCommand) {
      return Promise.resolve({ Trigger: { Name: 'my-trigger', State: 'DEACTIVATED' } });
    }
    if (cmd instanceof GetTagsCommand) return Promise.resolve({ Tags: {} });
    return Promise.resolve({});
  });
}

function getTagsArns(): unknown[] {
  return mockSend.mock.calls
    .filter((c) => c[0] instanceof GetTagsCommand)
    .map((c) => (c[0] as GetTagsCommand).input.ResourceArn);
}

describe('Glue ARN builders derive the partition from the client region (issue #1815)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    answerReads();
  });

  describe.each(REGIONS)('$region', ({ region, partition }) => {
    beforeEach(() => {
      clientRegion = region;
    });

    it('workflow readCurrentState() aims GetTags at the partition-correct workflow ARN', async () => {
      await new GlueWorkflowProvider().readCurrentState('my-wf', 'L', 'AWS::Glue::Workflow');
      expect(getTagsArns()).toEqual([
        `arn:${partition}:glue:${region}:123456789012:workflow/my-wf`,
      ]);
    });

    it.each([
      { name: 'Job', make: () => new GlueJobProvider(), type: 'AWS::Glue::Job', id: 'my-job', seg: 'job' },
      {
        name: 'Crawler',
        make: () => new GlueCrawlerProvider(),
        type: 'AWS::Glue::Crawler',
        id: 'my-crawler',
        seg: 'crawler',
      },
      {
        name: 'Trigger',
        make: () => new GlueTriggerProvider(),
        type: 'AWS::Glue::Trigger',
        id: 'my-trigger',
        seg: 'trigger',
      },
    ])('$name readCurrentState() aims GetTags at the partition-correct ARN', async (c) => {
      await c.make().readCurrentState(c.id, 'L', c.type);
      expect(getTagsArns()).toEqual([`arn:${partition}:glue:${region}:123456789012:${c.seg}/${c.id}`]);
    });

    it('Job update() aims TagResource / UntagResource at the partition-correct ARN', async () => {
      await new GlueJobProvider().update(
        'L',
        'my-job',
        'AWS::Glue::Job',
        { Name: 'my-job', Tags: [{ Key: 'env', Value: 'prod' }] },
        { Tags: [{ Key: 'old', Value: 'x' }] }
      );
      const expected = `arn:${partition}:glue:${region}:123456789012:job/my-job`;
      const add = mockSend.mock.calls.find((c) => c[0] instanceof TagResourceCommand);
      const remove = mockSend.mock.calls.find((c) => c[0] instanceof UntagResourceCommand);
      expect(add?.[0].input.ResourceArn).toBe(expected);
      expect(remove?.[0].input.ResourceArn).toBe(expected);
    });
  });

  it('keeps the commercial ARN byte-identical to the pre-#1815 literal', async () => {
    clientRegion = 'us-east-1';
    await new GlueWorkflowProvider().readCurrentState('my-wf', 'L', 'AWS::Glue::Workflow');
    await new GlueJobProvider().readCurrentState('my-job', 'L', 'AWS::Glue::Job');
    expect(getTagsArns()).toEqual([
      'arn:aws:glue:us-east-1:123456789012:workflow/my-wf',
      'arn:aws:glue:us-east-1:123456789012:job/my-job',
    ]);
  });
});
