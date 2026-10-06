import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.fn();
const mockRegion = vi.fn(() => Promise.resolve('us-east-1'));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sqs: { send: mockSend, config: { region: () => mockRegion() } },
  }),
}));

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

import { GetQueueAttributesCommand, SetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import {
  SQSQueuePolicyProvider,
  WRITTEN_QUEUES_KEY,
} from '../../../src/provisioning/providers/sqs-queue-policy-provider.js';
import { classifyRollbackOp } from '../../../src/deployment/rollback-executor/plan.js';
import type { CompletedOperation } from '../../../src/deployment/rollback-executor/types.js';
import type { ResourceState } from '../../../src/types/state.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';
import { getLogger } from '../../../src/utils/logger.js';

const warn = getLogger().child('SQSQueuePolicyProvider').warn as ReturnType<typeof vi.fn>;
function warnings(): string[] {
  return warn.mock.calls.map((c) => String(c[0]));
}

const TYPE = 'AWS::SQS::QueuePolicy';
const Q1 = 'https://sqs.us-east-1.amazonaws.com/123456789012/queue-1';
const Q2 = 'https://sqs.us-east-1.amazonaws.com/123456789012/queue-2';
const Q3 = 'https://sqs.us-east-1.amazonaws.com/123456789012/queue-3';
const DOC = { Version: '2012-10-17', Statement: [{ Effect: 'Allow' }] };
const DOC_JSON = JSON.stringify(DOC);

/** Every SetQueueAttributes sent, as `[QueueUrl, Policy]`. */
function setCalls(): Array<[unknown, unknown]> {
  return mockSend.mock.calls.filter((c) => c[0] instanceof SetQueueAttributesCommand).map((c) => {
    const input = (c[0] as { input: { QueueUrl?: unknown; Attributes?: { Policy?: unknown } } })
      .input;
    return [input.QueueUrl, input.Attributes?.Policy];
  });
}

const OTHER_JSON = JSON.stringify({ Version: '2012-10-17', Statement: [{ Sid: 'OtherWriter' }] });
const NEW_DOC = { Version: '2012-10-17', Statement: [{ Sid: 'New' }] };
const NEW_JSON = JSON.stringify(NEW_DOC);

/** The record attributes a create / update of `queues` returns. */
function written(...queues: string[]): Record<string, unknown> {
  return { [WRITTEN_QUEUES_KEY]: queues.join(',') };
}

function getReads(): unknown[] {
  return mockSend.mock.calls
    .filter((c) => c[0] instanceof GetQueueAttributesCommand)
    .map((c) => (c[0] as GetQueueAttributesCommand).input.QueueUrl);
}

/**
 * Answer GetQueueAttributes from `policies` (a URL absent from it has no
 * policy; `'gone'` / `'denied'` throw) and every SetQueueAttributes with {}.
 */
function routeAws(policies: Record<string, string>): void {
  mockSend.mockImplementation((command: { input: { QueueUrl?: string } }) => {
    if (command instanceof GetQueueAttributesCommand) {
      const policy = policies[command.input.QueueUrl ?? ''];
      if (policy === 'gone') return Promise.reject(goneError());
      if (policy === 'denied') {
        return Promise.reject(Object.assign(new Error('denied'), { name: 'AccessDenied' }));
      }
      return Promise.resolve({ Attributes: policy === undefined ? {} : { Policy: policy } });
    }
    return Promise.resolve({});
  });
}

function goneError(): Error {
  return Object.assign(new Error('The specified queue does not exist'), {
    name: 'QueueDoesNotExist',
  });
}

const provider = (): SQSQueuePolicyProvider => new SQSQueuePolicyProvider();

describe('SQSQueuePolicyProvider records the written set beside a stable id (#4594)', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockResolvedValue({});
  });

  it('create keeps the first queue as the id and records every written queue', async () => {
    const result = await provider().create('P', TYPE, { Queues: [Q1, Q2], PolicyDocument: DOC });
    expect(result).toEqual({ physicalId: Q1, attributes: written(Q1, Q2) });
  });

  it('an update that keeps the first queue keeps the id, so rollback reverts it in place', async () => {
    for (const [prevQueues, nextQueues] of [
      [[Q1, Q2], [Q1]],
      [[Q1], [Q1, Q2]],
    ] as const) {
      mockSend.mockClear();
      const prevState: ResourceState = {
        physicalId: Q1,
        resourceType: TYPE,
        properties: { Queues: [...prevQueues], PolicyDocument: DOC },
        attributes: written(...prevQueues),
      };
      const result = await provider().update(
        'P',
        Q1,
        TYPE,
        { Queues: [...nextQueues], PolicyDocument: NEW_DOC },
        prevState.properties!,
        { recordedAttributes: prevState.attributes }
      );
      expect(result.physicalId).toBe(Q1);
      expect(result.attributes).toEqual(written(...nextQueues));
      const op: CompletedOperation = {
        logicalId: 'P',
        changeType: 'UPDATE',
        resourceType: TYPE,
        previousState: prevState,
        physicalId: result.physicalId,
        properties: { Queues: [...nextQueues], PolicyDocument: NEW_DOC },
      };
      const current: ResourceState = {
        physicalId: result.physicalId,
        resourceType: TYPE,
        properties: op.properties!,
        attributes: result.attributes!,
      };
      expect(classifyRollbackOp(op, { P: current }, new Set())).toBe('revert');
    }
  });

  it("the rollback revert of a grow clears only the queue the grow added", async () => {
    // The revert arm: desired = the previous record, previous = the current one.
    await provider().update(
      'P',
      Q1,
      TYPE,
      { Queues: [Q1], PolicyDocument: DOC },
      { Queues: [Q1, Q2], PolicyDocument: NEW_DOC },
      { recordedAttributes: written(Q1, Q2), replayingState: true }
    );
    expect(setCalls()).toEqual([
      [Q1, DOC_JSON],
      [Q2, ''],
    ]);
    expect(getReads()).toEqual([]);
  });
});

describe('SQSQueuePolicyProvider update clears the queues the new list drops (#4594)', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockRegion.mockClear();
    warn.mockClear();
  });

  it('writes the new list, then clears a recorded queue the new list drops, reading nothing', async () => {
    mockSend.mockResolvedValue({});
    const result = await provider().update(
      'P',
      Q1,
      TYPE,
      { Queues: [Q1], PolicyDocument: DOC },
      { Queues: [Q1, Q2], PolicyDocument: DOC },
      { recordedAttributes: written(Q1, Q2) }
    );
    expect(setCalls()).toEqual([
      [Q1, DOC_JSON],
      [Q2, ''],
    ]);
    expect(getReads()).toEqual([]);
    expect(result).toEqual({ physicalId: Q1, wasReplaced: false, attributes: written(Q1) });
  });

  it('clears the old first queue when the new list replaces it', async () => {
    mockSend.mockResolvedValue({});
    const result = await provider().update(
      'P',
      Q1,
      TYPE,
      { Queues: [Q2, Q3], PolicyDocument: DOC },
      { Queues: [Q1, Q2], PolicyDocument: DOC },
      { recordedAttributes: written(Q1, Q2) }
    );
    expect(setCalls()).toEqual([
      [Q2, DOC_JSON],
      [Q3, DOC_JSON],
      [Q1, ''],
    ]);
    expect(result.physicalId).toBe(Q2);
  });

  it('clears nothing when the list is unchanged', async () => {
    mockSend.mockResolvedValue({});
    await provider().update(
      'P',
      Q1,
      TYPE,
      { Queues: [Q1, Q2], PolicyDocument: NEW_DOC },
      { Queues: [Q1, Q2], PolicyDocument: DOC },
      { recordedAttributes: written(Q1, Q2) }
    );
    expect(setCalls()).toEqual([
      [Q1, NEW_JSON],
      [Q2, NEW_JSON],
    ]);
  });

  it('a record written before #4594 (no attribute) clears a dropped queue only while it carries the recorded document', async () => {
    routeAws({ [Q1]: DOC_JSON, [Q2]: DOC_JSON, [Q3]: OTHER_JSON });
    await provider().update(
      'P',
      Q1,
      TYPE,
      { Queues: [Q1], PolicyDocument: NEW_DOC },
      { Queues: [Q1, Q2, Q3], PolicyDocument: DOC },
      { recordedAttributes: {} }
    );
    expect(setCalls()).toEqual([
      [Q1, NEW_JSON],
      [Q2, ''],
    ]);
    // Read before any write.
    const firstSet = mockSend.mock.calls.findIndex((c) => c[0] instanceof SetQueueAttributesCommand);
    const lastGet = mockSend.mock.calls.findLastIndex(
      (c) => c[0] instanceof GetQueueAttributesCommand
    );
    expect(lastGet).toBeLessThan(firstSet);
  });

  it("a pre-#4594 record's first update never clears a queue the new list keeps", async () => {
    routeAws({ [Q1]: DOC_JSON, [Q2]: DOC_JSON });
    await provider().update(
      'P',
      Q1,
      TYPE,
      { Queues: [Q1, Q2], PolicyDocument: NEW_DOC },
      { Queues: [Q1, Q2], PolicyDocument: DOC },
      { recordedAttributes: {} }
    );
    expect(setCalls()).toEqual([
      [Q1, NEW_JSON],
      [Q2, NEW_JSON],
    ]);
  });

  it('never takes the id queue live policy as a reference', async () => {
    // Q1 and Q2 both carry another writer's policy; the recorded document is
    // on neither, so Q2 is not this resource's to clear.
    routeAws({ [Q1]: OTHER_JSON, [Q2]: OTHER_JSON });
    await provider().update(
      'P',
      Q1,
      TYPE,
      { Queues: [Q1], PolicyDocument: DOC },
      { Queues: [Q1, Q2], PolicyDocument: DOC }
    );
    expect(setCalls()).toEqual([[Q1, DOC_JSON]]);
  });

  it('a retry after the id queue was rewritten still clears a queue carrying the recorded document', async () => {
    routeAws({ [Q1]: NEW_JSON, [Q2]: DOC_JSON });
    await provider().update(
      'P',
      Q1,
      TYPE,
      { Queues: [Q1], PolicyDocument: NEW_DOC },
      { Queues: [Q1, Q2], PolicyDocument: DOC }
    );
    expect(setCalls()).toEqual([
      [Q1, NEW_JSON],
      [Q2, ''],
    ]);
  });

  it('--revert-failed of a failed update clears an attempted queue the attempt wrote', async () => {
    // The revert passes the ATTEMPTED bag as previousProperties; X got the
    // attempted document before the update failed, so it is this resource's.
    routeAws({ [Q2]: NEW_JSON });
    await provider().update(
      'P',
      Q1,
      TYPE,
      { Queues: [Q1], PolicyDocument: DOC },
      { Queues: [Q1, Q2], PolicyDocument: NEW_DOC },
      { recordedAttributes: written(Q1), replayingState: true }
    );
    expect(setCalls()).toEqual([
      [Q1, DOC_JSON],
      [Q2, ''],
    ]);
  });

  it('--revert-failed of a failed update never clears an attempted queue another writer holds', async () => {
    routeAws({ [Q2]: OTHER_JSON });
    await provider().update(
      'P',
      Q1,
      TYPE,
      { Queues: [Q1], PolicyDocument: DOC },
      { Queues: [Q1, Q2], PolicyDocument: NEW_DOC },
      { recordedAttributes: written(Q1), replayingState: true }
    );
    expect(setCalls()).toEqual([[Q1, DOC_JSON]]);
  });

  it('a listed queue is matched by content wherever it sits in the list', async () => {
    // A pre-#4594 record whose id is not Queues[0]: Q1 still carries the document.
    routeAws({ [Q1]: DOC_JSON, [Q2]: DOC_JSON });
    await provider().update(
      'P',
      Q2,
      TYPE,
      { Queues: [Q2], PolicyDocument: DOC },
      { Queues: [Q1, Q2], PolicyDocument: DOC }
    );
    expect(setCalls()).toEqual([
      [Q2, DOC_JSON],
      [Q1, ''],
    ]);
  });

  it('ignores a written-set attribute holding a non-URL entry (redacted state)', async () => {
    routeAws({ [Q2]: OTHER_JSON });
    await provider().update(
      'P',
      Q1,
      TYPE,
      { Queues: [Q1], PolicyDocument: DOC },
      { Queues: [Q1, Q2], PolicyDocument: DOC },
      {
        recordedAttributes: {
          [WRITTEN_QUEUES_KEY]: `${Q1},https://sqs.us-east-1.amazonaws.com/123456789012/***`,
        },
      }
    );
    // Falls back to the content check: Q2 carries another policy, so stays.
    expect(setCalls()).toEqual([[Q1, DOC_JSON]]);
  });

  it('widens nothing, and names the unchecked queues, when the bag holds no document', async () => {
    routeAws({ [Q2]: DOC_JSON });
    await provider().update(
      'P',
      Q1,
      TYPE,
      { Queues: [Q1], PolicyDocument: DOC },
      { Queues: [Q1, Q2] }
    );
    expect(setCalls()).toEqual([[Q1, DOC_JSON]]);
    expect(getReads()).toEqual([]);
    expect(warnings()).toEqual([
      expect.stringContaining(`The queues ${Q2} listed by P were not checked (no policy document recorded`),
    ]);
  });

  it('leaves an unreadable queue alone, naming it, rather than failing the update', async () => {
    routeAws({ [Q2]: 'denied', [Q3]: DOC_JSON });
    await provider().update(
      'P',
      Q1,
      TYPE,
      { Queues: [Q1], PolicyDocument: DOC },
      { Queues: [Q1, Q2, Q3], PolicyDocument: DOC }
    );
    expect(setCalls()).toEqual([
      [Q1, DOC_JSON],
      [Q3, ''],
    ]);
    expect(warnings()).toEqual([
      expect.stringContaining(`Could not read the policy of queue ${Q2} (AccessDenied)`),
    ]);
  });

  it('ignores non-string and non-URL entries and reads a duplicate entry once', async () => {
    routeAws({ [Q2]: DOC_JSON });
    await provider().update(
      'P',
      Q1,
      TYPE,
      { Queues: [Q1], PolicyDocument: DOC },
      { Queues: [Q1, { Ref: 'Other' }, 'not-a-queue-url', Q2, Q2], PolicyDocument: DOC }
    );
    expect(setCalls()).toEqual([
      [Q1, DOC_JSON],
      [Q2, ''],
    ]);
    expect(getReads()).toEqual([Q2]);
  });

  it('tolerates a dropped queue that is already gone', async () => {
    mockSend.mockResolvedValueOnce({}); // Q1 write
    mockSend.mockRejectedValueOnce(goneError()); // Q2 clear
    await expect(
      provider().update(
        'P',
        Q1,
        TYPE,
        { Queues: [Q1], PolicyDocument: DOC },
        { Queues: [Q1, Q2], PolicyDocument: DOC },
        { expectedRegion: 'us-east-1', recordedAttributes: written(Q1, Q2) }
      )
    ).resolves.toMatchObject({ physicalId: Q1 });
  });

  it('refuses a gone dropped queue in another region, worded as an update', async () => {
    mockRegion.mockImplementationOnce(() => Promise.resolve('eu-west-1'));
    mockSend.mockResolvedValueOnce({});
    mockSend.mockRejectedValueOnce(goneError());
    const error = await provider()
      .update(
        'P',
        Q1,
        TYPE,
        { Queues: [Q1], PolicyDocument: DOC },
        { Queues: [Q1, Q2], PolicyDocument: DOC },
        { expectedRegion: 'us-east-1', recordedAttributes: written(Q1, Q2) }
      )
      .then(
        () => undefined,
        (e: unknown) => e as Error
      );
    expect(error?.message).toMatch(/^Refusing to update P \(AWS::SQS::QueuePolicy\)/);
    expect(error?.message).toContain('us-east-1');
    expect(error?.message).not.toMatch(/Failed to update|idempotent delete/);
  });

  it('fails the update when clearing a dropped queue fails otherwise', async () => {
    mockSend.mockResolvedValueOnce({});
    mockSend.mockRejectedValueOnce(new Error('AccessDenied: not authorized'));
    await expect(
      provider().update(
        'P',
        Q1,
        TYPE,
        { Queues: [Q1], PolicyDocument: DOC },
        { Queues: [Q1, Q2], PolicyDocument: DOC },
        { recordedAttributes: written(Q1, Q2) }
      )
    ).rejects.toThrow(/Failed to update SQS queue policy P: AccessDenied/);
  });
});

describe('SQSQueuePolicyProvider delete clears every queue the record wrote (#4594)', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockRegion.mockClear();
    warn.mockClear();
  });

  it('clears the id and every queue of the written-set attribute, reading nothing', async () => {
    mockSend.mockResolvedValue({});
    await provider().delete(
      'P',
      Q1,
      TYPE,
      { Queues: [Q1, Q2], PolicyDocument: DOC },
      { recordedAttributes: written(Q1, Q2) }
    );
    expect(setCalls()).toEqual([
      [Q1, ''],
      [Q2, ''],
    ]);
    expect(getReads()).toEqual([]);
  });

  it('a failed create mark clears exactly its comma-joined queues, reading nothing', async () => {
    mockSend.mockResolvedValue({});
    await provider().delete('P', `${Q1},${Q2}`, TYPE, {
      Queues: [Q1, Q2, Q3],
      PolicyDocument: DOC,
    });
    expect(setCalls()).toEqual([
      [Q1, ''],
      [Q2, ''],
    ]);
    expect(getReads()).toEqual([]);
  });

  it('a one-queue mark leaves attempted queues alone even when the id queue carries the document', async () => {
    // The attempt wrote Q1 only; Q2 / Q3 hold another policy or none.
    routeAws({ [Q1]: DOC_JSON, [Q2]: OTHER_JSON });
    await provider().delete('P', Q1, TYPE, { Queues: [Q1, Q2, Q3], PolicyDocument: DOC });
    expect(setCalls()).toEqual([[Q1, '']]);
  });

  it('a record written before #4594 clears the listed queues carrying its document, before the id queue', async () => {
    routeAws({ [Q1]: DOC_JSON, [Q2]: DOC_JSON, [Q3]: DOC_JSON });
    await provider().delete(
      'P',
      Q1,
      TYPE,
      { Queues: [Q1, Q2, Q3], PolicyDocument: DOC },
      { recordedAttributes: {} }
    );
    expect(setCalls()).toEqual([
      [Q2, ''],
      [Q3, ''],
      [Q1, ''],
    ]);
  });

  it('a retry after the id queue was cleared still clears a listed queue carrying the document', async () => {
    routeAws({ [Q2]: DOC_JSON });
    await provider().delete('P', Q1, TYPE, { Queues: [Q1, Q2], PolicyDocument: DOC });
    expect(setCalls()).toEqual([
      [Q2, ''],
      [Q1, ''],
    ]);
  });

  it('never clears a listed queue carrying another policy, or none', async () => {
    routeAws({ [Q1]: DOC_JSON, [Q2]: OTHER_JSON });
    await provider().delete('P', Q1, TYPE, { Queues: [Q1, Q2, Q3], PolicyDocument: DOC });
    expect(setCalls()).toEqual([[Q1, '']]);
  });

  it('matches by content: key order aside, a string-form document, never a reordered array or an extra __proto__', async () => {
    const recordedDoc = { Version: '2012-10-17', Id: 'x', Statement: [{ Sid: 'a' }, { Sid: 'b' }] };
    routeAws({
      [Q2]: JSON.stringify({ Statement: [{ Sid: 'a' }, { Sid: 'b' }], Version: '2012-10-17', Id: 'x' }),
      [Q3]: JSON.stringify({ ...recordedDoc, Statement: [{ Sid: 'b' }, { Sid: 'a' }] }),
      'https://sqs.us-east-1.amazonaws.com/123456789012/queue-4': `{"__proto__":{"Sid":"x"},${JSON.stringify(recordedDoc).slice(1)}`,
    });
    const Q4 = 'https://sqs.us-east-1.amazonaws.com/123456789012/queue-4';
    await provider().delete('P', Q1, TYPE, { Queues: [Q1, Q2, Q3, Q4], PolicyDocument: recordedDoc });
    expect(setCalls()).toEqual([
      [Q2, ''],
      [Q1, ''],
    ]);
    mockSend.mockClear();
    await provider().delete('P', Q1, TYPE, {
      Queues: [Q1, Q2],
      PolicyDocument: JSON.stringify(recordedDoc),
    });
    expect(setCalls()).toEqual([
      [Q2, ''],
      [Q1, ''],
    ]);
  });

  it('still clears the id queue when a listed queue cannot be read, naming that queue', async () => {
    routeAws({ [Q2]: 'denied', [Q3]: 'gone' });
    await provider().delete('P', Q1, TYPE, { Queues: [Q1, Q2, Q3], PolicyDocument: DOC });
    expect(setCalls()).toEqual([[Q1, '']]);
    expect(warnings()).toEqual([
      expect.stringContaining(`Could not read the policy of queue ${Q2} (AccessDenied)`),
    ]);
  });

  it('names the unchecked queues when the record holds no document', async () => {
    routeAws({ [Q2]: DOC_JSON });
    await provider().delete('P', Q1, TYPE, { Queues: [Q1, Q2] });
    expect(setCalls()).toEqual([[Q1, '']]);
    expect(warnings()[0]).toContain(`The queues ${Q2} listed by P were not checked`);
  });

  it('refuses a gone queue in another region without a second error prefix', async () => {
    mockRegion.mockImplementationOnce(() => Promise.resolve('eu-west-1'));
    mockSend.mockRejectedValueOnce(goneError());
    const error = await provider()
      .delete('P', `${Q1},${Q2}`, TYPE, undefined, { expectedRegion: 'us-east-1' })
      .then(
        () => undefined,
        (e: unknown) => e as Error
      );
    expect(error?.message).toMatch(/^Refusing to treat NotFound as idempotent delete success for P/);
  });

  it('refuses an id naming no queue instead of reporting it deleted', async () => {
    await expect(provider().delete('P', ',', TYPE)).rejects.toThrow(/names no queue URL/);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('SQSQueuePolicyProvider readCurrentState reads every queue a (journaled) id names (#4594)', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it('lists every queue still carrying a policy', async () => {
    mockSend.mockResolvedValue({ Attributes: { Policy: DOC_JSON } });
    const state = await new SQSQueuePolicyProvider().readCurrentState(`${Q1},${Q2}`, 'P', TYPE);
    expect(state).toEqual({ Queues: [Q1, Q2], PolicyDocument: DOC });
  });

  it('takes PolicyDocument from the first queue carrying one', async () => {
    mockSend.mockResolvedValueOnce({ Attributes: { Policy: DOC_JSON } });
    mockSend.mockResolvedValueOnce({ Attributes: { Policy: OTHER_JSON } });
    const state = await new SQSQueuePolicyProvider().readCurrentState(`${Q1},${Q2}`, 'P', TYPE);
    expect(state).toEqual({ Queues: [Q1, Q2], PolicyDocument: DOC });
  });

  it('drops a queue whose policy was removed out of band, so the drift shows', async () => {
    mockSend.mockResolvedValueOnce({ Attributes: { Policy: DOC_JSON } });
    mockSend.mockResolvedValueOnce({ Attributes: {} });
    const state = await new SQSQueuePolicyProvider().readCurrentState(`${Q1},${Q2}`, 'P', TYPE);
    expect(state).toEqual({ Queues: [Q1], PolicyDocument: DOC });
  });

  it('reads the policy from a later queue when the first is gone', async () => {
    mockSend.mockRejectedValueOnce(goneError());
    mockSend.mockResolvedValueOnce({ Attributes: { Policy: DOC_JSON } });
    const state = await new SQSQueuePolicyProvider().readCurrentState(`${Q1},${Q2}`, 'P', TYPE);
    expect(state).toEqual({ Queues: [Q2], PolicyDocument: DOC });
  });

  it('reports RESOURCE_NOT_FOUND when no named queue carries a policy', async () => {
    mockSend.mockRejectedValueOnce(goneError());
    mockSend.mockResolvedValueOnce({ Attributes: { Policy: '' } });
    await expect(
      new SQSQueuePolicyProvider().readCurrentState(`${Q1},${Q2}`, 'P', TYPE)
    ).resolves.toBe(RESOURCE_NOT_FOUND);
  });

  it('answers nothing for an id naming no queue', async () => {
    await expect(new SQSQueuePolicyProvider().readCurrentState(',', 'P', TYPE)).resolves.toBe(
      undefined
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('ignores an empty segment of the id', async () => {
    mockSend.mockResolvedValue({ Attributes: { Policy: DOC_JSON } });
    const state = await new SQSQueuePolicyProvider().readCurrentState(`${Q1},`, 'P', TYPE);
    expect(state).toEqual({ Queues: [Q1], PolicyDocument: DOC });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('rethrows a non-not-found error on a later queue', async () => {
    mockSend.mockResolvedValueOnce({ Attributes: { Policy: DOC_JSON } });
    mockSend.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'AccessDenied' }));
    await expect(
      new SQSQueuePolicyProvider().readCurrentState(`${Q1},${Q2}`, 'P', TYPE)
    ).rejects.toThrow('denied');
  });
});

