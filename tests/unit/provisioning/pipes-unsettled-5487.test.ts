/**
 * go-to-k/cdkd#5487: the Pipes `update()` marks every key `UpdatePipe`
 * changes before the call (its settle wait can fail with the change accepted)
 * and `Tags` before the tag calls, re-sends unsettled Tags without removing a
 * tag it never recorded, and reports a key as unsettled while the pipe is in
 * any state but RUNNING / STOPPED.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));
vi.mock('@aws-sdk/client-pipes', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-pipes')>('@aws-sdk/client-pipes');
  return {
    ...actual,
    PipesClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});
vi.mock('../../../src/utils/logger.js', () => {
  const child = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
  child.child.mockReturnValue(child);
  return { getLogger: () => ({ ...child, child: () => child }) };
});

import { PipesPipeProvider } from '../../../src/provisioning/providers/pipes-provider.js';

const TYPE = 'AWS::Pipes::Pipe';
const BASE = { Name: 'p', Source: 'arn:src', Target: 'arn:tgt', RoleArn: 'arn:role' };

function serve(live: { description?: string; state?: string; tags?: Record<string, string> }): void {
  mockSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
    switch (cmd.constructor.name) {
      case 'DescribePipeCommand':
        return {
          Name: 'p',
          Arn: 'arn:aws:pipes:us-east-1:123456789012:pipe/p',
          Source: BASE.Source,
          Target: BASE.Target,
          RoleArn: BASE.RoleArn,
          Description: live.description,
          DesiredState: 'RUNNING',
          CurrentState: live.state ?? 'RUNNING',
          LastModifiedTime: new Date(2_000),
          Tags: live.tags ?? {},
        };
      case 'UpdatePipeCommand':
        return { LastModifiedTime: new Date(1_000) };
      default:
        return {};
    }
  });
}

const sent = (name: string) =>
  mockSend.mock.calls.map((c) => c[0]).filter((c) => c.constructor.name === name);

function provider(): PipesPipeProvider {
  let clock = 0;
  return new PipesPipeProvider({
    sleep: async (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  });
}

describe('Pipes unsettled properties (go-to-k/cdkd#5487)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('marks every changed key before UpdatePipe, and Tags before the tag calls', async () => {
    serve({});
    const marks: string[] = [];
    let updatesAtFirstMark: number | undefined;
    await provider().update(
      'P',
      'p',
      TYPE,
      { ...BASE, Description: 'b', Tags: { a: '1' } },
      { ...BASE, Description: 'a' },
      {
        markUnsettled: (k: string) => {
          marks.push(k);
          updatesAtFirstMark ??= sent('UpdatePipeCommand').length;
        },
      }
    );
    expect(marks).toEqual(['Description', 'Tags']);
    expect(updatesAtFirstMark).toBe(0);
  });

  it('marks nothing when nothing is sent', async () => {
    serve({});
    const marks: string[] = [];
    await provider().update('P', 'p', TYPE, { ...BASE }, { ...BASE }, {
      markUnsettled: (k: string) => marks.push(k),
    });
    expect(marks).toEqual([]);
    expect(sent('UpdatePipeCommand')).toHaveLength(0);
  });

  it('unsettled Tags re-send every template tag and remove only recorded tags the template dropped', async () => {
    serve({ tags: { operator: 'keep' } });
    await provider().update(
      'P',
      'p',
      TYPE,
      { ...BASE, Tags: { a: '1' } },
      { ...BASE, Tags: { a: '1', gone: 'x' } },
      { unsettledProperties: new Set(['Tags']) }
    );
    expect(sent('TagResourceCommand').map((c) => c.input.tags)).toEqual([{ a: '1' }]);
    expect(sent('UntagResourceCommand').map((c) => c.input.tagKeys)).toEqual([['gone']]);
  });

  it('settled Tags equal in the bags send no tag call', async () => {
    serve({ tags: { operator: 'keep' } });
    await provider().update('P', 'p', TYPE, { ...BASE, Tags: { a: '1' } }, { ...BASE, Tags: { a: '1' } });
    expect(sent('TagResourceCommand')).toHaveLength(0);
    expect(sent('UntagResourceCommand')).toHaveLength(0);
  });

  it('unsettledInTransition: every key but Tags while UPDATING or failed, none when RUNNING, all on a failed read', async () => {
    const names = new Set(['Description', 'Tags']);
    serve({ state: 'UPDATING' });
    expect([...(await provider().unsettledInTransition('p', 'P', TYPE, names))]).toEqual(['Description']);
    serve({ state: 'RUNNING' });
    expect([...(await provider().unsettledInTransition('p', 'P', TYPE, names))]).toEqual([]);
    // A failed transition never reached the template's value: not settled.
    serve({ state: 'UPDATE_FAILED' });
    expect([...(await provider().unsettledInTransition('p', 'P', TYPE, names))]).toEqual(['Description']);
    mockSend.mockRejectedValue(new Error('throttled'));
    expect((await provider().unsettledInTransition('p', 'P', TYPE, names)).size).toBe(2);
  });
});
