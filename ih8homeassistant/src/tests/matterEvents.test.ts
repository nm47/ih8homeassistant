/**
 * Tests for the controller-origin predicate.
 *
 * This is the load-bearing check for the whole MQTT/Matter loop: too permissive and every
 * MQTT state update is echoed back as an MQTT command, too restrictive and no controller
 * command ever reaches MQTT at all.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { isFromController, onControllerChange } from "../mqtt/devices/matterEvents.js";

describe("isFromController", () => {
    it("is false when matter.js passes no context", () => {
        assert.equal(isFromController(undefined), false);
    });

    it("is false for offline contexts, which is what endpoint.set() produces", () => {
        assert.equal(isFromController({}), false);
        assert.equal(isFromController({ session: undefined }), false);
    });

    it("is true when a Matter session is present", () => {
        assert.equal(isFromController({ session: { name: "secure/1234" } }), true);
    });
});

describe("onControllerChange", () => {
    /** Minimal stand-in for a matter.js $Changed observable. */
    function observable<T>() {
        let handler: ((value: T, oldValue: T, context: unknown) => void) | undefined;
        return {
            on(fn: (value: T, oldValue: T, context: any) => void) {
                handler = fn;
            },
            emit(value: T, oldValue: T, context: unknown) {
                handler?.(value, oldValue, context);
            },
        };
    }

    it("forwards controller-originated changes", () => {
        const source = observable<boolean>();
        const seen: boolean[] = [];
        onControllerChange<boolean>(source, value => seen.push(value));

        source.emit(true, false, { session: {} });

        assert.deepEqual(seen, [true]);
    });

    it("swallows changes the bridge made itself", () => {
        const source = observable<boolean>();
        const seen: boolean[] = [];
        onControllerChange<boolean>(source, value => seen.push(value));

        source.emit(true, false, undefined);
        source.emit(false, true, {});

        assert.deepEqual(seen, []);
    });

    it("tolerates a missing observable", () => {
        assert.doesNotThrow(() => onControllerChange<boolean>(undefined, () => undefined));
    });
});
