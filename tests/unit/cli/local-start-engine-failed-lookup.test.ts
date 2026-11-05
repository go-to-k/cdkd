import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Guards the cdk-local contract cdkd relies on for go-to-k/cdkd#5812: the REAL
 * cdk-local engine (not mocked) must call the `checkSelectedStacks` hook cdkd's
 * host synthesizer returns, with the stack it serves. If a cdk-local bump
 * dropped the `checkSelectedStacks?.(...)` call, a failed context lookup would
 * silently stop blocking the serving command (fail-open).
 *
 * Only cdkd's Synthesizer and the docker CLI (a no-op stub via CDK_DOCKER) are
 * faked. The next step after the hook in `start-microvm` is resolving the code
 * artifact, which fails with a distinct error here (no asset manifest), so
 * reaching it proves the hook let the run through.
 */

const synth = vi.hoisted(() => ({
  result: { stacks: [] as unknown[], failedLookups: [] as unknown[] },
}));

vi.mock('../../../src/synthesis/synthesizer.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Synthesizer: class {
    synthesize = async () => synth.result;
  },
}));

const { createLocalStartMicrovmCommand } = await import(
  '../../../src/cli/commands/local-start-microvm.js'
);

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;
const IMAGE = 'Img';
const PAST_CHECK = /matches no file asset/;

function stack(name: string, messages: Array<{ level: string; message: string }>): unknown {
  return {
    stackName: name,
    displayName: name,
    artifactId: name,
    region: 'us-east-1',
    dependencyNames: [],
    messages,
    template: {
      Resources: {
        [IMAGE]: {
          Type: 'AWS::Lambda::MicrovmImage',
          Metadata: { 'aws:cdk:path': `${name}/${IMAGE}/Resource` },
          Properties: {
            Name: `${name}-image`,
            CodeArtifact: { Uri: 's3://cdk-assets-111111111111/abc123.zip' },
            CpuConfigurations: [{ Architecture: 'ARM_64' }],
            Hooks: {
              Port: 9001,
              MicrovmImageHooks: { Ready: 'ENABLED' },
              MicrovmHooks: { Run: 'ENABLED' },
            },
          },
        },
      },
    },
  };
}

const failure = { key: 'ssm:k', error: 'ParamFailed: denied' };
const asked = [{ level: 'error', message: `Something: ${failure.error}` }];

let dir: string;
let savedDocker: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cdkd-engine-lookup-'));
  const docker = join(dir, 'docker');
  writeFileSync(docker, '#!/bin/sh\nexit 0\n');
  chmodSync(docker, 0o755);
  savedDocker = process.env['CDK_DOCKER'];
  process.env['CDK_DOCKER'] = docker;
});

afterEach(() => {
  if (savedDocker === undefined) delete process.env['CDK_DOCKER'];
  else process.env['CDK_DOCKER'] = savedDocker;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Runs the command; returns what it printed (the engine logs its error there). */
// Both cases serve `Served/Img`; the argv stays a literal for the commander convention fence.
async function run(): Promise<string> {
  const out: string[] = [];
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      out.push(a.map(String).join(' '));
    });
  }
  const exits: number[] = [];
  vi.spyOn(process, 'exit').mockImplementation(((c?: number) => void exits.push(c ?? 0)) as never);
  await createLocalStartMicrovmCommand().parseAsync(['Served/Img', '--app', 'x'], { from: 'user' });
  expect(exits).toEqual([1]);
  return out.join('\n').replace(ANSI, '');
}

describe('cdk-local engine calls cdkd checkSelectedStacks (#5812)', () => {
  it('refuses a failed lookup asked by the served stack', async () => {
    synth.result = {
      stacks: [stack('Other', []), stack('Served', asked)],
      failedLookups: [failure],
    };
    const message = await run();
    expect(message).toContain('Context lookup failed: ssm:k: ParamFailed: denied');
    expect(message).not.toMatch(PAST_CHECK);
  });

  it('lets the run past the hook when only another stack asked for the failed lookup', async () => {
    synth.result = {
      stacks: [stack('Other', asked), stack('Served', [])],
      failedLookups: [failure],
    };
    const message = await run();
    expect(message).not.toContain('Context lookup failed');
    expect(message).toMatch(PAST_CHECK);
  });
});
