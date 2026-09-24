/**
 * Issue [go-to-k/cdkd#2660](https://github.com/go-to-k/cdkd/issues/2660):
 * the `--remove-protection` help left out `AWS::EMR::Cluster` and
 * `AWS::DynamoDB::GlobalTable`, whose providers honour the flag.
 *
 * The help now renders from `removeProtectionTypes()`. This file binds its SDK
 * half to the provider tree in both directions, so the list cannot drift from
 * what the code does:
 *
 * - every listed type's REGISTERED provider reads `removeProtection`;
 * - every provider file that reads `removeProtection` registers at least one
 *   listed type. This is the direction that caught the two missing types.
 *
 * Known limit: a provider file already in the list that gains the flip for a
 * SECOND type it registers (e.g. another EC2 type) is not caught. Only a
 * per-branch reading of each `delete()` could see that. Nor is a provider that
 * reads the flag through a parameter not named `context`; every provider does
 * today.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vite-plus/test';
import { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import { registerAllProviders } from '../../../src/provisioning/register-providers.js';
import {
  SDK_REMOVE_PROTECTION_TYPES,
  removeProtectionTypes,
} from '../../../src/provisioning/remove-protection-types.js';
import { ccProtectionRegistryTypes } from '../../../src/provisioning/cc-protection-properties.js';
import {
  destroyRemoveProtectionHelp,
  stateDestroyRemoveProtectionHelp,
} from './remove-protection-help.js';

const PROVIDERS_DIR = join(import.meta.dirname, '../../../src/provisioning/providers');

const files = readdirSync(PROVIDERS_DIR).filter((f) => f.endsWith('.ts'));
const source = new Map(files.map((f) => [f, readFileSync(join(PROVIDERS_DIR, f), 'utf8')]));

/** Provider class name -> the file declaring it. */
function fileOfClass(className: string): string | undefined {
  return files.find((f) => source.get(f)!.includes(`export class ${className} `));
}

/** Every registered type -> the file of the provider instance it is registered to. */
function registeredTypeFiles(): Map<string, string> {
  const registry = new ProviderRegistry();
  registerAllProviders(registry);
  const out = new Map<string, string>();
  for (const type of registry.getRegisteredTypes()) {
    const file = fileOfClass(registry.getProvider(type).constructor.name);
    if (file) out.set(type, file);
  }
  return out;
}

/**
 * A `delete()` gating on the flag. The call-site spelling, not the bare
 * identifier, so a mention in a comment does not count.
 * `nested-stack-provider.ts` forwards the flag to the child destroy
 * (`deleteContext?.removeProtection`) without flipping anything, and does not
 * match.
 */
const readsFlag = (file: string): boolean =>
  /\bcontext\?\.removeProtection\b/.test(source.get(file)!);

describe('--remove-protection types match the providers (go-to-k/cdkd#2660)', () => {
  const typeFiles = registeredTypeFiles();

  it('resolves registered types to provider files (so the sweeps below read something)', () => {
    expect(typeFiles.size).toBeGreaterThanOrEqual(100);
  });

  it("every listed SDK type's registered provider reads removeProtection", () => {
    const wrong = SDK_REMOVE_PROTECTION_TYPES.filter((t) => {
      const file = typeFiles.get(t);
      return file === undefined || !readsFlag(file);
    });
    expect(wrong).toEqual([]);
  });

  it('every provider file that reads removeProtection registers a listed type', () => {
    const flipping = files.filter(readsFlag);
    // Floor: 11 flipping files as of go-to-k/cdkd#2660, so a regex that
    // stopped matching cannot pass this by finding none.
    expect(flipping.length).toBeGreaterThanOrEqual(11);
    const listed = new Set(SDK_REMOVE_PROTECTION_TYPES);
    const unlisted = flipping.filter(
      (f) => ![...typeFiles].some(([type, file]) => file === f && listed.has(type))
    );
    expect(
      unlisted,
      'a provider honours --remove-protection but none of its types is in SDK_REMOVE_PROTECTION_TYPES'
    ).toEqual([]);
  });

  it('the SDK list and the Cloud Control registry do not overlap', () => {
    const cc = new Set(ccProtectionRegistryTypes());
    expect(SDK_REMOVE_PROTECTION_TYPES.filter((t) => cc.has(t))).toEqual([]);
  });

  for (const [label, help] of [
    ['cdkd destroy', destroyRemoveProtectionHelp()],
    ['cdkd state destroy', stateDestroyRemoveProtectionHelp()],
  ] as const) {
    it(`${label} --remove-protection help names every covered type`, () => {
      expect(removeProtectionTypes().filter((t) => !help.includes(t))).toEqual([]);
      // The two the hand-written copies had dropped.
      expect(help).toContain('AWS::EMR::Cluster');
      expect(help).toContain('AWS::DynamoDB::GlobalTable');
      expect(help).toMatch(/, and AWS::[A-Za-z0-9]+::[A-Za-z0-9]+\.$/);
    });
  }
});
