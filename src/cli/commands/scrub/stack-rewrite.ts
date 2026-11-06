import { isSupersededResourceRecord } from '../../../deployment/superseded-resources.js';
import { nullPrototypeRecord } from '../../../utils/own-keys.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import {
  scrubResourceRecord,
  redactForState,
  printingCorpusOf,
  maskSecretsInText,
  type RecordedSecretValues,
} from '../../../deployment/secret-redaction.js';
import { keepHeldTokenProvenance } from '../../../deployment/reference-provenance-record.js';
// An export NAME is a template-controlled RESOLVED value and an index read's
// error message interpolates a bucket / key, so both reach the terminal only
// through the same control-byte strip `export-index-store.ts` uses for the
// name it logs.
import { displayIdent, displayStackName, safeMsg } from '../../../utils/display-safe.js';
import type { StackState } from '../../../types/state.js';
import { stackInstanceIdCarriedFrom } from '../../../types/state.js';
import {
  exportAliasCollisionScrubWarning,
  secretBearingStateKeyWarning,
  secretBearing,
  secretSafeKeyDisplay,
} from '../../../deployment/outputs-export-alias.js';
import { isReadableBag } from '../../../state/malformed-resources-bag.js';
import { renderStateKeyForLine } from './errors.js';
import { saveScrubbedState } from './save-state.js';
import {
  NESTED_STACK_TYPE,
  type NestedChildScrubInput,
  type NestedChildScrubTarget,
  nestedChildRefusal,
  nestedChildParameters,
} from './nested.js';
import {
  allRecordedSecrets,
  redactUnaccountedOutputs,
  planUnnamedOutputDrop,
  knownExportNamesOf,
  addStoredStringLeaves,
  type DroppedOutputReader,
  readConsumerRecords,
  findDroppedOutputReaders,
} from './outputs.js';
import { DYNAMIC_REFERENCE_OPENING } from './cross-region.js';
import { findUnrepairedCrossStackReadNames } from './cross-stack-findings.js';
import { type ScrubStackResult, exportNameDisplayOver } from './stack-result.js';
import type { ScrubStackRewriteInput } from './stack.js';
import {
  planScrubNoEcho,
  scrubMigrationNeedles,
  maskScrubNoEchoOutputs,
  applyScrubNoEcho,
  noEchoFilledRowParameters,
} from './noecho.js';

/**
 * {@link scrubStack}'s rewrite pass, moved verbatim (go-to-k/cdkd#5835): from
 * the needle maps the resolve pass filled, rewrite the resources, orphans,
 * cross-stack reads and outputs, save the record, and return the result.
 * Called as `return await` inside `scrubStack`'s `try`, so that function's
 * `catch` and `finally` still apply.
 */
export async function scrubStackRewritePass({
  stack,
  region,
  stateBackend,
  opts,
  logger,
  shownStack,
  nestedInput,
  perResourceSecrets,
  outputSecrets,
  orphanSecrets,
  prePassFindings,
  unverifiableLeaves,
  emitAbandonedScanNotes,
  purgeExaminedHistory,
  loaded,
  state,
  malformedResources,
  malformedResourceRows,
  malformedOutputs,
  malformedOrphans,
  malformedOrphanRows,
  perResourceTemplateProps,
  outputsTemplateSource,
  conditions,
  templateResources,
  accountedOutputKeys,
  collisions,
  outputsSourceUntrusted,
  everyExportAliasReproduced,
  declaredAliasOf,
  nestedRowParameters,
}: ScrubStackRewriteInput): Promise<ScrubStackResult> {
  for (const [name, exportName] of collisions) {
    logger.warn(exportAliasCollisionScrubWarning(name, exportName, outputSecrets));
  }

  // A KEY that already holds plaintext is the residue of an earlier binary
  // publishing an export name that resolved to a secret (issue #1919). No
  // redaction pass can reach it — they all walk values — so this is REPORTED,
  // never rewritten: see `secretBearingStateKeyWarning` for why renaming a key
  // here would be worse than leaving it, and for the template-side remedy.
  // Counted so a state that leaks only through a key cannot be reported clean
  // by `--dry-run --fail`.
  // `state.outputs ?? {}`: every other consumer treats the field as optional
  // (`export-index-store.ts`, `state.ts`, `nested-stack-provider.ts`) and so
  // does this function's own redaction call below, so indexing it directly
  // would make the REMEDIATION command throw on a state file that simply has
  // no outputs — refusing to scrub the resources it could have scrubbed.
  // `outputSecrets`, NOT the widened union issue #2005 introduces for the
  // VALUE pass below, and that is a decision rather than an oversight. The
  // union would also flag a KEY holding a plaintext only a RESOURCE still
  // references — the same detection gap one class over — but this scan feeds
  // the `--fail` exit code on a REAL run, so widening it would start failing
  // builds over a finding no scrub can remedy (a key is never rewritten; the
  // remedy is an `Export.Name` change plus a redeploy, per #1919). Repairing
  // a value and re-classifying a build are different changes and the second
  // one is not this issue's.
  const secretBearingKeys: string[] = [];
  for (const key of Object.keys(state.outputs ?? {})) {
    // ONE call decides both the guard and the message (issue #2874). The
    // previous shape took the verdict from the RAW key here and printed a
    // SANITISED one in the warning, so a key whose secret is split by an
    // invisible character was skipped by this `continue` — the
    // `--dry-run --fail` gate passed over a secret-bearing key — while a
    // key holding a SECOND such secret had it reconstituted into the
    // printed text.
    const display = secretSafeKeyDisplay(key, outputSecrets);
    if (!secretBearing(display)) continue;
    secretBearingKeys.push(key);
    logger.warn(secretBearingStateKeyWarning(stack.stackName, display));
  }

  // go-to-k/cdkd#4043 Phase C: the POSITIONAL arm and its MIGRATION rule.
  // A leaf today's template serves from a `NoEcho` parameter (or a declared
  // `NoEcho` `Fn::GetAtt`) is persisted as `***`, named in `noEchoLeaves`,
  // as a v11 deploy writes it. Where the record still holds the plaintext
  // there (a stack deployed before v11, or under an older `Default`), that
  // stored value becomes a value-arm needle of a second scrub of that record
  // alone, so its other copies in the record are masked too.
  const noEchoPlans = planScrubNoEcho(
    state,
    stack.template,
    perResourceTemplateProps,
    conditions,
    nestedInput?.noEchoParameters ?? [],
    nestedInput?.noEchoConditionalParameters ?? []
  );

  // The nested children this stack deploys (go-to-k/cdkd#2252): every
  // `AWS::CloudFormation::Stack` row the template declares OR the record
  // holds. Each becomes a target carrying the parameters and bag above, or a
  // refusal naming why none could be derived — raised by the child's own
  // scrub only if its record exists.
  const nestedChildren: NestedChildScrubTarget[] = [];
  const nestedRowIds = new Set<string>();
  for (const [logicalId, resource] of Object.entries(templateResources)) {
    if (resource?.Type === NESTED_STACK_TYPE) nestedRowIds.add(logicalId);
  }
  for (const [logicalId, record] of Object.entries(state.resources ?? {})) {
    if (record?.resourceType === NESTED_STACK_TYPE) nestedRowIds.add(logicalId);
  }
  for (const logicalId of nestedRowIds) {
    const childStackName = `${stack.stackName}~${logicalId}`;
    const refuse = (cause: string, remedy: string): void => {
      nestedChildren.push({
        logicalId,
        stackName: childStackName,
        refusal: nestedChildRefusal(childStackName, cause, remedy),
      });
    };
    if (templateResources[logicalId]?.Type !== NESTED_STACK_TYPE) {
      refuse(
        `${shownStack}'s template no longer declares the nested-stack row it belongs to, so ` +
          `scrub has no template to learn its secrets from`,
        `Deploying ${shownStack} destroys a nested stack its template dropped, record included.`
      );
      continue;
    }
    if (!Object.hasOwn(state.resources ?? {}, logicalId)) {
      refuse(
        `${shownStack}'s state has no record of the nested-stack row that deploys it, so the ` +
          `parameters it was deployed with are unknown`,
        `Deploy ${shownStack} so it records the row, then re-run cdkd scrub; if its ` +
          `Condition keeps the row out of the deploy, the child record is left over — ` +
          `remove it with cdkd state destroy.`
      );
      continue;
    }
    const resolved = nestedRowParameters.get(logicalId);
    const parameters =
      resolved?.complete === true ? nestedChildParameters(resolved.value) : undefined;
    if (parameters === undefined) {
      refuse(
        `the Parameters ${shownStack} passes it could not be resolved to the values a deploy ` +
          `would hand it, so what it inherited is unknown`,
        `Re-run cdkd scrub with --verbose to see which value failed to resolve, and fix that.`
      );
      continue;
    }
    nestedChildren.push({
      logicalId,
      stackName: childStackName,
      input: {
        parameters,
        // The row's OWN bag, exactly the one `withCurrentResourceSecrets`
        // binds around the provider call on a deploy. An empty one is a
        // child with no secret-fed parameter: its own template still names
        // its own references.
        inheritedSecrets: perResourceSecrets.get(logicalId) ?? new Map<string, string>(),
        // Read against the plan's FINAL declared attributes (its fixed
        // point), so a row fed by an echoed `NoEcho` attribute counts.
        ...((): Pick<NestedChildScrubInput, 'noEchoParameters' | 'noEchoConditionalParameters'> => {
          const filled = noEchoFilledRowParameters(
            templateResources[logicalId]?.Properties,
            noEchoPlans.sources,
            noEchoPlans.needleSources
          );
          return {
            noEchoParameters: filled.names,
            ...(filled.conditional.length > 0 && {
              noEchoConditionalParameters: filled.conditional,
            }),
          };
        })(),
      },
    });
  }

  // The inverse of this run's redaction (go-to-k/cdkd#3961): every
  // `{{resolve:...}}` expression this run recorded, replaced by the plaintext
  // it resolved to. The
  // parent-row repair asks "is the stored attribute exactly what the child's
  // output expression resolves to", which needs no positioning rule and so
  // can neither miss a positioned key nor fabricate onto an unrelated value.
  // Read at CALL time, when every bag it closes over is complete.
  //
  // `outputRewrites` adds the pairs the plaintext-keyed bags LOSE: where two
  // expressions resolve to one plaintext, the bag keeps one of them, while
  // this run's positioned output pass still rewrote each output from that
  // plaintext onto its OWN expression. Filled once the output passes have
  // run (below); empty on the zero-needle return, where nothing was rewritten.
  // Keyed by EXPRESSION, the one side that does not collapse.
  const outputRewrites = new Map<string, string>();
  const resolveRecordedExpressions = (value: unknown): unknown => {
    // FIRST pair wins for an expression recorded twice. Which one is
    // immaterial to the caller: it rewrites an attribute only onto the
    // expression itself, and only when the attribute equals a value that
    // expression resolved to in this run.
    const plaintextByExpression = new Map<string, string>();
    const bags: RecordedSecretValues[] = [
      outputSecrets,
      ...perResourceSecrets.values(),
      ...orphanSecrets.values(),
    ];
    const pairs: Array<readonly [string, string]> = [
      ...bags.flatMap((bag) =>
        [...bag].map(([plaintext, expression]) => [expression, plaintext] as const)
      ),
      ...outputRewrites,
    ];
    for (const [expression, plaintext] of pairs) {
      if (!plaintextByExpression.has(expression)) plaintextByExpression.set(expression, plaintext);
    }
    const walk = (v: unknown): unknown => {
      if (typeof v === 'string') {
        let out = v;
        for (const [expression, plaintext] of plaintextByExpression) {
          if (out.includes(expression)) out = out.split(expression).join(plaintext);
        }
        return out;
      }
      if (Array.isArray(v)) return v.map(walk);
      if (v !== null && typeof v === 'object') {
        const out: Record<string, unknown> = nullPrototypeRecord();
        for (const [k, inner] of Object.entries(v as Record<string, unknown>)) {
          out[k] = walk(inner);
        }
        return out;
      }
      return v;
    };
    return walk(value);
  };
  // Whether a value holds any plaintext this run recorded (go-to-k/cdkd#3961),
  // for the parent-row repair to REPORT an attribute it could not match
  // rather than pass over it silently.
  const holdsRecordedPlaintext = (value: unknown): boolean => {
    const needles = new Map([
      ...allRecordedSecrets(outputSecrets, perResourceSecrets, orphanSecrets),
      ...outputSecrets,
    ]);
    return (
      JSON.stringify(redactForState(value, { provenance: 'value-scan', secrets: needles })) !==
      JSON.stringify(value)
    );
  };

  const noEchoPublicTokens: ReadonlySet<string> = new Set([region, stack.stackName]);

  const totalSecrets =
    outputSecrets.size +
    [...perResourceSecrets.values()].reduce((n, m) => n + m.size, 0) +
    // Orphan needles count (issue go-to-k/cdkd#2943). Without this term a
    // stack whose ONLY secret lives in a rollback-orphan record takes the
    // zero-needle branch below, returns `recordsChanged: 0`, and prints
    // "No plaintext secrets found" over the record it never examined.
    [...orphanSecrets.values()].reduce((n, m) => n + m.size, 0);
  if (totalSecrets === 0 && !noEchoPlans.changesAny) {
    // NOT a blanket "nothing found": `unverifiableReads` is carried out even
    // here, because a stack whose only cross-stack read cdkd declined by
    // design has exactly this shape — zero needles — and reporting it clean
    // is the outcome issue #2133 exists to prevent.
    //
    // `secretBearingKeys.length` is provably 0 on this branch and is carried
    // for SHAPE only (issue #2133 review): `totalSecrets === 0` implies
    // `outputSecrets.size === 0`, and `stateKeySecretExposure` needs a needle
    // from that very map, so the loop above pushed nothing. TWO fields can be
    // non-zero here, not one: `unverifiableReads`, and — since
    // go-to-k/cdkd#3160 — `unverifiableLeaves`. The second is not an edge
    // case but the HEADLINE path: an abandoned scan records no needle, so
    // `totalSecrets === 0` is exactly what it produces. The rationale above
    // covers both, and it is why the per-stack notes are emitted here too.
    emitAbandonedScanNotes();
    const zeroSecretPurge = await purgeExaminedHistory(loaded.migrationPending);
    return {
      ...zeroSecretPurge,
      recordsChanged: 0,
      secretsFound: 0,
      secretBearingKeys: secretBearingKeys.length,
      unverifiableReads: prePassFindings.unverifiable.length,
      unverifiableProducerRecords: prePassFindings.damagedProducerRecords.length,
      unverifiableLeaves,
      // Provably 0: a read whose name carries a secret records a needle, and
      // with none recorded no performed read's spelling holds a token, so
      // `findUnrepairedCrossStackReadNames` has nothing to flag against.
      unrepairedReadNames: 0,
      ...(malformedResources ? { malformedResources } : {}),
      ...(malformedResourceRows ? { malformedResourceRows } : {}),
      ...(malformedOutputs ? { malformedOutputs } : {}),
      ...(malformedOrphans ? { malformedOrphans } : {}),
      ...(malformedOrphanRows ? { malformedOrphanRows } : {}),
      // No needle was recorded, so no redaction pass ran and the stored bag
      // is what this run leaves — including on a RE-RUN over already-scrubbed
      // state, which is the case the index step exists to finish.
      outputs: state.outputs,
      exportNameDisplay: exportNameDisplayOver(outputSecrets),
      resolveRecordedExpressions,
      holdsRecordedPlaintext,
      nestedChildren,
    };
  }

  // Rewrite each record with ITS OWN secrets, POSITIONED by its own unresolved
  // template bag (#1910), + the outputs; count changes.
  let recordsChanged = 0;
  const newResources: StackState['resources'] = {};
  for (const [logicalId, record] of Object.entries(state.resources ?? {})) {
    const secrets = perResourceSecrets.get(logicalId);
    const templateProps = perResourceTemplateProps.get(logicalId);
    // A record with NO recorded secret is still worth scrubbing once a source
    // is in hand: that is the #1900 shape (an `observedProperties` readback
    // echoing a secret whose leaf the template positions), and it is exactly
    // what an older binary left behind — which is the state `cdkd scrub`
    // exists to clean.
    // Position `properties` HERE rather than handing `templateProps` to
    // `scrubResourceRecord` (issue #1910 review). That parameter also
    // re-points the `observedProperties` walk at the template, which for
    // scrub is the wrong source: an observed leaf whose expression is in
    // STATE but no longer in the template would lose the #1900
    // trust-any-expression relaxation and fall back to the value scan —
    // exactly the legacy state this command exists to clean.
    //
    // TEMPLATE_SOURCED rules, NOT template-derived: this bag is persisted
    // state, so it was NOT produced by resolving today's template. Their
    // shapes can diverge, which makes positional array descent unsound; the
    // template carries public ssm expressions that must not be persisted; and
    // it is a different GENERATION, so a state leaf that ALREADY holds a
    // `{{resolve:...}}` token is not overwritten from it (issue #1917) — an
    // edited-but-undeployed template would otherwise rewrite state onto its
    // own expression and the next deploy would see NO_CHANGE. See the
    // generation table on `PathSourceRules`.
    const ownSecrets = secrets ?? new Map<string, string>();
    const positioned = templateProps
      ? {
          ...record,
          properties: redactForState(record.properties, {
            provenance: 'template-sourced',
            secrets: ownSecrets,
            source: templateProps,
            // A record read from `state.json`: this run resolved none of it.
            generation: 'unproven',
          }),
        }
      : record;
    // STATE_SOURCED_CROSS_GENERATION rules for the observed walk (issue #1917
    // review). `scrubResourceRecord` would otherwise DERIVE the rules from
    // the absent source argument (since issue #2852: the fail-closed
    // `STATE_SOURCED_BASELINE_RULES` when `ownSecrets` is empty, the plain
    // readback constant otherwise) — right for the deploy persist walk,
    // wrong here, because `positioned.properties`
    // above has already been moved onto TODAY's template. Taking that as the
    // observed source for a leaf that already holds an expression would
    // rewrite the drift baseline onto a reference the stack may never have
    // deployed, which `cdkd drift --revert` then pushes to AWS. The
    // trust-any-expression relaxation is kept — that source is still a STATE
    // bag — because it is what cleans a legacy PLAINTEXT observed leaf.
    const scrubbed =
      secrets || templateProps
        ? scrubResourceRecord(positioned, ownSecrets, undefined, 'state-cross-generation', {
            // A record read from `state.json`: no bag this run produced.
            properties: 'unproven',
            observed: 'unproven',
          })
        : record;
    // go-to-k/cdkd#4043 Phase C, the migration rule: a plaintext this record
    // still holds at a `NoEcho` position is a needle of a SECOND scrub of
    // this record alone, in a map of its own: never `perResourceSecrets`,
    // which the stack-wide passes (orphans, cross-stack read names,
    // unaccounted outputs) union, and never the record's own bag, whose
    // pairs and marks the first pass reads unchanged.
    const plan = noEchoPlans.byLogicalId.get(logicalId);
    const migrationNeedles = scrubMigrationNeedles(plan, noEchoPublicTokens);
    const migrated =
      migrationNeedles === undefined
        ? scrubbed
        : scrubResourceRecord(scrubbed, migrationNeedles, undefined, 'state-cross-generation', {
            properties: 'unproven',
            observed: 'unproven',
          });
    // go-to-k/cdkd#4847: provenance only for the tokens the record still holds.
    const written = keepHeldTokenProvenance(applyScrubNoEcho(migrated, record, plan));
    if (JSON.stringify(written) !== JSON.stringify(record)) recordsChanged++;
    newResources[logicalId] = written;
  }

  // Rollback-orphan records (issue go-to-k/cdkd#2943).
  //
  // Needles are a UNION of two sources, because neither alone covers the
  // case this pass exists for:
  //
  //  - the record's OWN derivation (above) finds a secret whose record still
  //    holds a `{{resolve:...}}` EXPRESSION, including one whose logical id
  //    has left the template entirely;
  //  - `allRecordedSecrets` finds a PLAINTEXT the write side failed to
  //    redact, which carries no expression to derive from and so yields no
  //    needle of its own — but is very often the same secret a live resource
  //    or output still references, which this run already learned.
  //
  // The first was the design decision; the second is not a cheaper
  // alternative to it, which an earlier framing of this work got wrong. They
  // catch disjoint things, and the write-side-failed case is precisely the
  // one `scrub` exists to recover from.
  //
  // Residual, stated rather than implied by a clean verdict: a record whose
  // logical id is gone from the template AND whose bag holds plaintext
  // matches neither source. Nothing in this run knows that plaintext.
  const newOrphans = (state.orphans ?? []).map((record, orphanIndex) => {
    const own = orphanSecrets.get(String(orphanIndex));
    const needles = new Map(allRecordedSecrets(outputSecrets, perResourceSecrets, orphanSecrets));
    for (const [plaintext, expression] of own ?? []) needles.set(plaintext, expression);
    if (needles.size === 0) return record;
    const scrubbed = keepHeldTokenProvenance(
      scrubResourceRecord(record.state, needles, undefined, 'state-cross-generation', {
        properties: 'unproven',
        observed: 'unproven',
      })
    );
    if (JSON.stringify(scrubbed) === JSON.stringify(record.state)) return record;
    recordsChanged++;
    return { ...record, state: scrubbed };
  });
  // go-to-k/cdkd#5111: a superseded resource's record moved out of
  // `resources` verbatim, so it gets the same pass an orphan does, with this
  // run's needles (it has no logical-id slot of its own to resolve).
  const newSuperseded = Array.isArray(state.supersededResources)
    ? state.supersededResources.map((entry) => {
        if (!isSupersededResourceRecord(entry)) return entry;
        const needles = new Map(
          allRecordedSecrets(outputSecrets, perResourceSecrets, orphanSecrets)
        );
        if (needles.size === 0) return entry;
        const scrubbed = keepHeldTokenProvenance(
          scrubResourceRecord(entry.state, needles, undefined, 'state-cross-generation', {
            properties: 'unproven',
            observed: 'unproven',
          })
        );
        if (JSON.stringify(scrubbed) === JSON.stringify(entry.state)) return entry;
        recordsChanged++;
        return { ...entry, state: scrubbed };
      })
    : undefined;
  // --- CROSS-STACK READ NAMES (go-to-k/cdkd#3337) -------------------------
  //
  // go-to-k/cdkd#3289 closed the WRITE side: `imports[].exportName`,
  // `outputReads[].sourceStack` and `outputReads[].outputName` are redacted at
  // the persist choke point, so a name an `Fn::Sub` assembled around a
  // resolved `{{resolve:...}}` no longer reaches `state.json` in plaintext. It
  // did NOT close the repair side — both lists rode this function's
  // `...carriedState` spread untouched, so a record an older binary already
  // wrote kept its plaintext and `cdkd scrub --fail` reported it clean.
  //
  // WHICH FIELDS, and why it is not all six: the per-field provenance is in
  // `docs/design/3289-cross-stack-read-name-redaction.md`. Three names come
  // from the TEMPLATE and are redactable; `sourceRegion` is an AWS region and
  // `imports[].sourceStack` is stored verbatim forever because
  // `scanActiveConsumers` matches destroy-time refusals on it. Redacting that
  // one would drop a destroy-blocking record, which is why the write side
  // leaves it alone too — the two sides must agree on the field set or a
  // scrub would undo a deploy's deliberate decision.
  //
  // SCOPE IS **NEVER-AGAIN** ONLY, and the issue body was corrected before
  // this landed rather than after. Of the four across-deploy cases,
  // SAME-VALUE self-repairs and DUPLICATE is closed by the union normalizer;
  // this walk closes NEVER-AGAIN, where the reference is never re-resolved so
  // no later deploy rewrites it. **ROTATED is NOT repaired**: scrub derives
  // its needles by re-resolving the live template, so it holds the CURRENT
  // secret value, and the stale plaintext on disk is a value nothing in this
  // run knows. It is REPORTED instead (go-to-k/cdkd#3382) — see
  // `findUnrepairedCrossStackReadNames` below.
  //
  // The needle set is `allRecordedSecrets` — the union — for the same reason
  // `redactUnaccountedOutputs` uses it: a cross-stack NAME is not positioned
  // against any one resource's bag, so the per-resource scoping that protects
  // `state.resources` has nothing to scope here.
  //
  // NO FLOOR IS APPLIED HERE, and an earlier revision applied one and said it
  // matched `redactUnaccountedOutputs`. Both halves were wrong: that call site
  // applies none either, and `allRecordedSecrets` has ALREADY dropped every
  // sub-`MIN_NEEDLE_LENGTH` key before returning. A second copy of a
  // security-relevant predicate is the hazard this repo documents most — the
  // next reader sees callers filtering, removes the floor inside
  // `allRecordedSecrets`, and silently un-floors the OTHER callers while this
  // one stays safe. One floor, one place.
  //
  // A DELIBERATE DIVERGENCE FROM THE WRITE SIDE, so a later lane does not
  // "fix" it in the fabrication direction: `DeployEngine.redactCrossStackReads`
  // uses its own UNFILTERED union, so a sub-floor whole-value name is redacted
  // on write and is NOT repaired here. That is the safe direction — scrub
  // rewrites a record no deploy is re-deriving, so it must be the more
  // conservative of the two.
  //
  // Scrub's union also includes `orphanSecrets`, which the write side's does
  // not. A plaintext recorded ONLY by an orphan record therefore repairs here
  // and would not be redacted by the next deploy's key normalizer, so that
  // entry can re-take go-to-k/cdkd#3289's DUPLICATE shape. It needs a
  // coincidental substring match to happen at all, and DUPLICATE is a doubled
  // row rather than a disclosure, so it is recorded rather than designed
  // around.
  const crossStackNeedles = allRecordedSecrets(outputSecrets, perResourceSecrets, orphanSecrets);
  // No empty-map short-circuit: `redactSecretsForState` already returns its
  // input unchanged for an empty bag with no source, and the deploy-side twin
  // deleted exactly this arm because a branch no probe can red is worse than
  // no branch (go-to-k/cdkd#3289).
  const redactCrossStackName = (name: string): string =>
    redactForState(name, { provenance: 'value-scan', secrets: crossStackNeedles });
  const newImports = state.imports?.map((entry) => {
    const exportName = redactCrossStackName(entry.exportName);
    if (exportName === entry.exportName) return entry;
    recordsChanged++;
    return { ...entry, exportName };
  });
  const newOutputReads = state.outputReads?.map((entry) => {
    const sourceStack = redactCrossStackName(entry.sourceStack);
    const outputName = redactCrossStackName(entry.outputName);
    if (sourceStack === entry.sourceStack && outputName === entry.outputName) return entry;
    recordsChanged++;
    return { ...entry, sourceStack, outputName };
  });
  // The entries the walk above could NOT repair although today's template
  // still reads a secret-bearing name of their shape (go-to-k/cdkd#3382).
  // Counted into the verdict so `--fail` does not exit 0 over them. Nothing
  // is written for them: their plaintext is a value this run never learned.
  const unrepairedReadNames = findUnrepairedCrossStackReadNames(
    { imports: newImports, outputReads: newOutputReads },
    prePassFindings.performedReads,
    redactCrossStackName
  );
  for (const { list, index, entry } of unrepairedReadNames) {
    // The stored NAME is never printed: it holds a secret's earlier value,
    // which no needle this run holds can mask. `imports[].sourceStack` is a
    // producer record's own stack name, equal to a read this run performed,
    // and is masked anyway; `outputReads[].sourceStack` is template-derived
    // and may be the very field holding the old value, so it is omitted.
    const producer =
      list === 'imports'
        ? `producer ${displayStackName(maskSecretsInText(entry.sourceStack, crossStackNeedles))}, `
        : '';
    logger.warn(
      safeMsg`Scrub of ${shownStack}: state.${list}[${index}] (${producer}${displayIdent(String(entry.sourceRegion))}) ` +
        `holds a cross-stack read name in plaintext that has the shape of a secret-bearing ` +
        `read in today's template but not the secret's current value — most likely a value ` +
        `from before the secret was ROTATED. Scrub cannot repair it (it matches only the ` +
        `current value) and does not print it; treat that earlier value as exposed. A deploy ` +
        safeMsg`that updates ${shownStack} rewrites this list from the reads it performs.`
    );
  }

  // `TEMPLATE_SOURCED_RULES`, converging this call with its deploy-side twin
  // `redactOutputs` in `deployment/deploy-engine/masking.ts` (issues
  // [#1943](https://github.com/go-to-k/cdkd/issues/1943) /
  // [#2099](https://github.com/go-to-k/cdkd/issues/2099)). `state.outputs` is
  // a PERSISTED bag while `outputsTemplateSource` is TODAY's template, so
  // `TEMPLATE_DERIVED_RULES` — "the bag was produced by resolving the
  // source" — is not true of this pair. The two constants differ on
  // `descendArrays` ALONE (`sourceIsSameGeneration` is already false in
  // both), so that flag is the whole question here.
  //
  // **The premise this call site used to rest on is FALSE.** It read: the
  // array arm cannot fire because `outputsTemplateSource[name]` is a template
  // Output's `Value`, "which CloudFormation requires to be a string or an
  // intrinsic OBJECT". CloudFormation does require that; cdkd does not
  // ENFORCE it. `TemplateOutput.Value` is typed `unknown`, the resolver walks
  // an array elementwise with no string coercion, and `StackState.outputs` is
  // deliberately not string-coerced — so a list-valued output (an escape
  // hatch, a hand-written or imported template) puts an array on BOTH sides
  // and the arm IS reachable. The measurement that produced the claim
  // enumerated the shapes CDK emits, not the shapes this code accepts. And
  // this is the pair positional descent is least sound for: the bag is a
  // previous generation's persisted array and the source is today's template
  // array, so a stored literal at index `i` would be rewritten to today's
  // expression at index `i` — `redactByPath` returns a known-secret source
  // leaf VERBATIM — with nothing but equal length connecting the two.
  //
  // **THE TRADE, stated rather than re-decided.** Turning `descendArrays` off
  // gives up a legitimate positional descent, and on the deploy side that
  // cost lands on the 4 of 7 `redactOutputs` sites whose bag WAS freshly
  // resolved from today's template. This call site can never be one of those
  // — its bag is always persisted state — but it does NOT follow that the
  // swap is free here. When state happens to be current, the stored array and
  // the template array line up, and the descent that is now refused would
  // have rewritten an element whose plaintext this run did not record — a
  // value rotated away at its source since the deploy, which the value scan
  // cannot identify and therefore leaves in place. That is the accepted cost;
  // the ORDERING command doc above already tells operators to scrub BEFORE
  // rotating for the same reason. It is bought with the elimination of a
  // FABRICATED expression written into `state.outputs`, which the exports
  // index and `Fn::ImportValue` re-apply VERBATIM to consumer stacks — the
  // #1934 BREAK class, irreversible in a way an unredacted leaf is not.
  const positionedOutputs =
    outputSecrets.size > 0
      ? redactForState(
          state.outputs,
          outputsSourceUntrusted
            ? { provenance: 'value-scan', secrets: outputSecrets }
            : {
                provenance: 'template-sourced',
                secrets: outputSecrets,
                source: outputsTemplateSource,
                // The STORED outputs bag, never this run's resolution.
                generation: 'unproven',
              }
        )
      : state.outputs;
  // The widened pass (issue #2005): repair a stored output key today's
  // template cannot account for. See `redactUnaccountedOutputs` for both
  // halves of the scope decision, and for why the values it scans come from
  // `state.outputs` (the STORED bag) while its result is written over
  // `positionedOutputs`.
  const redactedOutputs = redactUnaccountedOutputs(
    positionedOutputs,
    state.outputs,
    accountedOutputKeys,
    // Orphan needles included (issue go-to-k/cdkd#2943), for CONSISTENCY
    // rather than from a measurement: this argument already carries
    // `perResourceSecrets`, whose needles belong to a resource's property
    // and not to any output, so the objection to including orphan needles —
    // that substituting one writes an expression the output never had —
    // applies equally to what is already here. Given that, matching the
    // established choice beats inventing a second rule, and the direction is
    // toward redacting more. The residual is the one this whole helper
    // carries: it redacts by VALUE because the template cannot position
    // these keys, so a coinciding literal is redacted too.
    allRecordedSecrets(outputSecrets, perResourceSecrets, orphanSecrets)
  );
  // go-to-k/cdkd#4043 Phase C: a declared output today's template serves
  // from a `NoEcho` parameter holds `***`, as the deploy's
  // `maskOutputsByPosition` writes it, and so does every other key (an
  // export alias) holding the same stored value.
  const noEchoMaskedOutputs = maskScrubNoEchoOutputs(
    redactedOutputs,
    noEchoPlans.outputKeys,
    new Set(Object.keys(stack.template.Outputs ?? {})),
    declaredAliasOf
  );
  emitAbandonedScanNotes();
  // THE DROP (go-to-k/cdkd#4120): a stored key today's template cannot name
  // and neither pass rewrote is REMOVED from the bag this run writes, never
  // left beside the expressions it writes — see `planUnnamedOutputDrop` for
  // which keys, and which it must keep. A key another stack still READS is
  // kept instead, and so is every candidate when the other records cannot be
  // read: the rest of the record is still written, because refusing it would
  // strand every plaintext this run CAN repair over a leftover it cannot
  // identify. Both are findings, never a clean result.
  let newOutputs = noEchoMaskedOutputs;
  let newExportNames: unknown = state.exportNames;
  let droppedOutputKeys = 0;
  let keptReadOutputKeys = 0;
  let keptAliasOutputKeys = 0;
  let droppedOutputReadersUnverified = false;
  // The key-display corpus below, kept for the exports-index lines too.
  const droppedDisplayCorpus: RecordedSecretValues = new Map();
  // The alias-shaped names the lines below withhold, for the index lines too.
  const withheldOutputKeys = new Set<string>();
  // Everything below reads the NoEcho-masked bag: a drop rebuilt from the
  // unmasked one would write the plaintext back (review of #4764).
  if (isReadableBag(state.outputs) && isReadableBag(noEchoMaskedOutputs)) {
    const stored = state.outputs as Record<string, unknown>;
    const plan = planUnnamedOutputDrop({
      stored,
      rewritten: noEchoMaskedOutputs as Record<string, unknown>,
      accountedKeys: accountedOutputKeys,
      reportedKeys: new Set(secretBearingKeys),
      exportNames: state.exportNames,
      everyExportAliasReproduced,
    });
    if (plan.drop.length > 0 || plan.keep.length > 0) {
      // A key is PRINTED, never its value. It is tested against every
      // plaintext this run recorded (the log-only ones included) and against
      // the stored value of every key in the plan, since a key built around
      // a secret an older binary resolved may hold that value — fail-closed,
      // so an innocent name sharing text with a dropped value is masked too.
      const corpus: RecordedSecretValues = new Map(
        printingCorpusOf(allRecordedSecrets(outputSecrets, perResourceSecrets, orphanSecrets))
      );
      for (const key of [...plan.drop, ...plan.keep]) addStoredStringLeaves(stored[key], corpus);
      for (const [value, expression] of corpus) droppedDisplayCorpus.set(value, expression);
      // `cdkd diff`'s alias-name refusal (`withholdsAliasName`, issue
      // #4015), applied here too: a key that may be an export alias and
      // carries a character an Output logical id cannot is WITHHELD, since
      // an older binary may have resolved a secret into it that no corpus
      // here holds. This pass runs only for a stack whose template recorded
      // a secret, the diff's other condition.
      const knownExports = knownExportNamesOf(state.exportNames);
      const aliasShaped = (key: string): boolean =>
        (knownExports === undefined || knownExports.has(key)) && /[^A-Za-z0-9]/.test(key);
      for (const key of [...plan.drop, ...plan.keep]) {
        if (aliasShaped(key)) withheldOutputKeys.add(key);
      }
      const shownKeys = (keys: Iterable<string>): string =>
        [...keys]
          .map((key) =>
            aliasShaped(key)
              ? '(name withheld: an export name, which may carry a secret)'
              : renderStateKeyForLine(
                  secretSafeKeyDisplay(key, corpus),
                  'it may contain a stored secret value'
                )
          )
          .join(', ');
      let dropping = new Set(plan.drop);
      if (dropping.size > 0) {
        let readers: DroppedOutputReader[] | undefined;
        try {
          readers = findDroppedOutputReaders(
            stack.stackName,
            region,
            dropping,
            await (opts.readConsumerRecords ?? (() => readConsumerRecords(stateBackend, region)))()
          );
        } catch (err) {
          droppedOutputReadersUnverified = true;
          logger.warn(
            safeMsg`${shownStack}'s template no longer declares output key(s) ${shownKeys(dropping)}, ` +
              `but the other stacks' state could not be read to confirm none of them still ` +
              safeMsg`reads one (${maskSecretsInText(describeAwsFailure(err).detail, corpus)}), ` +
              `so NONE was dropped and this stack is not reported clean. Fix the read and ` +
              `re-run cdkd scrub.`
          );
          dropping = new Set();
        }
        if (readers !== undefined && readers.length > 0) {
          // A read whose name is stored redacted cannot be matched to one
          // key, so it keeps them all.
          const read = readers.some((r) => r.key === undefined)
            ? new Set(dropping)
            : new Set(readers.map((r) => r.key!));
          keptReadOutputKeys = read.size;
          const lines = readers.map(
            (r) =>
              safeMsg`${displayStackName(maskSecretsInText(r.consumerStack, corpus))} (${displayIdent(r.consumerRegion)}) ` +
              (r.key === undefined
                ? r.legacy
                  ? `records no ${r.intrinsic} reads (written before cdkd recorded them), so it may read one`
                  : r.damaged
                    ? `reads an entry whose name is not a string (a damaged record), which cannot be compared, via ${r.intrinsic}`
                    : `reads a name stored redacted, which cannot be compared, via ${r.intrinsic}`
                : safeMsg`reads ${shownKeys([r.key])} via ${r.intrinsic}`)
          );
          logger.warn(
            safeMsg`${shownStack}'s template no longer declares output key(s) ${shownKeys(read)}, ` +
              safeMsg`but another stack still reads them: ${lines.join('; ')}. They were NOT ` +
              `dropped, since that read would break, and this stack is not reported clean: ` +
              `a value left beside the references scrub writes can be printed by cdkd diff. ` +
              `Stop the consumer reading it (or declare the output again), or redeploy a ` +
              `consumer whose record predates the reads, then re-run cdkd scrub.`
          );
          dropping = new Set([...dropping].filter((key) => !read.has(key)));
        }
      }
      if (dropping.size > 0) {
        droppedOutputKeys = dropping.size;
        newOutputs = Object.fromEntries(
          Object.entries(noEchoMaskedOutputs as Record<string, unknown>).filter(
            ([key]) => !dropping.has(key)
          )
        );
        if (Array.isArray(state.exportNames)) {
          newExportNames = (state.exportNames as unknown[]).filter(
            (name) => !(typeof name === 'string' && dropping.has(name))
          );
        }
        logger.info(
          safeMsg`${opts.dryRun ? 'Would drop' : 'Dropped'} ${dropping.size} output key(s) from ` +
            safeMsg`${shownStack} that its template no longer declares: ${shownKeys(dropping)}. ` +
            `Their values are not printed: scrub could not identify them as a secret's ` +
            `plaintext, and left beside the references it writes, cdkd diff would print ` +
            `them. A deploy of today's template does not write them either.`
        );
      }
      if (plan.keep.length > 0) {
        keptAliasOutputKeys = plan.keep.length;
        logger.warn(
          safeMsg`${plan.keep.length} output key(s) in ${shownStack} that its template does not ` +
            safeMsg`declare were LEFT as they are: ${shownKeys(plan.keep)}. Each may be a live ` +
            `export alias whose Export.Name this run could not reproduce (scrub resolves ` +
            `with template defaults and takes no --parameters), so it is not dropped. If it ` +
            `is a deleted output's, its value is still stored and cdkd diff can print it, ` +
            safeMsg`so ${shownStack} is not reported clean; deploying it rewrites the outputs.`
        );
      }
    }
  }
  const outputsChanged = JSON.stringify(newOutputs) !== JSON.stringify(state.outputs);
  // Whole-value rewrites of this record's outputs, as expression -> plaintext
  // pairs for `resolveRecordedExpressions` (see `outputRewrites`).
  if (isReadableBag(state.outputs) && isReadableBag(newOutputs)) {
    const before = state.outputs as Record<string, unknown>;
    const after = newOutputs as Record<string, unknown>;
    for (const key of Object.keys(after)) {
      const was = before[key];
      const now = after[key];
      if (
        typeof was === 'string' &&
        typeof now === 'string' &&
        now.includes(DYNAMIC_REFERENCE_OPENING) &&
        !was.includes(DYNAMIC_REFERENCE_OPENING)
      ) {
        outputRewrites.set(now, was);
      }
    }
  }
  if (outputsChanged) recordsChanged++;

  if (recordsChanged > 0 && !opts.dryRun) {
    // `skippedOutputs` (issue #2740) is dropped, as every writer that
    // rebuilds state outside a deploy drops it. Replacing a plaintext with
    // the expression it came from is not monotonically less resolvable: an
    // ordinary resource `GetAtt` returns the stored string verbatim, so an
    // output that splits that string and uses a segment can start resolving
    // once the shape changes. The record must not outlive a rewrite of the
    // values outputs read.
    const { skippedOutputs: _droppedByScrub, ...carriedState } = state;
    const nextState: StackState = {
      ...carriedState,
      ...stackInstanceIdCarriedFrom(state),
      resources: newResources,
      // WRITTEN BACK, not carried. `orphans` rode the `...carriedState`
      // spread untouched before go-to-k/cdkd#2943, which was correct while
      // nothing scrubbed it and is a silent drop of this pass's work now.
      // Spread conditionally so a state file that never orphaned anything
      // does not GAIN the key by being scrubbed.
      ...(state.orphans !== undefined && { orphans: newOrphans }),
      // go-to-k/cdkd#5111: written back, as `orphans` is.
      ...(newSuperseded !== undefined && { supersededResources: newSuperseded }),
      // WRITTEN BACK, not carried — the same shape as `orphans` above and for
      // the same reason (go-to-k/cdkd#3337). Both lists rode `...carriedState`
      // untouched, which was correct while nothing scrubbed them and is a
      // silent drop of this pass's work now. Spread CONDITIONALLY so a state
      // file that records no cross-stack reads does not GAIN an empty key by
      // being scrubbed: `imports` / `outputReads` are optional in the schema,
      // and materialising `[]` here is a write this command never intended.
      // The guard tests the NEW binding, not `state.imports`: under
      // `exactOptionalPropertyTypes` TypeScript cannot carry a narrowing from
      // one binding to another, so guarding on the source leaves the spread
      // typed `StateImportEntry[] | undefined` against an optional property.
      // `newImports` is undefined exactly when `state.imports` is, so the two
      // spellings are the same condition.
      ...(newImports !== undefined && { imports: newImports }),
      ...(newOutputReads !== undefined && { outputReads: newOutputReads }),
      // The cast restates what `StackState` already gets wrong rather than
      // introducing a lie: `outputs` is TYPED as required while every
      // consumer treats it as optional, and a state file that simply has no
      // outputs must round-trip WITHOUT gaining an empty bag — materializing
      // `{}` here would be a write this command never intended to make.
      // `newOutputs` IS `state.outputs`, unchanged, in exactly that case.
      outputs: newOutputs as StackState['outputs'],
      // A dropped export alias leaves the export set with it
      // (go-to-k/cdkd#4120); a record that never had the field gains none.
      ...(newExportNames !== state.exportNames && { exportNames: newExportNames as string[] }),
      lastModified: Date.now(),
    };
    await saveScrubbedState(stateBackend, stack.stackName, region, nextState, loaded);
  }
  const examinedPurge =
    recordsChanged > 0 ? {} : await purgeExaminedHistory(loaded.migrationPending);

  return {
    ...examinedPurge,
    recordsChanged,
    secretsFound: totalSecrets,
    secretBearingKeys: secretBearingKeys.length,
    droppedOutputKeys,
    keptReadOutputKeys,
    keptAliasOutputKeys,
    ...(droppedOutputReadersUnverified && { droppedOutputReadersUnverified: true as const }),
    unverifiableReads: prePassFindings.unverifiable.length,
    unverifiableProducerRecords: prePassFindings.damagedProducerRecords.length,
    unverifiableLeaves,
    unrepairedReadNames: unrepairedReadNames.length,
    ...(malformedResources ? { malformedResources } : {}),
    ...(malformedOutputs ? { malformedOutputs } : {}),
    ...(malformedOrphans ? { malformedOrphans } : {}),
    ...(malformedOrphanRows ? { malformedOrphanRows } : {}),
    ...(malformedResourceRows ? { malformedResourceRows } : {}),
    outputs: newOutputs,
    exportNameDisplay: exportNameDisplayOver(
      outputSecrets,
      droppedDisplayCorpus,
      withheldOutputKeys
    ),
    resolveRecordedExpressions,
    holdsRecordedPlaintext,
    nestedChildren,
  };
}
