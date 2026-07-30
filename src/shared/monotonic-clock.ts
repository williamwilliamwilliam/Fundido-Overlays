/**
 * A monotonic clock whose readings are comparable across threads.
 *
 * `performance.now()` cannot be used to time anything that crosses a worker
 * boundary: each thread has its own `performance.timeOrigin`, set when that
 * thread started, so a reading taken on the main thread and one taken in a
 * worker are measured from different zero points. Subtracting them produces a
 * number that looks plausible and means nothing.
 *
 * `process.hrtime.bigint()` reads the system monotonic clock directly with no
 * per-thread offset, so readings from any thread in this process share a
 * common basis.
 *
 * Nanoseconds are converted to a float of milliseconds. Values below ~2^53 ns
 * (about 104 days of process uptime) are exactly representable, so the
 * conversion costs no meaningful precision.
 */
export function nowMonotonicMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}
