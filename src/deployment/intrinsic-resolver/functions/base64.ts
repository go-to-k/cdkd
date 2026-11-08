import type { IntrinsicFunctionResolver } from '../../intrinsic-function-resolver.js';
import { logRender } from '../masking-display.js';
import {
  hasLogOnlyNeedles,
  logTextOfLeaf,
  maskNeedlesForLog,
  maskNeedlesOfBags,
  maskPrintedNeedlesForLog,
} from '../masking.js';
import { markNonRetryable } from '../../retryable-errors.js';
import { type ResolverContext } from '../support.js';
import { keepsSecretReferenceToken } from '../context.js';
import {
  SECRET_MASK,
  embedsFreshNoEchoValue,
  markNoEchoParameterClass,
  hasMaskableValues,
  recordDerivedMaskOnlyValue,
  recordFreshNoEchoValuesIn,
  recordLogOnlyValue,
} from '../../secret-redaction.js';
import { safeMsg } from '../../../utils/display-safe.js';

/**
 * Resolve Fn::Base64 intrinsic function
 *
 * Fn::Base64: valueToEncode
 * Returns the Base64 representation of the input string
 */
export async function resolveBase64(
  resolver: IntrinsicFunctionResolver,
  value: unknown,
  context: ResolverContext
): Promise<string> {
  // Recursively resolve the value first (it could be another intrinsic function)
  const resolvedValue = await resolver.resolveValue(value, context);

  if (typeof resolvedValue !== 'string') {
    // Names the TYPE only, never the value — nothing to mask, and nothing to
    // widen. Left as-is deliberately while its two siblings that DO
    // interpolate a value (`Fn::GetAtt`'s attribute-name refusal,
    // `Fn::Cidr`'s `ipBlock`) gained `maskValueLeaves`.
    throw markNonRetryable(
      new Error(`Fn::Base64: value must resolve to a string, got ${typeof resolvedValue}`)
    );
  }

  // THE COMPARISON PATH ANSWERS WHAT THE DEPLOY PERSISTS (issue
  // [#2909](https://github.com/go-to-k/cdkd/issues/2909)). Under
  // `skipDynamicReferences` (the deploy's diff pass, `cdkd diff`) a SECRET
  // reference is left as its `{{resolve:...}}` token, so encoding here
  // yielded base64 of the TOKEN, while the deploy encodes the plaintext and
  // persists `***` for it (the derived needle below). The two never agreed,
  // so such a resource diffed UPDATE on every run and `cdkd diff --fail`
  // was permanently red. Answering the mask compares like-for-like.
  //
  // `***` cannot say which expression it came from, so an edit to the text
  // around, or the target of, a secret reference inside the same
  // `Fn::Base64` compares equal HERE (as does a rotated value). The record's
  // `maskedPropertyFingerprints` (go-to-k/cdkd#4451), a hash of the
  // UNRESOLVED template value, is what tells the diff and the deploy's
  // no-change skip that such an edit happened.
  //
  // Only a token of a service the deploy RESOLVES counts: one of any other
  // service is left as written on BOTH paths, so its encoding already
  // agrees. Only a secret keeps its token through this pass (`secretsmanager`
  // and `ssm-secure` by spelling, a plain `ssm` one whose parameter is a
  // `SecureString`), which `keepsSecretReferenceToken` reads.
  //
  // NOT when the input also embeds a `NoEcho` value supplied in THIS deploy
  // (go-to-k/cdkd#3662): `***` against the recorded `***` would diff
  // NO_CHANGE and a re-minted value (a cross-stack read recovered from a
  // producer in the same `deploy --all`) would never be sent. The encoding
  // path below marks the encoding fresh, so the diff reports UPDATE and the
  // engine's skip refuses it.
  if (
    context.skipDynamicReferences === true &&
    keepsSecretReferenceToken(resolvedValue) &&
    !(
      context.recordedSecretValues !== undefined &&
      embedsFreshNoEchoValue(resolvedValue, context.recordedSecretValues)
    )
  ) {
    resolver.logger.debug(
      safeMsg`Resolved Fn::Base64: ${logRender(resolver, logTextOfLeaf(resolver, resolvedValue, context), context)} resolved to ${SECRET_MASK} (an unresolved secret reference, compared as the mask the deploy persists)`
    );
    return SECRET_MASK;
  }

  const result = Buffer.from(resolvedValue).toString('base64');

  // DERIVED NEEDLE (issue
  // [#2759](https://github.com/go-to-k/cdkd/issues/2759)). `Fn::Base64` over
  // a dynamic reference produces the secret in a trivially reversible
  // encoding, and every needle in the bag matches LITERALLY — so nothing
  // downstream can see it. The log line below masked the INPUT and printed
  // the OUTPUT in the same breath, and `resolveBase64` RETURNS `result`, so
  // the encoded secret reached `redactSecretsForState` and was persisted to
  // `state.json`, where one command decodes it (the GHSA-p5qg-v9gv-hc7w
  // class). Registering the TRANSFORMED value gives the existing masker
  // something to match, at the one site that still holds both forms.
  //
  // THE DETECTOR IS THE MASKER ITSELF — "did masking change the input?" —
  // rather than a `secrets.has(resolvedValue)` membership test, because the
  // input is often ASSEMBLED (`Fn::Sub` builds a UserData script around a
  // `{{resolve:...}}` reference), and base64 of a string that merely
  // CONTAINS a secret decodes back to that secret just as completely. TWO
  // maskers ask it, and each sees what the other cannot: the NEEDLE mask
  // catches a plaintext at or above `MIN_NEEDLE_LENGTH` wherever it
  // sits, and the POSITION mask (`logTextOfLeaf`, issue #3100) catches a
  // sub-floor plaintext an earlier write of this pass put into the input,
  // which the substring arm is blind to by design (issues #2516 / #2745).
  // Before the second asked (issue #3119), `port:` + a two-character
  // `secretValueFromJson('pin')` under `Fn::Base64` — the CDK UserData
  // shape — persisted its encoding to `state.json` in the clear while the
  // debug line beside it was already masked. The position twin is keyed by
  // the exact string a secret was written into, so a value it masks CARRIES
  // that secret's text, and registering its encoding is the same direction
  // the needle arm takes.
  //
  // THIS DECISION PERSISTS, and since issue #3114 it crosses the nested-stack
  // boundary: the position mask also reads the twins the PARENT registered
  // (`registeredLogTwin`), so in a CHILD this guard records the encoding into
  // the child's own bag and `***` lands in the child's `state.json` (a
  // rollback replay of that resource then refuses the masked baseline). The
  // log line below is not the only thing a change here affects.
  //
  // MASK-ONLY, not an expression pair. The whole point of an expression is
  // that a reader can re-resolve it, and re-resolving `{{resolve:...}}` here
  // would yield the PLAINTEXT rather than its base64 — a value AWS would
  // reject as UserData. `recordMaskOnlyValue` also refuses to demote a
  // plaintext that already carries a real expression, so registering the
  // encoding can never weaken the entry for the secret itself.
  //
  // Recorded BEFORE the debug line, which is what lets that line's NEEDLE
  // mask catch its right half; the line masks the right half whole on a
  // positioned input regardless, since the encoding decodes straight back
  // to the plaintext the input's mask hides.
  const inputLogText = logTextOfLeaf(resolver, resolvedValue, context);
  if (
    context.recordedSecretValues &&
    (inputLogText !== resolvedValue ||
      maskNeedlesForLog(resolver, resolvedValue, context) !== resolvedValue)
  ) {
    // DERIVED, so a leaf EMBEDDING the encoding is masked whole too
    // (go-to-k/cdkd#2453).
    recordDerivedMaskOnlyValue(context.recordedSecretValues, result);
    // The encoding of a FRESH `NoEcho` value is fresh too (go-to-k/cdkd#3662),
    // or a Base64 consumer of a re-minted token would be skipped as
    // `***` == `***`. The encoding of an ordinary secret is NOT: its record
    // already positions the reference, and marking it would update that
    // resource on every deploy.
    if (embedsFreshNoEchoValue(resolvedValue, context.recordedSecretValues)) {
      recordFreshNoEchoValuesIn(result, context.recordedSecretValues);
      // The encoding of a `NoEcho` PARAMETER's value is read as that
      // parameter's value is (go-to-k/cdkd#4043): one readback, never a
      // replacement on its word.
      if (embedsFreshNoEchoValue(resolvedValue, context.recordedSecretValues, 'parameter')) {
        markNoEchoParameterClass(context.recordedSecretValues, result);
      }
    }
  }
  // go-to-k/cdkd#1998: the encoding of text holding a LOG-ONLY needle (a
  // `NoEcho` parameter's value) decodes straight back to it, so it is a
  // log-only needle too. LOG-ONLY, deliberately, and outside the guard
  // above: that guard decides what is PERSISTED and must not see this class.
  if (
    context.recordedSecretValues &&
    hasLogOnlyNeedles(resolver, context) &&
    maskPrintedNeedlesForLog(resolver, resolvedValue, context) !==
      maskNeedlesForLog(resolver, resolvedValue, context)
  ) {
    recordLogOnlyValue(context.recordedSecretValues, result);
  }
  // The PRINT-ONLY twin (go-to-k/cdkd#4043): an encoding of text that only
  // the print-only corpus masks is recorded THERE, never into the pass's
  // bag, whose log-only needles decide an export alias.
  // Each mask is computed only inside its own guard, so a Base64 with no
  // printing bag or sink runs no extra scan.
  const printing = context.printingSecrets;
  let withPrinting: string | undefined;
  const maskedWithPrinting = (): string =>
    (withPrinting ??= maskNeedlesOfBags(resolver, resolvedValue, context, printing));
  if (
    printing !== undefined &&
    hasMaskableValues(printing) &&
    maskedWithPrinting() !== maskPrintedNeedlesForLog(resolver, resolvedValue, context)
  ) {
    recordLogOnlyValue(printing, result);
  }
  // The same for a command's derived-name sink (go-to-k/cdkd#3869): the
  // encoding of text embedding a secret-derived name (a CDK `UserData` over a
  // `Ref`) decodes straight back to it.
  const sink = context.secretNameSink;
  if (
    sink !== undefined &&
    hasMaskableValues(sink) &&
    maskNeedlesOfBags(resolver, resolvedValue, context, printing, sink) !== maskedWithPrinting()
  ) {
    recordLogOnlyValue(sink, result);
  }

  resolver.logger.debug(
    `Resolved Fn::Base64: ${logRender(resolver, inputLogText, context)} resolved to ${logRender(resolver, inputLogText !== resolvedValue ? SECRET_MASK : result, context)}`
  );
  return result;
}
