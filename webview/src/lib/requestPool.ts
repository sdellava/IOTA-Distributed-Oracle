// Reuse the same request while a slow refresh is pending; clear failures too.
export function createRequestPool() {
  const pending = new Map<string, Promise<unknown>>();
  return <T>(key: string, load: () => Promise<T>): Promise<T> => {
    if (pending.has(key)) return pending.get(key) as Promise<T>;
    const promise = Promise.resolve().then(load);
    pending.set(key, promise);
    void promise.finally(() => { if (pending.get(key) === promise) pending.delete(key); }).catch(() => {});
    return promise;
  };
}

export function historyHint(metric?: { state: string; value: number | null; asOf: string | null }, fallback = "") {
  if (!metric) return fallback;
  if (metric.state === "counting") return "Counting history…";
  if (metric.state === "updating") return "Last completed count; updating…";
  if (metric.state === "unavailable") return metric.value == null ? "Count temporarily unavailable" : "Last completed count; refresh unavailable";
  return metric.asOf ? `Count updated ${new Date(metric.asOf).toLocaleTimeString()}` : fallback;
}
