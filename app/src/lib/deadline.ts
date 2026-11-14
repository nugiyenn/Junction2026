/**
 * Races a promise against a clock. When the clock wins the caller gets `onTimeout()`'s error at once; the slow work is
 * left to finish on its own (its eventual failure is swallowed so it cannot crash the process). Pure: no server imports.
 */
export function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  work.catch(() => undefined); // an abandoned call that fails later must not become an unhandled rejection
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clock = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  return Promise.race([work, clock]).finally(() => clearTimeout(timer));
}
