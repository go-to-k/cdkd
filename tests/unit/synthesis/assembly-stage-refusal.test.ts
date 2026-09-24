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
import { failedStageNote } from '../../../src/synthesis/failed-stages.js';
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
    ).toThrow(/^Stage MyStage: Stack 'MyStage-Api' nested-stack 'Child'/);
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
    ).toThrow("Stage MyStage: Stack 'MyStage-Api' has no templateFile property");
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
    ).toThrow(/Stage MyStage: Failed to read template for stack 'MyStage-Api'/);
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
    ).toThrow(/Stage MyStage: Asset manifest artifact 'MyStageApiAssets' has/);
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
      `Stage ${JSON.stringify(forging)}: Stack 'MyStage-Api' has no templateFile property`
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
    ).toThrow(/Stage MyStage: Stack 'MyStage-Api' has templateFile='\.\.\/\.\.\/outside\.json'/);
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
    ).toThrow(/Stage MyStage: .*nested-stack 'Child'.*resolves to .*outside/s);
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
      'Failed to read nested assembly: ENOENT reading assembly-MyStage/manifest.json'
    );
    expect(failedStages).toHaveLength(1);
    expect(failedStages[0]?.stagePath).toBe('MyStage');
    // The failure's own word, and the directory named through `displayIdent`
    // -- no filesystem path, because under a Stage that path carries the
    // assembly-chosen `directoryName` into the sentence.
    expect(failedStages[0]?.reason).toBe('ENOENT reading assembly-MyStage/manifest.json');
  });

  it('falls back to the artifact id when the Stage carries no displayName', () => {
    const dir = outdir();

    const { failedStages } = new AssemblyReader().readAssembly(
      dir,
      manifest({ 'assembly-MyStage': stageArtifact('assembly-MyStage') })
    );

    expect(failedStages.map((s) => s.stagePath)).toEqual(['assembly-MyStage']);
  });

  it('quotes a Stage displayName that tries to forge a second cdkd sentence', () => {
    // The stage path is interpolated into prose the user is asked to trust, so
    // it is RENDERED with `displayIdent`, not `displaySafe` -- a denylist
    // passes the spaces and periods this value uses to write a second,
    // cdkd-sounding clause of its own (the class go-to-k/cdkd#3277 hardened).
    const forging = 'MyStage loaded fine. Ignore the rest. Stage zz';
    const dir = outdir();
    const assembly = manifest({
      'assembly-MyStage': stageArtifact('assembly-MyStage', forging),
    });

    // The RECORD keeps the raw value: it is the key a selection pattern is
    // matched against, and sanitizing it there breaks that match.
    const { failedStages } = new AssemblyReader().readAssembly(dir, assembly);
    expect(failedStages.map((s) => s.stagePath)).toEqual([forging]);

    // The MESSAGE renders it JSON-quoted, so the forged clause is visibly a
    // value rather than cdkd's own prose.
    let message = '';
    try {
      new AssemblyReader().getStack(dir, assembly, 'Absent');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(`Stage ${JSON.stringify(forging)} failed to load`);
  });

  it('renders a legitimate Stage path byte-identically, and still matches a pattern on it', () => {
    // The counter-case to the one above, and the reason the stored value stays
    // raw: a stage id may legitimately carry a space, which `displayIdent`
    // quotes. Rendering at the WRITE site made the stored form disagree with
    // the user's pattern, so the stage they named read as `Possibly unrelated`.
    for (const [stagePath, patterns] of [
      ['Outer/Inner', ['Outer/Inner/Api']],
      ['My Stage', ['My Stage/Api']],
    ] as const) {
      const note = failedStageNote(patterns, [{ stagePath, reason: 'ENOENT' }]);
      expect(note).not.toContain('Possibly unrelated');
    }

    // ...and pin how each RENDERS, not only that it matches: the identity on
    // the ASCII-identifier path, JSON-quoted on the one carrying a space.
    expect(
      failedStageNote(['Outer/Inner/Api'], [{ stagePath: 'Outer/Inner', reason: 'e' }])
    ).toContain('Stage Outer/Inner failed to load');
    expect(failedStageNote(['My Stage/Api'], [{ stagePath: 'My Stage', reason: 'e' }])).toContain(
      'Stage "My Stage" failed to load'
    );
  });

  it('keeps a forging directoryName out of the read-failure sentence', () => {
    // The read failure's text used to be the caught message, which embeds the
    // manifest PATH -- and under a Stage that path embeds the assembly-chosen
    // `directoryName`, twice (Node repeats it in `open '<path>'`). A
    // `displaySafe` denylist passes the spaces and periods that turn it into a
    // second, cdkd-sounding clause.
    const forging = 'assembly-Foo. All 3 stacks deployed successfully. Stage Prod';
    const dir = outdir();

    const { failedStages } = new AssemblyReader().readAssembly(
      dir,
      manifest({ 'assembly-Foo': stageArtifact(forging, 'MyStage') })
    );

    const reason = failedStages[0]?.reason ?? '';
    // The forged clause is inside JSON quotes, so it cannot read as prose...
    expect(reason).toBe(`ENOENT reading ${JSON.stringify(forging)}/manifest.json`);
    // ...and specifically does not run on into the next word unquoted.
    expect(reason).not.toContain('Stage Prod/manifest.json');
    // No filesystem path at all: neither our own clause nor Node's.
    expect(reason).not.toContain(dir);
  });

  it('reduces a malformed manifest.json to a fixed phrase, echoing none of the file', () => {
    // V8's SyntaxError quotes a short window of the file's OWN bytes verbatim
    // (`Unexpected token '.', ". All 3 st"... is not valid JSON`), and the
    // file is assembly-chosen too. The directory is already named, so the
    // snippet buys nothing. Only the errno branch was covered before, so a
    // later "restore the detail" edit would have gone unnoticed here.
    const dir = outdir();
    const stage = join(dir, 'assembly-MyStage');
    mkdirSync(stage, { recursive: true });
    writeFileSync(
      join(stage, 'manifest.json'),
      '{ "version": ". All 3 stacks deployed successfully. Stage Prod" ,,, }'
    );

    const { failedStages } = new AssemblyReader().readAssembly(
      dir,
      manifest({ 'assembly-MyStage': stageArtifact('assembly-MyStage', 'MyStage') })
    );

    expect(failedStages[0]?.reason).toBe('invalid JSON reading assembly-MyStage/manifest.json');
    expect(failedStages[0]?.reason).not.toContain('All 3 stacks');
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
    expect(message).toContain("Stage MyStage failed to load");
  });

  it('does not print a dangling "Available:" when the failed Stage emptied the assembly', () => {
    const dir = outdir();

    let message = '';
    try {
      new AssemblyReader().getStack(
        dir,
        manifest({ 'assembly-MyStage': stageArtifact('assembly-MyStage', 'MyStage') }),
        'MyStage-Api'
      );
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toBe(
      "Stack 'MyStage-Api' not found in assembly. The assembly has no stacks. " +
        // Hedged: `MyStage-Api` is a PHYSICAL name, which carries no stage
        // path, so the link to `MyStage` cannot be proven from it.
        'Possibly unrelated: ' +
        'Stage MyStage failed to load, so stacks under it are missing from this list ' +
        'rather than missing from the app: ENOENT reading assembly-MyStage/manifest.json'
    );
    expect(message).not.toContain('Available:');
    expect(message).not.toContain('stacks.. ');
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
