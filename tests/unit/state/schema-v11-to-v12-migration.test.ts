import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';
import type { S3Client } from '@aws-sdk/client-s3';
import { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import {
  STATE_SCHEMA_VERSION_CURRENT,
  STATE_SCHEMA_VERSIONS_READABLE,
  type StackState,
} from '../../../src/types/state.js';
import { StateError } from '../../../src/utils/error-handler.js';
import { clearBucketRegionCache } from '../../../src/utils/aws-region-resolver.js';
import { isKnownTokenFreeState } from '../../../src/state/token-free-state.js';
import {
  recordedProvenanceOf,
  referenceProvenanceOf,
} from '../../../src/deployment/reference-provenance-record.js';

/**
 * Schema v12 — `ResourceState.referenceProvenance` /
 * `StackState.outputReferenceProvenance` (go-to-k/cdkd#4847 / go-to-k/cdkd#4852).
 *
 * The integ test `tests/integration/schema-v11-to-v12-migration/` proves the
 * round trip against real AWS. This pins the in-memory contract through the
 * REAL `S3StateBackend` read path, over VERBATIM v11 documents (the shapes a
 * v11 binary writes): v12 is current and every older version readable, a v11
 * document is read unchanged with both fields absent ("not known", the v11
 * reading in every reader), reading rewrites nothing, the token-free fast path
 * is decided from the body, a v12 document round-trips, and a version past 12
 * is refused with "Upgrade cdkd" (as a v11 binary refuses 12). What the
 * migration DEPLOY writes (only the field, idempotent, no plaintext) is pinned
 * through the real engine in
 * `tests/unit/deployment/deploy-engine-reference-provenance-v12.test.ts`.
 */
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({ Account: '999999999999' }),
    destroy: vi.fn(),
  })),
  GetCallerIdentityCommand: vi.fn().mockImplementation((input) => ({ ...input })),
}));

vi.mock('../../../src/utils/aws-region-resolver.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../src/utils/aws-region-resolver.js')
  >('../../../src/utils/aws-region-resolver.js');
  return { ...actual, resolveBucketRegion: vi.fn() };
});

vi.mock('../../../src/utils/logger.js', () => {
  const fns = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { getLogger: () => ({ ...fns, child: () => fns }) };
});

function makeClient(): { send: ReturnType<typeof vi.fn> } & Record<string, unknown> {
  return {
    send: vi.fn(),
    destroy: vi.fn(),
    config: {
      region: () => Promise.resolve('us-east-1'),
      credentials: () =>
        Promise.resolve({ accessKeyId: 'AKIAFAKE', secretAccessKey: 'fake-secret' }),
    },
  };
}

const TOKEN = '{{resolve:secretsmanager:app/queue:SecretString:name::}}';

/** A v11 binary's `state.json` for a queue NAMED from a secret and a reader of its ARN. */
const V11_SECRET_BEARING = `{
  "version": 11,
  "stackName": "MigrateV12",
  "region": "us-east-1",
  "resources": {
    "Queue": {
      "physicalId": "https://sqs.us-east-1.amazonaws.com/123456789012/q-name-1",
      "resourceType": "AWS::SQS::Queue",
      "properties": {
        "QueueName": "${TOKEN}"
      },
      "attributes": {
        "Arn": "arn:aws:sqs:us-east-1:123456789012:${TOKEN}",
        "QueueUrl": "https://sqs.us-east-1.amazonaws.com/123456789012/q-name-1"
      },
      "dependencies": [],
      "provisionedBy": "sdk",
      "constructPath": "MigrateV12/Queue/Resource"
    },
    "Reader": {
      "physicalId": "/migrate/reader",
      "resourceType": "AWS::SSM::Parameter",
      "properties": {
        "Name": "/migrate/reader",
        "Type": "String",
        "Value": "arn:aws:sqs:us-east-1:123456789012:${TOKEN}"
      },
      "attributes": {},
      "dependencies": ["Queue"],
      "provisionedBy": "sdk"
    }
  },
  "outputs": {
    "QueueArn": "arn:aws:sqs:us-east-1:123456789012:${TOKEN}"
  },
  "exportNames": [],
  "lastModified": 1791800000000
}`;

/** A v11 binary's `state.json` for a stack that holds no secret reference. */
const V11_TOKEN_FREE = `{
  "version": 11,
  "stackName": "PlainV11",
  "region": "us-east-1",
  "resources": {
    "Bucket": {
      "physicalId": "plain-bucket-123",
      "resourceType": "AWS::S3::Bucket",
      "properties": { "BucketName": "plain-bucket-123" },
      "attributes": { "Arn": "arn:aws:s3:::plain-bucket-123" },
      "dependencies": [],
      "provisionedBy": "sdk"
    }
  },
  "outputs": { "BucketName": "plain-bucket-123" },
  "exportNames": [],
  "lastModified": 1791800000000
}`;

describe('State schema v12 — referenceProvenance / outputReferenceProvenance (#4847, #4852)', () => {
  let client: ReturnType<typeof makeClient>;
  let backend: S3StateBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    clearBucketRegionCache();
    const { resolveBucketRegion } = await import('../../../src/utils/aws-region-resolver.js');
    vi.mocked(resolveBucketRegion).mockResolvedValue('us-east-1');
    client = makeClient();
    backend = new S3StateBackend(
      client as unknown as S3Client,
      { bucket: 'b', prefix: 'cdkd' },
      { region: 'us-east-1' }
    );
  });

  const serve = (body: string): void => {
    client.send.mockResolvedValueOnce({
      Body: { transformToString: () => Promise.resolve(body) },
      ETag: '"e"',
    });
  };

  it('v12 is the current version, and every version 1..12 is readable', () => {
    expect(STATE_SCHEMA_VERSION_CURRENT).toBe(12);
    for (const v of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      expect(STATE_SCHEMA_VERSIONS_READABLE).toContain(v);
    }
    expect(STATE_SCHEMA_VERSIONS_READABLE).not.toContain(13);
  });

  it('reads a verbatim v11 document unchanged, both fields absent, and writes nothing on read', async () => {
    serve(V11_SECRET_BEARING);
    const state = (await backend.getState('MigrateV12', 'us-east-1'))?.state as StackState;
    expect(state).toEqual(JSON.parse(V11_SECRET_BEARING));
    expect(state.version).toBe(11);
    expect(state.outputReferenceProvenance).toBeUndefined();
    for (const record of Object.values(state.resources)) {
      expect(Object.hasOwn(record, 'referenceProvenance')).toBe(false);
      // ABSENT reads as "not known": every reader takes the v11 path.
      expect(referenceProvenanceOf(record)).toBeUndefined();
      expect(recordedProvenanceOf(record, TOKEN)).toBeUndefined();
    }
    // Reading never rewrites: the only S3 call was the GET.
    expect(client.send).toHaveBeenCalledTimes(1);
    // A token-bearing body is NOT on the token-free fast path.
    expect(isKnownTokenFreeState(state)).toBe(false);
  });

  it('marks a verbatim token-free v11 document for the fast path, from the body alone', async () => {
    serve(V11_TOKEN_FREE);
    const state = (await backend.getState('PlainV11', 'us-east-1'))?.state as StackState;
    expect(state).toEqual(JSON.parse(V11_TOKEN_FREE));
    expect(isKnownTokenFreeState(state)).toBe(true);
  });

  it('reads a v12 document carrying both fields as written, and off the fast path', async () => {
    const v12 = JSON.parse(V11_SECRET_BEARING) as StackState;
    v12.version = 12;
    v12.resources['Queue']!.referenceProvenance = {
      [TOKEN]: { region: 'us-east-1', versions: ['a1b2c3d4-0000-1111-2222-333333333333'] },
    };
    v12.resources['Reader']!.referenceProvenance = { [TOKEN]: { region: 'us-east-1' } };
    v12.outputReferenceProvenance = { QueueArn: { [TOKEN]: { region: 'us-east-1' } } };
    serve(JSON.stringify(v12));
    const state = (await backend.getState('MigrateV12', 'us-east-1'))?.state as StackState;
    expect(state).toEqual(v12);
    expect(recordedProvenanceOf(state.resources['Queue'], TOKEN)).toEqual({
      region: 'us-east-1',
      versions: ['a1b2c3d4-0000-1111-2222-333333333333'],
    });
    expect(isKnownTokenFreeState(state)).toBe(false);
  });

  it('a body holding only an empty provenance field is still off the fast path', async () => {
    const v12 = JSON.parse(V11_TOKEN_FREE) as StackState;
    v12.version = 12;
    v12.resources['Bucket']!.referenceProvenance = {};
    serve(JSON.stringify(v12));
    const state = (await backend.getState('PlainV11', 'us-east-1'))?.state as StackState;
    expect(isKnownTokenFreeState(state)).toBe(false);
  });

  it('refuses version 13 with the "Upgrade cdkd" error, as a v11 binary refuses 12', async () => {
    serve(JSON.stringify({ version: 13, stackName: 'X', resources: {}, outputs: {}, lastModified: 0 }));
    const caught = await backend.getState('X', 'us-east-1').catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(StateError);
    expect((caught as Error).message).toMatch(/Unsupported state schema version 13/);
    expect((caught as Error).message).toMatch(/1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12/);
    expect((caught as Error).message).toMatch(/Upgrade cdkd/);
  });

  it('saves a v12 document with the fields intact', async () => {
    client.send.mockResolvedValueOnce({ ETag: '"new"' });
    const v12 = JSON.parse(V11_SECRET_BEARING) as StackState;
    v12.resources['Queue']!.referenceProvenance = {
      [TOKEN]: { region: 'us-east-1', versions: ['a1b2c3d4-0000-1111-2222-333333333333'] },
    };
    await backend.saveState('MigrateV12', 'us-east-1', v12);
    const put = client.send.mock.calls.find(
      ([command]) => (command as { input?: { Body?: unknown } }).input?.Body !== undefined
    );
    const body = JSON.parse(
      String((put![0] as { input: { Body: string } }).input.Body)
    ) as StackState;
    expect(body.version).toBe(12);
    expect(body.resources['Queue']!.referenceProvenance).toEqual(
      v12.resources['Queue']!.referenceProvenance
    );
  });
});
