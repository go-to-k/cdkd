/**
 * `Synthesizer` renders no manifest- or template-derived value raw
 * (issue go-to-k/cdkd#3479).
 *
 * The values here are a context key from the manifest's `missing` list, a
 * `stackName` off `StackInfo`, and the template's own `Transform` /
 * `Fn::Transform` names. C1 bytes (`U+0080`-`U+009F`), `U+0085`, the Unicode
 * line terminators and the Trojan-Source bidi overrides survive ordinary string
 * building, and `formatError` sanitizes only an error's `cause` — never its own
 * `message` — so a crafted value appends what reads as a second, cdkd-authored
 * line.
 *
 * One case here is deliberately NOT an error path: the `[macros] Expanding ...`
 * line is a `logger.info` at DEFAULT verbosity on a successful run, which is the
 * shape that kept being declared safe by reading it (PR go-to-k/cdkd#3506 found
 * `Publishing assets for stack:` doing exactly this).
 *
 * Both polarities are pinned per site, the hostile cases carry a DISTINCT marker
 * per interpolated value (go-to-k/cdkd#3243 measured that one shared marker
 * leaves the message's other interpolations unpinned), and the ordinary cases
 * pin the whole message BYTE FOR BYTE rather than a readable substring.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockExecute = vi.hoisted(() => vi.fn());
const mockReadManifest = vi.hoisted(() => vi.fn());
const mockAssemblyStacks = vi.hoisted(() => vi.fn());
const mockContextStoreLoad = vi.hoisted(() => vi.fn());
const mockContextStoreSave = vi.hoisted(() => vi.fn());
const mockExpandMacros = vi.hoisted(() => vi.fn());

// STABLE spies: `Synthesizer` captures `getLogger().child('Synthesizer')` once
// per instance, so a factory minting a fresh spy per call records nothing
// readable.
const { loggerSpies } = vi.hoisted(() => ({
  loggerSpies: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/synthesis/app-executor.js', () => ({
  AppExecutor: vi.fn().mockImplementation(() => ({ execute: mockExecute })),
}));

vi.mock('../../../src/synthesis/assembly-reader.js', () => ({
  AssemblyReader: vi.fn().mockImplementation(() => ({
    readManifest: mockReadManifest,
    readAssembly: (...args: unknown[]) => ({
      stacks: mockAssemblyStacks(...args),
      failedStages: [],
    }),
  })),
}));

vi.mock('../../../src/synthesis/context-store.js', () => ({
  ContextStore: vi.fn().mockImplementation(() => ({
    load: mockContextStoreLoad,
    save: mockContextStoreSave,
  })),
}));

vi.mock('../../../src/synthesis/context-providers/index.js', () => ({
  ContextProviderRegistry: vi.fn().mockImplementation(() => ({
    resolve: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('../../../src/synthesis/macro-expander.js', () => ({
  expandMacros: mockExpandMacros,
}));

const mockLoadCdkJson = vi.hoisted(() => vi.fn());
const mockLoadUserCdkJson = vi.hoisted(() => vi.fn());
vi.mock('../../../src/cli/config-loader.js', () => ({
  loadCdkJson: () => mockLoadCdkJson(),
  loadUserCdkJson: () => mockLoadUserCdkJson(),
}));

const mockStsSend = vi.hoisted(() => vi.fn());
const mockStsConfigRegion = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation(() => ({
    send: mockStsSend,
    destroy: vi.fn(),
    config: { region: mockStsConfigRegion },
  })),
  GetCallerIdentityCommand: vi.fn(),
}));

vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
  existsSync: () => false,
  statSync: () => ({ isDirectory: () => false }),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({ ...loggerSpies, child: () => loggerSpies, setLevel: vi.fn() }),
}));

import { Synthesizer } from '../../../src/synthesis/synthesizer.js';
import {
  CSI,
  ESC,
  hasForgingCharacter,
  LINE_SEP,
  LRI,
  NEL,
  RLO,
  ST,
} from '../_forging-characters.js';

/**
 * One hostile marker per interpolated value, each with its own sanitized twin.
 *
 * Every `A` entry carries its marker at the element's TRAILING EDGE and every
 * `B` entry mid-value, because those two positions test different things. A
 * mid-value marker is removed whether the list is sanitized per element or as
 * one joined string, so only an edge marker discriminates the two — and only on
 * a NON-LAST element, since a trailing marker on the last one is erased by
 * `displaySafe`'s own final trim either way. Each of this module's three joined
 * lists therefore leads with an `A`.
 */
const HOSTILE = {
  contextKeyA: { raw: `ssm:keyA${CSI}`, clean: 'ssm:keyA' },
  contextKeyB: { raw: `ami:key${LINE_SEP}B`, clean: 'ami:key B' },
  macroStackA: { raw: `MacroStackA${NEL}`, clean: 'MacroStackA' },
  macroStackB: { raw: `Macro${RLO}StackB`, clean: 'Macro StackB' },
  oversizeStack: { raw: `Oversize${ST}Stack`, clean: 'Oversize Stack' },
  infoStack: { raw: `Info${ESC}[2KStack`, clean: 'Info [2KStack' },
  transformA: { raw: `AWS::Serverless2016${LRI}`, clean: 'AWS::Serverless2016' },
  transformB: { raw: `My::Macro${NEL}v2`, clean: 'My::Macro v2' },
} as const;

function infoLines(): string[] {
  return loggerSpies.info.mock.calls.map((call) => String(call[0]));
}

async function messageOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the call to reject');
}

/** A template whose `Transform` names are chosen by whoever wrote it. */
function macroTemplate(transforms: readonly string[]): Record<string, unknown> {
  return {
    Transform: [...transforms],
    Resources: { F: { Type: 'AWS::Serverless::Function', Properties: {} } },
  };
}

beforeEach(() => {
  for (const spy of Object.values(loggerSpies)) spy.mockReset();
  mockExecute.mockReset();
  mockReadManifest.mockReset();
  mockAssemblyStacks.mockReset();
  mockContextStoreLoad.mockReset();
  mockContextStoreSave.mockReset();
  mockExpandMacros.mockReset();
  mockLoadCdkJson.mockReset();
  mockLoadUserCdkJson.mockReset();
  mockStsSend.mockReset();
  mockStsConfigRegion.mockReset();
  mockContextStoreLoad.mockReturnValue({});
  mockLoadCdkJson.mockReturnValue(null);
  mockLoadUserCdkJson.mockReturnValue(null);
  mockAssemblyStacks.mockReturnValue([]);
  mockStsSend.mockResolvedValue({ Account: '123456789012' });
  mockStsConfigRegion.mockRejectedValue(new Error('no region configured'));
  mockExpandMacros.mockResolvedValue({ Resources: {} });
  delete process.env['AWS_REGION'];
  delete process.env['AWS_DEFAULT_REGION'];
});

describe('Synthesizer renders manifest-derived values display-safe (#3479)', () => {
  describe('the no-progress refusal names every missing context key', () => {
    /**
     * Two iterations with the SAME missing keys is what trips the refusal, so
     * the manifest answers the same `missing` list both times.
     */
    function primeMissing(keys: readonly string[]): void {
      mockReadManifest.mockReturnValue({
        missing: keys.map((key) => ({ key, provider: 'ssm', props: {} })),
      });
    }

    it('sanitizes each key SEPARATELY, so a mid-list terminator cannot break the line', async () => {
      primeMissing([HOSTILE.contextKeyA.raw, HOSTILE.contextKeyB.raw]);
      const message = await messageOf(() =>
        new Synthesizer().synthesize({ app: 'node app.js', region: 'us-east-1' })
      );
      expect(message).toBe(
        'Context resolution made no progress. ' +
          `Missing context keys: ${HOSTILE.contextKeyA.clean}, ${HOSTILE.contextKeyB.clean}. ` +
          'Ensure cdk.context.json is correctly configured or required AWS permissions are granted.'
      );
      expect(hasForgingCharacter(message)).toBe(false);
    });

    it('leaves an ordinary key byte-identical', async () => {
      primeMissing(['ssm:account=1:parameterName=/db/host:region=us-east-1']);
      const message = await messageOf(() =>
        new Synthesizer().synthesize({ app: 'node app.js', region: 'us-east-1' })
      );
      expect(message).toBe(
        'Context resolution made no progress. ' +
          'Missing context keys: ssm:account=1:parameterName=/db/host:region=us-east-1. ' +
          'Ensure cdk.context.json is correctly configured or required AWS permissions are granted.'
      );
    });
  });

  describe('the unresolvable-region refusal lists every macro-bearing stack', () => {
    /** No region anywhere: not on the caller, the options, the env or the stacks. */
    function stacksWithNoRegion(names: readonly string[]): Record<string, unknown>[] {
      return names.map((stackName) => ({
        stackName,
        template: macroTemplate(['AWS::Serverless-2016-10-31']),
        region: undefined,
      }));
    }

    it('sanitizes each stack name SEPARATELY', async () => {
      const synthesizer = new Synthesizer();
      const message = await messageOf(() =>
        synthesizer.expandMacrosForStacks(
          stacksWithNoRegion([HOSTILE.macroStackA.raw, HOSTILE.macroStackB.raw]) as never,
          { app: 'node app.js' },
          { region: undefined }
        )
      );
      expect(message).toBe(
        `Stack(s) [${HOSTILE.macroStackA.clean}, ${HOSTILE.macroStackB.clean}] ` +
          'use CloudFormation macros (Transform / Fn::Transform) but cdkd could not resolve an ' +
          'AWS region for the expansion round-trip. Set AWS_REGION, pass --region <r>, or set ' +
          "env: { region: '<r>' } in your CDK Stack constructor."
      );
      expect(hasForgingCharacter(message)).toBe(false);
    });

    it('leaves ordinary stack names byte-identical', async () => {
      const synthesizer = new Synthesizer();
      const message = await messageOf(() =>
        synthesizer.expandMacrosForStacks(
          stacksWithNoRegion(['Alpha', 'Beta']) as never,
          { app: 'node app.js' },
          { region: undefined }
        )
      );
      expect(message).toBe(
        'Stack(s) [Alpha, Beta] use CloudFormation macros (Transform / Fn::Transform) but cdkd ' +
          'could not resolve an AWS region for the expansion round-trip. Set AWS_REGION, pass ' +
          "--region <r>, or set env: { region: '<r>' } in your CDK Stack constructor."
      );
    });
  });

  describe('the oversize-template refusal names the offending stack', () => {
    /**
     * Over the 51,200-byte inline `TemplateBody` ceiling, with no resolved
     * account and no `--state-bucket`, which is the branch that names the stack.
     */
    function oversizeStack(stackName: string): Record<string, unknown>[] {
      const template = macroTemplate(['AWS::Serverless-2016-10-31']);
      (template['Resources'] as Record<string, unknown>)['Big'] = {
        Type: 'AWS::S3::Bucket',
        Properties: { Description: 'x'.repeat(60_000) },
      };
      return [{ stackName, template, region: 'us-east-1' }];
    }

    it('sanitizes the stack name', async () => {
      const synthesizer = new Synthesizer();
      const message = await messageOf(() =>
        synthesizer.expandMacrosForStacks(
          oversizeStack(HOSTILE.oversizeStack.raw) as never,
          { app: 'node app.js' },
          { region: 'us-east-1' }
        )
      );
      expect(message.startsWith(`Stack ${JSON.stringify(HOSTILE.oversizeStack.clean)} uses CloudFormation`)).toBe(
        true
      );
      expect(hasForgingCharacter(message)).toBe(false);
    });

    it('leaves an ordinary stack name byte-identical', async () => {
      const synthesizer = new Synthesizer();
      const message = await messageOf(() =>
        synthesizer.expandMacrosForStacks(
          oversizeStack('ProdStack') as never,
          { app: 'node app.js' },
          { region: 'us-east-1' }
        )
      );
      expect(message.startsWith("Stack ProdStack uses CloudFormation")).toBe(true);
    });
  });

  describe('the macro-expansion progress line — a NORMAL-RUN logger.info, no error involved', () => {
    function macroStack(stackName: string, transforms: readonly string[]) {
      return [{ stackName, template: macroTemplate(transforms), region: 'us-east-1' }];
    }

    it('sanitizes the stack name and each transform, one marker per value', async () => {
      const synthesizer = new Synthesizer();
      await synthesizer.expandMacrosForStacks(
        macroStack(HOSTILE.infoStack.raw, [
          HOSTILE.transformA.raw,
          HOSTILE.transformB.raw,
        ]) as never,
        { app: 'node app.js' },
        { region: 'us-east-1', accountId: '123456789012' }
      );
      const lines = infoLines();
      expect(lines[0]).toBe(
        `[macros] Expanding CloudFormation macros for stack ${JSON.stringify(HOSTILE.infoStack.clean)} ` +
          `via CFn round-trip (transforms: ${HOSTILE.transformA.clean}, ` +
          `${HOSTILE.transformB.clean}; may take 30-60s)...`
      );
      // Every line the run emitted, not just the one asserted above.
      for (const line of lines) expect(hasForgingCharacter(line)).toBe(false);
    });

    it('leaves an ordinary stack and transform name byte-identical', async () => {
      const synthesizer = new Synthesizer();
      await synthesizer.expandMacrosForStacks(
        macroStack('ProdStack', ['AWS::Serverless-2016-10-31']) as never,
        { app: 'node app.js' },
        { region: 'us-east-1', accountId: '123456789012' }
      );
      expect(infoLines()[0]).toBe(
        "[macros] Expanding CloudFormation macros for stack ProdStack via CFn round-trip " +
          '(transforms: AWS::Serverless-2016-10-31; may take 30-60s)...'
      );
    });
  });
});
