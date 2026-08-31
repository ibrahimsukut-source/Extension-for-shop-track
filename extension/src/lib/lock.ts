// A tiny async mutex. chrome.storage.local mutations are read-modify-write, so
// concurrent captures (several JSON responses arriving at once) would otherwise
// race and clobber each other's writes — losing captures. All storage RMW ops
// run through runExclusive so they serialize within the service worker.
let chain: Promise<unknown> = Promise.resolve();

export function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const result = chain.then(fn, fn);
  // Keep the chain alive regardless of fn's success/failure.
  chain = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}
