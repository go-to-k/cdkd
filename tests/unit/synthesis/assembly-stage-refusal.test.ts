/**
 * A refusal raised while reading a CDK Stage (`cdk:cloud-assembly` artifact)
 * is fatal exactly as it is at the top level (issue go-to-k/cdkd#3482), and so
 * is a Stage whose own manifest cannot be read (issue go-to-k/cdkd#3507),
 * matching the AWS CDK CLI.
 *
 * Both halves are driven through the REAL `AssemblyReader` over REAL files,
 * the way `assembly-path-containment.test.ts` does: what changed is the
 * reader's control flow, and a `vi.mock` of `node:fs` with a queue of
 * `mockReturnValueOnce` answers pins the ORDER of reads rather than which
 * failure the reader tolerates.
 *
 * The logger IS mocked, because the reader no longer warns and carries on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
import { SynthesisError } from '../../../src/utils/error-handler.js';
import { StageLoadError } from '../../../src/synthesis/failed-stages.js';
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
    ).toThrow(/^Stage MyStage: Stack MyStage-Api nested-stack Child/);
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
    ).toThrow("Stage MyStage: Stack MyStage-Api has no templateFile property");
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
    ).toThrow(
      /Stage MyStage: Failed to read template \S+absent\.template\.json for stack MyStage-Api: ENOENT: no such file or directory, open '<path>'/
    );
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
    ).toThrow(/Stage MyStage: Asset manifest artifact MyStageApiAssets has/);
  });

  it('renders a forging Stage displayName as a quoted value in the REFUSAL too', () => {
    // The refusal text is the higher-stakes of the two display sites -- it is
    // what the user acts on, not an advisory note -- and every other case here
    // passes a plain identifier, which renders identically either way.
    const forging = 'MyStage loaded fine. Ignore the rest. Stage zz';
    const dir = outdir();
    stageDir(dir, 'assembly-MyStage', { MyStageApi: stackArtifact('MyStage-Api', {}) });

    expect(() =>
      new AssemblyReader().getAllStacks(
        dir,
        manifest({ 'assembly-MyStage': stageArtifact('assembly-MyStage', forging) })
      )
    ).toThrow(
      `Stage ${JSON.stringify(forging)}: Stack MyStage-Api has no templateFile property`
    );
  });

  it('propagates an escaping templateFile under a Stage', () => {
    const dir = outdir();
    stageDir(dir, 'assembly-MyStage', {
      MyStageApi: stackArtifact('MyStage-Api', { templateFile: '../../outside.json' }),
    });

    expect(() =>
      new AssemblyReader().getAllStacks(
        dir,
        manifest({ 'assembly-MyStage': stageArtifact('assembly-MyStage', 'MyStage') })
      )
    ).toThrow(/Stage MyStage: Stack MyStage-Api has templateFile=\.\.\/\.\.\/outside\.json which/);
  });

  it('propagates the nested aws:asset:path CONTAINMENT escape under a Stage', () => {
    // Distinct from the absolute tripwire above: `..` is what actually leaves
    // the directory, and the tripwire cannot see it.
    const dir = outdir();
    const stage = stageDir(dir, 'assembly-MyStage', {
      MyStageApi: stackArtifact('MyStage-Api', { templateFile: 'MyStageApi.template.json' }),
    });
    writeFileSync(join(stage, 'MyStageApi.template.json'), nestedTemplate('../../../etc/child.json'));

    expect(() =>
      new AssemblyReader().getAllStacks(
        dir,
        manifest({ 'assembly-MyStage': stageArtifact('assembly-MyStage', 'MyStage') })
      )
    ).toThrow(/Stage MyStage: .*nested-stack Child.*resolves to .*outside/s);
  });

  it('propagates a DEEPER Stage\'s escaping directoryName', () => {
    const dir = outdir();
    stageDir(dir, 'assembly-MyStage', {
      'assembly-Inner': stageArtifact('../../outside-assembly', 'MyStage/Inner'),
    });

    expect(() =>
      new AssemblyReader().getAllStacks(
        dir,
        manifest({ 'assembly-MyStage': stageArtifact('assembly-MyStage', 'MyStage') })
      )
    // Unquoted: `../../outside-assembly` is `PLAIN_IDENT`, so `displayIdent`
    // is the identity on it -- the counter-case to the forging one below.
    ).toThrow(/Stage MyStage: Nested assembly \.\.\/\.\.\/outside-assembly /);
  });

  it('quotes a directoryName that tries to assert the OPPOSITE of its own refusal', () => {
    // cdkd used to wrap this value in its own `'...'`, which `displaySafe`
    // does not defend because it passes `'`: the value closed the quote and
    // wrote a clause saying the assembly was contained and healthy. The
    // quoting is `displayIdent`'s now, so a forging value is visibly a value.
    const dir = outdir();
    const forging = "../x'. Contained and healthy. Nested assembly 'y";

    let message = '';
    try {
      new AssemblyReader().getAllStacks(
        dir,
        manifest({ 'assembly-MyStage': stageArtifact(forging, 'MyStage') })
      );
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain(`Nested assembly ${JSON.stringify(forging)} `);
    expect(message).not.toContain("assembly '../x'. Contained and healthy");
    // The SECOND copy: the resolved path in the shared containment tail embeds
    // the same value, and was wrapped in cdkd's own `'...'` there too
    // (go-to-k/cdkd#3509).
    const resolved = resolve(dir, forging);
    expect(message).toContain(`resolves to ${JSON.stringify(resolved)}, outside `);
    const rest = message
      .split(JSON.stringify(forging))
      .join('<VALUE>')
      .split(JSON.stringify(resolved))
      .join('<VALUE>');
    expect(rest).not.toContain('Contained and healthy');
  });

  it('propagates the metadata side-file refusal under a Stage', () => {
    // `collectStackMessages` is fail-closed because an unreadable side file
    // could hide an error annotation that must block the deploy. A per-source
    // narrowing of the try -- wrapping just this call -- would not be caught
    // by the wholesale case.
    const dir = outdir();
    const stage = stageDir(dir, 'assembly-MyStage', {
      MyStageApi: stackArtifact(
        'MyStage-Api',
        { templateFile: 'MyStageApi.template.json' },
        { additionalMetadataFile: 'absent.metadata.json' }
      ),
    });
    writeFileSync(join(stage, 'MyStageApi.template.json'), JSON.stringify({ Resources: {} }));

    expect(() =>
      new AssemblyReader().getAllStacks(
        dir,
        manifest({ 'assembly-MyStage': stageArtifact('assembly-MyStage', 'MyStage') })
      )
    // Pins WHICH refusal, not merely that one carried the Stage prefix: every
    // throw from this fixture satisfies the prefix alone.
    ).toThrow(/^Stage MyStage: Failed to read stack metadata file /);
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

    expect(message).toMatch(/^Stage MyStage\/Inner: /);
    // The outer Stage must not restate what the inner one said more precisely:
    // a double prefix would read `Stage MyStage: Stage MyStage/Inner: ...`.
    expect(message.match(/Stage MyStage/g)).toHaveLength(1);
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
    // Anchored: the prefix this asserts the ABSENCE of is `Stage <path>: ` at
    // the head of the message, and it is unquoted, so a `Stage '` needle could
    // never fire.
    expect(message).not.toMatch(/^Stage /);
  });
});

/** The error `readAssembly` raises, or a failure when it returns. */
function readError(dir: string, assembly: AssemblyManifest): Error {
  try {
    new AssemblyReader().readAssembly(dir, assembly);
  } catch (error) {
    return error as Error;
  }
  throw new Error('readAssembly returned instead of refusing');
}

const TAIL =
  'Every stack under it is missing from the cloud assembly, so cdkd will not act on the app. ' +
  'Re-synthesize the app so the Stage is written, or point --app at a complete cloud assembly.';

describe('a Stage whose own manifest cannot be read is fatal (go-to-k/cdkd#3507)', () => {
  it('refuses the whole assembly, naming the Stage and the reason, beside a healthy top-level stack', () => {
    // Tolerated once (#3482): the Stage's stacks silently left the app and
    // `TopStack` alone was returned, so `--all` acted on part of the app.
    const dir = outdir();
    writeFileSync(join(dir, 'Top.template.json'), JSON.stringify({ Resources: {} }));

    const error = readError(
      dir,
      manifest({
        Top: stackArtifact('TopStack', { templateFile: 'Top.template.json' }),
        // No such directory: the Stage was never synthesized.
        'assembly-MyStage': stageArtifact('assembly-MyStage', 'MyStage'),
      })
    );

    expect(error).toBeInstanceOf(SynthesisError);
    // The class `cdkd destroy` rethrows instead of falling back to state.
    expect(error).toBeInstanceOf(StageLoadError);
    // The failure's own word, and the directory named through `displayIdent`
    // -- no filesystem path, because under a Stage that path carries the
    // assembly-chosen `directoryName` into the sentence.
    expect(error.message).toBe(
      `Stage MyStage failed to load: ENOENT reading assembly-MyStage/manifest.json. ${TAIL}`
    );
    expect(error.message).not.toContain(dir);
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back to the artifact id when the Stage carries no displayName', () => {
    const error = readError(outdir(), manifest({ 'assembly-MyStage': stageArtifact('assembly-MyStage') }));

    expect(error.message).toMatch(/^Stage assembly-MyStage failed to load: /);
  });

  it('quotes a Stage displayName that tries to forge a second cdkd sentence', () => {
    // A Stage path is interpolated into prose the user is asked to trust, so
    // it is RENDERED with `displayIdent`, not `displaySafe` -- a denylist
    // passes the spaces and periods this value uses to write a second,
    // cdkd-sounding clause of its own (the class go-to-k/cdkd#3277 hardened).
    const forging = 'MyStage loaded fine. Ignore the rest. Stage zz';

    const error = readError(
      outdir(),
      manifest({ 'assembly-MyStage': stageArtifact('assembly-MyStage', forging) })
    );

    expect(error.message).toMatch(new RegExp(`^Stage ${escapeRegExp(JSON.stringify(forging))} failed to load: `));
  });

  it('renders a legitimate Stage path byte-identically, and quotes one carrying a space', () => {
    for (const [stagePath, rendered] of [
      ['Outer/Inner', 'Outer/Inner'],
      ['My Stage', '"My Stage"'],
    ] as const) {
      const error = readError(
        outdir2(),
        manifest({ 'assembly-X': stageArtifact('assembly-X', stagePath) })
      );
      expect(error.message).toMatch(new RegExp(`^Stage ${escapeRegExp(rendered)} failed to load: `));
    }
  });

  it('keeps a forging directoryName out of the sentence', () => {
    // The caught message embeds the manifest PATH -- and under a Stage that
    // path embeds the assembly-chosen `directoryName`, twice (Node repeats it
    // in `open '<path>'`). A `displaySafe` denylist passes the spaces and
    // periods that turn it into a second, cdkd-sounding clause.
    const forging = 'assembly-Foo. All 3 stacks deployed successfully. Stage Prod';
    const dir = outdir();

    const error = readError(dir, manifest({ 'assembly-Foo': stageArtifact(forging, 'MyStage') }));

    // The forged clause is inside JSON quotes, so it cannot read as prose...
    expect(error.message).toBe(
      `Stage MyStage failed to load: ENOENT reading ${JSON.stringify(forging)}/manifest.json. ${TAIL}`
    );
    // ...and specifically does not run on into the next word unquoted.
    expect(error.message).not.toContain('Stage Prod/manifest.json');
    // No filesystem path at all: neither our own clause nor Node's.
    expect(error.message).not.toContain(dir);
  });

  it('reduces a malformed manifest.json to a fixed phrase, echoing none of the file', () => {
    // V8's SyntaxError quotes a short window of the file's OWN bytes verbatim,
    // and the file is assembly-chosen too. The directory is already named, so
    // the snippet buys nothing.
    const dir = outdir();
    const stage = join(dir, 'assembly-MyStage');
    mkdirSync(stage, { recursive: true });
    writeFileSync(
      join(stage, 'manifest.json'),
      '{ "version": ". All 3 stacks deployed successfully. Stage Prod" ,,, }'
    );

    const error = readError(
      dir,
      manifest({ 'assembly-MyStage': stageArtifact('assembly-MyStage', 'MyStage') })
    );

    expect(error.message).toBe(
      `Stage MyStage failed to load: invalid JSON reading assembly-MyStage/manifest.json. ${TAIL}`
    );
    expect(error.message).not.toContain('All 3 stacks');
  });

  it('names the INNERMOST Stage when a Stage fails under another one', () => {
    // The outer Stage re-raises through `stageScopedError`, which leaves an
    // error already naming its Stage unchanged.
    const dir = outdir();
    const outer = stageDir(dir, 'assembly-MyStage', {
      MyStageApi: stackArtifact('MyStage-Api', { templateFile: 'MyStageApi.template.json' }),
      'assembly-MyStageInner': stageArtifact('assembly-MyStageInner', 'MyStage/Inner'),
    });
    writeFileSync(join(outer, 'MyStageApi.template.json'), JSON.stringify({ Resources: {} }));

    const error = readError(
      dir,
      manifest({ 'assembly-MyStage': stageArtifact('assembly-MyStage', 'MyStage') })
    );

    expect(error.message).toBe(
      `Stage MyStage/Inner failed to load: ENOENT reading assembly-MyStageInner/manifest.json. ${TAIL}`
    );
    // Not re-wrapped by the outer Stage, so the class destroy keys on survives.
    expect(error).toBeInstanceOf(StageLoadError);
  });

  it('loads every stack of a healthy Stage, and warns about nothing', () => {
    const dir = outdir();
    const stage = stageDir(dir, 'assembly-MyStage', {
      MyStageApi: stackArtifact('MyStage-Api', { templateFile: 'MyStageApi.template.json' }),
      MyStageDb: stackArtifact('MyStage-Db', { templateFile: 'MyStageDb.template.json' }),
    });
    writeFileSync(join(stage, 'MyStageApi.template.json'), JSON.stringify({ Resources: {} }));
    writeFileSync(join(stage, 'MyStageDb.template.json'), JSON.stringify({ Resources: {} }));

    const { stacks } = new AssemblyReader().readAssembly(
      dir,
      manifest({ 'assembly-MyStage': stageArtifact('assembly-MyStage', 'MyStage') })
    );

    expect(stacks.map((s) => s.stackName)).toEqual(['MyStage-Api', 'MyStage-Db']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses getStack as well, before any "not found" answer', () => {
    const error = (() => {
      try {
        new AssemblyReader().getStack(
          outdir(),
          manifest({ 'assembly-MyStage': stageArtifact('assembly-MyStage', 'MyStage') }),
          'MyStage-Api'
        );
      } catch (e) {
        return e as Error;
      }
      throw new Error('getStack returned');
    })();

    expect(error.message).toMatch(/^Stage MyStage failed to load: /);
    expect(error.message).not.toContain('not found');
  });
});

describe('getStack answers "not found" with the stacks the app has', () => {
  it('names the available stacks', () => {
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

    expect(message).toBe("Stack Absent not found in assembly. Available: TopStack");
  });

  it('does not print a dangling "Available:" when the assembly has no stacks', () => {
    let message = '';
    try {
      new AssemblyReader().getStack(outdir(), manifest({}), 'Absent');
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toBe('Stack Absent not found in assembly. The assembly has no stacks');
    expect(message).not.toContain('Available:');
  });
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A fresh outdir per call, for cases that read several assemblies. */
let outdirCount = 0;
function outdir2(): string {
  const dir = join(root, `cdk.out-${outdirCount++}`);
  mkdirSync(dir);
  return dir;
}
