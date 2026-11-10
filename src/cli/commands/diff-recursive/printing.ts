import { nullPrototypeRecord } from '../../../utils/own-keys.js';
import type { PropertyChange, ResourceChange } from '../../../types/state.js';
import type { OutputChange } from '../../../analyzer/outputs-diff.js';
import { secretSafeKeyDisplay } from '../../../deployment/outputs-export-alias.js';
import {
  SECRET_MASK,
  createUnionSecretMasker,
  isSingleDynamicReferenceToken,
  logOnlyValueCount,
  printingCorpusOf,
  recordLogOnlyValue,
  type RecordedSecretValues,
} from '../../../deployment/secret-redaction.js';
import type { MaskerFn } from '../../../provisioning/masked-retry-logger.js';
import type { SecretTokensByParameter } from './types.js';

/**
 * Every token of a {@link SecretTokensByParameter}, merged BY SPELLING, as a
 * resolver pass reads them: inside the child a named token stays whole in any
 * `Fn::Split`, even one over another parameter that received the same
 * spelling as text. The deploy's `standsForInheritedSecret` reads its
 * inherited bag the same way, keyed by token, not by parameter.
 */
export function standInTokensOf(
  byParameter: SecretTokensByParameter | undefined
): ReadonlySet<string> | undefined {
  if (byParameter === undefined) return undefined;
  const all = new Set<string>();
  for (const tokens of byParameter.values()) for (const token of tokens) all.add(token);
  return all.size > 0 ? all : undefined;
}

/**
 * The PRINTING corpus of one `cdkd diff` node (go-to-k/cdkd#4049), as one bag
 * of log-only needles: every needle of the diff resolver's own bag, of the
 * node's `NoEcho` parameter values, and of the bag a nested child inherits
 * from its parent. ONE bag, so `maskSecretsInText` masks all of them in one
 * pass.
 *
 * A needle that IS one whole `{{resolve:...}}` token is left out: this
 * command prints a dynamic reference as its expression (it never resolves a
 * secret), and a `NoEcho` parameter fed one is that expression, not a value.
 * A needle merely CONTAINING one keeps its literal part secret, so it stays.
 *
 * Its map is EMPTY, only log-only needles: the resolver takes it as
 * `inheritedSecrets` for its debug lines, and every resolver reader that
 * DECIDES (the coerced-secret refusal, the parameter associations, the
 * recorded-secret tests) reads the map. It persists nothing: `cdkd diff`
 * writes nothing.
 */
export function diffPrintingSecrets(
  bags: ReadonlyArray<RecordedSecretValues | undefined>
): RecordedSecretValues {
  const all: RecordedSecretValues = new Map();
  for (const bag of bags) {
    if (bag === undefined) continue;
    for (const needle of printingCorpusOf(bag).keys()) {
      if (!isSingleDynamicReferenceToken(needle)) recordLogOnlyValue(all, needle);
    }
  }
  return all;
}

/**
 * ONE cached printing masker over a node's bags (go-to-k/cdkd#4049): the
 * {@link diffPrintingSecrets} corpus and its regex are rebuilt only when a bag
 * GREW, so a value walk masks every leaf against one compiled regex while a
 * needle the resolver records mid-walk (an `Fn::Base64` encoding) still lands
 * on the next call. Sound because a pass's bags only grow.
 */
export function createDiffPrintingMasker(
  bags: ReadonlyArray<RecordedSecretValues | undefined>,
  /** Masked with, but left out of `corpus()` (go-to-k/cdkd#4049). */
  maskOnly: ReadonlyArray<RecordedSecretValues>
): {
  mask: MaskerFn;
  corpus: () => RecordedSecretValues;
  /** `corpus()` plus the mask-only bags: for this node's own printing only. */
  maskCorpus: () => RecordedSecretValues;
} {
  const present = bags.filter((bag): bag is RecordedSecretValues => bag !== undefined);
  let stamp: string | undefined;
  let corpus: RecordedSecretValues = new Map();
  let maskCorpus: RecordedSecretValues = new Map();
  let masker: MaskerFn = (text) => text;
  const refresh = (): void => {
    const now = [...present, ...maskOnly]
      .map((bag) => `${bag.size}:${logOnlyValueCount(bag)}`)
      .join(',');
    if (now === stamp) return;
    corpus = diffPrintingSecrets(present);
    maskCorpus = diffPrintingSecrets([...present, ...maskOnly]);
    masker = createUnionSecretMasker([maskCorpus]);
    stamp = now;
  };
  return {
    mask: (text) => {
      refresh();
      return masker(text);
    },
    corpus: () => {
      refresh();
      return corpus;
    },
    maskCorpus: () => {
      refresh();
      return maskCorpus;
    },
  };
}

/**
 * Past this depth a value is tested WHOLE: every string leaf, key and
 * number / boolean leaf below it is visited ITERATIVELY, and the subtree is
 * kept as it is when none holds a needle, replaced by the mask when one does.
 * Never returned unmasked with a needle inside.
 */
const DIFF_VALUE_MASK_MAX_DEPTH = 32;

/** Does any leaf or key under `value` change under `mask`? No recursion, so no depth limit. */
function subtreeCarriesNeedle(value: unknown, mask: MaskerFn): boolean {
  const pending: unknown[] = [value];
  // A shared subtree is walked once: a DAG of references is otherwise walked
  // once per path, exponential in its depth.
  const visited = new Set<object>();
  while (pending.length > 0) {
    const next = pending.pop();
    if (next !== null && typeof next === 'object') {
      if (visited.has(next)) continue;
      visited.add(next);
    }
    if (typeof next === 'string') {
      if (mask(next) !== next) return true;
    } else if (typeof next === 'number' || typeof next === 'boolean') {
      if (mask(String(next)) !== String(next)) return true;
    } else if (Array.isArray(next)) {
      pending.push(...next);
    } else if (next !== null && typeof next === 'object') {
      for (const [key, leaf] of Object.entries(next as Record<string, unknown>)) {
        pending.push(key, leaf);
      }
    }
  }
  return false;
}

/**
 * `value` as `cdkd diff` prints it (go-to-k/cdkd#4049): each string leaf and
 * object key through `mask`, and a number or boolean leaf whose printed form
 * `mask` changes replaced by the mask (a `Number` `NoEcho` parameter). Masks
 * the VALUE, not the serialised text, so a needle holding `"` or `\` is still
 * found, and `--json` escapes what is left.
 *
 * Returns `value` ITSELF when nothing changed, so an unmasked record keeps
 * its identity and shape. Never mutates `value`: the old side is the state
 * record's own object.
 */
export function maskDiffValue(value: unknown, mask: MaskerFn, depth = 0): unknown {
  if (typeof value === 'string') return mask(value);
  if (typeof value === 'number' || typeof value === 'boolean') {
    const text = String(value);
    return mask(text) === text ? value : SECRET_MASK;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= DIFF_VALUE_MASK_MAX_DEPTH) {
    return subtreeCarriesNeedle(value, mask) ? SECRET_MASK : value;
  }
  if (Array.isArray(value)) {
    const masked = value.map((element: unknown) => maskDiffValue(element, mask, depth + 1));
    return masked.every((element, index) => element === value[index]) ? value : masked;
  }
  let changed = false;
  const masked = nullPrototypeRecord<unknown>();
  for (const [key, leaf] of Object.entries(value as Record<string, unknown>)) {
    const shownKey = mask(key);
    const shownLeaf = maskDiffValue(leaf, mask, depth + 1);
    if (shownKey !== key || shownLeaf !== leaf) changed = true;
    // Two keys masking to one spelling would drop a row: the object is then
    // withheld whole instead.
    if (Object.prototype.hasOwnProperty.call(masked, shownKey)) return SECRET_MASK;
    masked[shownKey] = shownLeaf;
  }
  return changed ? masked : value;
}

/**
 * The OLD side shown beside a new side (go-to-k/cdkd#4049). State keeps a
 * `NoEcho` value in the clear, and only the CURRENT value is a needle, so a
 * rotated value's previous plaintext would print. When the new side carries a
 * needle, the old side is therefore withheld whole: the property served by a
 * secret now is taken to have been served by it before. CloudFormation's
 * change set prints `****` for both sides the same way.
 */
function maskedOldSide(oldValue: unknown, newCarriesNeedle: boolean, mask: MaskerFn): unknown {
  if (newCarriesNeedle && oldValue !== undefined) return SECRET_MASK;
  return maskDiffValue(oldValue, mask);
}

/** One resource change as `cdkd diff` prints it; the same object when nothing is masked. */
export function maskResourceChangeForDisplay(
  change: ResourceChange,
  mask: MaskerFn
): ResourceChange {
  if (!change.propertyChanges || change.propertyChanges.length === 0) return change;
  let changed = false;
  const propertyChanges = change.propertyChanges.map((propertyChange): PropertyChange => {
    const newValue = maskDiffValue(propertyChange.newValue, mask);
    // go-to-k/cdkd#6078: the template value printed in place of a stale
    // `newValue` is a new side too.
    const hasTemplate = Object.prototype.hasOwnProperty.call(propertyChange, 'newValueTemplate');
    const newValueTemplate = hasTemplate
      ? maskDiffValue(propertyChange.newValueTemplate, mask)
      : undefined;
    const oldValue = maskedOldSide(
      propertyChange.oldValue,
      newValue !== propertyChange.newValue ||
        (hasTemplate && newValueTemplate !== propertyChange.newValueTemplate),
      mask
    );
    // `path` is a top-level property NAME the template's resource schema
    // spells, never a value, so it is printed as it is.
    if (
      newValue === propertyChange.newValue &&
      oldValue === propertyChange.oldValue &&
      newValueTemplate === propertyChange.newValueTemplate
    ) {
      return propertyChange;
    }
    changed = true;
    return {
      ...propertyChange,
      oldValue,
      newValue,
      ...(hasTemplate && { newValueTemplate }),
    };
  });
  return changed ? { ...change, propertyChanges } : change;
}

/**
 * One Outputs change as `cdkd diff` prints it (go-to-k/cdkd#4049): the values
 * as {@link maskResourceChangeForDisplay} masks a property's, and a row NAME
 * holding a needle (an `Export.Name` built from a `NoEcho` value) through
 * `secretSafeKeyDisplay`'s verdict, unless `computeOutputsDiff` already gave
 * it one.
 */
export function maskOutputChangeForDisplay(
  change: OutputChange,
  mask: MaskerFn,
  nameCorpus: RecordedSecretValues
): OutputChange {
  const shown: OutputChange = { ...change };
  let changed = false;
  let newCarriesNeedle = false;
  if (Object.prototype.hasOwnProperty.call(change, 'newValue')) {
    shown.newValue = maskDiffValue(change.newValue, mask);
    newCarriesNeedle = shown.newValue !== change.newValue;
    changed ||= newCarriesNeedle;
  }
  if (Object.prototype.hasOwnProperty.call(change, 'oldValue')) {
    shown.oldValue = maskedOldSide(change.oldValue, newCarriesNeedle, mask);
    changed ||= shown.oldValue !== change.oldValue;
  }
  if (change.nameDisplay === undefined) {
    const display = secretSafeKeyDisplay(change.name, nameCorpus);
    if (display.kind !== 'safe') {
      shown.nameDisplay = display;
      changed = true;
    }
  } else if (
    change.nameDisplay.kind === 'masked' &&
    secretSafeKeyDisplay(change.name, nameCorpus).kind !== 'safe'
  ) {
    // `computeOutputsDiff` masked another secret in it, and the RAW name holds
    // a `NoEcho` value too. Its masked text is a normalised string, so masking
    // that again would test a different string than the verdict did: the name
    // is withheld instead, decided on the raw key alone.
    shown.nameDisplay = { kind: 'withheld' };
    changed = true;
  }
  return changed ? shown : change;
}
