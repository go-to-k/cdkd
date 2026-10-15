/**
 * `CloudControlProvider.resumeAbandonedRequest` (go-to-k/cdkd#3252): re-poll a
 * CREATE an earlier run stopped waiting for and say how it ended, without
 * sending any write.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const mockCloudControlSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudControl: {
      send: mockCloudControlSend,
      config: { region: () => Promise.resolve('us-east-1') },
    },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => {
    const child = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(() => child),
    };
    return { child: () => child, debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  },
}));

import {
  CloudControlProvider,
  CloudControlWaitAbandonedError,
} from '../../../src/provisioning/cloud-control-provider.js';
import {
  abandonedRequestOf,
  isWaitAbandonedError,
} from '../../../src/provisioning/wait-abandoned.js';

const TOKEN = 'tok-3252';

function event(status: string, extra: Record<string, unknown> = {}): unknown {
  return {
    ProgressEvent: {
      OperationStatus: status,
      Operation: 'CREATE',
      TypeName: 'AWS::Logs::LogGroup',
      RequestToken: TOKEN,
      ...extra,
    },
  };
}

function commandNames(): string[] {
  return mockCloudControlSend.mock.calls.map(
    (c) => (c[0] as { constructor: { name: string } }).constructor.name
  );
}

describe('CloudControlProvider.resumeAbandonedRequest (#3252)', () => {
  let provider: CloudControlProvider;
  let now: number;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new CloudControlProvider();
    now = 1_780_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.spyOn(
      provider as unknown as { sleep: (ms: number) => Promise<void> },
      'sleep'
    ).mockImplementation((ms: number) => {
      now += ms;
      return Promise.resolve();
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports the Identifier of a create that already succeeded, with one status read', async () => {
    mockCloudControlSend.mockResolvedValueOnce(event('SUCCESS', { Identifier: 'my-log-group' }));
    await expect(
      provider.resumeAbandonedRequest(TOKEN, 'Logs', 'AWS::Logs::LogGroup')
    ).resolves.toEqual({ status: 'succeeded', identifier: 'my-log-group' });
    expect(commandNames()).toEqual(['GetResourceRequestStatusCommand']);
    expect(mockCloudControlSend.mock.calls[0]![0].input).toEqual({ RequestToken: TOKEN });
  });

  it('waits on a create still in progress, re-polling the SAME token, never re-creating', async () => {
    mockCloudControlSend
      .mockResolvedValueOnce(event('IN_PROGRESS'))
      .mockResolvedValueOnce(event('IN_PROGRESS'))
      .mockResolvedValueOnce(event('SUCCESS', { Identifier: 'made' }));
    await expect(
      provider.resumeAbandonedRequest(TOKEN, 'Logs', 'AWS::Logs::LogGroup')
    ).resolves.toEqual({ status: 'succeeded', identifier: 'made' });
    expect(new Set(commandNames())).toEqual(new Set(['GetResourceRequestStatusCommand']));
    for (const call of mockCloudControlSend.mock.calls) {
      expect(call[0].input).toEqual({ RequestToken: TOKEN });
    }
  });

  it('a FAILED create that named a remnant reports it; AlreadyExists / ResourceConflict do not', async () => {
    mockCloudControlSend.mockResolvedValueOnce(
      event('FAILED', { Identifier: 'half-made', ErrorCode: 'InternalFailure' })
    );
    await expect(
      provider.resumeAbandonedRequest(TOKEN, 'Logs', 'AWS::Logs::LogGroup')
    ).resolves.toEqual({ status: 'failed', remnant: 'half-made' });

    for (const code of ['AlreadyExists', 'ResourceConflict']) {
      mockCloudControlSend.mockResolvedValueOnce(
        event('FAILED', { Identifier: 'someone-elses', ErrorCode: code })
      );
      await expect(
        provider.resumeAbandonedRequest(TOKEN, 'Logs', 'AWS::Logs::LogGroup')
      ).resolves.toEqual({ status: 'failed' });
    }
  });

  it('a create that fails while being waited on reports its remnant the same way', async () => {
    mockCloudControlSend
      .mockResolvedValueOnce(event('IN_PROGRESS'))
      .mockResolvedValueOnce(
        event('FAILED', { Identifier: 'half-made', ErrorCode: 'InternalFailure' })
      );
    await expect(
      provider.resumeAbandonedRequest(TOKEN, 'Logs', 'AWS::Logs::LogGroup')
    ).resolves.toEqual({ status: 'failed', remnant: 'half-made' });
  });

  it('a cancelled create reports cancelled, read directly or after a wait', async () => {
    mockCloudControlSend.mockResolvedValueOnce(event('CANCEL_COMPLETE'));
    await expect(
      provider.resumeAbandonedRequest(TOKEN, 'Logs', 'AWS::Logs::LogGroup')
    ).resolves.toEqual({ status: 'cancelled' });
    mockCloudControlSend
      .mockResolvedValueOnce(event('CANCEL_IN_PROGRESS'))
      .mockResolvedValueOnce(event('CANCEL_COMPLETE'));
    await expect(
      provider.resumeAbandonedRequest(TOKEN, 'Logs', 'AWS::Logs::LogGroup')
    ).resolves.toEqual({ status: 'cancelled' });
  });

  it('a cancelled create that left its resource names it, read directly or after a wait', async () => {
    mockCloudControlSend.mockResolvedValueOnce(event('CANCEL_COMPLETE', { Identifier: 'half' }));
    await expect(
      provider.resumeAbandonedRequest(TOKEN, 'Logs', 'AWS::Logs::LogGroup')
    ).resolves.toEqual({ status: 'cancelled', remnant: 'half' });
    mockCloudControlSend
      .mockResolvedValueOnce(event('PENDING'))
      .mockResolvedValueOnce(event('CANCEL_COMPLETE', { Identifier: 'half' }));
    await expect(
      provider.resumeAbandonedRequest(TOKEN, 'Logs', 'AWS::Logs::LogGroup')
    ).resolves.toEqual({ status: 'cancelled', remnant: 'half' });
  });

  it('Ctrl-C while waiting stops the run instead of reading as unknown', async () => {
    const { InterruptedWaitError } = await import('../../../src/provisioning/interrupt-watch.js');
    mockCloudControlSend.mockResolvedValueOnce(event('IN_PROGRESS'));
    const interrupted = new InterruptedWaitError('interrupted');
    vi.spyOn(
      provider as unknown as { waitForOperation: () => Promise<unknown> },
      'waitForOperation'
    ).mockRejectedValueOnce(interrupted);
    await expect(
      provider.resumeAbandonedRequest(TOKEN, 'Logs', 'AWS::Logs::LogGroup')
    ).rejects.toBe(interrupted);
  });

  it('RequestTokenNotFoundException is not-found; any other read failure is unresolved', async () => {
    mockCloudControlSend.mockRejectedValueOnce(
      Object.assign(new Error('Request with token tok-3252 was not found'), {
        name: 'RequestTokenNotFoundException',
      })
    );
    await expect(
      provider.resumeAbandonedRequest(TOKEN, 'Logs', 'AWS::Logs::LogGroup')
    ).resolves.toEqual({ status: 'not-found' });

    const denied = Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' });
    mockCloudControlSend.mockRejectedValueOnce(denied);
    await expect(
      provider.resumeAbandonedRequest(TOKEN, 'Logs', 'AWS::Logs::LogGroup')
    ).resolves.toEqual({ status: 'unresolved', error: denied });
  });

  it('a create still running past the poll budget is unresolved, not a guess', async () => {
    mockCloudControlSend.mockResolvedValue(event('IN_PROGRESS'));
    const outcome = await provider.resumeAbandonedRequest(TOKEN, 'Logs', 'AWS::Logs::LogGroup');
    expect(outcome.status).toBe('unresolved');
    expect((outcome as { error: unknown }).error).toBeInstanceOf(CloudControlWaitAbandonedError);
  });

  it('a SUCCESS event without an Identifier is unresolved: there is nothing to record', async () => {
    mockCloudControlSend.mockResolvedValueOnce(event('SUCCESS'));
    const outcome = await provider.resumeAbandonedRequest(TOKEN, 'Logs', 'AWS::Logs::LogGroup');
    expect(outcome.status).toBe('unresolved');
  });
});

describe('CloudControlProvider.resumeAbandonedRequest: request identity (#3252)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('a request of another type, or not a CREATE, is unresolved: it is not the one journaled', async () => {
    const provider = new CloudControlProvider();
    mockCloudControlSend.mockResolvedValueOnce(
      event('SUCCESS', { TypeName: 'AWS::SNS::Topic', Identifier: 'x' })
    );
    expect(
      (await provider.resumeAbandonedRequest(TOKEN, 'Logs', 'AWS::Logs::LogGroup')).status
    ).toBe('unresolved');
    mockCloudControlSend.mockResolvedValueOnce(
      event('SUCCESS', { Operation: 'DELETE', Identifier: 'x' })
    );
    expect(
      (await provider.resumeAbandonedRequest(TOKEN, 'Logs', 'AWS::Logs::LogGroup')).status
    ).toBe('unresolved');
  });
});

describe('CloudControlProvider.resumeCreatedResource (#3252)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('builds the create result from a GetResource read of the identifier, sending no write', async () => {
    const provider = new CloudControlProvider();
    mockCloudControlSend.mockResolvedValue({
      ResourceDescription: {
        Identifier: 'my-group',
        Properties: JSON.stringify({
          LogGroupName: 'my-group',
          Arn: 'arn:aws:logs:us-east-1:123456789012:log-group:my-group:*',
        }),
      },
    });
    const result = await provider.resumeCreatedResource(
      'Logs',
      'AWS::Logs::LogGroup',
      'my-group',
      { LogGroupName: 'my-group' }
    );
    expect(result.physicalId).toBe('my-group');
    expect(result.attributes).toMatchObject({
      Arn: 'arn:aws:logs:us-east-1:123456789012:log-group:my-group:*',
    });
    expect(new Set(commandNames())).toEqual(new Set(['GetResourceCommand']));
  });

  it('marks a resource that is GONE, so the caller creates as usual', async () => {
    const provider = new CloudControlProvider();
    mockCloudControlSend.mockRejectedValue(
      Object.assign(new Error('gone'), { name: 'ResourceNotFoundException' })
    );
    await expect(
      provider.resumeCreatedResource('Logs', 'AWS::Logs::LogGroup', 'my-group', {})
    ).rejects.toMatchObject({ resumedResourceGone: true });
  });

  it('any other read failure is NOT marked gone: the resource may still stand', async () => {
    const provider = new CloudControlProvider();
    const throttled = Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
    mockCloudControlSend.mockRejectedValue(throttled);
    const error = await provider
      .resumeCreatedResource('Logs', 'AWS::Logs::LogGroup', 'my-group', {})
      .catch((e: unknown) => e);
    expect(error).toBe(throttled);
    expect((error as { resumedResourceGone?: unknown }).resumedResourceGone).toBeUndefined();
  });
});

describe('the abandoned-wait marker carries the request (#3252)', () => {
  it('CloudControlWaitAbandonedError exposes its token and operation through the leaf reader', () => {
    const error = new CloudControlWaitAbandonedError(
      'msg',
      'AWS::Logs::LogGroup',
      'Logs',
      TOKEN,
      'CREATE',
      undefined
    );
    expect(isWaitAbandonedError(error)).toBe(true);
    expect(abandonedRequestOf(error)).toEqual({ requestToken: TOKEN, operation: 'CREATE' });
    // Read through a wrapper's cause chain, as the deploy engine receives it.
    expect(abandonedRequestOf(new Error('wrapped', { cause: error }))).toEqual({
      requestToken: TOKEN,
      operation: 'CREATE',
    });
  });

  it('an error with no request carries none', () => {
    expect(abandonedRequestOf(new Error('plain'))).toBeUndefined();
  });
});
