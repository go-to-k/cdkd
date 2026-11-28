/**
 * go-to-k/cdkd#7139: a pre-#7127 cdkd recorded an `AWS::AppSync::GraphQLSchema`
 * baseline while AppSync still served the schema the deploy replaced. The
 * inline heal (`preFixBaselineUncomparedDriftKeys`) needs a declared SDL, so a
 * schema sourced from `DefinitionS3Location` kept reporting `Definition`, and
 * `drift --revert` pushed the stale schema back. The provider's
 * `canonicalizeDriftPair` now reads the declared object, once, and only when
 * the comparison would otherwise report `Definition`.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-appsync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-appsync')>();
  return {
    ...actual,
    AppSyncClient: vi.fn(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

const childLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(function (this: unknown) {
    return this;
  }),
}));
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    child: () => childLogger,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { GetIntrospectionSchemaCommand } from '@aws-sdk/client-appsync';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { AppSyncProvider } from '../../../src/provisioning/providers/appsync-provider.js';
import { compareDriftReadback } from '../../../src/cli/commands/drift/compare.js';

const TYPE = 'AWS::AppSync::GraphQLSchema';
const LOCATION = 's3://cdk-assets-bucket/abc123.graphql';
/** The schema the deploy replaced, as the pre-#7127 capture recorded it (canonical). */
const STALE_DEFINITION = 'type Query {\n  a: String\n}';
/** The declared object's body: the deployed schema, as authored (comment, one line). */
const DECLARED_BODY = '# v2\ntype Query { a: String b: String }\n';
/** AppSync's SDL for the deployed schema (with the default schema block). */
const LIVE_V2 = 'schema {\n  query: Query\n}\n\ntype Query {\n  a: String\n  b: String\n}\n';
const LIVE_V2_CANONICAL = 'type Query {\n  a: String\n  b: String\n}';
/** An out-of-band schema, neither the declared nor the recorded one. */
const LIVE_OTHER = 'type Query {\n  c: String\n}\n';

const s3Send = vi.fn();
let provider: AppSyncProvider;

function serveLive(sdl: string): void {
  mockSend.mockImplementation(async (command: unknown) => {
    if (command instanceof GetIntrospectionSchemaCommand) {
      return { schema: new TextEncoder().encode(sdl) };
    }
    throw new Error(`test: unexpected ${String((command as object).constructor.name)}`);
  });
}

function serveBody(body: string): void {
  s3Send.mockImplementation(async (command: unknown) => {
    if (!(command instanceof GetObjectCommand)) throw new Error('test: unexpected S3 call');
    return { Body: { transformToString: () => Promise.resolve(body) } };
  });
}

function getObjectCalls(): number {
  return s3Send.mock.calls.filter((c) => c[0] instanceof GetObjectCommand).length;
}

/** One `cdkd drift` comparison of the seeded record; the reported change paths. */
async function driftPaths(
  properties: Record<string, unknown>,
  observedProperties: Record<string, unknown> | undefined
): Promise<string[]> {
  const resource = {
    resourceType: TYPE,
    physicalId: 'api-1',
    properties,
    ...(observedProperties ? { observedProperties } : {}),
    attributes: {},
  };
  const aws = (await provider.readCurrentState('api-1', 'Schema', TYPE, properties)) as Record<
    string,
    unknown
  >;
  const outcomes: Array<{ kind: string; changes?: Array<{ path: string }> }> = [];
  await compareDriftReadback({
    region: 'us-east-1',
    resolvePrincipalUniqueId: () => Promise.resolve(undefined),
    outcomes: outcomes as never,
    logger: childLogger as never,
    secretResolvers: {} as never,
    producerRegions: { regions: [], complete: true },
    stackSecretNames: new Map(),
    resource: resource as never,
    logicalId: 'Schema',
    provider,
    secrets: new Map(),
    printing: new Map(),
    aws,
  });
  expect(outcomes).toHaveLength(1);
  return (outcomes[0]!.changes ?? []).map((c) => c.path);
}

const S3_PROPS = { ApiId: 'api-1', DefinitionS3Location: LOCATION };
const STALE = { ApiId: 'api-1', Definition: STALE_DEFINITION };

beforeEach(() => {
  mockSend.mockReset();
  s3Send.mockReset();
  childLogger.debug.mockReset();
  provider = new AppSyncProvider();
  provider.s3Client = { send: s3Send } as never;
});

describe('drift heals a pre-#7127 DefinitionS3Location schema baseline (#7139)', () => {
  it('is clean while the live SDL is the declared object body, with one GetObject', async () => {
    serveLive(LIVE_V2);
    serveBody(DECLARED_BODY);
    expect(await driftPaths(S3_PROPS, STALE)).toEqual([]);
    expect(getObjectCalls()).toBe(1);
    expect(s3Send.mock.calls[0]![0].input).toEqual({
      Bucket: 'cdk-assets-bucket',
      Key: 'abc123.graphql',
    });
  });

  it('reports Definition when the live SDL is not the declared body', async () => {
    serveLive(LIVE_OTHER);
    serveBody(DECLARED_BODY);
    expect(await driftPaths(S3_PROPS, STALE)).toEqual(['Definition']);
  });

  it('reports Definition, and does not fail drift, when the object cannot be read; the log names the error class only', async () => {
    serveLive(LIVE_V2);
    s3Send.mockRejectedValue(
      Object.assign(new Error('Access Denied for token-sekrit-7139'), { name: 'AccessDenied' })
    );
    expect(await driftPaths(S3_PROPS, STALE)).toEqual(['Definition']);
    expect(getObjectCalls()).toBe(1);
    const lines = childLogger.debug.mock.calls.map((c) => c.map(String).join(' '));
    expect(lines.some((l) => l.includes('AccessDenied'))).toBe(true);
    expect(lines.some((l) => l.includes('token-sekrit-7139'))).toBe(false);
  });

  it('reports Definition when the object is empty', async () => {
    serveLive(LIVE_V2);
    serveBody('');
    expect(await driftPaths(S3_PROPS, STALE)).toEqual(['Definition']);
  });

  it('reads no object for a clean record', async () => {
    serveLive(LIVE_V2);
    expect(await driftPaths(S3_PROPS, { ApiId: 'api-1', Definition: LIVE_V2_CANONICAL })).toEqual(
      []
    );
    expect(getObjectCalls()).toBe(0);
  });

  it('reads no object for a record without an observed baseline', async () => {
    serveLive(LIVE_V2);
    await driftPaths(S3_PROPS, undefined);
    expect(getObjectCalls()).toBe(0);
  });

  it('reads no object for an inline Definition (the synchronous heal owns it)', async () => {
    serveLive(LIVE_V2);
    serveBody(DECLARED_BODY);
    const inline = { ApiId: 'api-1', Definition: 'type Query { a: String b: String }' };
    expect(await driftPaths(inline, STALE)).toEqual([]);
    expect(getObjectCalls()).toBe(0);
  });

  it('reads no object, and reports Definition, when the template declares both (inline wins)', async () => {
    serveLive(LIVE_V2);
    serveBody(DECLARED_BODY);
    const both = { ...S3_PROPS, Definition: 'type Query { z: String }' };
    expect(await driftPaths(both, STALE)).toEqual(['Definition']);
    expect(getObjectCalls()).toBe(0);
  });

  it("drift --revert's desired bag takes the live schema, never the stale one", async () => {
    serveBody(DECLARED_BODY);
    const live = { ApiId: 'api-1', Definition: LIVE_V2_CANONICAL };
    const { baseline } = await provider.canonicalizeDriftPair(TYPE, { ...STALE }, live, S3_PROPS);
    expect(baseline).toEqual({ ApiId: 'api-1', Definition: LIVE_V2_CANONICAL });
  });

  it("drift --revert's desired bag keeps the recorded schema when the live one is not declared", async () => {
    serveBody(DECLARED_BODY);
    const live = { ApiId: 'api-1', Definition: 'type Query {\n  c: String\n}' };
    const desired = { ...STALE };
    const out = await provider.canonicalizeDriftPair(TYPE, desired, live, S3_PROPS);
    expect(out.baseline).toBe(desired);
    expect(out.aws).toBe(live);
  });
});
