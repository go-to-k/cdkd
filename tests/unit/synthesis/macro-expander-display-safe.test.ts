/**
 * `expandMacros` renders no template-derived transform name raw
 * (issue go-to-k/cdkd#3479).
 *
 * A transform name comes from the template's own `Transform` / `Fn::Transform`
 * node, so it is chosen by whoever wrote the assembly; so are a `Parameters`
 * key and its `Type`. They reach the terminal through a `logger.debug` line, a
 * DEFAULT-verbosity `logger.warn`, and `MacroExpansionError` messages, whose own
 * `message` `formatError` does NOT sanitize.
 *
 * CloudFormation's `StatusReason` is covered too, one class out: AWS ECHOES the
 * template's transform name and the macro Lambda's error text into it, so the
 * value sanitized at the first render re-enters through the reply — and at a
 * length whoever wrote the template chose, which is why that site takes
 * `displayAwsMessage` rather than bare `displaySafe`.
 *
 * Two cases are NORMAL-RUN, not error paths: the `detected transforms` debug
 * line and the parameter-placeholder warn, which fires before any AWS call.
 *
 * Both polarities per site; the hostile cases use a DISTINCT marker per
 * interpolated value, and the ordinary cases pin the rendered bytes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

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

import { expandMacros, retryDelays } from '../../../src/synthesis/macro-expander.js';
import {
  AWS_MESSAGE_MAX_CODE_POINTS,
  displayAwsMessage,
} from '../../../src/utils/display-safe.js';
import {
  CSI,
  ESC,
  hasForgingCharacter,
  LINE_SEP,
  NEL,
  PARA_SEP,
  RLO,
  ST,
} from '../_forging-characters.js';

/** One hostile marker per interpolated value, each with its own sanitized twin. */
const HOSTILE = {
  detectedA: { raw: `AWS::Serverless${CSI}2016`, clean: 'AWS::Serverless 2016' },
  detectedB: { raw: `My::Macro${NEL}v1`, clean: 'My::Macro v1' },
  involvedA: { raw: `Involved${LINE_SEP}Macro`, clean: 'Involved Macro' },
  innerA: { raw: `Inner${RLO}Macro`, clean: 'Inner Macro' },
  paramKey: { raw: `MyParam${ST}Key`, clean: 'MyParam Key' },
  paramType: { raw: `Weird${PARA_SEP}Type`, clean: 'Weird Type' },
  statusReason: { raw: `macro Lambda said no${CSI}2K`, clean: 'macro Lambda said no 2K' },
  edgeTransform: { raw: `AWS::Serverless${NEL}`, clean: 'AWS::Serverless' },
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

/** Like {@link buildCfnClient}, but one command REJECTS. */
function buildRejectingCfnClient(command: string, error: Error) {
  const send = vi.fn(async (cmd: FakeCommand) => {
    if (cmd._name === command) throw error;
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
  // The retry backoff is 2s then 4s of WALL CLOCK. Without this seam a case
  // that stops retrying when it should reds on Vitest's 5s timeout instead of
  // on the assertion, which names the wrong thing.
  vi.spyOn(retryDelays, 'sleep').mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
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

describe('the parameter-placeholder warn — template-derived, default verbosity (#3479)', () => {
  /**
   * Reached from `buildParameterValues` BEFORE `CreateChangeSet`, so it prints
   * locally on a crafted `cdk.out` with no AWS call at all. Both values come
   * straight off the template's `Parameters` node, and `Type` is free-form.
   */
  function templateWithParameter(key: string, type: string): Record<string, unknown> {
    return {
      ...macroTemplate(['AWS::Serverless-2016-10-31']),
      Parameters: { [key]: { Type: type } },
    };
  }

  function warnLines(): string[] {
    return loggerSpies.warn.mock.calls.map((call) => String(call[0]));
  }

  it('sanitizes the parameter key AND its Type, one marker per value', async () => {
    const cfnClient = buildCfnClient({
      CreateChangeSet: { Id: 'cs-arn', StackId: 's-arn' },
      GetTemplate: { TemplateBody: EXPANDED },
    });
    await expandMacros(
      templateWithParameter(HOSTILE.paramKey.raw, HOSTILE.paramType.raw),
      { ...OPTS, cfnClient }
    );
    expect(warnLines()).toEqual([
      `Parameter '${HOSTILE.paramKey.clean}' has unrecognized CFn Type ` +
        `'${HOSTILE.paramType.clean}'; using a generic string placeholder for the ` +
        'transient macro-expansion changeset. If CFn rejects the changeset with a ' +
        'type error, file an issue with the offending Type.',
    ]);
    for (const line of warnLines()) expect(hasForgingCharacter(line)).toBe(false);
  });

  it('leaves an ordinary key and Type byte-identical', async () => {
    const cfnClient = buildCfnClient({
      CreateChangeSet: { Id: 'cs-arn', StackId: 's-arn' },
      GetTemplate: { TemplateBody: EXPANDED },
    });
    await expandMacros(templateWithParameter('MyParam', 'Custom::Weird'), {
      ...OPTS,
      cfnClient,
    });
    expect(warnLines()).toEqual([
      "Parameter 'MyParam' has unrecognized CFn Type 'Custom::Weird'; using a generic " +
        'string placeholder for the transient macro-expansion changeset. If CFn rejects ' +
        'the changeset with a type error, file an issue with the offending Type.',
    ]);
  });
});

describe("the changeset-failure refusal quotes CloudFormation's own reply (#3479)", () => {
  /**
   * `StatusReason` is AWS's text, and AWS ECHOES the template's transform name
   * and the macro Lambda's error into it — so the value sanitized where the
   * transform name is first rendered re-enters through the reply, at a length
   * whoever wrote the template chose. Hence `displayAwsMessage`, which caps AND
   * marks its cut, rather than bare `displaySafe`.
   */
  function failingWaiter(statusReason: string, status: string) {
    waitUntilChangeSetCreateCompleteMock.mockRejectedValue(new Error('waiter failed'));
    return buildCfnClient({
      CreateChangeSet: { Id: 'cs-arn', StackId: 's-arn' },
      DescribeChangeSet: { StatusReason: statusReason, Status: status },
    });
  }

  it('sanitizes the reason and the status, one marker per value', async () => {
    const message = await messageOf(() =>
      expandMacros(macroTemplate(['AWS::Serverless-2016-10-31']), {
        ...OPTS,
        cfnClient: failingWaiter(HOSTILE.statusReason.raw, `FAIL${NEL}ED`),
      })
    );
    expect(message).toBe(
      `CloudFormation macro expansion failed (status=FAIL ED): ${HOSTILE.statusReason.clean}`
    );
    expect(hasForgingCharacter(message)).toBe(false);
  });

  it('leaves an ordinary reason byte-identical', async () => {
    const message = await messageOf(() =>
      expandMacros(macroTemplate(['AWS::Serverless-2016-10-31']), {
        ...OPTS,
        cfnClient: failingWaiter('Transform AWS::Serverless failed: boom', 'FAILED'),
      })
    );
    expect(message).toBe(
      'CloudFormation macro expansion failed (status=FAILED): ' +
        'Transform AWS::Serverless failed: boom'
    );
  });

  it('MARKS the cut when AWS echoes an oversized payload back', async () => {
    const flood = 'x'.repeat(5000);
    const message = await messageOf(() =>
      expandMacros(macroTemplate(['AWS::Serverless-2016-10-31']), {
        ...OPTS,
        cfnClient: failingWaiter(flood, 'FAILED'),
      })
    );
    // DERIVED from the cap rather than transcribed: a retune of the constant
    // must not red this case with a diff that blames the wrong thing.
    const withheld = flood.length - AWS_MESSAGE_MAX_CODE_POINTS;
    expect(withheld).toBeGreaterThan(0);
    expect(message.endsWith(`[cut: ${withheld} more characters withheld]`)).toBe(true);
  });
});

describe('AWS and parser text that ECHOES the template back (#3479)', () => {
  it('sanitizes the CreateChangeSet rejection, which quotes the submitted values', async () => {
    // CFn quotes the transform names and the parameter placeholders it was
    // handed back in a validation error, so this is AWS text carrying assembly
    // content.
    const message = await messageOf(() =>
      expandMacros(macroTemplate(['AWS::Serverless-2016-10-31']), {
        ...OPTS,
        cfnClient: buildRejectingCfnClient(
          'CreateChangeSet',
          new Error(`Transform ${HOSTILE.detectedA.raw} is not valid`)
        ),
      })
    );
    expect(message).toBe(
      'CloudFormation rejected the macro-expansion changeset: ' +
        `Transform ${HOSTILE.detectedA.clean} is not valid`
    );
    expect(hasForgingCharacter(message)).toBe(false);
  });

  it('CAPS an oversized CreateChangeSet rejection and MARKS the cut', async () => {
    // CFn echoes the submitted values back, so the LENGTH is template-chosen
    // here too. Without this the cap at that site is undiscriminated —
    // swapping `displayAwsMessage` for bare `displaySafe` stayed green.
    const flood = `Transform ${'y'.repeat(AWS_MESSAGE_MAX_CODE_POINTS + 500)} is not valid`;
    const message = await messageOf(() =>
      expandMacros(macroTemplate(['AWS::Serverless-2016-10-31']), {
        ...OPTS,
        cfnClient: buildRejectingCfnClient('CreateChangeSet', new Error(flood)),
      })
    );
    const withheld = flood.length - AWS_MESSAGE_MAX_CODE_POINTS;
    expect(withheld).toBeGreaterThan(0);
    expect(message.endsWith(`[cut: ${withheld} more characters withheld]`)).toBe(true);
  });

  it('leaves an ordinary CreateChangeSet rejection byte-identical', async () => {
    const message = await messageOf(() =>
      expandMacros(macroTemplate(['AWS::Serverless-2016-10-31']), {
        ...OPTS,
        cfnClient: buildRejectingCfnClient('CreateChangeSet', new Error('AccessDenied')),
      })
    );
    expect(message).toBe(
      'CloudFormation rejected the macro-expansion changeset: AccessDenied'
    );
  });

  it("sanitizes the JSON.parse failure, which embeds CFn's returned body verbatim", async () => {
    // Measured: Node quotes the offending INPUT inside its own parse error, so
    // the round-tripped template's bytes re-enter through the parser's text.
    const message = await messageOf(() =>
      expandMacros(macroTemplate(['AWS::Serverless-2016-10-31']), {
        ...OPTS,
        cfnClient: buildCfnClient({
          CreateChangeSet: { Id: 'cs-arn', StackId: 's-arn' },
          GetTemplate: { TemplateBody: `notjson ${ESC}[2K forged` },
        }),
      })
    );
    expect(message).toContain('CloudFormation returned a non-JSON Processed-stage');
    expect(message).toContain('Cause: ');
    // The parse error carried the ESC through before this site was sanitized.
    expect(message.includes(`${ESC}[2K`)).toBe(false);
    expect(message).toContain('notjson  [2K forged');
    expect(hasForgingCharacter(message)).toBe(false);
  });

  it('leaves an ordinary parse failure readable', async () => {
    const message = await messageOf(() =>
      expandMacros(macroTemplate(['AWS::Serverless-2016-10-31']), {
        ...OPTS,
        cfnClient: buildCfnClient({
          CreateChangeSet: { Id: 'cs-arn', StackId: 's-arn' },
          GetTemplate: { TemplateBody: 'Resources:\n  Fn:\n    Type: AWS::Lambda::Function' },
        }),
      })
    );
    expect(message).toContain('Cause: ');
    expect(message).toContain('is not valid JSON');
  });
});

describe('the EarlyValidation retry verdict survives the message cap (#3479)', () => {
  /**
   * The retry that issue go-to-k/cdkd#1151 exists for used to be decided by
   * testing the RENDERED message for `AWS::EarlyValidation::`. Rendering AWS's
   * reply through `displayAwsMessage` made that wrong: the cap CUTS at
   * `AWS_MESSAGE_MAX_CODE_POINTS`, so a hook marker sitting past that point
   * vanished from the text the predicate read, and a macro deploy hard-failed on
   * attempt 1 instead of retrying. The verdict is now taken from the RAW reason
   * and carried on the error.
   *
   * The reason here is built so the marker is PAST the cap — the one shape that
   * discriminates the two designs. A reason with the marker near the front
   * passes either way, which is why the existing suite stayed green through the
   * regression.
   */
  const MARKER = 'The following hook(s)/validation failed: [AWS::EarlyValidation::ResourceExistenceCheck].';

  function reasonWithMarkerPastTheCap(): string {
    return `${'p'.repeat(AWS_MESSAGE_MAX_CODE_POINTS + 100)} ${MARKER}`;
  }

  it('still retries when the hook marker is cut out of the rendered message', async () => {
    const reason = reasonWithMarkerPastTheCap();
    // The premise, asserted rather than assumed: the rendered text really does
    // NOT carry the marker any more.
    expect(displayAwsMessage(reason).includes('AWS::EarlyValidation::')).toBe(false);

    waitUntilChangeSetCreateCompleteMock.mockRejectedValueOnce(new Error('waiter failed'));
    waitUntilChangeSetCreateCompleteMock.mockResolvedValue({});
    let describeCalls = 0;
    const send = vi.fn(async (cmd: FakeCommand) => {
      if (cmd._name === 'CreateChangeSet') return { Id: 'cs-arn', StackId: 's-arn' };
      if (cmd._name === 'DescribeChangeSet') {
        describeCalls += 1;
        return { Status: 'FAILED', StatusReason: reason };
      }
      if (cmd._name === 'GetTemplate') return { TemplateBody: EXPANDED };
      return {};
    });
    const result = await expandMacros(macroTemplate(['AWS::Serverless-2016-10-31']), {
      ...OPTS,
      cfnClient: { send, destroy: vi.fn() } as never,
    });
    expect(result.Resources).toEqual(EXPANDED.Resources);
    expect(describeCalls).toBe(1);
  });

  it('still does NOT retry a rejection that is not a hook, however long', async () => {
    // The other polarity: a marker-free reason of the same length must fail on
    // the first attempt, so the case above cannot be satisfied by retrying
    // everything.
    waitUntilChangeSetCreateCompleteMock.mockRejectedValue(new Error('waiter failed'));
    let createCalls = 0;
    const send = vi.fn(async (cmd: FakeCommand) => {
      if (cmd._name === 'CreateChangeSet') {
        createCalls += 1;
        return { Id: 'cs-arn', StackId: 's-arn' };
      }
      if (cmd._name === 'DescribeChangeSet') {
        return { Status: 'FAILED', StatusReason: 'q'.repeat(AWS_MESSAGE_MAX_CODE_POINTS + 100) };
      }
      return {};
    });
    await messageOf(() =>
      expandMacros(macroTemplate(['AWS::Serverless-2016-10-31']), {
        ...OPTS,
        cfnClient: { send, destroy: vi.fn() } as never,
      })
    );
    expect(createCalls).toBe(1);
  });
});

describe('the finally-block cleanup warns quote AWS text too (#3479)', () => {
  /**
   * Both warns go through `formatErr`, which is what makes this module's header
   * claim — one spelling for AWS-or-parser text — true. Neither had a case that
   * could see the difference: the only existing assertion matches the warn's own
   * opening phrase and a clean error string, so dropping the sanitizer was
   * green.
   */
  function warnLines(): string[] {
    return loggerSpies.warn.mock.calls.map((call) => String(call[0]));
  }

  /** Expansion SUCCEEDS; only the `DeleteStack` cleanup fails. */
  function cleanupFails(error: Error) {
    const send = vi.fn(async (cmd: FakeCommand) => {
      if (cmd._name === 'CreateChangeSet') return { Id: 'cs-arn', StackId: 's-arn' };
      if (cmd._name === 'GetTemplate') return { TemplateBody: EXPANDED };
      if (cmd._name === 'DeleteStack') throw error;
      return {};
    });
    return { send, destroy: vi.fn() } as never;
  }

  it('sanitizes the SDK text in the DeleteStack cleanup warn', async () => {
    const result = await expandMacros(macroTemplate(['AWS::Serverless-2016-10-31']), {
      ...OPTS,
      cfnClient: cleanupFails(new Error(`AccessDenied${CSI}2K on delete`)),
    });
    // The cleanup failure must not mask the successful expansion.
    expect(result.Resources).toEqual(EXPANDED.Resources);
    const warn = warnLines().find((w) => w.includes('Failed to delete transient macro-expand stack'));
    expect(warn).toBeDefined();
    expect(warn).toContain('AccessDenied 2K on delete');
    expect(hasForgingCharacter(warn!)).toBe(false);
  });

  it('leaves ordinary SDK text byte-identical in that warn', async () => {
    await expandMacros(macroTemplate(['AWS::Serverless-2016-10-31']), {
      ...OPTS,
      cfnClient: cleanupFails(new Error('AccessDenied')),
    });
    const warn = warnLines().find((w) => w.includes('Failed to delete transient macro-expand stack'));
    expect(warn).toContain(': AccessDenied. Clean up manually via');
  });

  it('CAPS an oversized cleanup error and MARKS the cut', async () => {
    const flood = `AccessDenied ${'d'.repeat(AWS_MESSAGE_MAX_CODE_POINTS + 200)}`;
    await expandMacros(macroTemplate(['AWS::Serverless-2016-10-31']), {
      ...OPTS,
      cfnClient: cleanupFails(new Error(flood)),
    });
    const withheld = flood.length - AWS_MESSAGE_MAX_CODE_POINTS;
    expect(withheld).toBeGreaterThan(0);
    const warn = warnLines().find((w) => w.includes('Failed to delete transient macro-expand stack'));
    expect(warn).toContain(`[cut: ${withheld} more characters withheld]`);
  });
});

describe('the CreateChangeSet site carries its own retry verdict (#3479)', () => {
  /**
   * `withEarlyValidationVerdict` is applied at BOTH throw sites, because a
   * validation hook can reject the `CreateChangeSet` call itself rather than
   * failing the waiter. Nothing pinned that second site, so deleting its
   * wrapper was green everywhere — including in the pre-existing #1151 block,
   * which only drives the `DescribeChangeSet` path.
   */
  it('retries a CreateChangeSet rejection naming a validation hook', async () => {
    let createCalls = 0;
    const send = vi.fn(async (cmd: FakeCommand) => {
      if (cmd._name === 'CreateChangeSet') {
        createCalls += 1;
        if (createCalls === 1) {
          throw new Error(
            'The following hook(s)/validation failed: [AWS::EarlyValidation::ResourceExistenceCheck]'
          );
        }
        return { Id: 'cs-arn', StackId: 's-arn' };
      }
      if (cmd._name === 'GetTemplate') return { TemplateBody: EXPANDED };
      return {};
    });
    const result = await expandMacros(macroTemplate(['AWS::Serverless-2016-10-31']), {
      ...OPTS,
      cfnClient: { send, destroy: vi.fn() } as never,
    });
    expect(result.Resources).toEqual(EXPANDED.Resources);
    expect(createCalls).toBe(2);
  });

  it('does NOT retry a CreateChangeSet rejection that names no hook', async () => {
    let createCalls = 0;
    const send = vi.fn(async (cmd: FakeCommand) => {
      if (cmd._name === 'CreateChangeSet') {
        createCalls += 1;
        throw new Error('AccessDenied');
      }
      return {};
    });
    await messageOf(() =>
      expandMacros(macroTemplate(['AWS::Serverless-2016-10-31']), {
        ...OPTS,
        cfnClient: { send, destroy: vi.fn() } as never,
      })
    );
    expect(createCalls).toBe(1);
  });
});

describe('a joined transform list is sanitized per ELEMENT (#3479)', () => {
  it('keeps `, ` exact for a marker at an element EDGE', async () => {
    // `displaySafe` replaces globally, so a MID-value marker is stripped either
    // way; the two forms differ only here, where sanitizing the joined string
    // would print `AWS::Serverless , My::Macro`.
    const cfnClient = buildCfnClient({
      CreateChangeSet: { Id: 'cs-arn', StackId: 's-arn' },
      GetTemplate: { TemplateBody: EXPANDED },
    });
    await expandMacros(macroTemplate([HOSTILE.edgeTransform.raw, 'My::Macro']), {
      ...OPTS,
      cfnClient,
    });
    expect(debugLines()[0]).toBe(
      `Macro expansion: detected transforms [${HOSTILE.edgeTransform.clean}, My::Macro], ` +
        'starting CFn round-trip...'
    );
  });
});
