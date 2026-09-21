/**
 * Issue go-to-k/cdkd#3482: a refusal raised while reading a CDK Stage
 * (`cdk:cloud-assembly` artifact) is fatal exactly as it is at the top level,
 * while a Stage whose own directory cannot be read keeps warning — and the
 * stacks that tolerance drops are reported at SELECTION time instead of
 * answering "not found".
 *
 * Both halves are driven through the REAL `AssemblyReader` over REAL files,
 * the way `assembly-path-containment.test.ts` does: what changed is the
 * reader's control flow, and a `vi.mock` of `node:fs` with a queue of
 * `mockReturnValueOnce` answers pins the ORDER of reads rather than which
 * failure the reader tolerates.
 *
 * The logger IS mocked, because "it still warns" is half of what the tolerant
 * arm promises.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const warn = vi.fn();
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() }),
  }),
}));

import { AssemblyReader } from '../../../src/synthesis/assembly-reader.js';
import type { AssemblyManifest, ArtifactManifest } from '../../../src/types/assembly.js';

let root: string;

beforeEach(() => {
  warn.mockReset();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cdkd-stage-refusal-')));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function manifest(artifacts: Record<string, ArtifactManifest>): AssemblyManifest {
  return { version: '54.0.0', artifacts } as AssemblyManifest;
}

function stackArtifact(
  stackName: string,
  props: Record<string, unknown>,
  extra: Partial<ArtifactManifest> = {}
): ArtifactManifest {
  return {
    type: 'aws:cloudformation:stack',
    properties: { stackName, ...props },
    ...extra,
  } as ArtifactManifest;
}

function stageArtifact(directoryName: string, displayName?: string): ArtifactManifest {
  return {
    type: 'cdk:cloud-assembly',
    properties: { directoryName, ...(displayName !== undefined && { displayName }) },
  } as ArtifactManifest;
}

/** Create `<root>/cdk.out` and return it. */
function outdir(): string {
  const dir = join(root, 'cdk.out');
  mkdirSync(dir);
  return dir;
}

/** Write a stage directory with its own manifest, and return its path. */
function stageDir(dir: string, name: string, artifacts: Record<string, ArtifactManifest>): string {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'manifest.json'), JSON.stringify(manifest(artifacts)));
  return path;
}

/** A template whose one nested-stack row carries `assetPath`. */
function nestedTemplate(assetPath: string): string {
  return JSON.stringify({
    Resources: {
      Child: { Type: 'AWS::CloudFormation::Stack', Metadata: { 'aws:asset:path': assetPath } },
    },
  });
}

const ABSOLUTE_REFUSAL = /which is absolute\..*Refusing to load\./s;

describe('a refusal raised under a Stage is fatal, as it is at the top level', () => {
  it('propagates the absolute aws:asset:path tripwire, naming the Stage', () => {
    const dir = outdir();
    const stage = stageDir(dir, 'assembly-MyStage', {
      MyStageApi: stackArtifact('MyStage-Api', { templateFile: 'MyStageApi.template.json' }),
    });
    writeFileSync(
      join(stage, 'MyStageApi.template.json'),
      nestedTemplate('/etc/child.nested.template.json')
    );

    expect(() =>
      new AssemblyReader().getAllStacks(
        dir,
        manifest({ 'assembly-MyStage': stageArtifact('assembly-MyStage', 'MyStage') })
      )
    ).toThrow(ABSOLUTE_REFUSAL);
    expect(() =>
      new AssemblyReader().getAllStacks(
        dir,
        manifest({ 'assembly-MyStage': stageArtifact('assembly-MyStage', 'MyStage') })
      )
    ).toThrow(/^Stage 'MyStage': Stack 'MyStage-Api' nested-stack 'Child'/);
    // The tolerant arm must NOT have run: this is a refusal, not a read failure.
    expect(warn).not.toHaveBeenCalled();
  });

  it('propagates a missing templateFile under a Stage', () => {
    const dir = outdir();
    stageDir(dir, 'assembly-MyStage', { MyStageApi: stackArtifact('MyStage-Api', {}) });

    expect(() =>
      new AssemblyReader().getAllStacks(
        dir,
        manifest({ 'assembly-MyStage': stageArtifact('assembly-MyStage', 'MyStage') })
      )
    ).toThrow("Stage 'MyStage': Stack 'MyStage-Api' has no templateFile property");
  });

  it('propagates an unreadable template under a Stage', () => {
    const dir = outdir();
    stageDir(dir, 'assembly-MyStage', {
      MyStageApi: stackArtifact('MyStage-Api', { templateFile: 'absent.template.json' }),
    });

    expect(() =>
      new AssemblyReader().getAllStacks(
        dir,
        manifest({ 'assembly-MyStage': stageArtifact('assembly-MyStage', 'MyStage') })
      )
    ).toThrow(/Stage 'MyStage': Failed to read template for stack 'MyStage-Api'/);
  });

  it('propagates an escaping asset-manifest file under a Stage', () => {
    const dir = outdir();
    stageDir(dir, 'assembly-MyStage', {
      MyStageApiAssets: {
        type: 'cdk:asset-manifest',
        properties: { file: '../../outside.assets.json' },
      } as ArtifactManifest,
    });

    expect(() =>
      new AssemblyReader().getAllStacks(
        dir,
        manifest({ 'assembly-MyStage': stageArtifact('assembly-MyStage', 'MyStage') })
      )
    ).toThrow(/Stage 'MyStage': Asset manifest artifact 'MyStageApiAssets' has/);
  });

  it('names the INNERMOST Stage when Stages nest', () => {
    const dir = outdir();
    const outer = stageDir(dir, 'assembly-MyStage', {
      'assembly-MyStageInner': stageArtifact('assembly-MyStageInner', 'MyStage/Inner'),
    });
    const inner = stageDir(outer, 'assembly-MyStageInner', {
      InnerApi: stackArtifact('MyStage-Inner-Api', { templateFile: 'InnerApi.template.json' }),
    });
    writeFileSync(join(inner, 'InnerApi.template.json'), nestedTemplate('/etc/passwd'));

    let message = '';
    try {
      new AssemblyReader().getAllStacks(
        dir,
        manifest({ 'assembly-MyStage': stageArtifact('assembly-MyStage', 'MyStage') })
      );
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toMatch(/^Stage 'MyStage\/Inner': /);
    // The outer Stage must not restate what the inner one said more precisely.
    expect(message.match(/Stage '/g)).toHaveLength(1);
  });

  it('leaves a TOP-LEVEL refusal unprefixed', () => {
    const dir = outdir();
    writeFileSync(join(dir, 'Api.template.json'), nestedTemplate('/etc/passwd'));

    let message = '';
    try {
      new AssemblyReader().getAllStacks(
        dir,
        manifest({ Api: stackArtifact('Api', { templateFile: 'Api.template.json' }) })
      );
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toMatch(ABSOLUTE_REFUSAL);
    expect(message).not.toContain("Stage '");
  });
});

describe('a Stage whose directory cannot be read still warns and the run continues', () => {
  it('keeps the sibling stacks, warns, and records the failed Stage', () => {
    const dir = outdir();
    writeFileSync(join(dir, 'Top.template.json'), JSON.stringify({ Resources: {} }));

    const { stacks, failedStages } = new AssemblyReader().readAssembly(
      dir,
      manifest({
        Top: stackArtifact('TopStack', { templateFile: 'Top.template.json' }),
        // No such directory: the Stage was never synthesized.
        'assembly-MyStage': stageArtifact('assembly-MyStage', 'MyStage'),
      })
    );

    expect(stacks.map((s) => s.stackName)).toEqual(['TopStack']);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Failed to read nested assembly 'assembly-MyStage'")
    );
    expect(failedStages).toHaveLength(1);
    expect(failedStages[0]?.stagePath).toBe('MyStage');
    expect(failedStages[0]?.reason).toContain('Failed to read cloud assembly manifest');
  });

  it('falls back to the artifact id when the Stage carries no displayName', () => {
    const dir = outdir();

    const { failedStages } = new AssemblyReader().readAssembly(
      dir,
      manifest({ 'assembly-MyStage': stageArtifact('assembly-MyStage') })
    );

    expect(failedStages.map((s) => s.stagePath)).toEqual(['assembly-MyStage']);
  });

  it('records a Stage that fails UNDER another Stage, and keeps that outer Stage loaded', () => {
    // The recursive call passes the accumulator down; without that argument a
    // deeper failure never reaches the top-level caller.
    const dir = outdir();
    const outer = stageDir(dir, 'assembly-MyStage', {
      MyStageApi: stackArtifact('MyStage-Api', { templateFile: 'MyStageApi.template.json' }),
      'assembly-MyStageInner': stageArtifact('assembly-MyStageInner', 'MyStage/Inner'),
    });
    writeFileSync(join(outer, 'MyStageApi.template.json'), JSON.stringify({ Resources: {} }));

    const { stacks, failedStages } = new AssemblyReader().readAssembly(
      dir,
      manifest({ 'assembly-MyStage': stageArtifact('assembly-MyStage', 'MyStage') })
    );

    expect(stacks.map((s) => s.stackName)).toEqual(['MyStage-Api']);
    expect(failedStages.map((s) => s.stagePath)).toEqual(['MyStage/Inner']);
  });

  it('records nothing for a healthy Stage, which still loads all its stacks', () => {
    const dir = outdir();
    const stage = stageDir(dir, 'assembly-MyStage', {
      MyStageApi: stackArtifact('MyStage-Api', { templateFile: 'MyStageApi.template.json' }),
      MyStageDb: stackArtifact('MyStage-Db', { templateFile: 'MyStageDb.template.json' }),
    });
    writeFileSync(join(stage, 'MyStageApi.template.json'), JSON.stringify({ Resources: {} }));
    writeFileSync(join(stage, 'MyStageDb.template.json'), JSON.stringify({ Resources: {} }));

    const { stacks, failedStages } = new AssemblyReader().readAssembly(
      dir,
      manifest({ 'assembly-MyStage': stageArtifact('assembly-MyStage', 'MyStage') })
    );

    expect(stacks.map((s) => s.stackName)).toEqual(['MyStage-Api', 'MyStage-Db']);
    expect(failedStages).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('stack selection reports the failed Stage instead of answering "not found"', () => {
  it('names the Stage when the named stack would have come from it', () => {
    const dir = outdir();
    writeFileSync(join(dir, 'Top.template.json'), JSON.stringify({ Resources: {} }));
    const assembly = manifest({
      Top: stackArtifact('TopStack', { templateFile: 'Top.template.json' }),
      'assembly-MyStage': stageArtifact('assembly-MyStage', 'MyStage'),
    });

    let message = '';
    try {
      new AssemblyReader().getStack(dir, assembly, 'MyStage-Api');
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("Stack 'MyStage-Api' not found in assembly. Available: TopStack");
    expect(message).toContain("Stage 'MyStage' failed to load");
  });

  it('appends nothing when every Stage loaded', () => {
    const dir = outdir();
    writeFileSync(join(dir, 'Top.template.json'), JSON.stringify({ Resources: {} }));

    let message = '';
    try {
      new AssemblyReader().getStack(
        dir,
        manifest({ Top: stackArtifact('TopStack', { templateFile: 'Top.template.json' }) }),
        'Absent'
      );
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toBe("Stack 'Absent' not found in assembly. Available: TopStack");
  });
});
