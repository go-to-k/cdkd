/**
 * go-to-k/cdkd#6284: `CreateService` ITSELF threw after ECS created the
 * service (an unreadable 2xx, a 5xx, a reset or timeout). The service must be
 * named on the thrown error for the failed-CREATE journal (or, with no ARN
 * readable, retired by name) -- and never one that held the name before the
 * create (go-to-k/cdkd#4403), nor after a definite refusal.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  CreateServiceCommand,
  DeleteServiceCommand,
  DescribeServicesCommand,
} from '@aws-sdk/client-ecs';

const { createSend, lookupSend, afterSend, warn } = vi.hoisted(() => ({
  // CreateService.
  createSend: vi.fn(),
  // The by-name DescribeServices before CreateService (go-to-k/cdkd#4403).
  lookupSend: vi.fn(),
  // Every call after CreateService: the ambiguous-failure lookup and cleanup.
  afterSend: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@aws-sdk/client-ecs', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    ECSClient: vi.fn().mockImplementation(() => ({
      send: (command: { constructor: { name: string } }) => {
        if (command.constructor.name === 'CreateServiceCommand') return createSend(command);
        return createSend.mock.calls.length === 0 ? lookupSend(command) : afterSend(command);
      },
      config: { region: () => Promise.resolve('us-east-1') },
    })),
    waitUntilServicesStable: vi.fn(),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const l = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
  const child = { ...l, child: vi.fn().mockReturnThis() };
  return { getLogger: () => ({ ...l, child: () => child }) };
});

import { ECSProvider } from '../../../src/provisioning/providers/ecs-provider.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';
import {
  CreatedResourceSink,
  collectCreatedResources,
} from '../../../src/provisioning/created-resource-sink.js';
import {
  answeredSuccess,
  createServiceOutcomeUnknown,
} from '../../../src/provisioning/providers/ecs/service-create-ambiguous.js';

const TYPE = 'AWS::ECS::Service';
const SERVICE_ARN = 'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service';
const PROPS = {
  Cluster: 'my-cluster',
  ServiceName: 'my-service',
  TaskDefinition: 'my-task:1',
  DesiredCount: 1,
};

/** What the SDK throws when a 2xx body does not parse (the #6284 emulator answer). */
const unreadable2xx = (): Error =>
  Object.assign(
    new TypeError(
      'Epoch timestamps must be expressed as floating point numbers or their string representation'
    ),
    { $metadata: { httpStatusCode: 200 } }
  );
const serverError = (): Error =>
  Object.assign(new Error('internal'), {
    name: 'ServerException',
    $fault: 'server',
    $metadata: { httpStatusCode: 500 },
  });
const refusal = (): Error =>
  Object.assign(new Error('bad parameter'), {
    name: 'InvalidParameterException',
    $fault: 'client',
    $metadata: { httpStatusCode: 400 },
  });

const present = (createdAt: Date | undefined, status = 'ACTIVE') => ({
  services: [{ serviceArn: SERVICE_ARN, serviceName: 'my-service', status, createdAt }],
  failures: [],
});
const MISSING = { services: [], failures: [{ arn: 'x', reason: 'MISSING' }] };

const callsOf = (ctor: abstract new (...args: never[]) => unknown) =>
  afterSend.mock.calls.filter(([c]) => c instanceof ctor);

async function failedCreate(): Promise<unknown> {
  return new ECSProvider().create('MySvc', TYPE, { ...PROPS }).then(
    () => {
      throw new Error('create unexpectedly succeeded');
    },
    (e: unknown) => e
  );
}

const warned = (): string => warn.mock.calls.map((c) => String(c[0])).join('\n');

describe('ECSProvider.create (Service) — CreateService itself fails ambiguously (#6284)', () => {
  let originalNoWait: string | undefined;

  beforeEach(() => {
    createSend.mockReset();
    lookupSend.mockReset();
    afterSend.mockReset();
    warn.mockReset();
    lookupSend.mockResolvedValue(MISSING);
    originalNoWait = process.env['CDKD_NO_WAIT'];
    delete process.env['CDKD_NO_WAIT'];
  });

  afterEach(() => {
    if (originalNoWait === undefined) delete process.env['CDKD_NO_WAIT'];
    else process.env['CDKD_NO_WAIT'] = originalNoWait;
  });

  describe('classification', () => {
    it('reads an unreadable 2xx, a 5xx and a reset as unknown, a 4xx and a bare error as refused', () => {
      expect(answeredSuccess(unreadable2xx())).toBe(true);
      expect(createServiceOutcomeUnknown(unreadable2xx())).toBe(true);
      expect(createServiceOutcomeUnknown(serverError())).toBe(true);
      expect(
        createServiceOutcomeUnknown(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
      ).toBe(true);
      expect(createServiceOutcomeUnknown(refusal())).toBe(false);
      expect(createServiceOutcomeUnknown(new Error('no status'))).toBe(false);
      expect(answeredSuccess(serverError())).toBe(false);
    });
  });

  it.each([
    ['an unreadable 2xx', unreadable2xx],
    ['a 5xx', serverError],
  ])(
    'marks the service found under the sent name after %s, the name measured free',
    async (_l, fail) => {
      const thrown = fail();
      createSend.mockRejectedValueOnce(thrown);
      afterSend.mockResolvedValueOnce(present(new Date(0)));

      const error = await failedCreate();

      expect((error as { cause?: unknown }).cause).toBe(thrown);
      expect(createdBeforeFailure(error, 'MySvc', TYPE)).toBe(SERVICE_ARN);
      expect(callsOf(DescribeServicesCommand)[0]![0].input).toEqual({
        cluster: 'my-cluster',
        services: ['my-service'],
      });
      expect(callsOf(DeleteServiceCommand)).toHaveLength(0);
      expect(warned()).toMatch(/recorded on the failed create/);
    }
  );

  it('reports the marked ARN to the created-resource sink (#5511)', async () => {
    const sink = new CreatedResourceSink('MySvc', TYPE);
    createSend.mockRejectedValueOnce(unreadable2xx());
    afterSend.mockResolvedValueOnce(present(new Date()));

    await collectCreatedResources(sink, () => failedCreate());

    expect(sink.report).toEqual({ physicalId: SERVICE_ARN });
  });

  it('neither looks nor marks after a definite refusal', async () => {
    createSend.mockRejectedValueOnce(refusal());

    const error = await failedCreate();

    expect(afterSend).not.toHaveBeenCalled();
    expect(createdBeforeFailure(error, 'MySvc', TYPE)).toBeUndefined();
  });

  it('leaves a service that held the name BEFORE the create alone (#4403)', async () => {
    lookupSend.mockResolvedValue(present(new Date()));
    createSend.mockRejectedValueOnce(unreadable2xx());

    const error = await failedCreate();

    expect(afterSend).not.toHaveBeenCalled();
    expect(createdBeforeFailure(error, 'MySvc', TYPE)).toBeUndefined();
  });

  it('marks nothing when no service exists under the name', async () => {
    createSend.mockRejectedValueOnce(serverError());
    afterSend.mockResolvedValueOnce(MISSING);

    const error = await failedCreate();

    expect(createdBeforeFailure(error, 'MySvc', TYPE)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('marks nothing for an INACTIVE service under the name', async () => {
    createSend.mockRejectedValueOnce(serverError());
    afterSend.mockResolvedValueOnce(present(new Date(), 'INACTIVE'));

    const error = await failedCreate();

    expect(createdBeforeFailure(error, 'MySvc', TYPE)).toBeUndefined();
  });

  describe('name not measured before the create (--no-wait): the creation time decides', () => {
    beforeEach(() => {
      process.env['CDKD_NO_WAIT'] = 'true';
    });

    it('marks a service created inside the attempt window', async () => {
      createSend.mockRejectedValueOnce(serverError());
      afterSend.mockResolvedValueOnce(present(new Date()));

      const error = await failedCreate();

      expect(lookupSend).not.toHaveBeenCalled();
      expect(createdBeforeFailure(error, 'MySvc', TYPE)).toBe(SERVICE_ARN);
    });

    it.each([
      ['created long before the attempt', new Date(Date.now() - 3_600_000)],
      ['with no creation time', undefined],
    ])('leaves a service %s alone', async (_l, createdAt) => {
      createSend.mockRejectedValueOnce(serverError());
      afterSend.mockResolvedValueOnce(present(createdAt));

      const error = await failedCreate();

      expect(createdBeforeFailure(error, 'MySvc', TYPE)).toBeUndefined();
      expect(callsOf(DeleteServiceCommand)).toHaveLength(0);
    });

    it('only reports when the lookup cannot answer, even after a 2xx (name never measured)', async () => {
      createSend.mockRejectedValueOnce(unreadable2xx());
      afterSend.mockRejectedValueOnce(unreadable2xx());

      const error = await failedCreate();

      expect(callsOf(DeleteServiceCommand)).toHaveLength(0);
      expect(createdBeforeFailure(error, 'MySvc', TYPE)).toBeUndefined();
      expect(warned()).toMatch(/could not look for it/);
      expect(warned()).toMatch(/aws ecs delete-service --cluster my-cluster --service my-service/);
    });
  });

  describe('lookup cannot answer', () => {
    it('deletes by name after an unreadable 2xx with the name measured free (the #6284 repro)', async () => {
      createSend.mockRejectedValueOnce(unreadable2xx());
      afterSend.mockRejectedValueOnce(unreadable2xx()); // DescribeServices
      afterSend.mockRejectedValueOnce(unreadable2xx()); // DeleteService: 2xx = accepted

      const error = await failedCreate();

      const deletes = callsOf(DeleteServiceCommand);
      expect(deletes).toHaveLength(1);
      expect(deletes[0]![0].input).toEqual({
        cluster: 'my-cluster',
        service: 'my-service',
        force: true,
      });
      expect(createdBeforeFailure(error, 'MySvc', TYPE)).toBeUndefined();
      expect(warned()).toMatch(/Deleted ECS service MySvc \(my-service\)/);
    });

    it('warns with the manual command when that delete fails', async () => {
      createSend.mockRejectedValueOnce(unreadable2xx());
      afterSend.mockRejectedValueOnce(unreadable2xx());
      afterSend.mockRejectedValueOnce(new Error('delete denied'));

      await failedCreate();

      expect(warned()).toMatch(
        /Failed to clean up .*Manual deletion may be required.*aws ecs delete-service --cluster my-cluster --service my-service --force/s
      );
    });

    it('only reports after a 5xx (the create may not have run)', async () => {
      createSend.mockRejectedValueOnce(serverError());
      afterSend.mockRejectedValueOnce(
        Object.assign(new Error('denied'), { name: 'AccessDeniedException' })
      );

      const error = await failedCreate();

      expect(callsOf(DeleteServiceCommand)).toHaveLength(0);
      expect(createdBeforeFailure(error, 'MySvc', TYPE)).toBeUndefined();
      expect(warned()).toMatch(/could not look for it \(DescribeServices: /);
    });
  });

  it('rethrows the CreateService error even when the lookup itself blows up', async () => {
    const thrown = serverError();
    createSend.mockRejectedValueOnce(thrown);
    afterSend.mockImplementationOnce(() => {
      throw new Error('synchronous boom');
    });

    const error = await failedCreate();

    expect((error as { cause?: unknown }).cause).toBe(thrown);
    expect(createdBeforeFailure(error, 'MySvc', TYPE)).toBeUndefined();
  });

  it('sends the same CreateService it always did', async () => {
    createSend.mockRejectedValueOnce(refusal());
    await failedCreate();
    expect(createSend.mock.calls[0]![0]).toBeInstanceOf(CreateServiceCommand);
    expect(createSend.mock.calls[0]![0].input.serviceName).toBe('my-service');
  });
});
