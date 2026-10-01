/**
 * go-to-k/cdkd#3371: the template- and CLI-derived identifiers `cdkd export`
 * prints — a `--parameter` token, a `--cfn-child-stack-name` value, a template
 * Parameter name, the CloudFormation and CDK stack names in the by-hand
 * commands — render through `quotedOrNotShown` in prose and through the shared
 * gate in a command, so a value that is not inert on a command line is
 * described or becomes a quoted hole, and no pasted span of the message runs.
 *
 * The source-level half (no such name interpolated raw anywhere in the file)
 * is `export.test.ts`'s "renders no record-, template- or CLI-derived name
 * RAW" fence; these cases drive the builders.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const infoSpy = vi.hoisted(() => vi.fn());
const warnSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: infoSpy,
    warn: warnSpy,
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

import {
  adoptionPreparingLabel,
  invokePreDeleteHandler,
  awsStackNameArg,
  crossStackRefLine,
  fetchPrimaryIdentifier,
  parseCfnChildStackNameOverrides,
  parseParameterOverrides,
  parseTemplateFile,
  phase2RetryCommand,
  pickStackRegion,
  preDeleteListingLines,
  printNextSteps,
  refuseTransientContextIfUnsafe,
  resolveRouteDestination,
  resolveTemplateParameters,
} from '../../../src/cli/commands/export.js';
import {
  OPERATOR_FLIP,
  PASTE_PAYLOADS,
  segmentsOf,
  spanRun,
  spansThatRun,
  withPasteDir,
} from '../utils/paste-harness.js';
import { filesTouchedBy } from '../utils/paste-harness.js';
import { malformedExportResourcePropertiesRefusalMessage } from '../../../src/state/malformed-resources-bag.js';

const NOT_SHOWN = '(not shown: it is not a plain identifier)';

/**
 * The `"` variant of the harness's `OPERATOR_FLIP` (go-to-k/cdkd#4229): a
 * line ABOVE the message holding one unpaired `"`, under which `$( )` and a
 * backtick run and a JSON-quoted value turns inside out. The harness models
 * only the `'` flip, so these spans are built here: every prefix of the
 * message that ends at a line end, behind that line.
 */
function doubleQuoteFlipSpans(message: string): string[] {
  const lines = message.split('\n');
  return lines.map((_, last) => `zzq "above\n${lines.slice(0, last + 1).join('\n')}`);
}

/** Every span of `message` that touched a file, under BOTH flips and none. */
function spansThatRunUnderEitherFlip(message: string, dir: string): string[] {
  return [
    ...spansThatRun(message, dir),
    ...doubleQuoteFlipSpans(message).filter((span) => filesTouchedBy(span, dir).length > 0),
  ];
}

function thrown(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error('expected a throw');
}

/** Every operator-typed or template-derived value these messages quote. */
function messagesFor(value: string): string[] {
  return [
    thrown(() => parseParameterOverrides([value])),
    thrown(() => parseParameterOverrides([`=${value}`])),
    // A whitespace-only key takes the key-is-empty branch, not the no-`=` one.
    thrown(() => parseParameterOverrides([` =${value}`])),
    thrown(() => parseCfnChildStackNameOverrides([value])),
    thrown(() => parseCfnChildStackNameOverrides([`${value}=`])),
    thrown(() => parseCfnChildStackNameOverrides([`=${value}`])),
    thrown(() => parseCfnChildStackNameOverrides([`A=${value}`])),
    thrown(() =>
      resolveTemplateParameters({ Parameters: { Env: { Default: 'x' } } }, { [value]: 'v' })
    ),
    thrown(() => resolveTemplateParameters({ Resources: {} }, { [value]: 'v' })),
    thrown(() => refuseTransientContextIfUnsafe({ context: [value], acceptTransientContext: false })),
    // The fs CODE, never the error's message, which repeats the path.
    thrown(() => parseTemplateFile(`/nonexistent-cdkd-3371/${value}`)),
  ];
}

describe('cdkd export renders template- and CLI-derived identifiers (go-to-k/cdkd#3371)', () => {
  beforeEach(() => {
    infoSpy.mockReset();
    warnSpy.mockReset();
  });

  it('the adoption-preparation head names a plain row bare and describes a forged one', () => {
    expect(adoptionPreparingLabel('Child')).toBe('Preparing the adoption of nested child Child');
    const forged = "Child'x";
    expect(adoptionPreparingLabel(forged)).toBe(
      `Preparing the adoption of nested child ${NOT_SHOWN}`
    );
    for (const { value } of PASTE_PAYLOADS) {
      expect(adoptionPreparingLabel(value), value).not.toContain(value);
    }
  });

  it('a plain value keeps its quoted spelling', () => {
    expect(thrown(() => parseParameterOverrides(['Env']))).toContain("Invalid --parameter 'Env':");
    expect(thrown(() => parseParameterOverrides([' =v']))).toBe(
      `Invalid --parameter ${NOT_SHOWN}: key is empty`
    );
    expect(
      thrown(() =>
        refuseTransientContextIfUnsafe({ context: ['env=prod'], acceptTransientContext: false })
      )
    ).toContain("Supplied:\n    -c 'env=prod'");
    expect(thrown(() => parseTemplateFile('/nonexistent-cdkd-3371/t.json'))).toBe(
      "Failed to read template file '/nonexistent-cdkd-3371/t.json': ENOENT"
    );
    expect(thrown(() => parseCfnChildStackNameOverrides(['A=1bad']))).toContain(
      "--cfn-child-stack-name 'A=1bad': CFn stack name '1bad' must match"
    );
    expect(
      thrown(() => resolveTemplateParameters({ Parameters: { Env: {} } }, { Typo: 'v' }))
    ).toContain("--parameter override 'Typo' does not match any parameter in the synthesized " +
      "template (template declares: 'Env')");
  });

  it('describes every payload, names none of it, and no pasted span runs', () => {
    withPasteDir((dir) => {
      for (const { value } of PASTE_PAYLOADS) {
        for (const message of messagesFor(value)) {
          expect(message, value).toContain(NOT_SHOWN);
          expect(message, value).not.toContain(value);
          expect(spansThatRun(message, dir), `${value}: ${message}`).toEqual([]);
        }
      }
    });
  }, 60_000);

  it("the phase-2 retry command names a plain CloudFormation stack and holes a payload", () => {
    expect(phase2RetryCommand('MyStack')).toBe(
      'aws cloudformation create-change-set --stack-name MyStack --change-set-name ' +
        "cdkd-phase2-retry --change-set-type UPDATE --template-body 'file://<full-template.json>'"
    );
    withPasteDir((dir) => {
      for (const { value } of PASTE_PAYLOADS) {
        const command = phase2RetryCommand(value);
        expect(command, value).toContain("--stack-name '<stack-name>'");
        expect(command, value).not.toContain(value);
        expect(spansThatRun(command, dir), value).toEqual([]);
      }
    });
  }, 60_000);

  it('the EC2::Route destination refusal and warning describe a forged segment or value, and nothing runs (B1)', () => {
    const rendered: Array<{ value: string; message: string }> = [];
    for (const { value } of PASTE_PAYLOADS) {
      // Refusal arm: the declared destination is an IPv4 CIDR, so the
      // mismatch is decidable and refused.
      rendered.push({
        value,
        message: thrown(() => resolveRouteDestination(value, { DestinationCidrBlock: '10.0.0.0/16' })),
      });
      // Warning arm: an IPv6 declared destination cdkd cannot normalise. The
      // warning carries `'cdkd import --resource'`.
      warnSpy.mockReset();
      expect(resolveRouteDestination(value, { DestinationIpv6CidrBlock: '2001:db8::/64' })).toBe(
        value
      );
      rendered.push({ value, message: String(warnSpy.mock.calls[0]![0]) });
      warnSpy.mockReset();
      resolveRouteDestination('10.1.0.0/16', { DestinationIpv6CidrBlock: value });
      rendered.push({ value, message: String(warnSpy.mock.calls[0]![0]) });
    }
    withPasteDir((dir) => {
      for (const { value, message } of rendered) {
        expect(message, value).toContain(NOT_SHOWN);
        expect(message, value).not.toContain(value);
        expect(spansThatRun(message, dir), `${value}: ${message}`).toEqual([]);
      }
    });
    // A plain destination keeps its spelling.
    warnSpy.mockReset();
    resolveRouteDestination('10.1.0.0/16', { DestinationIpv6CidrBlock: '2001:db8::/64' });
    expect(String(warnSpy.mock.calls[0]![0])).toContain(
      "declare DestinationIpv6CidrBlock=2001:db8::/64, but the physical id's destination " +
        'segment is 10.1.0.0/16.'
    );
  }, 60_000);

  it('the no-fallback identifier refusal describes a template-chosen Type (S1)', async () => {
    const client = {
      send: vi.fn(async () => {
        throw Object.assign(new Error('Type not found'), { name: 'TypeNotFoundException' });
      }),
    } as unknown as Parameters<typeof fetchPrimaryIdentifier>[1];
    for (const { value } of PASTE_PAYLOADS) {
      const message = await fetchPrimaryIdentifier(`Custom::${value}`, client).then(
        () => 'resolved',
        (e: unknown) => (e as Error).message
      );
      expect(message, value).toContain(`Add ${NOT_SHOWN} to PRIMARY_IDENTIFIER_FALLBACK`);
      expect(message, value).not.toContain(value);
    }
    const plain = await fetchPrimaryIdentifier('AWS::Nope::Thing', client).then(
      () => 'resolved',
      (e: unknown) => (e as Error).message
    );
    expect(plain).toContain("Add 'AWS::Nope::Thing' to PRIMARY_IDENTIFIER_FALLBACK");
  });

  it('a cross-stack reference row quotes plain names and describes a non-inert path (G3)', () => {
    expect(
      crossStackRefLine(
        { consumerStackName: 'Consumer', outputName: 'BucketName', location: 'Resources.Fn.Properties.Environment' },
        'Producer'
      )
    ).toBe(
      "  'Consumer' → output 'BucketName' of 'Producer' at Resources.Fn.Properties.Environment"
    );
    expect(
      crossStackRefLine(
        { consumerStackName: 'Consumer', outputName: 'O', location: 'Resources.Fn.Properties.Tags[0].Value' },
        'Producer'
      )
    ).toBe(`  'Consumer' → output 'O' of 'Producer' at ${NOT_SHOWN}`);
    withPasteDir((dir) => {
      for (const { value } of PASTE_PAYLOADS) {
        const line = crossStackRefLine(
          { consumerStackName: value, outputName: value, location: `Resources.${value}` },
          value
        );
        expect(line, value).not.toContain(value);
        expect(spansThatRun(line, dir), `${value}: ${line}`).toEqual([]);
      }
    });
  }, 60_000);

  it('the template parse failure cause is one bounded line (G5)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-3371-parse-'));
    try {
      const file = join(dir, 'bad.template.json');
      writeFileSync(file, `{ "Resources": \n  ${'x'.repeat(5000)}\n  oops`, 'utf-8');
      const message = thrown(() => parseTemplateFile(file));
      expect(message).toContain('is not a valid CloudFormation template.');
      expect(message).toContain('Cause: ');
      expect(message).not.toContain('\n');
      expect(message).not.toContain('x'.repeat(4097));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the pre-delete handler refusals describe a forged logical id (R5)', async () => {
    const forged = "Stage'x";
    // A Stage row with no ApiId: refused before any AWS call.
    const stage = await invokePreDeleteHandler('AWS::ApiGatewayV2::Stage', {
      logicalId: forged,
      resourceType: 'AWS::ApiGatewayV2::Stage',
      physicalId: 'stage-1',
      properties: {},
    }).then(
      () => 'resolved',
      (e: unknown) => (e as Error).message
    );
    expect(stage).toBe(
      `cdkd state's properties for ${NOT_SHOWN} (AWS::ApiGatewayV2::Stage) is missing 'ApiId'`
    );
    // A Policy row whose detach targets refuse (no readable principal list).
    const policy = await invokePreDeleteHandler('AWS::IAM::Policy', {
      logicalId: forged,
      resourceType: 'AWS::IAM::Policy',
      physicalId: 'PolicyName',
      properties: { Roles: 'not-a-list' },
    }).then(
      () => 'resolved',
      (e: unknown) => (e as Error).message
    );
    expect(policy).toContain(`cdkd state for ${NOT_SHOWN} (AWS::IAM::Policy) cannot be pre-deleted:`);
    for (const message of [stage, policy]) expect(message).not.toContain(forged);
  });

  it('an empty region is described, never printed as an empty quote pair (R6)', async () => {
    const backend = {
      listStacks: async () => [{ stackName: 'S', region: 'us-east-1' }, { stackName: 'S', region: '' }],
    } as unknown as Parameters<typeof pickStackRegion>[0];
    const message = await pickStackRegion(backend, 'S', undefined, undefined).then(
      () => 'resolved',
      (e: unknown) => (e as Error).message
    );
    expect(message).toContain("multiple regions: 'us-east-1', (not shown: it is empty).");
    expect(message).not.toContain("''");
  });

  it("rows and the export properties refusal describe a forged id under BOTH the ' and the \" flip (R1)", () => {
    const messages: Array<{ value: string; message: string }> = [];
    for (const { value } of PASTE_PAYLOADS) {
      messages.push({
        value,
        message: preDeleteListingLines({
          logicalId: value,
          resourceType: 'AWS::ApiGatewayV2::Stage',
          physicalId: 'p',
          properties: { ApiId: 'a1' },
        }).join('\n'),
      });
      messages.push({
        value,
        message: malformedExportResourcePropertiesRefusalMessage('S', 'us-east-1', [value]),
      });
    }
    withPasteDir((dir) => {
      // Non-vacuity: the `"` flip DOES run a JSON-quoted payload, which is the
      // render these sites used to print.
      expect(
        doubleQuoteFlipSpans(`"x; touch OWNED; #" (AWS::ApiGatewayV2::Stage)`).some(
          (span) => filesTouchedBy(span, dir).length > 0
        )
      ).toBe(true);
      for (const { value, message } of messages) {
        expect(message, value).toContain(NOT_SHOWN);
        expect(message, value).not.toContain(value);
        expect(spansThatRunUnderEitherFlip(message, dir), `${value}: ${message}`).toEqual([]);
      }
    });
  }, 120_000);

  it('the aws --stack-name holes a value the AWS CLI itself acts on (go-to-k/cdkd#4199)', () => {
    // Inert to the SHELL, so only the aws-CLI gate stops them.
    for (const value of ['file://stack.json', 'fileb://x', 'https://evil.example/x', 'a@=b']) {
      const command = phase2RetryCommand(value);
      expect(command, value).toContain("--stack-name '<stack-name>'");
      expect(command, value).not.toContain(value);
      expect(awsStackNameArg(value), value).toEqual({ flag: '--stack-name', hole: 'stack-name' });
    }
    // A leading `-` was already a hole through the shell gate; still one.
    expect(phase2RetryCommand('-x')).toContain("--stack-name '<stack-name>'");
    expect(awsStackNameArg('MyStack')).toEqual({
      flag: '--stack-name',
      value: 'MyStack',
      hole: 'stack-name',
    });
  });

  it('the next-steps cdk commands carry a plain name and -c value, and hole a payload', () => {
    printNextSteps({ cfnStackName: 'S', cdkStackName: 'MyStack', contextOverrides: ['env=prod'] });
    const plain = infoSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(plain).toContain("  cdk diff MyStack -c 'env=prod'    # verify synth");
    expect(plain).toContain("  cdk deploy MyStack -c 'env=prod'  # subsequent updates");
    withPasteDir((dir) => {
      const texts = new Set<string>();
      for (const { value } of PASTE_PAYLOADS) {
        infoSpy.mockReset();
        printNextSteps({ cfnStackName: 'S', cdkStackName: value, contextOverrides: [value] });
        const text = infoSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(text, value).toContain("cdk diff '<stack>' -c '<context>'");
        expect(text, value).not.toContain(value);
        texts.add(text);
      }
      // Every payload is holed, so every payload renders the SAME text.
      expect(texts.size).toBe(1);
      const flipTouched = new Set<string>();
      let flipSpans = 0;
      for (const span of segmentsOf([...texts][0]!)) {
        const { touched, verbRan } = spanRun(span, dir, {});
        expect(verbRan, span).toBe(false);
        if (span.startsWith(OPERATOR_FLIP)) {
          flipSpans++;
          for (const f of touched) flipTouched.add(f);
          continue;
        }
        expect(touched, span).toEqual([]);
      }
      // CLASSIFIED residual, go-to-k/cdkd#4230: behind an unpaired `'` pasted
      // above, the quoted holes invert into redirections, and the only file
      // written is named by cdkd's OWN words (` -c `). Pinned EXACTLY, so
      // #4230's hole spelling flips it red. LIMIT: the harness stubs `cdkd`
      // and `aws` only, so `verbRan` cannot observe the host's own `cdk`.
      expect(flipSpans).toBeGreaterThan(0);
      expect([...flipTouched].sort()).toEqual([' -c ']);
    });
  }, 60_000);

  it('the region lists and the --stack-region value are quoted or described', async () => {
    const backend = (regions: Array<string | undefined>) =>
      ({
        listStacks: async () => regions.map((region) => ({ stackName: 'S', ...(region ? { region } : {}) })),
      }) as unknown as Parameters<typeof pickStackRegion>[0];
    const refused = async (regions: Array<string | undefined>, flag?: string): Promise<string> =>
      pickStackRegion(backend(regions), 'S', undefined, flag).then(
        () => {
          throw new Error('expected a refusal');
        },
        (e: unknown) => (e as Error).message
      );
    expect(await refused(['us-east-1', undefined], 'eu-west-1')).toBe(
      "No state found for stack 'S' in region 'eu-west-1'. Available regions: 'us-east-1', (legacy)."
    );
    expect(await refused(['us-east-1', 'eu-west-1'])).toBe(
      "Stack 'S' has state in multiple regions: 'us-east-1', 'eu-west-1'. " +
        "Re-run with --stack-region '<region>' to disambiguate."
    );
    // `withPasteDir` is synchronous, so the messages are built first.
    const rendered: Array<{ value: string; message: string }> = [];
    for (const { value } of PASTE_PAYLOADS) {
      for (const message of [
        await refused(['us-east-1', value], 'eu-west-1'),
        await refused(['us-east-1'], value),
        await refused(['us-east-1', value]),
      ]) {
        rendered.push({ value, message });
      }
    }
    withPasteDir((dir) => {
      for (const { value, message } of rendered) {
        expect(message, value).toContain(NOT_SHOWN);
        expect(message, value).not.toContain(value);
        expect(spansThatRun(message, dir), `${value}: ${message}`).toEqual([]);
      }
    });
  }, 60_000);
});
