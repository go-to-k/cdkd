/**
 * Issue #2080 (Plan C, Lambda): `CreateEventSourceMapping` and
 * `PublishLayerVersion` mint their id (a mapping UUID, a layer version number)
 * and carry no idempotency token. A 5xx whose request AWS completed used to be
 * replayed -- inside one `send` by the SDK, invisibly (#3978 layer (b)), or by
 * the engine's retry -- adding a second mapping or a second layer version that
 * no state records. The create now goes through a client that refuses the
 * SDK's 5xx retry, and the engine's next attempt REPORTS the candidates
 * first. Detection only: nothing is adopted or deleted.
 *
 * The fakes count RESOURCES, not calls (acceptance item 2), and every retry
 * advances the clock (acceptance item 3).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const { mockSend, warnSpy, debugSpy, sentVia, baseStrategy, ctorArgs, regionFails, clients } =
  vi.hoisted(() => ({
    mockSend: vi.fn(),
    /** How many upcoming `config.region()` reads reject, across every client. */
    regionFails: { remaining: 0 },
    /** Every `LambdaClient` constructor's options, in order. */
    ctorArgs: [] as Array<{ region?: unknown }>,
    warnSpy: vi.fn(),
    debugSpy: vi.fn(),
    /** `[command name, client config]` per send, so a test can see WHICH client sent it. */
    sentVia: [] as Array<
      [string, { region: () => Promise<unknown>; retryStrategy: () => Promise<unknown> }]
    >,
    /** A stand-in for the SDK's resolved V2 retry strategy. */
    baseStrategy: {
      acquireInitialRetryToken: async (_scope: string) => 'token',
      refreshRetryTokenForRetry: async (_token: unknown, _info: { error?: unknown }) =>
        'retry-token',
      recordSuccess: (_token: unknown) => undefined,
    },
    /** The region the shared `getAwsClients().lambda` client resolves. */
    clients: { sharedRegion: 'eu-west-3' },
  }));

/** A client double whose sends are attributed to its own config; `region` may be read lazily. */
const fakeClient = (region: unknown) => {
  const config = {
    region: () => {
      if (regionFails.remaining > 0) {
        regionFails.remaining--;
        return Promise.reject(new Error('Region is missing'));
      }
      return Promise.resolve((typeof region === 'function' ? region() : region) ?? 'us-east-1');
    },
    retryStrategy: async (): Promise<unknown> => baseStrategy,
  };
  return {
    config,
    send: (command: { constructor: { name: string } }) => {
      sentVia.push([command.constructor.name, config]);
      return mockSend(command);
    },
  };
};

vi.mock('@aws-sdk/client-lambda', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-lambda')>();
  return {
    ...actual,
    LambdaClient: vi.fn().mockImplementation((options: { region?: unknown }) => {
      ctorArgs.push(options);
      return fakeClient(options.region);
    }),
  };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    // Read lazily, so a test can move the shared client to another region.
    lambda: fakeClient(() => clients.sharedRegion),
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: debugSpy,
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: debugSpy,
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import { ResourceConflictException } from '@aws-sdk/client-lambda';
import {
  LambdaEventSourceMappingProvider,
  resetEventSourceMappingCreateRetryStateForTests,
} from '../../../src/provisioning/providers/lambda-eventsource-provider.js';
import {
  LambdaLayerVersionProvider,
  parseLayerCreatedDate,
  resetLayerVersionCreateRetryStateForTests,
} from '../../../src/provisioning/providers/lambda-layer-provider.js';
import { withRetry } from '../../../src/deployment/retry.js';
import { WITHHELD_AWS_COMMAND } from '../../../src/provisioning/replacement-protection-advice.js';

/** Lambda's modeled 500, in the shape `isTransientServerError` / `isAmbiguousOutcomeError` classify. */
const transient500 = (): Error =>
  Object.assign(new Error('Internal server error'), {
    name: 'ServiceException',
    $fault: 'server',
    $metadata: { httpStatusCode: 500 },
  });

/** A throttle IDENTIFIED by name on a 503, so only the name exemption keeps it from arming the latch. */
const throttled = (): Error =>
  Object.assign(new Error('Rate exceeded'), {
    name: 'TooManyRequestsException',
    $fault: 'server',
    $metadata: { httpStatusCode: 503 },
  });

/** A definite refusal: Lambda did nothing, and the text is an IAM-propagation retry pattern. */
const propagationDenied = (action: string): Error =>
  Object.assign(
    new Error(`User: arn:aws:sts::1:assumed-role/r/s is not authorized to perform: ${action}`),
    { name: 'AccessDeniedException', $fault: 'client', $metadata: { httpStatusCode: 403 } }
  );

/** Advance the fake clock on every backoff (issue #2080 acceptance item 3). */
const advancingSleep = (ms: number): Promise<void> => {
  vi.setSystemTime(Date.now() + Math.max(ms, 1000));
  return Promise.resolve();
};

/** `ListLayerVersions`' documented `CreatedDate` spelling: an offset with no colon. */
const layerDate = (ms: number): string => new Date(ms).toISOString().replace('Z', '+0000');

interface FakeMapping {
  UUID: string;
  FunctionName: string;
  EventSourceArn?: string;
  /** Absent models a mapping Lambda returned without it. */
  LastModified?: Date;
}

interface FakeLayerVersion {
  LayerName: string;
  Version: number;
  LayerVersionArn: string;
  CreatedDate: string;
}

const LAYER_ARN_PREFIX = 'arn:aws:lambda:eu-west-3:123456789012:layer:';

/** A fake Lambda. The arrays count RESOURCES, not calls (issue #2080 acceptance item 2). */
class FakeLambda {
  readonly mappings: FakeMapping[] = [];
  readonly versions: FakeLayerVersion[] = [];
  readonly calls: string[] = [];
  readonly listInputs: Array<Record<string, unknown>> = [];
  readonly failNext = new Map<string, Error[]>();
  /** The next create makes its resource, THEN throws this (a lost response). */
  loseNextCreateResponse: Error | undefined;
  /** Items per list page. */
  pageSize = 50;
  /** `ListLayerVersions` order; Lambda lists newest first. */
  oldestFirst = false;
  /** Runs on every list call, to stage what the NEXT create does. */
  onList: (() => void) | undefined;
  private nextId = 1;

  send = async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const name = command.constructor.name;
    this.calls.push(name);
    const queued = this.failNext.get(name);
    if (queued && queued.length > 0) throw queued.shift();
    const input = command.input;
    switch (name) {
      case 'CreateEventSourceMappingCommand': {
        const fn = input['FunctionName'] as string;
        const source = input['EventSourceArn'] as string | undefined;
        // An SQS queue takes one mapping per (function, source) pair.
        const existing =
          source !== undefined &&
          this.mappings.find((m) => m.FunctionName === fn && m.EventSourceArn === source);
        if (existing) {
          throw new ResourceConflictException({
            message: `An event source mapping with SQS arn (" ${source} ") and function (" ${fn} ") already exists. Please update or delete the existing mapping with UUID ${existing.UUID}`,
            $metadata: { httpStatusCode: 409 },
          });
        }
        const created: FakeMapping = {
          UUID: `uuid-${this.nextId++}`,
          FunctionName: fn,
          ...(source !== undefined && { EventSourceArn: source }),
          LastModified: new Date(Date.now()),
        };
        this.mappings.push(created);
        this.loseResponse();
        return {
          UUID: created.UUID,
          EventSourceMappingArn: `arn:aws:lambda:eu-west-3:123456789012:event-source-mapping:${created.UUID}`,
        };
      }
      case 'ListEventSourceMappingsCommand':
        this.onList?.();
        this.listInputs.push(input);
        return this.page(
          'EventSourceMappings',
          this.mappings.filter(
            (m) =>
              m.FunctionName === input['FunctionName'] &&
              (input['EventSourceArn'] === undefined ||
                m.EventSourceArn === input['EventSourceArn'])
          ),
          input['Marker']
        );
      case 'PublishLayerVersionCommand': {
        const layerName = input['LayerName'] as string;
        const version =
          Math.max(0, ...this.versions.filter((v) => v.LayerName === layerName).map((v) => v.Version)) +
          1;
        const created: FakeLayerVersion = {
          LayerName: layerName,
          Version: version,
          // A layer ARN given as `LayerName` publishes under that layer.
          LayerVersionArn: layerName.startsWith('arn:')
            ? `${layerName}:${version}`
            : `${LAYER_ARN_PREFIX}${layerName}:${version}`,
          CreatedDate: layerDate(Date.now()),
        };
        this.versions.push(created);
        this.loseResponse();
        return { LayerVersionArn: created.LayerVersionArn, Version: version };
      }
      case 'ListLayerVersionsCommand':
        this.onList?.();
        this.listInputs.push(input);
        // Newest first, as Lambda lists them.
        return this.page(
          'LayerVersions',
          this.versions
            .filter((v) => v.LayerName === input['LayerName'])
            .sort((a, b) => (this.oldestFirst ? a.Version - b.Version : b.Version - a.Version))
            .map(({ LayerVersionArn, Version, CreatedDate }) => ({
              LayerVersionArn,
              Version,
              CreatedDate,
            })),
          input['Marker']
        );
      default:
        return {};
    }
  };

  private loseResponse(): void {
    if (this.loseNextCreateResponse) {
      const error = this.loseNextCreateResponse;
      this.loseNextCreateResponse = undefined;
      throw error;
    }
  }

  private page<T>(key: string, all: T[], marker: unknown): Record<string, unknown> {
    const start = marker === undefined ? 0 : Number(marker);
    const end = start + this.pageSize;
    return {
      [key]: all.slice(start, end).map((a) => structuredClone(a)),
      ...(end < all.length && { NextMarker: String(end) }),
    };
  }

  count(name: string): number {
    return this.calls.filter((c) => c === name).length;
  }
}

const QUEUE_ARN = 'arn:aws:sqs:eu-west-3:123456789012:jobs';
const SQS_PROPS = { FunctionName: 'worker-fn', EventSourceArn: QUEUE_ARN, BatchSize: 10 };
const KAFKA_PROPS = {
  FunctionName: 'worker-fn',
  Topics: ['orders'],
  SelfManagedEventSource: { Endpoints: { KafkaBootstrapServers: ['b-1.example.com:9092'] } },
};
const LAYER_PROPS = {
  LayerName: 'shared-libs',
  Content: { S3Bucket: 'assets-bucket', S3Key: 'layer.zip' },
  CompatibleRuntimes: ['nodejs20.x'],
};

const ESM = 'AWS::Lambda::EventSourceMapping';
const LAYER = 'AWS::Lambda::LayerVersion';

describe('Lambda tokenless create retry safety (issue #2080, detection only)', () => {
  let aws: FakeLambda;
  let savedRegion: string | undefined;
  let esm: LambdaEventSourceMappingProvider;
  let layer: LambdaLayerVersionProvider;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
    resetEventSourceMappingCreateRetryStateForTests();
    resetLayerVersionCreateRetryStateForTests();
    aws = new FakeLambda();
    mockSend.mockReset();
    mockSend.mockImplementation(aws.send);
    warnSpy.mockReset();
    debugSpy.mockReset();
    sentVia.length = 0;
    ctorArgs.length = 0;
    regionFails.remaining = 0;
    clients.sharedRegion = 'eu-west-3';
    // Not the SDK's fallback, so a client built without the stack region is told apart.
    savedRegion = process.env['AWS_REGION'];
    process.env['AWS_REGION'] = 'eu-west-3';
    esm = new LambdaEventSourceMappingProvider();
    layer = new LambdaLayerVersionProvider();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (savedRegion === undefined) delete process.env['AWS_REGION'];
    else process.env['AWS_REGION'] = savedRegion;
  });

  const createWithRetry = (
    type: string,
    props: Record<string, unknown>,
    logicalId = 'Res',
    maskSecrets?: (text: string) => string
  ) =>
    withRetry(
      () =>
        (type === ESM ? esm : layer).create(
          logicalId,
          type,
          props,
          maskSecrets !== undefined ? { maskSecrets } : undefined
        ),
      logicalId,
      { sleep: advancingSleep }
    );

  const warnLines = (): string[] => warnSpy.mock.calls.map((c) => String(c[0]));
  const reportFor = (action: string): string | undefined =>
    warnLines().find((l) => l.includes(`earlier ${action} attempt`));

  describe('PublishLayerVersion', () => {
    it('names the version a lost response published, with a read then a conditional delete command', async () => {
      aws.loseNextCreateResponse = transient500();

      const result = await createWithRetry(LAYER, LAYER_PROPS);

      // Two versions exist -- the orphan is REPORTED, not prevented -- and the
      // recorded one is the second.
      expect(aws.versions.map((v) => v.Version)).toEqual([1, 2]);
      expect(result.physicalId).toBe(`${LAYER_ARN_PREFIX}shared-libs:2`);
      expect(aws.calls).not.toContain('DeleteLayerVersionCommand');
      const line = reportFor('PublishLayerVersion')!;
      expect(line).toContain('Lambda may have created a version of layer shared-libs');
      expect(line).toContain('1 layer version(s) were created');
      expect(line).toContain(`${LAYER_ARN_PREFIX}shared-libs:1`);
      expect(line).not.toContain(`${LAYER_ARN_PREFIX}shared-libs:2`);
      const read = line.indexOf(
        'aws lambda get-layer-version --layer-name shared-libs --version-number 1 --region eu-west-3'
      );
      const remove = line.indexOf(
        'aws lambda delete-layer-version --layer-name shared-libs --version-number 1 --region eu-west-3'
      );
      expect(read).toBeGreaterThan(-1);
      expect(remove).toBeGreaterThan(read);
      expect(line).toContain('does not adopt or delete');
      expect(line).toContain('Only after confirming');
    });

    it('lists the layer the create publishes under', async () => {
      aws.loseNextCreateResponse = transient500();

      await createWithRetry(LAYER, LAYER_PROPS);

      expect(aws.listInputs).toEqual([{ LayerName: 'shared-libs' }]);
    });

    it('does not report a version created before the window, one this process recorded, or another layer', async () => {
      // Recorded by this process, inside what becomes the window.
      const earlier = await layer.create('Other', LAYER, LAYER_PROPS);
      aws.versions.push({
        LayerName: 'shared-libs',
        Version: 99,
        LayerVersionArn: `${LAYER_ARN_PREFIX}shared-libs:99`,
        CreatedDate: layerDate(Date.now() - 60_000),
      });
      aws.versions.push({
        LayerName: 'other-layer',
        Version: 1,
        LayerVersionArn: `${LAYER_ARN_PREFIX}other-layer:1`,
        CreatedDate: layerDate(Date.now()),
      });
      aws.loseNextCreateResponse = transient500();

      await createWithRetry(LAYER, LAYER_PROPS);

      const line = reportFor('PublishLayerVersion')!;
      // The lost response's version: the next after 99.
      expect(line).toContain('1 layer version(s) were created');
      expect(line).toContain('--version-number 100 ');
      // `shared-libs:1` is a prefix of `shared-libs:100`: match it delimited.
      expect(earlier.physicalId).toBe(`${LAYER_ARN_PREFIX}shared-libs:1`);
      expect(line).not.toContain(`${earlier.physicalId}.`);
      expect(line).not.toContain('--version-number 1 ');
      expect(line).not.toContain('shared-libs:99');
      expect(line).not.toContain('other-layer');
    });

    it('a version published by another process after the window is not a candidate', async () => {
      aws.loseNextCreateResponse = transient500();
      aws.onList = () => {
        aws.versions.push({
          LayerName: 'shared-libs',
          Version: 50,
          LayerVersionArn: `${LAYER_ARN_PREFIX}shared-libs:50`,
          CreatedDate: layerDate(Date.now()),
        });
        aws.onList = undefined;
      };

      await withRetry(() => layer.create('Res', LAYER, LAYER_PROPS), 'Res', {
        sleep: (): Promise<void> => {
          vi.setSystemTime(Date.now() + 30_000);
          return Promise.resolve();
        },
      });

      const line = reportFor('PublishLayerVersion')!;
      expect(line).toContain('1 layer version(s) were created');
      expect(line).not.toContain('shared-libs:50');
    });

    it('two ambiguous attempts in a row: the second report covers the FIRST attempt too', async () => {
      aws.loseNextCreateResponse = transient500();
      aws.onList = () => {
        aws.loseNextCreateResponse = transient500();
        aws.onList = undefined;
      };

      await withRetry(() => layer.create('Res', LAYER, LAYER_PROPS), 'Res', {
        sleep: (): Promise<void> => {
          vi.setSystemTime(Date.now() + 30_000);
          return Promise.resolve();
        },
      });

      expect(aws.versions).toHaveLength(3);
      const lines = warnLines().filter((l) => l.includes('earlier PublishLayerVersion attempt'));
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain('between 2026-09-30T23:59:55.000Z');
      expect(lines[1]).toContain('--version-number 1 ');
      expect(lines[1]).toContain('--version-number 2 ');
    });

    it('follows ListLayerVersions pagination to a candidate on a later page', async () => {
      for (let v = 1; v <= 3; v++) {
        aws.versions.push({
          LayerName: 'shared-libs',
          Version: v,
          LayerVersionArn: `${LAYER_ARN_PREFIX}shared-libs:${v}`,
          CreatedDate: layerDate(Date.now() - 3_600_000),
        });
      }
      aws.pageSize = 1;
      // Oldest first, so the orphan (v4) is on the LAST page.
      aws.oldestFirst = true;
      aws.loseNextCreateResponse = transient500();

      await createWithRetry(LAYER, LAYER_PROPS);

      expect(aws.count('ListLayerVersionsCommand')).toBe(4);
      expect(reportFor('PublishLayerVersion')!).toContain('--version-number 4 ');
    });

    it('a failed ListLayerVersions warns and lets the create proceed', async () => {
      aws.loseNextCreateResponse = transient500();
      aws.failNext.set('ListLayerVersionsCommand', [
        propagationDenied('lambda:ListLayerVersions'),
      ]);

      const result = await createWithRetry(LAYER, LAYER_PROPS);

      expect(result.physicalId).toBe(`${LAYER_ARN_PREFIX}shared-libs:2`);
      expect(
        warnLines().some(
          (l) =>
            l.includes('Lambda may have created a version of layer shared-libs') &&
            l.includes('could not look for it (ListLayerVersions')
        )
      ).toBe(true);
    });

    it('a DEFINITE PublishLayerVersion failure (a 4xx) triggers no lookup', async () => {
      aws.failNext.set('PublishLayerVersionCommand', [
        propagationDenied('lambda:PublishLayerVersion'),
      ]);

      await createWithRetry(LAYER, LAYER_PROPS);

      expect(aws.count('ListLayerVersionsCommand')).toBe(0);
      expect(aws.versions).toHaveLength(1);
    });

    it('a throttled PublishLayerVersion triggers no lookup', async () => {
      aws.failNext.set('PublishLayerVersionCommand', [throttled()]);

      await createWithRetry(LAYER, LAYER_PROPS);

      expect(aws.count('ListLayerVersionsCommand')).toBe(0);
      expect(aws.versions).toHaveLength(1);
    });

    it('a generated layer name is the one listed and named', async () => {
      aws.loseNextCreateResponse = transient500();
      const { LayerName: _omit, ...props } = LAYER_PROPS;

      const result = await createWithRetry(LAYER, props);

      const name = String(aws.listInputs[0]!['LayerName']);
      expect(name.length).toBeGreaterThan(0);
      expect(result.physicalId).toBe(`${LAYER_ARN_PREFIX}${name}:2`);
      expect(reportFor('PublishLayerVersion')!).toContain(
        `aws lambda delete-layer-version --layer-name ${name} --version-number 1 `
      );
    });

    it('masks a short secret-derived layer name and withholds the commands that carry it', async () => {
      aws.loseNextCreateResponse = transient500();

      await createWithRetry(LAYER, { ...LAYER_PROPS, LayerName: 'zq' }, 'Res', (t) =>
        t === 'zq' ? '***' : t
      );

      const line = reportFor('PublishLayerVersion')!;
      expect(line).toContain('a version of layer ***');
      expect(line).not.toMatch(/\bzq\b/);
      expect(line.split(WITHHELD_AWS_COMMAND)).toHaveLength(3);
    });

    it('a secret-derived layer ARN given as LayerName is masked in the candidate ARNs', async () => {
      const secretArn = `${LAYER_ARN_PREFIX}zq`;
      aws.loseNextCreateResponse = transient500();

      await createWithRetry(LAYER, { ...LAYER_PROPS, LayerName: secretArn }, 'Res', (t) =>
        t.split(secretArn).join('***')
      );

      const line = reportFor('PublishLayerVersion')!;
      expect(line).toContain('1 layer version(s) were created');
      expect(line).not.toMatch(/\bzq\b/);
      expect(line.split(WITHHELD_AWS_COMMAND)).toHaveLength(3);
    });

    it('a secret-derived layer ARN given as LayerName: a failure quoting only its bare name is masked', async () => {
      const secretArn = `${LAYER_ARN_PREFIX}zq`;
      aws.loseNextCreateResponse = transient500();
      // AWS quotes the bare layer name, which the whole-ARN masker never sees.
      aws.failNext.set('ListLayerVersionsCommand', [
        Object.assign(new Error('Layer zq is not accessible to this account'), {
          name: 'AccessDeniedException',
          $fault: 'client',
          $metadata: { httpStatusCode: 403 },
        }),
      ]);

      await createWithRetry(LAYER, { ...LAYER_PROPS, LayerName: secretArn }, 'Res', (t) =>
        t.split(secretArn).join('***')
      );

      expect(warnLines().some((l) => l.includes('could not look for it (ListLayerVersions'))).toBe(
        true
      );
      // The warn line carries only the error class for an AWS-authored
      // failure; the failure's own text goes to the debug line.
      const detail = debugSpy.mock.calls
        .map((c) => String(c[0]))
        .find((l) => l.startsWith('ListLayerVersions failed with'))!;
      expect(detail).toContain('is not accessible');
      expect(detail).not.toMatch(/\bzq\b/);
    });

    it('a region that cannot be read drops the --region flag rather than the command', async () => {
      aws.loseNextCreateResponse = transient500();
      // Fail the region read AFTER the first publish: the create client is
      // built by then, so the read that fails is the report's.
      mockSend.mockImplementation(async (command: { constructor: { name: string } }) => {
        if (command.constructor.name === 'PublishLayerVersionCommand' && regionFails.remaining === 0) {
          regionFails.remaining = 1;
          mockSend.mockImplementation(aws.send);
        }
        return aws.send(command as never);
      });

      await createWithRetry(LAYER, LAYER_PROPS);

      expect(regionFails.remaining).toBe(0);
      expect(reportFor('PublishLayerVersion')!).toContain(
        'aws lambda get-layer-version --layer-name shared-libs --version-number 1.'
      );
    });
  });

  describe('CreateEventSourceMapping', () => {
    it('names the mapping a lost response created, with a read command and no delete command', async () => {
      aws.loseNextCreateResponse = transient500();

      const result = await createWithRetry(ESM, KAFKA_PROPS);

      expect(aws.mappings.map((m) => m.UUID)).toEqual(['uuid-1', 'uuid-2']);
      expect(result.physicalId).toBe('uuid-2');
      expect(aws.calls).not.toContain('DeleteEventSourceMappingCommand');
      const line = reportFor('CreateEventSourceMapping')!;
      expect(line).toContain(
        'Lambda may have created an event source mapping from a self-managed event source to function worker-fn'
      );
      expect(line).toContain('1 event source mapping(s) match');
      expect(line).toContain('aws lambda get-event-source-mapping --uuid uuid-1 --region eu-west-3');
      expect(line).not.toContain('uuid-2');
      expect(line).toContain('Lambda reports no creation time');
      expect(line).not.toContain('delete-event-source-mapping');
    });

    it('lists by function and source, or by function alone for a self-managed source', async () => {
      aws.loseNextCreateResponse = transient500();
      // The SQS replay collides with its own orphan (next test); only the listing matters here.
      await createWithRetry(ESM, SQS_PROPS, 'Sqs').catch(() => undefined);
      aws.loseNextCreateResponse = transient500();
      await createWithRetry(ESM, KAFKA_PROPS, 'Kafka');

      expect(aws.listInputs).toEqual([
        { FunctionName: 'worker-fn', EventSourceArn: QUEUE_ARN },
        { FunctionName: 'worker-fn' },
      ]);
    });

    it('an SQS source: the report names the orphan the replayed create then collides with', async () => {
      aws.loseNextCreateResponse = transient500();

      await expect(createWithRetry(ESM, SQS_PROPS)).rejects.toThrow(/uuid-1/);

      // One mapping: Lambda refused the second, and nothing was deleted.
      expect(aws.mappings.map((m) => m.UUID)).toEqual(['uuid-1']);
      expect(aws.calls).not.toContain('DeleteEventSourceMappingCommand');
      const line = reportFor('CreateEventSourceMapping')!;
      expect(line).toContain(`from ${QUEUE_ARN} to function worker-fn`);
      expect(line).toContain('aws lambda get-event-source-mapping --uuid uuid-1 ');
    });

    it('does not report a mapping untouched since before the window or one this process recorded', async () => {
      const earlier = await esm.create('Other', ESM, KAFKA_PROPS);
      aws.mappings.push({
        UUID: 'uuid-OLD',
        FunctionName: 'worker-fn',
        LastModified: new Date(Date.now() - 60_000),
      });
      aws.mappings.push({
        UUID: 'uuid-OTHER-FN',
        FunctionName: 'other-fn',
        LastModified: new Date(Date.now()),
      });
      // No clock advance: the recorded mapping is inside the window, so only
      // the recorded-id check keeps it out.
      aws.loseNextCreateResponse = transient500();

      await createWithRetry(ESM, KAFKA_PROPS);

      const line = reportFor('CreateEventSourceMapping')!;
      expect(line).toContain('1 event source mapping(s) match');
      expect(line).toContain('--uuid uuid-2 ');
      expect(line).not.toContain(earlier.physicalId);
      expect(line).not.toContain('uuid-OLD');
      expect(line).not.toContain('uuid-OTHER-FN');
    });

    it('two ambiguous attempts in a row: the second report covers the FIRST attempt too', async () => {
      aws.loseNextCreateResponse = transient500();
      aws.onList = () => {
        aws.loseNextCreateResponse = transient500();
        aws.onList = undefined;
      };

      await withRetry(() => esm.create('Res', ESM, KAFKA_PROPS), 'Res', {
        sleep: (): Promise<void> => {
          vi.setSystemTime(Date.now() + 30_000);
          return Promise.resolve();
        },
      });

      expect(aws.mappings).toHaveLength(3);
      const lines = warnLines().filter((l) =>
        l.includes('earlier CreateEventSourceMapping attempt')
      );
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain('at 2026-09-30T23:59:55.000Z');
      expect(lines[1]).toContain('--uuid uuid-1 ');
      expect(lines[1]).toContain('--uuid uuid-2 ');
    });

    it('follows ListEventSourceMappings pagination to a candidate on a later page', async () => {
      for (let i = 0; i < 3; i++) {
        aws.mappings.push({
          UUID: `uuid-OLD-${i}`,
          FunctionName: 'worker-fn',
          LastModified: new Date(Date.now() - 3_600_000),
        });
      }
      aws.pageSize = 1;
      aws.loseNextCreateResponse = transient500();

      await createWithRetry(ESM, KAFKA_PROPS);

      expect(aws.count('ListEventSourceMappingsCommand')).toBe(4);
      expect(reportFor('CreateEventSourceMapping')!).toContain('--uuid uuid-1 ');
    });

    it('a failed ListEventSourceMappings warns and lets the create proceed', async () => {
      aws.loseNextCreateResponse = transient500();
      aws.failNext.set('ListEventSourceMappingsCommand', [
        propagationDenied('lambda:ListEventSourceMappings'),
      ]);

      const result = await createWithRetry(ESM, KAFKA_PROPS);

      expect(result.physicalId).toBe('uuid-2');
      expect(
        warnLines().some(
          (l) =>
            l.includes('Lambda may have created an event source mapping') &&
            l.includes('could not look for it (ListEventSourceMappings')
        )
      ).toBe(true);
    });

    it('a DEFINITE CreateEventSourceMapping failure (a 4xx) triggers no lookup', async () => {
      aws.failNext.set('CreateEventSourceMappingCommand', [
        propagationDenied('lambda:CreateEventSourceMapping'),
      ]);

      await createWithRetry(ESM, KAFKA_PROPS);

      expect(aws.count('ListEventSourceMappingsCommand')).toBe(0);
      expect(aws.mappings).toHaveLength(1);
    });

    it('a throttled CreateEventSourceMapping triggers no lookup', async () => {
      aws.failNext.set('CreateEventSourceMappingCommand', [throttled()]);

      await createWithRetry(ESM, KAFKA_PROPS);

      expect(aws.count('ListEventSourceMappingsCommand')).toBe(0);
      expect(aws.mappings).toHaveLength(1);
    });

    it('masks a secret-derived EventSourceArn in the subject', async () => {
      aws.loseNextCreateResponse = transient500();

      await createWithRetry(ESM, SQS_PROPS, 'Res', (t) => t.split(QUEUE_ARN).join('***')).catch(
        () => undefined
      );

      const line = reportFor('CreateEventSourceMapping')!;
      expect(line).toContain('from *** to function worker-fn');
      expect(line).not.toContain(QUEUE_ARN);
      expect(line).toContain('--uuid uuid-1 ');
    });

    it('does not report a mapping Lambda returned without LastModified', async () => {
      aws.mappings.push({ UUID: 'uuid-UNDATED', FunctionName: 'worker-fn' });
      aws.loseNextCreateResponse = transient500();

      await createWithRetry(ESM, KAFKA_PROPS);

      const line = reportFor('CreateEventSourceMapping')!;
      expect(line).toContain('1 event source mapping(s) match');
      expect(line).not.toContain('uuid-UNDATED');
    });

    it('masks a short secret-derived function name as a WHOLE value', async () => {
      aws.loseNextCreateResponse = transient500();

      await createWithRetry(ESM, { ...KAFKA_PROPS, FunctionName: 'zq' }, 'Res', (t) =>
        t === 'zq' ? '***' : t
      );

      const line = reportFor('CreateEventSourceMapping')!;
      expect(line).toContain('to function ***');
      expect(line).not.toMatch(/\bzq\b/);
      expect(line).toContain('--uuid uuid-1 ');
    });
  });

  it('parseLayerCreatedDate reads the documented +0000 spelling, and refuses what does not parse', () => {
    expect(parseLayerCreatedDate('2018-11-27T15:10:45.123+0000')?.toISOString()).toBe(
      '2018-11-27T15:10:45.123Z'
    );
    expect(parseLayerCreatedDate('2018-11-27T15:10:45.123-0130')?.toISOString()).toBe(
      '2018-11-27T16:40:45.123Z'
    );
    expect(parseLayerCreatedDate('2018-11-27T15:10:45.123Z')?.toISOString()).toBe(
      '2018-11-27T15:10:45.123Z'
    );
    expect(parseLayerCreatedDate('not a date')).toBeUndefined();
    expect(parseLayerCreatedDate(undefined)).toBeUndefined();
  });

  it.each([
    ['CreateEventSourceMappingCommand', 'ListEventSourceMappingsCommand', ESM, KAFKA_PROPS],
    ['PublishLayerVersionCommand', 'ListLayerVersionsCommand', LAYER, LAYER_PROPS],
  ] as const)(
    'sends %s through a client that refuses the SDK retry of a 5xx, and %s through one that does not',
    async (create, list, type, props) => {
      aws.loseNextCreateResponse = transient500();

      await createWithRetry(type, props);

      const createConfig = sentVia.find(([name]) => name === create)![1];
      const strategy = (await createConfig.retryStrategy()) as typeof baseStrategy;
      await expect(
        strategy.refreshRetryTokenForRetry('t', { error: transient500() } as never)
      ).rejects.toThrow();
      await expect(
        strategy.refreshRetryTokenForRetry('t', { error: throttled() } as never)
      ).resolves.toBe('retry-token');
      const listConfig = sentVia.find(([name]) => name === list)![1];
      expect(await listConfig.retryStrategy()).toBe(baseStrategy);
    }
  );

  it.each([
    ['CreateEventSourceMappingCommand', ESM, KAFKA_PROPS],
    ['PublishLayerVersionCommand', LAYER, LAYER_PROPS],
  ] as const)("builds the %s client once, in the shared client's region", async (create, type, props) => {
    const provider = type === ESM ? esm : layer;
    await Promise.all([provider.create('A', type, props), provider.create('B', type, props)]);

    const createConfig = sentVia.find(([name]) => name === create)![1];
    expect(await createConfig.region()).toBe('eu-west-3');
    // Two concurrent creates on a cold provider build ONE create client.
    expect(ctorArgs.map((o) => o.region)).toEqual(['eu-west-3']);
  });

  it.each([
    ['CreateEventSourceMappingCommand', ESM, KAFKA_PROPS],
    ['PublishLayerVersionCommand', LAYER, LAYER_PROPS],
  ] as const)(
    "builds the %s client in the shared client's region, not the ambient one",
    async (create, type, props) => {
      // The shared client resolves a region the environment does not name
      // (AWS_REGION is eu-west-3): the create must follow the shared client.
      clients.sharedRegion = 'ap-south-2';

      await (type === ESM ? esm : layer).create('A', type, props);

      const createConfig = sentVia.find(([name]) => name === create)![1];
      expect(await createConfig.region()).toBe('ap-south-2');
      expect(ctorArgs.map((o) => o.region)).toEqual(['ap-south-2']);
    }
  );

  it.each([
    ['CreateEventSourceMappingCommand', ESM, KAFKA_PROPS],
    ['PublishLayerVersionCommand', LAYER, LAYER_PROPS],
  ] as const)(
    'a rejected region read is not cached: the next %s create builds the client',
    async (create, type, props) => {
      const provider = type === ESM ? esm : layer;
      regionFails.remaining = 1;

      await expect(provider.create('A', type, props)).rejects.toThrow('Region is missing');
      expect(sentVia.some(([name]) => name === create)).toBe(false);

      await provider.create('B', type, props);
      expect(sentVia.filter(([name]) => name === create)).toHaveLength(1);
      expect(ctorArgs).toHaveLength(1);
    }
  );
});
