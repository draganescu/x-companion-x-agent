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
