import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';

/**
 * Issue [#5254](https://github.com/go-to-k/cdkd/issues/5254): the siblings of
 * go-to-k/cdkd#5247. Each site parsed a body with `JSON.parse` and printed
 * V8's `SyntaxError` text, which quotes a window of that body, into a thrown
 * message, a `cause` or a `warn`. Every case first proves V8 quotes the
 * token for the body it feeds, then pins the token as absent from the
 * message, the whole cause chain and every log level above `debug`, and
 * present at `debug`, where V8's text now goes.
 */

const mockCcSend = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-cloudcontrol', () => ({
  CloudControlClient: vi.fn().mockImplementation(() => ({ send: mockCcSend, destroy: vi.fn() })),
  GetResourceCommand: vi.fn().mockImplementation((input: object) => ({ ...input })),
  ListResourcesCommand: vi.fn().mockImplementation((input: object) => ({ ...input })),
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

import { AssetManifestLoader } from '../../src/assets/asset-manifest-loader.js';
import { parseBootstrapMarker } from '../../src/assets/asset-storage.js';
import { loadCdkJson } from '../../src/cli/config-loader.js';
import { parseCfnTemplate } from '../../src/cli/yaml-cfn.js';
import { AssemblyReader } from '../../src/synthesis/assembly-reader.js';
import { ContextStore } from '../../src/synthesis/context-store.js';
import { CcApiContextProvider } from '../../src/synthesis/context-providers/cc-api-provider.js';
import { formatError } from '../../src/utils/error-handler.js';
import {
  parseEvent as parseInvokeEvent,
  readEnvOverridesFile as readInvokeEnvVars,
} from '../../src/cli/commands/local-invoke.js';
import {
  parseEvent as parseAgentCoreEvent,
  readEnvOverridesFile as readAgentCoreEnvVars,
} from '../../src/cli/commands/local-invoke-agentcore.js';
import { readEnvOverridesFile as readRunTaskEnvVars } from '../../src/cli/commands/local-run-task.js';
import { readEnvOverridesFile as readStartApiEnvVars } from '../../src/cli/commands/local-start-api.js';
import { AssetPublisher } from '../../src/assets/asset-publisher.js';
import { loadPublishableAssetManifest } from '../../src/assets/asset-redirect.js';
import { WorkGraph } from '../../src/deployment/work-graph.js';
import {
  LEAK_BODY,
  LEAK_BODY_BYTES,
  LEAK_TOKEN,
  causeChainText,
  expectLeakTokenOnlyAtDebug,
  expectV8QuotesLeakToken,
  loggedText,
} from './_json-parse-leak.js';

const SIZE_ONLY = `invalid JSON; ${LEAK_BODY_BYTES} byte(s) read`;

function caughtFrom(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected the call to throw');
}

/** The message, the whole cause chain and `formatError`'s rendering. */
function expectNoLeakIn(err: unknown): void {
  expect(err).toBeInstanceOf(Error);
  expect(causeChainText(err)).not.toContain(LEAK_TOKEN);
  expect(formatError(err)).not.toContain(LEAK_TOKEN);
}

let dir: string;
beforeEach(() => {
  for (const fn of Object.values(loggerSpies)) fn.mockReset();
  mockCcSend.mockReset();
  dir = mkdtempSync(join(tmpdir(), 'cdkd-5254-'));
  expectV8QuotesLeakToken();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('JSON.parse failures quote no body (issue #5254)', () => {
  it('AssetManifestLoader.loadManifest', async () => {
    writeFileSync(join(dir, 'S.assets.json'), LEAK_BODY);
    const err = await new AssetManifestLoader().loadManifest(dir, 'S').catch((e: unknown) => e);
    expect((err as Error).message).toBe(
      `Failed to load asset manifest from ${join(dir, 'S.assets.json')}: ${SIZE_ONLY}`
    );
    expectNoLeakIn(err);
    expectLeakTokenOnlyAtDebug(loggerSpies);
  });

  it('parseBootstrapMarker keeps a SyntaxError cause, without the body', () => {
    const err = caughtFrom(() => parseBootstrapMarker(LEAK_BODY, 'cdkd-bootstrap/us-east-1.json'));
    expect(err).toMatchObject({ code: 'INVALID_BOOTSTRAP_MARKER' });
    // The stand-in keeps the class, so a `name` / `instanceof` reader still
    // classifies it, and carries the size instead of the window.
    const cause = (err as Error).cause;
    expect(cause).toBeInstanceOf(SyntaxError);
    expect((cause as Error).message).toBe(SIZE_ONLY);
    expectNoLeakIn(err);
    expectLeakTokenOnlyAtDebug(loggerSpies);
  });

  it('loadCdkJson warns with the size only', () => {
    writeFileSync(join(dir, 'cdk.json'), LEAK_BODY);
    expect(loadCdkJson(dir)).toBeNull();
    expect(loggerSpies.warn).toHaveBeenCalledWith(
      `Failed to parse ${join(dir, 'cdk.json')}: ${SIZE_ONLY}`
    );
    expectLeakTokenOnlyAtDebug(loggerSpies);
  });

  it('ContextStore.load warns with the size only', () => {
    writeFileSync(join(dir, 'cdk.context.json'), LEAK_BODY);
    expect(new ContextStore().load(dir)).toEqual({});
    expect(loggerSpies.warn).toHaveBeenCalledWith(`Failed to parse cdk.context.json: ${SIZE_ONLY}`);
    expectLeakTokenOnlyAtDebug(loggerSpies);
  });

  it('parseCfnTemplate (JSON)', () => {
    const err = caughtFrom(() => parseCfnTemplate(LEAK_BODY));
    expect((err as Error).message).toBe(`Template is not valid JSON. Cause: ${SIZE_ONLY}`);
    expectNoLeakIn(err);
    expectLeakTokenOnlyAtDebug(loggerSpies);
  });

  it('parseCfnTemplate (YAML) renders the error code and position, not the code frame', () => {
    const body = 'Resources:\n  A:\n    Password: hunter2SECRET\n   bad: [unclosed\n';
    // Premise: the `yaml` library quotes the source lines in its message.
    expect(() => parse(body)).toThrow(LEAK_TOKEN);
    const err = caughtFrom(() => parseCfnTemplate(body));
    expect((err as Error).message).toBe(
      'Template is not valid YAML. Cause: YAMLParseError BAD_INDENT at line 4, column 1'
    );
    expectNoLeakIn(err);
    expectLeakTokenOnlyAtDebug(loggerSpies);
  });

  // Reasons that interpolate a source token into the message's FIRST line,
  // and an unresolved alias, which `yaml` throws as a `ReferenceError` naming
  // the alias.
  it.each([
    ['a block scalar header', 'Password: |hunter2SECRET\n', 'YAMLParseError'],
    ['a stray token', 'Password: >2 hunter2SECRET\n', 'YAMLParseError'],
    ['an unresolved alias', 'Password: *hunter2SECRET\n', 'ReferenceError'],
  ])('parseCfnTemplate (YAML): %s names no source token', (_shape, body, cause) => {
    let first = '';
    try {
      parse(body);
    } catch (e) {
      first = String((e as Error).message).split('\n', 1)[0]!;
    }
    // Premise: the token is in the first line, so a first-line rule leaks it.
    expect(first).toContain(LEAK_TOKEN);
    const err = caughtFrom(() => parseCfnTemplate(body));
    expect((err as Error).message).toMatch(
      new RegExp(`^Template is not valid YAML\\. Cause: ${cause}( [A-Z_]+ at line \\d+, column \\d+)?$`)
    );
    expectNoLeakIn(err);
    expectLeakTokenOnlyAtDebug(loggerSpies);
  });

  it("parseCfnTemplate (YAML): cdkd's !GetAtt refusal keeps its fixed reason, never the scalar or the frame", () => {
    const body = 'A: hunter2SECRET\nX: !GetAtt hunter2Logical\nB: hunter2OTHER\n';
    const err = caughtFrom(() => parseCfnTemplate(body));
    // Premise: the library message (now only at debug) quotes the scalar and
    // a code frame of its line.
    const raw = loggedText(loggerSpies.debug);
    expect(raw).toContain("got 'hunter2Logical'");
    expect(raw).toContain('X: !GetAtt hunter2Logical');
    expect((err as Error).message).toBe(
      "Template is not valid YAML. Cause: !GetAtt requires '<LogicalId>.<Attribute>' at line 2, column 4"
    );
    expectNoLeakIn(err);
    expectLeakTokenOnlyAtDebug(loggerSpies);
  });

  it('parseCfnTemplate (YAML): the alias-exhaustion refusal keeps its fixed text', () => {
    // 11 levels of 10 aliases each: far past `toJS`'s alias count cap.
    const lines = ['a0: &a0 [hunter2]'];
    for (let n = 1; n <= 11; n++) {
      lines.push(`a${n}: &a${n} [${Array(10).fill(`*a${n - 1}`).join(', ')}]`);
    }
    const err = caughtFrom(() => parseCfnTemplate(lines.join('\n') + '\n'));
    expect((err as Error).message).toBe(
      'Template is not valid YAML. Cause: ReferenceError: Excessive alias count indicates a resource exhaustion attack'
    );
  });

  it('parseCfnTemplate (YAML): a warning is a warn line without the code frame, never stderr', () => {
    const emit = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    try {
      const body = 'Resources:\n  A:\n    Password: !hunter2SECRET value\n';
      expect(parseCfnTemplate(body)).toEqual({ Resources: { A: { Password: 'value' } } });
      expect(emit).not.toHaveBeenCalled();
      expect(loggedText(loggerSpies.warn)).toBe(
        'Template YAML warning: YAMLWarning TAG_RESOLVE_FAILED at line 3, column 15'
      );
      expectLeakTokenOnlyAtDebug(loggerSpies);
    } finally {
      emit.mockRestore();
    }
  });

  it('AssemblyReader.readManifest keeps a SyntaxError cause, without the body', () => {
    writeFileSync(join(dir, 'manifest.json'), LEAK_BODY);
    const err = caughtFrom(() => new AssemblyReader().readManifest(dir));
    expect((err as Error).name).toBe('SynthesisError');
    expect((err as Error).message).toBe(
      `Failed to read cloud assembly manifest from ${join(dir, 'manifest.json')}: ${SIZE_ONLY}`
    );
    expect((err as Error).cause).toBeInstanceOf(SyntaxError);
    expectNoLeakIn(err);
    expectLeakTokenOnlyAtDebug(loggerSpies);
  });

  it("AssemblyReader: a Stage's unparseable manifest is still classified `invalid JSON`", () => {
    // `manifestReadFailureText` reads `cause instanceof SyntaxError`; a stand-in
    // that lost the class would turn this into `unreadable`.
    mkdirSync(join(dir, 'assembly-Prod'));
    writeFileSync(join(dir, 'assembly-Prod', 'manifest.json'), LEAK_BODY);
    const err = caughtFrom(() =>
      new AssemblyReader().getAllStacks(dir, {
        version: '38.0.0',
        artifacts: {
          'assembly-Prod': {
            type: 'cdk:cloud-assembly',
            properties: { directoryName: 'assembly-Prod' },
          },
        },
      })
    );
    expect((err as Error).message).toContain('invalid JSON reading');
    expectNoLeakIn(err);
    expectLeakTokenOnlyAtDebug(loggerSpies);
  });

  it('CcApiContextProvider: GetResource model', async () => {
    mockCcSend.mockResolvedValue({ ResourceDescription: { Properties: LEAK_BODY } });
    const err = await new CcApiContextProvider({ region: 'us-east-1' })
      .resolve({ typeName: 'AWS::IAM::Role', exactIdentifier: 'r' })
      .catch((e: unknown) => e);
    expect((err as Error).message).toBe(
      `Cloud Control returned a resource model for AWS::IAM::Role that is not valid JSON: ${SIZE_ONLY}`
    );
    expectNoLeakIn(err);
    expectLeakTokenOnlyAtDebug(loggerSpies);
  });

  it('CcApiContextProvider: ListResources model', async () => {
    mockCcSend.mockResolvedValue({ ResourceDescriptions: [{ Properties: LEAK_BODY }] });
    const err = await new CcApiContextProvider({ region: 'us-east-1' })
      .resolve({ typeName: 'AWS::IAM::Role' })
      .catch((e: unknown) => e);
    expect((err as Error).message).toBe(
      `Cloud Control returned a resource model for AWS::IAM::Role that is not valid JSON: ${SIZE_ONLY}`
    );
    expectNoLeakIn(err);
    expectLeakTokenOnlyAtDebug(loggerSpies);
  });
});

describe('user-supplied local-* bodies quote no window (issue #5254)', () => {
  it.each([
    ['local invoke', readInvokeEnvVars],
    ['local invoke-agentcore', readAgentCoreEnvVars],
    ['local run-task', readRunTaskEnvVars],
    ['local start-api', readStartApiEnvVars],
  ] as const)('%s --env-vars file', (_name, read) => {
    const file = join(dir, 'env.json');
    writeFileSync(file, LEAK_BODY);
    const err = caughtFrom(() => read(file));
    expect((err as Error).message).toBe(
      `Failed to parse --env-vars file '${file}' as JSON: ${SIZE_ONLY}`
    );
    expectNoLeakIn(err);
    expectLeakTokenOnlyAtDebug(loggerSpies);
  });

  it.each([
    ['local invoke', parseInvokeEvent],
    ['local invoke-agentcore', parseAgentCoreEvent],
  ] as const)('%s event payload', (_name, parse) => {
    const err = caughtFrom(() => parse(LEAK_BODY, '<stdin>'));
    expect((err as Error).message).toBe(
      `Failed to parse event payload from <stdin> as JSON: ${SIZE_ONLY}`
    );
    expectNoLeakIn(err);
    expectLeakTokenOnlyAtDebug(loggerSpies);
  });
});

describe('asset manifest parses with no catch of their own (issue #5254)', () => {
  it('AssetPublisher.addAssetsToGraph', () => {
    const file = join(dir, 'S.assets.json');
    writeFileSync(file, LEAK_BODY);
    const err = caughtFrom(() =>
      new AssetPublisher().addAssetsToGraph(new WorkGraph(), file, {
        accountId: '123456789012',
        region: 'us-east-1',
      })
    );
    expect((err as Error).message).toBe(`Failed to load asset manifest from ${file}: ${SIZE_ONLY}`);
    expectNoLeakIn(err);
    expectLeakTokenOnlyAtDebug(loggerSpies);
  });

  it('loadPublishableAssetManifest', () => {
    const file = join(dir, 'S.assets.json');
    writeFileSync(file, LEAK_BODY);
    const err = caughtFrom(() => loadPublishableAssetManifest(file));
    expect((err as Error).message).toBe(`Failed to load asset manifest from ${file}: ${SIZE_ONLY}`);
    expectNoLeakIn(err);
    expectLeakTokenOnlyAtDebug(loggerSpies);
  });
});
