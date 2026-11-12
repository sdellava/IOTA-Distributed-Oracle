const cursorKey = (cursor) => JSON.stringify(cursor);
export function createHistoryCounter(options = {}) {
    const now = options.now ?? Date.now;
    const entries = new Map();
    const pages = options.pages ?? 2;
    const interval = options.intervalMs ?? 10000;
    const refresh = options.refreshMs ?? 300000;
    function read(key, mode, load) {
        let entry = entries.get(key);
        if (!entry) {
            if (entries.size >= (options.maxEntries ?? 32)) {
                const removable = [...entries].find(([, item]) => !item.pending);
                if (removable)
                    entries.delete(removable[0]);
                else
                    return { value: null, state: "unavailable", asOf: null };
            }
            entry = { value: null, completedAt: null, count: 0, cursor: null, complete: false, nextAttempt: 0, failed: false };
            entries.set(key, entry);
        }
        const state = entry;
        if (!state.pending && now() >= state.nextAttempt) {
            if (mode === "snapshot" && state.complete) {
                state.count = 0;
                state.cursor = null;
            }
            state.complete = false;
            state.pending = Promise.resolve().then(async () => {
                try {
                    for (let index = 0; index < pages; index++) {
                        const page = await load(state.cursor);
                        if (!Number.isSafeInteger(page.count) || page.count < 0 || typeof page.hasNextPage !== "boolean" ||
                            (page.hasNextPage && (page.count === 0 || page.cursor == null || cursorKey(page.cursor) === cursorKey(state.cursor))) ||
                            (mode === "append" && page.count > 0 && (page.cursor == null || cursorKey(page.cursor) === cursorKey(state.cursor)))) {
                            throw new Error("INVALID_HISTORY_PAGE");
                        }
                        // Commit progress only after validating the complete response. Failures retain the last good cursor.
                        state.count += page.count;
                        if (page.cursor != null)
                            state.cursor = page.cursor;
                        state.failed = false;
                        if (!page.hasNextPage) {
                            state.value = state.count;
                            state.completedAt = now();
                            state.complete = true;
                            break;
                        }
                    }
                }
                catch {
                    state.failed = true;
                }
                finally {
                    state.nextAttempt = now() + (state.failed ? Math.max(30000, interval) : mode === "snapshot" && state.complete ? refresh : interval);
                    state.pending = undefined;
                }
            });
        }
        return { value: state.value, state: state.failed ? "unavailable" : state.value == null ? "counting" : state.complete ? "current" : "updating",
            asOf: state.completedAt == null ? null : new Date(state.completedAt).toISOString() };
    }
    return { read };
}
// A short response cache also shares in-flight work across simultaneous clients.
export function createStatusCache(ttlMs = 5000, maxEntries = 32, now = Date.now) {
    const entries = new Map();
    return (key, load) => {
        const existing = entries.get(key);
        if (existing?.pending)
            return existing.pending;
        if (existing?.value !== undefined && existing.expires > now())
            return Promise.resolve(existing.value);
        if (!existing && entries.size >= maxEntries) {
            const removable = [...entries].find(([, item]) => !item.pending);
            if (!removable)
                return Promise.reject(new Error("STATUS_CAPACITY"));
            entries.delete(removable[0]);
        }
        const entry = existing ?? { expires: 0 };
        const promise = load().then(value => { entry.value = value; entry.expires = now() + ttlMs; return value; });
        entry.pending = promise;
        entries.set(key, entry);
        void promise.finally(() => { entry.pending = undefined; }).catch(() => { });
        return promise;
    };
}
