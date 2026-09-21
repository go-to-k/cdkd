/**
 * Every path `AssemblyReader` and `collectStackMessages` build from a Cloud
 * Assembly must stay inside the assembly directory (issue go-to-k/cdkd#3489).
 *
 * `cdkd deploy -a <dir>` / `cdkd synth -a <dir>` consume a PRE-SYNTHESIZED
 * assembly with no CDK subprocess in between, so nothing upstream validates a
 * manifest string. `path.join` folds `..`, so a `templateFile` of
 * `../../../home/user/.aws/credentials` was read from outside the directory
 * and — where it parsed — became the template cdkd deploys.
 *
 * Four sites live in `assembly-reader.ts` (a nested assembly's
 * `directoryName`, a stack's `templateFile`, an asset-manifest artifact's
 * `file`, and a nested-stack row's `Metadata['aws:asset:path']`) and one in
 * `stack-messages.ts` (`additionalMetadataFile`). Each is pinned in BOTH
 * polarities: the escaping value refuses with the containment message, an
 * ordinary sibling still loads, and a value that normalises back inside still
 * loads. The nested-stack site additionally keeps its ABSOLUTE tripwire, whose
 * message must stay distinguishable — `join` never lets an absolute value
 * leave the directory, so the two refusals answer different questions.
 *
 * Real files on disk rather than a `vi.mock` of `node:fs`: the escape is a
 * property of the FILESYSTEM resolution, and the symlink arm cannot be
 * exhibited against a mock at all.
 */
import { describe, it, expect } from 'vite-plus/test';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { AssemblyReader } from '../../../src/synthesis/assembly-reader.js';
import { collectStackMessages } from '../../../src/synthesis/stack-messages.js';
import type { AssemblyManifest, ArtifactManifest } from '../../../src/types/assembly.js';

function tmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'cdkd-assembly-containment-')));
}

/** An assembly directory with a sibling file OUTSIDE it, as a hostile tarball has. */
function assembly(): { dir: string; outside: string } {
  const root = tmp();
  const dir = join(root, 'cdk.out');
  mkdirSync(dir);
  writeFileSync(join(root, 'outside.json'), JSON.stringify({ Resources: {} }));
  return { dir, outside: '../outside.json' };
}

function stackArtifact(props: Record<string, unknown>, extra = {}): ArtifactManifest {
  return {
    type: 'aws:cloudformation:stack',
    properties: { stackName: 'MainStack', ...props },
    ...extra,
  } as ArtifactManifest;
}

function manifest(artifacts: Record<string, ArtifactManifest>): AssemblyManifest {
  return { version: '54.0.0', artifacts } as AssemblyManifest;
}

/** A template whose one nested-stack row carries `assetPath`. */
function nestedTemplate(assetPath: string | undefined): string {
  return JSON.stringify({
    Resources: {
      Child: {
        Type: 'AWS::CloudFormation::Stack',
        ...(assetPath === undefined ? {} : { Metadata: { 'aws:asset:path': assetPath } }),
      },
    },
  });
}

const CONTAINMENT = /resolves to '.*', outside '.*'\./;

describe('AssemblyReader: a nested assembly directoryName', () => {
  it('refuses one that escapes the assembly directory', () => {
    const { dir } = assembly();
    const escapingDir = join(dirname(dir), 'outside-assembly');
    mkdirSync(escapingDir);
    writeFileSync(join(escapingDir, 'manifest.json'), JSON.stringify(manifest({})));

    expect(() =>
      new AssemblyReader().getAllStacks(
        dir,
        manifest({
          Stage: {
            type: 'cdk:cloud-assembly',
            properties: { directoryName: '../outside-assembly' },
          } as ArtifactManifest,
        })
      )
    ).toThrow(
      /Nested assembly '\.\.\/outside-assembly' resolves to '.*outside-assembly', outside/
    );
  });

  it('THROWS rather than degrading to the warn-and-skip the read failure takes', () => {
    // The surrounding catch turns an unreadable nested assembly into a warning
    // and drops every stack under the Stage. The escape must fail closed.
    const { dir } = assembly();

    expect(() =>
      new AssemblyReader().getAllStacks(
        dir,
        manifest({
          Stage: {
            type: 'cdk:cloud-assembly',
            properties: { directoryName: '../outside-assembly' },
          } as ArtifactManifest,
        })
      )
    ).toThrow();
  });

  it('still reads an ordinary sub-directory, and one that normalises back inside', () => {
    // The nested manifest carries a STACK, and the assertion is that it comes
    // back. An empty expectation would be satisfied by the warn-and-skip this
    // site exists to stay out of, so it could not tell "recursed" from
    // "silently dropped the Stage".
    const { dir } = assembly();
    for (const name of ['assembly-MyStage', 'other']) {
      mkdirSync(join(dir, name));
      writeFileSync(
        join(dir, name, 'manifest.json'),
        JSON.stringify(manifest({ Inner: stackArtifact({ templateFile: 'Inner.template.json' }) }))
      );
      writeFileSync(join(dir, name, 'Inner.template.json'), JSON.stringify({ Resources: {} }));
    }

    for (const directoryName of ['assembly-MyStage', 'other/../assembly-MyStage']) {
      const stacks = new AssemblyReader().getAllStacks(
        dir,
        manifest({
          Stage: { type: 'cdk:cloud-assembly', properties: { directoryName } } as ArtifactManifest,
        })
      );
      expect(stacks.map((s) => s.stackName)).toEqual(['MainStack']);
      expect(stacks[0]?.artifactId).toBe('Inner');
    }
  });

  it('refuses a directoryName that stays inside lexically but leads out through a symlink', () => {
    const { dir } = assembly();
    mkdirSync(join(dirname(dir), 'outside-assembly'));
    symlinkSync(dirname(dir), join(dir, 'link'), 'dir');

    expect(() =>
      new AssemblyReader().getAllStacks(
        dir,
        manifest({
          Stage: {
            type: 'cdk:cloud-assembly',
            properties: { directoryName: 'link/outside-assembly' },
          } as ArtifactManifest,
        })
      )
    ).toThrow(/leads through a symbolic link to '.*outside-assembly', outside/);
  });
});

describe('AssemblyReader: a stack templateFile', () => {
  it('refuses one that escapes, naming the value and the resolved path', () => {
    const { dir, outside } = assembly();

    expect(() =>
      new AssemblyReader().getAllStacks(
        dir,
        manifest({ MainStack: stackArtifact({ templateFile: outside }) })
      )
    ).toThrow(
      /Stack 'MainStack' has templateFile='\.\.\/outside\.json' which resolves to '.*outside\.json', outside/
    );
  });

  it('still loads an ordinary sibling and a value that normalises back inside', () => {
    const { dir } = assembly();
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'MainStack.template.json'), JSON.stringify({ Resources: {} }));

    for (const templateFile of ['MainStack.template.json', 'sub/../MainStack.template.json']) {
      const stacks = new AssemblyReader().getAllStacks(
        dir,
        manifest({ MainStack: stackArtifact({ templateFile }) })
      );
      expect(stacks.map((s) => s.stackName)).toEqual(['MainStack']);
    }
  });

  it('refuses a lexically contained value that leads out through a symlink', () => {
    const { dir } = assembly();
    symlinkSync(dirname(dir), join(dir, 'link'), 'dir');

    expect(() =>
      new AssemblyReader().getAllStacks(
        dir,
        manifest({ MainStack: stackArtifact({ templateFile: 'link/outside.json' }) })
      )
    ).toThrow(/leads through a symbolic link to '.*outside\.json', outside/);
  });
});

describe('AssemblyReader: an asset-manifest artifact file', () => {
  it('refuses one that escapes', () => {
    const { dir, outside } = assembly();
    writeFileSync(join(dir, 'MainStack.template.json'), JSON.stringify({ Resources: {} }));

    expect(() =>
      new AssemblyReader().getAllStacks(
        dir,
        manifest({
          'MainStack.assets': {
            type: 'cdk:asset-manifest',
            properties: { file: outside },
          } as ArtifactManifest,
          MainStack: stackArtifact({ templateFile: 'MainStack.template.json' }),
        })
      )
    ).toThrow(
      /Asset manifest artifact 'MainStack\.assets' has file='\.\.\/outside\.json' which resolves to/
    );
  });

  it('refuses one that stays inside lexically but leads out through a symlink', () => {
    const { dir } = assembly();
    writeFileSync(join(dir, 'MainStack.template.json'), JSON.stringify({ Resources: {} }));
    symlinkSync(dirname(dir), join(dir, 'link'), 'dir');

    expect(() =>
      new AssemblyReader().getAllStacks(
        dir,
        manifest({
          'MainStack.assets': {
            type: 'cdk:asset-manifest',
            properties: { file: 'link/outside.json' },
          } as ArtifactManifest,
          MainStack: stackArtifact({ templateFile: 'MainStack.template.json' }),
        })
      )
    ).toThrow(/leads through a symbolic link to '.*outside\.json', outside/);
  });

  it('still resolves a value that normalises back inside', () => {
    const { dir } = assembly();
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'MainStack.template.json'), JSON.stringify({ Resources: {} }));

    const stacks = new AssemblyReader().getAllStacks(
      dir,
      manifest({
        'MainStack.assets': {
          type: 'cdk:asset-manifest',
          properties: { file: 'sub/../MainStack.assets.json' },
        } as ArtifactManifest,
        MainStack: stackArtifact(
          { templateFile: 'MainStack.template.json' },
          { dependencies: ['MainStack.assets'] }
        ),
      })
    );

    expect(stacks[0]?.assetManifestPath).toBe(join(dir, 'MainStack.assets.json'));
  });

  it('still resolves an ordinary sibling asset manifest onto the stack', () => {
    const { dir } = assembly();
    writeFileSync(join(dir, 'MainStack.template.json'), JSON.stringify({ Resources: {} }));

    const stacks = new AssemblyReader().getAllStacks(
      dir,
      manifest({
        'MainStack.assets': {
          type: 'cdk:asset-manifest',
          properties: { file: 'MainStack.assets.json' },
        } as ArtifactManifest,
        MainStack: stackArtifact(
          { templateFile: 'MainStack.template.json' },
          { dependencies: ['MainStack.assets'] }
        ),
      })
    );

    expect(stacks[0]?.assetManifestPath).toBe(join(dir, 'MainStack.assets.json'));
  });
});

describe("AssemblyReader: a nested-stack row's aws:asset:path", () => {
  const read = (dir: string): unknown =>
    new AssemblyReader().getAllStacks(
      dir,
      manifest({ MainStack: stackArtifact({ templateFile: 'MainStack.template.json' }) })
    );

  it('refuses one that escapes, with the containment message', () => {
    const { dir, outside } = assembly();
    writeFileSync(join(dir, 'MainStack.template.json'), nestedTemplate(outside));

    expect(() => read(dir)).toThrow(
      /nested-stack 'Child' has Metadata\['aws:asset:path'\]='\.\.\/outside\.json' which resolves to/
    );
    expect(() => read(dir)).toThrow(CONTAINMENT);
  });

  it('keeps the ABSOLUTE tripwire, whose message stays distinguishable', () => {
    const { dir } = assembly();
    writeFileSync(join(dir, 'MainStack.template.json'), nestedTemplate('/etc/hosts'));

    expect(() => read(dir)).toThrow(/which is absolute/);
    expect(() => read(dir)).not.toThrow(CONTAINMENT);
  });

  it('refuses one that stays inside lexically but leads out through a symlink', () => {
    const { dir } = assembly();
    symlinkSync(dirname(dir), join(dir, 'link'), 'dir');
    writeFileSync(join(dir, 'MainStack.template.json'), nestedTemplate('link/outside.json'));

    expect(() => read(dir)).toThrow(
      /leads through a symbolic link to '.*outside\.json', outside/
    );
  });

  it('still indexes an ordinary sibling and a value that normalises back inside', () => {
    const { dir } = assembly();
    mkdirSync(join(dir, 'sub'));

    for (const assetPath of ['Child.nested.template.json', 'sub/../Child.nested.template.json']) {
      writeFileSync(join(dir, 'MainStack.template.json'), nestedTemplate(assetPath));
      const stacks = new AssemblyReader().getAllStacks(
        dir,
        manifest({ MainStack: stackArtifact({ templateFile: 'MainStack.template.json' }) })
      );
      expect(stacks[0]?.nestedTemplates).toEqual({
        Child: join(dir, 'Child.nested.template.json'),
      });
    }
  });
});

describe('collectStackMessages: additionalMetadataFile', () => {
  it('refuses one that escapes', () => {
    const { dir, outside } = assembly();
    writeFileSync(join(dirname(dir), 'outside.json'), JSON.stringify({ '/x': [] }));

    expect(() =>
      collectStackMessages(dir, stackArtifact({}, { additionalMetadataFile: outside }))
    ).toThrow(
      /Stack metadata file '\.\.\/outside\.json' resolves to '.*outside\.json', outside .* Refusing to load\./
    );
  });

  it('still reads an ordinary side file and one that normalises back inside', () => {
    const { dir } = assembly();
    mkdirSync(join(dir, 'sub'));
    writeFileSync(
      join(dir, 'MainStack.metadata.json'),
      JSON.stringify({ '/MainStack': [{ type: 'aws:cdk:warning', data: 'careful' }] })
    );

    for (const file of ['MainStack.metadata.json', 'sub/../MainStack.metadata.json']) {
      expect(collectStackMessages(dir, stackArtifact({}, { additionalMetadataFile: file }))).toEqual(
        [{ level: 'warning', path: '/MainStack', message: 'careful' }]
      );
    }
  });

  it('refuses a lexically contained side file that leads out through a symlink', () => {
    const { dir } = assembly();
    writeFileSync(join(dirname(dir), 'outside.json'), JSON.stringify({ '/x': [] }));
    symlinkSync(dirname(dir), join(dir, 'link'), 'dir');

    expect(() =>
      collectStackMessages(dir, stackArtifact({}, { additionalMetadataFile: 'link/outside.json' }))
    ).toThrow(/leads through a symbolic link to/);
  });
});
