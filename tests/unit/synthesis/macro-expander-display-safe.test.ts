/**
 * `expandMacros` renders no template-derived transform name raw
 * (issue go-to-k/cdkd#3479).
 *
 * A transform name comes from the template's own `Transform` / `Fn::Transform`
 * node, so it is chosen by whoever wrote the assembly. It reaches the terminal
 * at three sites — a `logger.debug` line, and two `MacroExpansionError`
 * messages, whose own `message` `formatError` does NOT sanitize.
 *
 * The `detected transforms` case is a NORMAL-RUN log line on a successful
 * expansion, not an error path.
 *
 * Both polarities per site; the hostile cases use a DISTINCT marker per
 * interpolated value, and the ordinary cases pin the rendered bytes.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const waitUntilChangeSetCreateCompleteMock = vi.hoisted(() => vi.fn());

class FakeCommand {
  constructor(
    public readonly _name: string,
    public readonly input: Record<string, unknown>
  ) {}
}

const cfnCommands = vi.hoisted(() => {
  class FakeCfnCommand {
    constructor(
      public readonly _name: string,
      public readonly input: Record<string, unknown>
    ) {}
  }
  return {
    CreateChangeSetCommand: class extends FakeCfnCommand {
      constructor(input: Record<string, unknown>) {
        super('CreateChangeSet', input);
      }
    },
    DescribeChangeSetCommand: class extends FakeCfnCommand {
      constructor(input: Record<string, unknown>) {
        super('DescribeChangeSet', input);
      }
    },
    GetTemplateCommand: class extends FakeCfnCommand {
      constructor(input: Record<string, unknown>) {
        super('GetTemplate', input);
      }
    },
    DeleteChangeSetCommand: class extends FakeCfnCommand {
      constructor(input: Record<string, unknown>) {
        super('DeleteChangeSet', input);
      }
    },
    DeleteStackCommand: class extends FakeCfnCommand {
      constructor(input: Record<string, unknown>) {
        super('DeleteStack', input);
      }
    },
  };
});

vi.mock('@aws-sdk/client-cloudformation', () => ({
  CloudFormationClient: vi.fn(),
  CreateChangeSetCommand: cfnCommands.CreateChangeSetCommand,
  DescribeChangeSetCommand: cfnCommands.DescribeChangeSetCommand,
  GetTemplateCommand: cfnCommands.GetTemplateCommand,
  DeleteChangeSetCommand: cfnCommands.DeleteChangeSetCommand,
  DeleteStackCommand: cfnCommands.DeleteStackCommand,
  waitUntilChangeSetCreateComplete: waitUntilChangeSetCreateCompleteMock,
}));

const loggerSpies = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({ ...loggerSpies, child: () => loggerSpies }),
}));

import { expandMacros } from '../../../src/synthesis/macro-expander.js';
import { CSI, hasForgingCharacter, LINE_SEP, NEL, RLO } from '../_forging-characters.js';

/** One hostile marker per interpolated value, each with its own sanitized twin. */
const HOSTILE = {
  detectedA: { raw: `AWS::Serverless${CSI}2016`, clean: 'AWS::Serverless 2016' },
  detectedB: { raw: `My::Macro${NEL}v1`, clean: 'My::Macro v1' },
  involvedA: { raw: `Involved${LINE_SEP}Macro`, clean: 'Involved Macro' },
  innerA: { raw: `Inner${RLO}Macro`, clean: 'Inner Macro' },
} as const;

function macroTemplate(transforms: readonly string[]): Record<string, unknown> {
  return {
    Transform: [...transforms],
    Resources: { Fn: { Type: 'AWS::Serverless::Function', Properties: {} } },
  };
}

const EXPANDED = { Resources: { Fn: { Type: 'AWS::Lambda::Function', Properties: {} } } };

function buildCfnClient(responses: Record<string, unknown>) {
  const send = vi.fn(async (cmd: FakeCommand) => {
    if (cmd._name in responses) return responses[cmd._name];
    return {};
  });
  return { send, destroy: vi.fn() } as never;
}

function debugLines(): string[] {
  return loggerSpies.debug.mock.calls.map((call) => String(call[0]));
}

async function messageOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the call to reject');
}

const OPTS = { region: 'us-east-1', stateBucket: 'cdkd-state-123456789012' };

beforeEach(() => {
  for (const spy of Object.values(loggerSpies)) spy.mockReset();
  waitUntilChangeSetCreateCompleteMock.mockReset();
  waitUntilChangeSetCreateCompleteMock.mockResolvedValue({});
});

describe('expandMacros renders template-derived transform names display-safe (#3479)', () => {
  describe('the detected-transforms debug line — a NORMAL-RUN log, expansion succeeds', () => {
    it('sanitizes each transform name SEPARATELY', async () => {
      const cfnClient = buildCfnClient({
        CreateChangeSet: { Id: 'cs-arn', StackId: 's-arn' },
        GetTemplate: { TemplateBody: EXPANDED },
      });
      await expandMacros(macroTemplate([HOSTILE.detectedA.raw, HOSTILE.detectedB.raw]), {
        ...OPTS,
        cfnClient,
      });
      const lines = debugLines();
      expect(lines[0]).toBe(
        `Macro expansion: detected transforms [${HOSTILE.detectedA.clean}, ` +
          `${HOSTILE.detectedB.clean}], starting CFn round-trip...`
      );
      for (const line of lines) expect(hasForgingCharacter(line)).toBe(false);
    });

    it('leaves ordinary transform names byte-identical', async () => {
      const cfnClient = buildCfnClient({
        CreateChangeSet: { Id: 'cs-arn', StackId: 's-arn' },
        GetTemplate: { TemplateBody: EXPANDED },
      });
      await expandMacros(macroTemplate(['AWS::Serverless-2016-10-31', 'My::Macro']), {
        ...OPTS,
        cfnClient,
      });
      expect(debugLines()[0]).toBe(
        'Macro expansion: detected transforms [AWS::Serverless-2016-10-31, My::Macro], ' +
          'starting CFn round-trip...'
      );
    });
  });

  describe('the missing-TemplateBody refusal names the transforms involved', () => {
    function noTemplateBody() {
      return buildCfnClient({
        CreateChangeSet: { Id: 'cs-arn', StackId: 's-arn' },
        GetTemplate: {},
      });
    }

    it('sanitizes the transform name', async () => {
      const message = await messageOf(() =>
        expandMacros(macroTemplate([HOSTILE.involvedA.raw]), {
          ...OPTS,
          cfnClient: noTemplateBody(),
        })
      );
      expect(message.endsWith(`with the transforms involved: [${HOSTILE.involvedA.clean}].`)).toBe(
        true
      );
      expect(hasForgingCharacter(message)).toBe(false);
    });

    it('leaves an ordinary transform name byte-identical', async () => {
      const message = await messageOf(() =>
        expandMacros(macroTemplate(['AWS::Serverless-2016-10-31']), {
          ...OPTS,
          cfnClient: noTemplateBody(),
        })
      );
      expect(
        message.endsWith('with the transforms involved: [AWS::Serverless-2016-10-31].')
      ).toBe(true);
    });
  });

  describe('the multi-stage refusal names the transforms the EXPANSION still carries', () => {
    /**
     * The names in this message come from the CFn-returned Processed template,
     * a second assembly-influenced source: the macro the template named chose
     * what to emit.
     */
    function stillMacroed(innerTransforms: readonly string[]) {
      return buildCfnClient({
        CreateChangeSet: { Id: 'cs-arn', StackId: 's-arn' },
        GetTemplate: { TemplateBody: macroTemplate(innerTransforms) },
      });
    }

    it('sanitizes the inner transform name', async () => {
      const message = await messageOf(() =>
        expandMacros(macroTemplate(['AWS::Serverless-2016-10-31']), {
          ...OPTS,
          cfnClient: stillMacroed([HOSTILE.innerA.raw]),
        })
      );
      expect(
        message.startsWith(
          `Macro expansion produced a template that still contains macros ` +
            `[${HOSTILE.innerA.clean}].`
        )
      ).toBe(true);
      expect(hasForgingCharacter(message)).toBe(false);
    });

    it('leaves an ordinary inner transform name byte-identical', async () => {
      const message = await messageOf(() =>
        expandMacros(macroTemplate(['AWS::Serverless-2016-10-31']), {
          ...OPTS,
          cfnClient: stillMacroed(['My::SecondStage']),
        })
      );
      expect(
        message.startsWith(
          'Macro expansion produced a template that still contains macros [My::SecondStage].'
        )
      ).toBe(true);
    });
  });
});
