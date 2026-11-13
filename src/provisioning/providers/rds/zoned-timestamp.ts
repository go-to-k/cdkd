// A LEAF: no imports. `restore-source-guard.ts` reads it on the deploy
// engine's path before a replacement's delete (go-to-k/cdkd#5640).

/**
 * The shape `java.time.ZonedDateTime.parse` takes, which the handler's
 * `Validations.validateTimestamp` applies to any non-blank `RestoreToTime`:
 * ISO 8601 date and time, either case of `T` / `Z`, a `Z` or `+hh[:mm[:ss]]`
 * offset (`appendOffsetId` parses leniently, so an hours-only `+01` passes),
 * and an optional `[Region/Zone]` suffix. No space separator and no `+hhmm`:
 * Java refuses both.
 */
const ZONED_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(?:[Zz]|([+-])(\d{2})(?::(\d{2})(?::(\d{2}))?)?)(?:\[[^\]]+\])?$/;

/** A `RestoreToTime` as the instant it names, or `undefined` when Java would refuse it. */
export function parseZonedTimestamp(text: string): Date | undefined {
  const match = ZONED_DATE_TIME.exec(text);
  if (match === null) return undefined;
  const n = (i: number): number => (match[i] === undefined ? 0 : Number(match[i]));
  const [year, month, day, hour, minute, second] = [n(1), n(2), n(3), n(4), n(5), n(6)];
  const [offsetHours, offsetMinutes, offsetSeconds] = [n(9), n(10), n(11)];
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return undefined;
  // Java's ZoneOffset spans -18:00 to +18:00 in all.
  if (offsetMinutes > 59 || offsetSeconds > 59) return undefined;
  if (offsetHours * 3600 + offsetMinutes * 60 + offsetSeconds > 18 * 3600) return undefined;
  // Java resolves strictly: 2026-02-30 is refused, not rolled into March.
  if (day < 1 || new Date(Date.UTC(year, month - 1, day)).getUTCDate() !== day) return undefined;
  const millis = Number((match[7] ?? '').padEnd(3, '0').slice(0, 3));
  const offsetMs =
    (match[8] === '-' ? -1 : 1) * (offsetHours * 3600 + offsetMinutes * 60 + offsetSeconds) * 1000;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millis) - offsetMs);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
