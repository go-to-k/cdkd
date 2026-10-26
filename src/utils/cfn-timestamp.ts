/**
 * An ISO 8601 date-time with NO offset: `2026-01-01T00:00:00`,
 * `2026-01-01T00:00`, `2026-01-01T00:00:00.123`, and the `t` / space
 * separators the JavaScript parser also takes.
 */
const OFFSETLESS_DATE_TIME = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

/**
 * Parse a timestamp a CloudFormation template carries as a string into a
 * `Date`, reading an offset-less ISO date-time as UTC (issue #5311).
 *
 * `new Date('2026-01-01T00:00:00')` is HOST-LOCAL time by the ECMAScript spec,
 * so under `TZ=Asia/Tokyo` it becomes `2025-12-31T15:00:00Z` and the value
 * sent to AWS shifts by the deployer's UTC offset. CloudFormation never sees
 * the deployer's zone: it reads the same string as UTC (measured for
 * `AWS::CloudWatch::AnomalyDetector` `ExcludedTimeRanges`, whose documented
 * format is `yyyy-MM-dd'T'HH:mm:ss`, even with `MetricTimeZone` set).
 *
 * Every other string parses exactly as `new Date(value)` does: a `Z` or
 * `+HH:MM` offset is honoured, a bare `YYYY-MM-DD` is already UTC by spec, and
 * a value that does not parse stays an Invalid Date for the caller to reject.
 */
export function parseCfnTimestamp(value: string): Date {
  return new Date(OFFSETLESS_DATE_TIME.test(value) ? `${value}Z` : value);
}
