/**
 * go-to-k/cdkd#5487: the Glue trigger and crawler updates mark every key
 * their whole-resource call changes before it, and `Tags` before the tag
 * calls (from the tag plan). Unsettled Tags re-send the template's tags and
 * remove only recorded ones the template dropped; the trigger reports a key
 * still changing while it reads ACTIVATING / DEACTIVATING / CREATING /
 * UPDATING.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-glue', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-glue')>('@aws-sdk/client-glue');
  return {
    ...actual,
    GlueClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({ Account: '123456789012' }),
  })),
  GetCallerIdentityCommand: vi.fn(),
}));
vi.mock('../../../src/utils/logger.js', () => {
  const child = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
  child.child.mockReturnValue(child);
  return { getLogger: () => ({ ...child, child: () => child }) };
});

import { GlueCrawlerProvider, GlueTriggerProvider } from '../../../src/provisioning/providers/glue-provider.js';

function serve(live: { triggerState?: string; tags?: Record<string, string> }): void {
  mockSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
    switch (cmd.constructor.name) {
      case 'GetTriggerCommand':
        return {
          Trigger: {
            Name: 't',
            Type: 'ON_DEMAND',
            State: live.triggerState ?? 'CREATED',
            Actions: [{ JobName: 'j' }],
          },
        };
      case 'GetCrawlerCommand':
        return { Crawler: { Name: 'c', Role: 'arn:role', Targets: {} } };
      case 'GetTagsCommand':
        return { Tags: live.tags ?? {} };
      default:
        return {};
    }
  });
}

const sent = (name: string) =>
  mockSend.mock.calls.map((c) => c[0]).filter((c) => c.constructor.name === name);

const TRIGGER = { Name: 't', Type: 'ON_DEMAND', Actions: [{ JobName: 'j' }] };
const CRAWLER = { Name: 'c', Role: 'arn:role', Targets: {} };

describe('Glue unsettled properties (go-to-k/cdkd#5487)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('trigger: marks the changed keys before UpdateTrigger, and Tags before the tag calls', async () => {
    serve({});
    const marks: string[] = [];
    let updatesAtFirstMark: number | undefined;
    await new GlueTriggerProvider().update(
      'T',
      't',
      'AWS::Glue::Trigger',
      { ...TRIGGER, Description: 'b', Tags: { a: '1' } },
      { ...TRIGGER, Description: 'a' },
      {
        markUnsettled: (k: string) => {
          marks.push(k);
          updatesAtFirstMark ??= sent('UpdateTriggerCommand').length;
        },
      }
    );
    expect(marks).toEqual(['Description', 'Tags']);
    expect(updatesAtFirstMark).toBe(0);
  });

  it('crawler: marks the changed keys before UpdateCrawler, and nothing for equal bags', async () => {
    serve({});
    const marks: string[] = [];
    let updatesAtFirstMark: number | undefined;
    await new GlueCrawlerProvider().update(
      'C',
      'c',
      'AWS::Glue::Crawler',
      { ...CRAWLER, Description: 'b' },
      { ...CRAWLER, Description: 'a' },
      {
        markUnsettled: (k: string) => {
          marks.push(k);
          updatesAtFirstMark ??= sent('UpdateCrawlerCommand').length;
        },
      }
    );
    expect(marks).toEqual(['Description']);
    expect(updatesAtFirstMark).toBe(0);
    marks.length = 0;
    await new GlueCrawlerProvider().update('C', 'c', 'AWS::Glue::Crawler', { ...CRAWLER }, { ...CRAWLER }, {
      markUnsettled: (k: string) => marks.push(k),
    });
    expect(marks).toEqual([]);
  });

  it.each([
    ['trigger', () => new GlueTriggerProvider(), 'AWS::Glue::Trigger', TRIGGER],
    ['crawler', () => new GlueCrawlerProvider(), 'AWS::Glue::Crawler', CRAWLER],
  ] as const)('%s: unsettled Tags re-send the template tags and remove only recorded ones the template dropped', async (_l, make, type, props) => {
    serve({ tags: { operator: 'keep' } });
    const marks: string[] = [];
    await make().update('R', 'r', type, { ...props, Tags: { a: '1' } }, { ...props, Tags: { a: '1', gone: 'x' } }, {
      unsettledProperties: new Set(['Tags']),
      markUnsettled: (k: string) => marks.push(k),
    });
    expect(sent('TagResourceCommand').map((c) => c.input.TagsToAdd)).toEqual([{ a: '1' }]);
    expect(sent('UntagResourceCommand').map((c) => c.input.TagsToRemove)).toEqual([['gone']]);
    expect(marks).toContain('Tags');
    vi.clearAllMocks();
    serve({ tags: { operator: 'keep' } });
    marks.length = 0;
    await make().update('R', 'r', type, { ...props, Tags: { a: '1' } }, { ...props, Tags: { a: '1' } }, {
      markUnsettled: (k: string) => marks.push(k),
    });
    expect(sent('TagResourceCommand')).toHaveLength(0);
    expect(marks).not.toContain('Tags');
  });

  it('trigger unsettledInTransition: every key but Tags while ACTIVATING, none when settled, all on a failed read', async () => {
    const names = new Set(['Schedule', 'Tags']);
    const p = new GlueTriggerProvider();
    serve({ triggerState: 'ACTIVATING' });
    expect([...(await p.unsettledInTransition('t', 'T', 'AWS::Glue::Trigger', names))]).toEqual(['Schedule']);
    serve({ triggerState: 'ACTIVATED' });
    expect([...(await p.unsettledInTransition('t', 'T', 'AWS::Glue::Trigger', names))]).toEqual([]);
    mockSend.mockRejectedValue(new Error('throttled'));
    expect((await p.unsettledInTransition('t', 'T', 'AWS::Glue::Trigger', names)).size).toBe(2);
  });
});
