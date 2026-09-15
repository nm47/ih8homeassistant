/**
 * Tests for config normalization, matching and validation.
 *
 * Validation and runtime matching must share one normalization, or values that pass
 * validation can still be indistinguishable on the wire.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
    matchToken,
    normalizeToken,
    validateDeviceConfig,
} from "../mqtt/devices/metadata.js";
import type { OptionSchema, TopicSchema } from "../mqtt/devices/metadata.js";

const TOPIC_SCHEMA: TopicSchema = { required: ["getOnline"], optional: [] };
const OPTION_SCHEMA: OptionSchema = {
    onValue: { type: "string", default: "ON" },
    offValue: { type: "string", default: "OFF" },
    onlineValue: { type: "string", default: "Online" },
    offlineValue: { type: "string", default: "Offline" },
    hex: { type: "boolean", default: false },
};

function baseConfig(overrides: Record<string, any> = {}): any {
    return {
        type: "OnOffLightDevice",
        name: "Test Device",
        topics: { getOnline: "tele/test/LWT" },
        options: {},
        ...overrides,
    };
}

describe("normalizeToken", () => {
    it("trims and lowercases", () => {
        assert.equal(normalizeToken("  Online "), "online");
        assert.equal(normalizeToken("OFF"), "off");
    });
});

describe("matchToken", () => {
    it("matches case-insensitively, which is what fixes Nudge", () => {
        // Nudge sets onlineValue = "online" but inherits offlineValue = "Offline", while the
        // device actually publishes "offline"
        assert.equal(matchToken("offline", "online", "Offline"), false);
        assert.equal(matchToken("online", "online", "Offline"), true);
    });

    it("ignores surrounding whitespace", () => {
        assert.equal(matchToken(" ON \n", "ON", "OFF"), true);
    });

    it("returns null for unrecognized values instead of assuming off", () => {
        assert.equal(matchToken("MAYBE", "ON", "OFF"), null);
        assert.equal(matchToken("", "ON", "OFF"), null);
    });
});

describe("validateDeviceConfig", () => {
    it("accepts a well-formed config and applies defaults", () => {
        const config = baseConfig();
        const result = validateDeviceConfig(config, TOPIC_SCHEMA, OPTION_SCHEMA);

        assert.equal(result.valid, true, result.errors.join("; "));
        assert.equal(config.options.onValue, "ON");
        assert.equal(config.options.hex, false);
    });

    it("rejects a scalar topics table instead of silently treating it as empty", () => {
        const result = validateDeviceConfig(baseConfig({ topics: false }), TOPIC_SCHEMA, OPTION_SCHEMA);

        assert.equal(result.valid, false);
        assert.match(result.errors.join("; "), /topics must be a table/);
    });

    it("rejects a scalar options table", () => {
        const result = validateDeviceConfig(baseConfig({ options: 0 }), TOPIC_SCHEMA, OPTION_SCHEMA);

        assert.equal(result.valid, false);
        assert.match(result.errors.join("; "), /options must be a table/);
    });

    it("rejects empty and missing topics", () => {
        const missing = validateDeviceConfig(baseConfig({ topics: {} }), TOPIC_SCHEMA, OPTION_SCHEMA);
        assert.equal(missing.valid, false);

        const blank = validateDeviceConfig(
            baseConfig({ topics: { getOnline: "   " } }),
            TOPIC_SCHEMA,
            OPTION_SCHEMA
        );
        assert.equal(blank.valid, false);
        assert.match(blank.errors.join("; "), /Missing or empty required topic/);
    });

    it("enforces the declared option types", () => {
        const result = validateDeviceConfig(
            baseConfig({ options: { hex: "yes" } }),
            TOPIC_SCHEMA,
            OPTION_SCHEMA
        );

        assert.equal(result.valid, false);
        assert.match(result.errors.join("; "), /Option hex must be a boolean/);
    });

    it("rejects token pairs that collide after normalization", () => {
        const result = validateDeviceConfig(
            baseConfig({ options: { onValue: "ON", offValue: "on" } }),
            TOPIC_SCHEMA,
            OPTION_SCHEMA,
            [["onValue", "offValue"]]
        );

        assert.equal(result.valid, false);
        assert.match(result.errors.join("; "), /indistinguishable/);
    });

    it("rejects an empty token value", () => {
        const result = validateDeviceConfig(
            baseConfig({ options: { onValue: "  " } }),
            TOPIC_SCHEMA,
            OPTION_SCHEMA,
            [["onValue", "offValue"]]
        );

        assert.equal(result.valid, false);
        assert.match(result.errors.join("; "), /must not be empty/);
    });

    it("rejects a missing name", () => {
        const result = validateDeviceConfig(baseConfig({ name: "" }), TOPIC_SCHEMA, OPTION_SCHEMA);

        assert.equal(result.valid, false);
        assert.match(result.errors.join("; "), /Missing device name/);
    });
});
