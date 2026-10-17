import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript-v6';

/**
 * Issue [#3361](https://github.com/go-to-k/cdkd/issues/3361), the CLI
 * "singletons" slice: eight files whose handlers rendered their caught value
 * with `x instanceof Error ? x.message : String(x)` (or a bare `String(x)`).
 * `String(Object.create(null))` throws
 * `TypeError: Cannot convert object to primitive value` from INSIDE the
 * handler, so the graceful degradation the handler exists for (a warning and a
 * fallback value, a skipped cleanup, a retry) became a hard failure.
 *
 * The behaviour cases reject with exactly that value and assert the
 * DEGRADATION still happens AND the placeholder is reported, so a fix that
 * swallowed the failure silently would not pass. The handlers no exported
 * entry point reaches (`local start-api`'s shutdown closure, `cdkd export`'s
 * per-stack loop) are held by the source scan at the bottom.
 */

const warnSpy = vi.hoisted(() => vi.fn());
const debugSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => {
  const l = {
    setLevel: vi.fn(),
    debug: debugSpy,
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: () => l,
  };
  return { getLogger: () => l };
});

const describeTypeMock = vi.hoisted(() => vi.fn());
vi.mock('../../../src/provisioning/describe-type.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/provisioning/describe-type.js')>()),
  describeTypeWithThrottleRetry: describeTypeMock,
}));

const { loadCdkJson } = await import('../../../src/cli/config-loader.js');
const { ContextStore } = await import('../../../src/synthesis/context-store.js');
const { rewriteResourceReferences } = await import('../../../src/analyzer/orphan-rewriter.js');
const { fetchPrimaryIdentifier } = await import('../../../src/cli/commands/export.js');
const { DockerAssetPublisher } = await import('../../../src/assets/docker-asset-publisher.js');

/** What `safeStringify` / `describeAwsFailure(x).detail` render for a value `String()` cannot convert. */
const PLACEHOLDER = 'a value that could not be converted to text';

/** A value whose `String()` throws. */
const unconvertible = (): unknown => Object.create(null) as unknown;

const tmpDirs: string[] = [];
function dirWith(file: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cdkd-3361-'));
  tmpDirs.push(dir);
  writeFileSync(join(dir, file), body, 'utf-8');
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  warnSpy.mockReset();
  debugSpy.mockReset();
  describeTypeMock.mockReset();
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('config readers degrade on an unconvertible parse failure (#3361)', () => {
  it('loadCdkJson warns with the placeholder and returns null', () => {
    const dir = dirWith('cdk.json', '{"app":"x"}');
    vi.spyOn(JSON, 'parse').mockImplementationOnce(() => {
      throw unconvertible();
    });

    expect(loadCdkJson(dir)).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(`Failed to parse ${join(dir, 'cdk.json')}: ${PLACEHOLDER}`);
  });

  it('ContextStore.load warns with the placeholder and returns an empty context', () => {
    const dir = dirWith('cdk.context.json', '{"k":"v"}');
    vi.spyOn(JSON, 'parse').mockImplementationOnce(() => {
      throw unconvertible();
    });

    expect(new ContextStore().load(dir)).toEqual({});
    expect(warnSpy).toHaveBeenCalledWith(`Failed to parse cdk.context.json: ${PLACEHOLDER}`);
  });

  it('keeps an Error message verbatim (control)', () => {
    const dir = dirWith('cdk.json', '{not json');

    expect(loadCdkJson(dir)).toBeNull();
    const msg = String(warnSpy.mock.calls[0]?.[0]);
    expect(msg.startsWith(`Failed to parse ${join(dir, 'cdk.json')}: `)).toBe(true);
    expect(msg).not.toContain(PLACEHOLDER);
  });
});

describe('orphan-rewriter provider lookup (#3361)', () => {
  it('reports the GetAtt as unresolvable with the placeholder instead of throwing', async () => {
    const registry = {
      getProviderFor: vi.fn(() => {
        throw unconvertible();
      }),
    };
    const state = {
      version: 2,
      stackName: 'TestStack',
      region: 'us-east-1',
      resources: {
        Bucket: { physicalId: 'b-phys', resourceType: 'AWS::S3::Bucket', properties: {} },
        Other: {
          physicalId: 'o-phys',
          resourceType: 'AWS::S3::Bucket',
          properties: { Target: { 'Fn::GetAtt': ['Bucket', 'Arn'] } },
        },
      },
      outputs: {},
      lastModified: 0,
    };

    const result = await rewriteResourceReferences(
      state as never,
      ['Bucket'],
      registry as never
    );

    expect(result.unresolvable).toHaveLength(1);
    expect(result.unresolvable[0]).toMatchObject({
      orphanLogicalId: 'Bucket',
      attribute: 'Arn',
      reason: `no provider available for AWS::S3::Bucket: ${PLACEHOLDER}`,
    });
  });
});

describe('export fetchPrimaryIdentifier DescribeType failure (#3361)', () => {
  it('falls back to the hardcoded identifier and debug-logs the placeholder', async () => {
    describeTypeMock.mockRejectedValueOnce(unconvertible());

    const entry = await fetchPrimaryIdentifier('AWS::S3::Bucket', {} as never);

    expect(entry.fields).toEqual(['BucketName']);
    expect(describeTypeMock).toHaveBeenCalledTimes(1);
    expect(debugSpy.mock.calls.some(([m]) => String(m).includes(PLACEHOLDER))).toBe(true);
  });
});

describe('docker push auth classification (#3361)', () => {
  function publisherWithPushRejecting(reason: unknown): {
    publisher: InstanceType<typeof DockerAssetPublisher>;
    ecrLogin: ReturnType<typeof vi.fn>;
  } {
    const publisher = new DockerAssetPublisher();
    const ecrLogin = vi.fn(async () => undefined);
    Object.assign(publisher, {
      tagImage: vi.fn(async () => undefined),
      pushImage: vi.fn(() => Promise.reject(reason)),
      ecrLogin,
    });
    return { publisher, ecrLogin };
  }

  const push = (p: InstanceType<typeof DockerAssetPublisher>): Promise<void> =>
    (
      p as unknown as {
        tagAndPushWithLazyLogin: (c: unknown, l: string, u: string, h: string) => Promise<void>;
      }
    ).tagAndPushWithLazyLogin({}, 'local:tag', 'uri', 'host');

  it.each([
    ['a null-prototype object', unconvertible()],
    ['null', null],
    ['undefined', undefined],
  ])('rethrows %s itself, not a TypeError from classifying it', async (_label, reason) => {
    const { publisher, ecrLogin } = publisherWithPushRejecting(reason);

    let caught: unknown = 'not thrown';
    try {
      await push(publisher);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(reason);
    expect(ecrLogin).not.toHaveBeenCalled();
  });
});

/**
 * The handlers above are the ones an exported entry point reaches. The rest
 * (the `local start-api` shutdown closure and reload disposal, `cdkd export`'s
 * per-stack loop and lock release, `cdkd import`'s mapping write, the
 * transient-template version purge) sit inside command bodies, so the files
 * are scanned instead: no `catch` clause or `.catch(cb)` handler in them may
 * read its own binding through `String(...)`.
 */
describe('no handler in the slice stringifies its caught value with String() (#3361)', () => {
  /** File -> the floor of handlers the scan must see, so a parse that saw nothing cannot pass. */
  const FILES: Readonly<Record<string, number>> = {
    'src/cli/commands/local-start-api.ts': 10,
    'src/cli/commands/export.ts': 20,
    'src/cli/commands/import.ts': 5,
    'src/analyzer/orphan-rewriter.ts': 1,
    'src/assets/docker-asset-publisher.ts': 1,
    'src/cli/config-loader.ts': 1,
    'src/cli/upload-cfn-template.ts': 1,
    'src/synthesis/context-store.ts': 1,
  };

  function scan(file: string): { handlers: number; offenders: string[] } {
    const text = readFileSync(join(process.cwd(), file), 'utf-8');
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    let handlers = 0;
    const offenders: string[] = [];
    const check = (binding: string, body: ts.Node): void => {
      handlers++;
      const walk = (n: ts.Node): void => {
        if (
          ts.isCallExpression(n) &&
          ts.isIdentifier(n.expression) &&
          n.expression.text === 'String' &&
          n.arguments.length === 1 &&
          ts.isIdentifier(n.arguments[0]!) &&
          n.arguments[0]!.text === binding
        ) {
          offenders.push(`${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`);
        }
        ts.forEachChild(n, walk);
      };
      walk(body);
    };
    const visit = (node: ts.Node): void => {
      if (
        ts.isCatchClause(node) &&
        node.variableDeclaration !== undefined &&
        ts.isIdentifier(node.variableDeclaration.name)
      ) {
        check(node.variableDeclaration.name.text, node.block);
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'catch' &&
        node.arguments.length === 1
      ) {
        const cb = node.arguments[0]!;
        if (
          (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) &&
          cb.parameters.length === 1 &&
          ts.isIdentifier(cb.parameters[0]!.name)
        ) {
          check(cb.parameters[0]!.name.text, cb.body);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return { handlers, offenders };
  }

  it.each(Object.entries(FILES))('%s', (file, floor) => {
    const { handlers, offenders } = scan(file);
    expect(handlers).toBeGreaterThanOrEqual(floor);
    expect(offenders).toEqual([]);
  });
});
