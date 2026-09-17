/**
 * URL-safe reading of an S3 listing's key-bearing fields (issue
 * [#3313](https://github.com/go-to-k/cdkd/issues/3313)).
 *
 * **Why this exists at all.** `ListObjectsV2` and `ListObjectVersions` answer in
 * XML, and an XML parser normalises a CARRIAGE RETURN to a LINE FEED per the
 * specification (XML 1.0 section 2.11). So a key containing a CR comes back
 * with an LF in its place, and anything the caller then does with that
 * value — a `DeleteObject`, a `GetObject`, a membership test against a key
 * cdkd constructed — addresses a key that does not exist.
 *
 * MEASURED against real S3 (us-east-1, 2026-09-17), not read off the spec:
 *
 * ```
 * PutObject  key `a b`            -> listed as `a+b`   (FORM-style, not %20)
 * PutObject  key `a+b`            -> listed as `a%2Bb`
 * PutObject  key containing CR    -> stored
 * ListObjectsV2, no EncodingType -> the CR comes back as \n
 * ListObjectsV2, EncodingType=url -> ...%0D..., which decodes to the real CR
 * ```
 *
 * The delete that follows such a listing is the dangerous half: it SUCCEEDS
 * and removes nothing, so a sweep counts it and moves on. That is how
 * `s3-noncurrent-version-purge.ts` — the sweep that removes state versions
 * carrying a secret plaintext — can report a clean run over a surviving one.
 *
 * **What is and is NOT encoded**, measured in the same run, because getting
 * this backwards breaks pagination rather than fixing anything:
 *
 * | field | under `EncodingType: 'url'` | so |
 * | --- | --- | --- |
 * | `Contents[].Key`, `Versions[].Key`, `DeleteMarkers[].Key` | encoded | DECODE |
 * | `CommonPrefixes[].Prefix` | encoded | DECODE |
 * | `NextKeyMarker` | encoded | DECODE — the next request sends the RAW value |
 * | `NextVersionIdMarker` | NOT encoded | pass back verbatim (a version id is opaque) |
 * | `NextContinuationToken` | opaque, NOT encoded | send back VERBATIM; decoding corrupts it |
 * | `Prefix`, `Delimiter` | ENCODED (AWS lists them) | decode IF read; no cdkd site reads them |
 *
 * A helper that decoded `NextContinuationToken` along with the rest would
 * produce a token S3 rejects, which is why the two are named separately here
 * rather than "decode every string on the response".
 *
 * **NUL is out of scope and that is a measurement, not an omission**: S3
 * refuses to store a key containing one (`PutObject` fails), so no listing can
 * deliver it. An ESC survives verbatim — the transformation is specific to the
 * line-ending class, so a guard looking for "control characters" would miss
 * the one character that actually moves.
 */

/**
 * Decode one key-bearing field of a listing taken with `EncodingType: 'url'`.
 *
 * Returns `undefined` unchanged so a caller can pass an optional field
 * straight through.
 *
 * `decodeURIComponent` throws on a malformed sequence (`%` not followed by two
 * hex digits). That cannot arise from S3's own encoding, but this function is
 * the ONE place a raw response value is trusted, so it refuses rather than
 * guesses: a key it cannot decode is one a later delete would address wrongly,
 * which is the defect this module exists to close.
 */
export function decodeListingKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    // `+` FIRST, then percent-decode. S3's `encoding-type=url` is FORM-style:
    // measured, a key `a b` comes back `a+b` and a key `a+b` comes back `a%2Bb`,
    // so a bare `decodeURIComponent` maps BOTH onto `a+b` — two distinct keys
    // collapsing onto one value, and a delete then addresses the wrong object.
    // A space is far commoner in a key than the carriage return this module was
    // written for, so this line is the load-bearing half.
    //
    // Order matters: replacing `+` AFTER percent-decoding would also rewrite a
    // `+` that came from a real `%2B`.
    return decodeURIComponent(value.replace(/\+/g, '%20'));
  } catch (error) {
    throw new Error(
      `S3 returned a listing key that is not valid URL encoding: ${JSON.stringify(value)}. ` +
        `cdkd takes every listing with EncodingType='url' so a key containing a carriage ` +
        `return survives the XML round-trip; a value that will not decode cannot be addressed ` +
        `safely, so this listing is refused rather than acted on.`,
      { cause: error }
    );
  }
}

/**
 * The `EncodingType` every cdkd listing must pass.
 *
 * A constant rather than a literal at nine call sites: the point of this module
 * is that the DECODE and the REQUEST agree, and a site that decodes a response
 * it did not ask to be encoded corrupts every `%` in a legitimate key.
 */
export const LISTING_ENCODING_TYPE = 'url' as const;
