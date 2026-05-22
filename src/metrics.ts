/**
 * Per-process counters for inbound/outbound events. Aggregated by an
 * operator-meaningful "reason" so the question "how many messages did the
 * bot drop today and why?" can be answered without grepping the logs.
 *
 * Deliberately tiny: an in-memory `Map<string, number>` per process. No
 * window / decay / persistence — operators consume `readRoamMetrics()`
 * snapshots at whatever cadence suits them (status UI, periodic log dump,
 * etc.) and reset via the dedicated test-only helper.
 */

const counters = new Map<string, number>();

/** Increment the counter for an operator-facing event reason. */
export function recordRoamEvent(reason: string): void {
  counters.set(reason, (counters.get(reason) ?? 0) + 1);
}

/** Snapshot of all counters as a plain object. Order matches insertion. */
export function readRoamMetrics(): Record<string, number> {
  return Object.fromEntries(counters);
}

/** Test-only: clear all counters. */
export function __resetRoamMetricsForTests(): void {
  counters.clear();
}
