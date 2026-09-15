/**
 * Tests for the pure conversion utilities.
 *
 * These are small but load-bearing: the device classes access Matter state through `as any`,
 * so a wrong conversion produces a plausible-looking payload rather than a type error.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
    mqttToMatterBrightness,
    matterToMqttBrightness,
    parseBrightness,
} from "../utils/BrightnessConverter.js";
import {
    hexToHsv,
    hsvToHex,
    miredsToRgb,
    rgbToHex,
    xyToRgb,
} from "../utils/ColorConverter.js";

describe("parseBrightness", () => {
    it("accepts bare decimal integers in range", () => {
        assert.equal(parseBrightness("0"), 0);
        assert.equal(parseBrightness("128"), 128);
        assert.equal(parseBrightness("255"), 255);
        assert.equal(parseBrightness("  42  "), 42);
    });

    it("rejects empty and whitespace-only payloads", () => {
        // Number("") and Number("   ") are both 0, which would silently mean "off"
        assert.equal(parseBrightness(""), null);
        assert.equal(parseBrightness("   "), null);
    });

    it("rejects non-integers and trailing garbage", () => {
        assert.equal(parseBrightness("1.5"), null);
        assert.equal(parseBrightness("100garbage"), null);
        assert.equal(parseBrightness("abc"), null);
        assert.equal(parseBrightness("0x10"), null);
    });

    it("rejects out-of-range values", () => {
        assert.equal(parseBrightness("-1"), null);
        assert.equal(parseBrightness("256"), null);
    });
});

describe("brightness scaling", () => {
    it("scales rather than clamping the top of the range", () => {
        // The old implementation clamped, collapsing 254 and 255 onto the same level
        assert.equal(mqttToMatterBrightness(255), 254);
        assert.equal(mqttToMatterBrightness(254), 253);
        assert.notEqual(mqttToMatterBrightness(255), mqttToMatterBrightness(254));
    });

    it("maps MQTT 0 to Matter 1, lossily and on purpose", () => {
        // Matter's Lighting feature reserves level 0; "off" is expressed via OnOff instead,
        // so this direction is intentionally not a round trip.
        assert.equal(mqttToMatterBrightness(0), 1);
        assert.equal(matterToMqttBrightness(mqttToMatterBrightness(0)), 1);
    });

    it("round-trips mid-range values within rounding error", () => {
        for (const value of [1, 64, 128, 200, 254, 255]) {
            const roundTripped = matterToMqttBrightness(mqttToMatterBrightness(value));
            assert.ok(
                Math.abs(roundTripped - value) <= 1,
                `${value} round-tripped to ${roundTripped}`
            );
        }
    });

    it("clamps inputs outside the valid range", () => {
        assert.equal(mqttToMatterBrightness(-10), 1);
        assert.equal(mqttToMatterBrightness(9999), 254);
        assert.equal(matterToMqttBrightness(-10), 0);
        assert.equal(matterToMqttBrightness(9999), 255);
    });
});

describe("rgbToHex", () => {
    it("always emits exactly six hex digits", () => {
        assert.equal(rgbToHex({ r: 0, g: 0, b: 0 }), "000000");
        assert.equal(rgbToHex({ r: 255, g: 255, b: 255 }), "ffffff");
        assert.equal(rgbToHex({ r: 255, g: 0, b: 0 }, "#"), "#ff0000");
    });

    it("clamps out-of-range components rather than emitting malformed hex", () => {
        // Unclamped, 300 becomes "12c" (three digits) and -5 becomes "-5"
        assert.equal(rgbToHex({ r: 300, g: -5, b: 128 }), "ff0080");
        assert.equal(rgbToHex({ r: NaN, g: NaN, b: NaN }), "000000");
    });
});

describe("hex <-> HSV", () => {
    it("round-trips exactly where Matter's hue quantization is lossless", () => {
        // Red sits on hue 0 and white has zero saturation, so neither loses anything
        for (const hex of ["ff0000", "ffffff", "000000"]) {
            const hsv = hexToHsv(hex);
            assert.ok(hsv, `${hex} failed to parse`);
            assert.equal(hsvToHex(hsv!), hex);
        }
    });

    it("round-trips other primaries within the hue quantization error", () => {
        // Matter carries hue in 254 steps, so e.g. green lands on hue 85 and comes back as
        // 00ff02. This is inherent to the 0-254 range, not a conversion bug.
        for (const hex of ["00ff00", "0000ff", "ffff00", "00ffff"]) {
            const hsv = hexToHsv(hex);
            assert.ok(hsv, `${hex} failed to parse`);
            const roundTripped = hsvToHex(hsv!);

            for (let channel = 0; channel < 3; channel++) {
                const before = parseInt(hex.slice(channel * 2, channel * 2 + 2), 16);
                const after = parseInt(roundTripped.slice(channel * 2, channel * 2 + 2), 16);
                assert.ok(
                    Math.abs(before - after) <= 3,
                    `${hex} -> ${roundTripped}: channel ${channel} drifted by ${Math.abs(before - after)}`
                );
            }
        }
    });

    it("rejects malformed hex", () => {
        assert.equal(hexToHsv("nothex"), null);
        assert.equal(hexToHsv("ff00"), null);
        assert.equal(hexToHsv("#ff0000"), null); // prefix not stripped without the option
        assert.equal(hexToHsv("#ff0000", "#")?.saturation, 254);
    });
});

describe("xyToRgb", () => {
    it("returns black when y is zero rather than dividing by it", () => {
        assert.deepEqual(xyToRgb(20000, 0, 254), { r: 0, g: 0, b: 0 });
    });

    it("rejects non-finite inputs", () => {
        assert.equal(xyToRgb(NaN, 20000, 254), null);
        assert.equal(xyToRgb(20000, NaN, 254), null);
        assert.equal(xyToRgb(20000, 20000, NaN), null);
    });

    it("maps the D65 white point to a near-neutral colour", () => {
        // D65 is x=0.3127, y=0.3290 -> fixed point over 65536
        const rgb = xyToRgb(Math.round(0.3127 * 65536), Math.round(0.329 * 65536), 254);
        assert.ok(rgb);
        const { r, g, b } = rgb!;
        assert.ok(r > 240 && g > 240 && b > 240, `expected near-white, got ${r},${g},${b}`);
        assert.ok(Math.max(r, g, b) - Math.min(r, g, b) < 12, "channels should be close");
    });

    it("keeps out-of-gamut results inside 0-255", () => {
        // A deeply saturated point outside sRGB, which produces both negative and >1 linear
        // components before clamping and normalization
        const rgb = xyToRgb(Math.round(0.7 * 65536), Math.round(0.28 * 65536), 254);
        assert.ok(rgb);
        for (const component of [rgb!.r, rgb!.g, rgb!.b]) {
            assert.ok(component >= 0 && component <= 255, `component out of range: ${component}`);
            assert.ok(Number.isInteger(component), `component not an integer: ${component}`);
        }
    });

    it("scales with level", () => {
        const bright = xyToRgb(Math.round(0.3127 * 65536), Math.round(0.329 * 65536), 254);
        const dim = xyToRgb(Math.round(0.3127 * 65536), Math.round(0.329 * 65536), 25);
        assert.ok(bright && dim);
        assert.ok(dim!.r < bright!.r, "dim should be darker than bright");
    });
});

describe("miredsToRgb", () => {
    it("rejects non-finite inputs", () => {
        assert.equal(miredsToRgb(NaN, 254), null);
        assert.equal(miredsToRgb(300, NaN), null);
    });

    it("clamps mireds of zero instead of producing a nonsense kelvin", () => {
        // 0 mireds would be infinite kelvin; clamping yields the coolest advertised value
        assert.deepEqual(miredsToRgb(0, 254), miredsToRgb(147, 254));
        assert.deepEqual(miredsToRgb(99999, 254), miredsToRgb(500, 254));
    });

    it("makes warm temperatures redder than cool ones", () => {
        const warm = miredsToRgb(500, 254); // 2000K
        const cool = miredsToRgb(147, 254); // ~6800K
        assert.ok(warm && cool);
        assert.ok(warm!.b < cool!.b, "warm light should have less blue");
        assert.ok(warm!.r >= cool!.r, "warm light should have at least as much red");
    });

    it("stays inside 0-255 and scales with level", () => {
        for (const mireds of [147, 250, 370, 500]) {
            const rgb = miredsToRgb(mireds, 254);
            assert.ok(rgb);
            for (const component of [rgb!.r, rgb!.g, rgb!.b]) {
                assert.ok(component >= 0 && component <= 255, `out of range: ${component}`);
            }
        }

        const bright = miredsToRgb(300, 254);
        const dim = miredsToRgb(300, 25);
        assert.ok(bright && dim);
        assert.ok(dim!.r < bright!.r);
    });
});
