import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

  it('parseCfnTemplate (YAML) keeps the reason and position, not the code frame', () => {
    const body = 'Resources:\n  A:\n    Password: hunter2SECRET\n   bad: [unclosed\n';
    // Premise: the `yaml` library quotes the source lines in its message.
    const err = caughtFrom(() => parseCfnTemplate(body));
    expect(loggedText(loggerSpies.debug)).toContain(LEAK_TOKEN);
    expect((err as Error).message).toMatch(
      /^Template is not valid YAML\. Cause: \S.* at line \d+, column \d+$/
    );
    expectNoLeakIn(err);
    for (const fn of [loggerSpies.info, loggerSpies.warn, loggerSpies.error]) {
      expect(loggedText(fn)).not.toContain(LEAK_TOKEN);
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
