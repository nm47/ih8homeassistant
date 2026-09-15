/**
 * Helpers for distinguishing controller-originated Matter state changes from the ones this
 * bridge makes itself.
 *
 * Matter.js emits `$Changed` for every state mutation, including the offline writes we perform
 * when applying an MQTT update. Without filtering, applying MQTT state to Matter immediately
 * publishes that same state back as an MQTT *command*.
 */

/**
 * Shape of the ActionContext matter.js passes as the third `$Changed` argument.
 *
 * Typed structurally rather than importing ActionContext, so this does not depend on whether
 * `@matter/main` re-exports that type.
 */
export type ChangeContext = { session?: unknown } | undefined;

/**
 * True only for controller-originated online interactions.
 *
 * Matter.js populates `context.session` (a SecureSession) from OnlineContext, i.e. real
 * network traffic from a controller. Offline writes via `endpoint.set()` leave it undefined.
 */
export function isFromController(context: ChangeContext): boolean {
    return context?.session !== undefined;
}

/**
 * Minimal shape of a matter.js `$Changed` observable.
 */
export interface ChangeObservable<T> {
    on(handler: (value: T, oldValue: T, context: ChangeContext) => void): void;
}

/**
 * Subscribe to a `$Changed` observable, ignoring changes this bridge caused itself.
 *
 * Accepts undefined so callers can pass optional-chained observables directly for clusters
 * that may not be present on a given endpoint.
 */
export function onControllerChange<T>(
    observable: ChangeObservable<T> | undefined,
    handler: (value: T) => void
): void {
    observable?.on((value, _oldValue, context) => {
        if (isFromController(context)) {
            handler(value);
        }
    });
}
