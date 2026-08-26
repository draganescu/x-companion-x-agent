// Fan-out barrier that never abandons a lane: EVERY promise settles before the
// first failure is rethrown. Promise.all rejects on the first failure and
// leaves the other lanes running as orphans — in the field those orphans
// outlived the run's finally, called tools after the toolchain was disposed,
// relaunched a chromium nobody owned, and held the process open at 0% CPU
// forever (the zombie-run bug). With this barrier, dispose() runs only after
// every lane has finished, so nothing is left to reopen the browser.
export async function settleAll(promises) {
    const results = await Promise.allSettled(promises);
    const failed = results.find((r) => r.status === 'rejected');
    if (failed) throw failed.reason;
    return results.map((r) => r.value);
}

// Thunk-based semaphore. Pass a THUNK (() => promise) — an already-invoked
// promise is already running and the limiter can no longer bound it.
export function pLimit(max) {
    let active = 0;
    const queue = [];
    const next = () => {
        active -= 1;
        if (queue.length > 0) queue.shift()();
    };
    return (thunk) => new Promise((resolve, reject) => {
        const start = () => {
            active += 1;
            Promise.resolve().then(thunk).then(
                (v) => { next(); resolve(v); },
                (e) => { next(); reject(e); },
            );
        };
        if (active < max) start(); else queue.push(start);
    });
}
