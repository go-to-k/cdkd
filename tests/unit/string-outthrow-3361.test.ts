import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Issue [#3361](https://github.com/go-to-k/cdkd/issues/3361), the synthesis /
 * assets / analyzer / top-level CLI / retry-marks slice: each site built its
 * text with `x instanceof Error ? x.message : String(x)` (or a bare
 * `String(x)` fallback), and `String(Object.create(null))` throws
 * `TypeError: Cannot convert object to primitive value`. The handler then
 * replaced the failure it was reporting with that TypeError.
 *
 * Every case feeds exactly that value and asserts the handler's OWN outcome
 * (its error class, its message, its return) plus the placeholder, so a fix
 * that dropped the failure text would not pass either.
 *
 * Sites that only ever see an `Error` (`parseResourceTimeoutToken`'s
 * `parseDuration` catch in `src/cli/options.ts`, and the two
 * `parseCfnTemplate` catches in `src/cli/commands/retire-cfn-stack.ts`, whose
 * callee always throws an `Error` it built itself) are converted as hygiene
 * and have no non-`Error` input to feed; the YAML / JSON parse catches are
 * driven here by stubbing the parser, since the real parsers throw `Error`s.
 */

const yamlParseOverride = vi.hoisted(() => ({ fn: undefined as undefined | (() => unknown) }));
vi.mock('yaml', async (importOriginal) => {
  const actual = await importOriginal<typeof import('yaml')>();
  return {
    ...actual,
    parse: (...args: Parameters<typeof actual.parse>) =>
      yamlParseOverride.fn !== undefined ? yamlParseOverride.fn() : actual.parse(...args),
    // `parseCfnTemplate` parses through `parseDocument` since #5254, which
    // stopped `parse`'s `process.emitWarning` printing a code frame.
    parseDocument: (...args: Parameters<typeof actual.parseDocument>) =>
      yamlParseOverride.fn !== undefined
        ? yamlParseOverride.fn()
        : actual.parseDocument(...args),
  };
});

vi.mock('@aws-sdk/client-cloudformation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aws-sdk/client-cloudformation')>()),
  waitUntilChangeSetCreateComplete: vi.fn(async () => ({})),
}));

const loggerSpies = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../../src/utils/logger.js', () => ({
  getLogger: () => ({ ...loggerSpies, child: () => loggerSpies }),
}));

import { expandMacros } from '../../src/synthesis/macro-expander.js';
import { stageScopedError } from '../../src/synthesis/failed-stages.js';
import { AssemblyReader } from '../../src/synthesis/assembly-reader.js';
import { AssetManifestLoader } from '../../src/assets/asset-manifest-loader.js';
import { FileAssetPublisher } from '../../src/assets/file-asset-publisher.js';
import { diffSecurity } from '../../src/analyzer/security-diff.js';
import { parseCfnTemplate } from '../../src/cli/yaml-cfn.js';
import { injectRetainPolicies } from '../../src/cli/commands/retire-cfn-stack.js';
import { wrapMaskedAwsError, hasRedactedCause } from '../../src/deployment/retryable-errors/marks.js';
import type { ResourceChange } from '../../src/types/state.js';

/** What `describeAwsFailure(x).detail` / `safeStringify(x)` render for a value `String()` cannot convert. */
const PLACEHOLDER = 'a value that could not be converted to text';

/** A value whose `String()` throws. */
const unconvertible = (): unknown => Object.create(null) as unknown;

/**
 * Make `JSON.parse` throw `unconvertible()` for exactly the text `body`, and
 * parse everything else for real. Keyed on the INPUT rather than on call order,
 * so an unrelated parse between installing the stub and reaching the site
 * cannot consume it; `hits()` lets the case assert the stub really fired.
 */
const jsonParseThrowsOn = (body: string): { hits: () => number } => {
  const realParse = JSON.parse.bind(JSON);
  let hits = 0;
  vi.spyOn(JSON, 'parse').mockImplementation((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
    if (text === body) {
      hits++;
      throw unconvertible();
    }
    return realParse(text, reviver);
  });
  return { hits: () => hits };
};

beforeEach(() => {
  vi.clearAllMocks();
  yamlParseOverride.fn = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('src/synthesis (#3361)', () => {
  const SAM_TEMPLATE = {
    Transform: ['AWS::Serverless-2016-10-31'],
    Resources: { Fn: { Type: 'AWS::Serverless::Function', Properties: {} } },
  };

  it('expandMacros: a CreateChangeSet rejecting unconvertibly throws the MacroExpansionError, not a TypeError', async () => {
    const send = vi.fn(async () => {
      throw unconvertible();
    });
    const err = await expandMacros(SAM_TEMPLATE, {
      region: 'us-east-1',
      stateBucket: 'cdkd-state-123456789012',
      cfnClient: { send, destroy: vi.fn() } as never,
    }).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe('MacroExpansionError');
    expect((err as Error).message).toContain(
      'CloudFormation rejected the macro-expansion changeset: '
    );
    expect((err as Error).message).toContain(PLACEHOLDER);
  });

  it('expandMacros: a Processed-stage body whose parse throws unconvertibly is a MacroExpansionError', async () => {
    const MACRO_BODY = '{"Resources":{},"_3361":"macro"}';
    const stub = jsonParseThrowsOn(MACRO_BODY);
    const send = vi.fn(async (cmd: { constructor: { name: string } }) => {
      const name = cmd.constructor.name;
      if (name === 'CreateChangeSetCommand') return { Id: 'cs', StackId: 's' };
      if (name === 'GetTemplateCommand') return { TemplateBody: MACRO_BODY };
      return {};
    });
    const err = await expandMacros(SAM_TEMPLATE, {
      region: 'us-east-1',
      stateBucket: 'cdkd-state-123456789012',
      cfnClient: { send, destroy: vi.fn() } as never,
    }).then(
      () => undefined,
      (e: unknown) => e
    );
    expect((err as Error).name).toBe('MacroExpansionError');
    expect((err as Error).message).toContain('non-JSON Processed-stage template body');
    // The size-only form since #5254, which never renders the thrown value.
    expect((err as Error).message).toContain(
      `Cause: invalid JSON; ${Buffer.byteLength(MACRO_BODY, 'utf8')} byte(s) read`
    );
    expect(stub.hits()).toBe(1);
  });

  it('stageScopedError renders an unconvertible value instead of throwing', () => {
    const scoped = stageScopedError('Prod', unconvertible()) as Error;
    expect(scoped.name).toBe('SynthesisError');
    expect(scoped.message).toBe(`Stage Prod: ${PLACEHOLDER}`);
  });

  describe('AssemblyReader.readManifest', () => {
    const ASM_BODY = '{"version":"1","_3361":"asm"}';
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'cdkd-3361-asm-'));
      writeFileSync(join(dir, 'manifest.json'), ASM_BODY);
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('a parse throwing unconvertibly is a SynthesisError naming the manifest', () => {
      const stub = jsonParseThrowsOn(ASM_BODY);
      let caught: unknown;
      try {
        new AssemblyReader().readManifest(dir);
      } catch (e) {
        caught = e;
      }
      expect((caught as Error).name).toBe('SynthesisError');
      expect((caught as Error).message).toContain('Failed to read cloud assembly manifest');
      expect((caught as Error).message).toContain(PLACEHOLDER);
      expect(stub.hits()).toBe(1);
    });
  });
});

describe('src/assets (#3361)', () => {
  const ASSETS_BODY = '{"files":{},"dockerImages":{},"_3361":"assets"}';
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cdkd-3361-assets-'));
    writeFileSync(join(dir, 'S.assets.json'), ASSETS_BODY);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('AssetManifestLoader.loadManifest: a parse throwing unconvertibly is its own load failure', async () => {
    const stub = jsonParseThrowsOn(ASSETS_BODY);
    const err = await new AssetManifestLoader().loadManifest(dir, 'S').then(
      () => undefined,
      (e: unknown) => e
    );
    expect((err as Error).message).toContain('Failed to load asset manifest from');
    expect((err as Error).message).toContain(PLACEHOLDER);
    expect(stub.hits()).toBe(1);
  });

  it('FileAssetPublisher.objectExists: a HeadObject rejecting unconvertibly is its own check failure', async () => {
    const client = { send: vi.fn(() => Promise.reject(unconvertible())) };
    const publisher = new FileAssetPublisher();
    const objectExists = (
      publisher as unknown as {
        objectExists(c: unknown, b: string, k: string): Promise<boolean>;
      }
    ).objectExists.bind(publisher);
    const err = await objectExists(client, 'bucket', 'key').then(
      () => undefined,
      (e: unknown) => e
    );
    expect((err as Error).message).toBe(
      `Failed to check S3 object s3://bucket/key: UnknownError: ${PLACEHOLDER}`
    );
  });

  it('FileAssetPublisher.objectExists: a rejection whose name and message are unconvertible is its own check failure', async () => {
    const client = {
      send: vi.fn(() => Promise.reject({ name: unconvertible(), message: unconvertible() })),
    };
    const publisher = new FileAssetPublisher();
    const objectExists = (
      publisher as unknown as {
        objectExists(c: unknown, b: string, k: string): Promise<boolean>;
      }
    ).objectExists.bind(publisher);
    const err = await objectExists(client, 'bucket', 'key').then(
      () => undefined,
      (e: unknown) => e
    );
    expect((err as Error).message).toBe(
      `Failed to check S3 object s3://bucket/key: ${PLACEHOLDER}: ${PLACEHOLDER}`
    );
  });

  it('FileAssetPublisher.objectExists: a HeadObject rejecting with null is its own check failure', async () => {
    const client = { send: vi.fn(() => Promise.reject(null)) };
    const publisher = new FileAssetPublisher();
    const objectExists = (
      publisher as unknown as {
        objectExists(c: unknown, b: string, k: string): Promise<boolean>;
      }
    ).objectExists.bind(publisher);
    const err = await objectExists(client, 'bucket', 'key').then(
      () => undefined,
      (e: unknown) => e
    );
    expect((err as Error).message).toBe(
      'Failed to check S3 object s3://bucket/key: UnknownError: null'
    );
  });
});

describe('src/analyzer/security-diff (#3361)', () => {
  it('diffSecurity: a classifier failure throwing unconvertibly is SECURITY_DIFF_FAILED, not a TypeError', async () => {
    // `structuredClone` reads every own property through [[Get]], so a getter
    // throwing an unconvertible value surfaces inside the gate's try.
    const hostile = {};
    Object.defineProperty(hostile, 'Effect', {
      enumerable: true,
      get() {
        throw unconvertible();
      },
    });
    const change = {
      logicalId: 'Role',
      changeType: 'CREATE',
      resourceType: 'AWS::IAM::Role',
      desiredProperties: { AssumeRolePolicyDocument: { Statement: [hostile] } },
    } as unknown as ResourceChange;
    const err = await diffSecurity({ stackName: 'S', changes: [change], records: {} }).then(
      () => undefined,
      (e: unknown) => e
    );
    expect((err as { code?: string }).code).toBe('SECURITY_DIFF_FAILED');
    expect((err as Error).message).toContain(PLACEHOLDER);
  });
});

describe('src/cli/yaml-cfn and retire-cfn-stack (#3361)', () => {
  it('parseCfnTemplate (JSON): a parse throwing unconvertibly is "not valid JSON"', () => {
    const body = '{"Resources":{},"_3361":"yaml-cfn"}';
    const stub = jsonParseThrowsOn(body);
    expect(() => parseCfnTemplate(body)).toThrow(
      // The size-only form since #5254, which never renders the thrown value.
      `Template is not valid JSON. Cause: invalid JSON; ${Buffer.byteLength(body, 'utf8')} byte(s) read`
    );
    expect(stub.hits()).toBe(1);
  });

  it('parseCfnTemplate (YAML): a parse throwing unconvertibly is "not valid YAML"', () => {
    yamlParseOverride.fn = () => {
      throw unconvertible();
    };
    expect(() => parseCfnTemplate('Resources: {}\n')).toThrow(
      `Template is not valid YAML. Cause: ${PLACEHOLDER}`
    );
  });

  it('injectRetainPolicies quotes parseCfnTemplate\'s (always-Error) refusal for an unconvertible parse failure', () => {
    // Its own catch only ever receives the `Error` parseCfnTemplate builds, so
    // this pins the end-to-end text, not that catch's non-Error arm.
    const body = '{"Resources":{},"_3361":"retire"}';
    const stub = jsonParseThrowsOn(body);
    expect(() => injectRetainPolicies(body, 'Legacy')).toThrow(
      `Cause: Template is not valid JSON. Cause: invalid JSON; ${Buffer.byteLength(body, 'utf8')} byte(s) read`
    );
    expect(stub.hits()).toBe(1);
  });
});

describe('src/deployment/retryable-errors/marks (#3361)', () => {
  it('wrapMaskedAwsError builds the wrap from the placeholder and leaves it unstamped', () => {
    const wrapped = wrapMaskedAwsError(
      (t) => t,
      unconvertible(),
      (masked) => new Error(`Failed to delete X: ${masked}`)
    );
    expect(wrapped.message).toBe(`Failed to delete X: ${PLACEHOLDER}`);
    expect(hasRedactedCause(wrapped)).toBe(false);
  });
});
