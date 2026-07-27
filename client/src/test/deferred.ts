/** Controls the settlement of a promise so asynchronous state can be asserted deterministically. */
export interface DeferredPromise<Value> {
  promise: Promise<Value>;
  reject: (reason?: unknown) => void;
  resolve: (value: Value | PromiseLike<Value>) => void;
}

/** Creates a promise whose resolution and rejection are exposed to the calling test. */
export function createDeferredPromise<Value>(): DeferredPromise<Value> {
  let rejectPromise: DeferredPromise<Value>['reject'] | undefined;
  let resolvePromise: DeferredPromise<Value>['resolve'] | undefined;

  const promise = new Promise<Value>((resolve, reject) => {
    rejectPromise = reject;
    resolvePromise = resolve;
  });

  if (!rejectPromise || !resolvePromise) {
    throw new Error('Deferred promise controls were not initialized.');
  }

  return {
    promise,
    reject: rejectPromise,
    resolve: resolvePromise,
  };
}
