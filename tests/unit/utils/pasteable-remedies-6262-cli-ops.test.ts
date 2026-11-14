import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import { buildProgram } from '../../../src/cli/program.js';
import { setPasteableRunFlags } from '../../../src/utils/pasteable-run-context.js';
import { incompleteRemediationMessage } from '../../../src/cli/commands/drift/outcome.js';
import { blockedMigrationTail } from '../../../src/cli/commands/export/import-plan.js';
import { unrepresentableOverlayMessage } from '../../../src/cli/commands/export/template-overlay.js';
import { pickStackRegion } from '../../../src/cli/commands/export/command-helpers.js';
import { rollbackJournalRefusal } from '../../../src/cli/commands/refactor/apply.js';
import { unresolvableCrossStackReadError } from '../../../src/cli/commands/scrub/cross-stack-refusals.js';
import { renderOutputChangeLines } from '../../../src/cli/commands/diff-recursive/render.js';
import { claimRegistryMarkerAfterImport } from '../../../src/cli/commands/import/stack-state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { OutputChange } from '../../../src/analyzer/outputs-diff.js';

vi.mock('../../../src/state/stack-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/state/stack-registry.js')>();
  class FakeGuard {
    async full(): Promise<unknown> {
      return { kind: 'found', prefixes: ['other'] };
    }
  }
  return { ...actual, CrossPrefixGuard: FakeGuard };
});

/**
 * go-to-k/cdkd#6262, `cdkd drift` / `export` / `refactor` / `scrub` / `diff` /
 * `import` remedies: each carries the run's typed `--aws-emulator`, and is
 * byte-identical when no flag was typed.
 */
const EMU = 'https://127.0.0.1:4599';
const FLAG = `--aws-emulator=${EMU}`;

beforeEach(() => {
  buildProgram();
});
afterEach(() => {
  setPasteableRunFlags({});
});

function withEmulator(): void {
  setPasteableRunFlags({ awsEmulator: EMU });
}

describe('drift remedies (#6262)', () => {
  it('re-run `cdkd drift` carries the emulator flag', () => {
    withEmulator();
    expect(incompleteRemediationMessage([], 'revert').at(-1)).toContain(
      `Re-run 'cdkd drift ${FLAG}' without --revert to see`
    );
  });
  it('is unchanged without a flag', () => {
    setPasteableRunFlags({});
    expect(incompleteRemediationMessage([], 'revert').at(-1)).toContain(
      "Re-run 'cdkd drift' without --revert to see"
    );
  });
});

describe('export remedies (#6262)', () => {
  const entry = { logicalId: 'Res', resourceType: 'AWS::X::Y' };
  it('re-run `cdkd export` carries the emulator flag', () => {
    withEmulator();
    expect(unrepresentableOverlayMessage(entry, 'f', ['a'], 'v')).toContain(
      `re-run 'cdkd export ${FLAG}'.`
    );
    expect(blockedMigrationTail([])).toBe(
      `Run each row's 'Repair with:' command, then re-run cdkd export ${FLAG}.`
    );
  });
  it('is unchanged without a flag', () => {
    setPasteableRunFlags({});
    expect(unrepresentableOverlayMessage(entry, 'f', ['a'], 'v')).toContain("re-run 'cdkd export'.");
    expect(blockedMigrationTail([])).toBe(
      "Run each row's 'Repair with:' command, then re-run cdkd export."
    );
  });
  it('`cdkd state list` carries the emulator flag', async () => {
    const backend = { listStacks: async () => [] } as unknown as S3StateBackend;
    withEmulator();
    await expect(pickStackRegion(backend, 'S', undefined, undefined)).rejects.toThrow(
      `Run 'cdkd state list ${FLAG}' to see available stacks.`
    );
    setPasteableRunFlags({});
    await expect(pickStackRegion(backend, 'S', undefined, undefined)).rejects.toThrow(
      "Run 'cdkd state list' to see available stacks."
    );
  });
});

describe('refactor remedies: rollback / deploy (#6262)', () => {
  it('carries the emulator flag', () => {
    withEmulator();
    expect(rollbackJournalRefusal('S', 'us-east-1').message).toContain(
      `Run 'cdkd rollback S ${FLAG}' or a successful 'cdkd deploy ${FLAG}' first.`
    );
  });
  it('is unchanged without a flag', () => {
    setPasteableRunFlags({});
    expect(rollbackJournalRefusal('S', 'us-east-1').message).toContain(
      "Run 'cdkd rollback S' or a successful 'cdkd deploy' first."
    );
  });
});

describe('scrub remedies (#6262)', () => {
  const build = (): string =>
    unresolvableCrossStackReadError('o', 'S', 'Fn::GetAtt', '', new Error('x'), new Map()).message;
  it('carries the emulator flag', () => {
    withEmulator();
    expect(build()).toContain(`re-run 'cdkd scrub ${FLAG}'.`);
  });
  it('is unchanged without a flag', () => {
    setPasteableRunFlags({});
    expect(build()).toContain("re-run 'cdkd scrub'.");
  });
});

describe('diff-recursive scrub hint (#6262)', () => {
  const render = (): string => {
    const lines: string[] = [];
    const change = {
      changeType: 'MODIFY',
      name: 'Out',
      isExport: false,
      oldValue: 'x',
      newValue: 'y',
      oldValueRedacted: true,
    } as unknown as OutputChange;
    renderOutputChangeLines([change], (m) => lines.push(m));
    return lines.join('\n');
  };
  it('carries the emulator flag', () => {
    withEmulator();
    expect(render()).toContain(`run \`cdkd scrub ${FLAG}\`>`);
  });
  it('is unchanged without a flag', () => {
    setPasteableRunFlags({});
    expect(render()).toContain('run `cdkd scrub`>');
  });
});

describe('import remedies: state orphan (#6262)', () => {
  const warn = async (): Promise<string> => {
    const warnings: string[] = [];
    await claimRegistryMarkerAfterImport({} as S3StateBackend, 'S', 'us-east-1', {
      warn: (m) => warnings.push(m),
      debug: () => {},
    });
    return warnings.join('\n');
  };
  it('carries the emulator flag', async () => {
    withEmulator();
    expect(await warn()).toContain(`with 'cdkd state orphan ${FLAG}' before deploying`);
  });
  it('is unchanged without a flag', async () => {
    setPasteableRunFlags({});
    expect(await warn()).toContain("with 'cdkd state orphan' before deploying");
  });
});
