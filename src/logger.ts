/**
 * Conditional logging utility for performance-sensitive code.
 * Logs are completely disabled by default to maximize performance.
 */

let loggingEnabled = false;

/**
 * Enable or disable console logging globally.
 * @param enabled - Whether to enable logging
 */
export function setLogging(enabled: boolean): void {
  loggingEnabled = enabled;
}

/**
 * Conditional log - only logs when enabled.
 * Zero overhead when disabled (dead code elimination).
 */
export function log(...args: unknown[]): void {
  if (loggingEnabled) {
    console.log(...args);
  }
}

/**
 * Conditional warn - only logs when enabled.
 */
export function warn(...args: unknown[]): void {
  if (loggingEnabled) {
    console.warn(...args);
  }
}

/**
 * Conditional error - only logs when enabled.
 */
export function error(...args: unknown[]): void {
  if (loggingEnabled) {
    console.error(...args);
  }
}
