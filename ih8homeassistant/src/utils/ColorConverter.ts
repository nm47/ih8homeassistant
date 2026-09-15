/**
 * Color conversion utilities for RGB <-> HSV transformations
 * Matter uses HSV color space with Hue and Saturation in 0-254 range
 * MQTT typically uses RGB hex format (RRGGBB)
 */

export interface RGB {
    r: number; // 0-255
    g: number; // 0-255
    b: number; // 0-255
}

export interface HSV {
    hue: number;        // 0-254 (Matter range, representing 0-360 degrees)
    saturation: number; // 0-254 (Matter range, representing 0-100%)
    value: number;      // 0-254 (Matter range, representing 0-100%)
}

/** Highest level Matter's LevelControl permits; used to scale brightness into 0-1. */
const MATTER_MAX_LEVEL = 254;

/**
 * Matter reports CurrentX/CurrentY as fixed-point: x = CurrentX / 65536.
 * @see Matter Core Specification, ColorControl cluster
 */
const MATTER_XY_SCALE = 65536;

/** Physical colour temperature bounds this bridge advertises, in mireds. */
const MIN_MIREDS = 147;
const MAX_MIREDS = 500;

/**
 * Parse RGB hex string (RRGGBB) to RGB object
 * @param rgbHex Hex string in format RRGGBB (with optional prefix like #)
 * @param prefix Optional prefix to strip (e.g., "#")
 * @returns RGB object or null if invalid
 */
export function parseRgbHex(rgbHex: string, prefix?: string): RGB | null {
    let hex = rgbHex;

    // Strip prefix if provided and present
    if (prefix && hex.startsWith(prefix)) {
        hex = hex.substring(prefix.length);
    }

    // Parse hex string (RRGGBB)
    const match = hex.match(/^([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/);
    if (!match) {
        return null;
    }

    return {
        r: parseInt(match[1], 16),
        g: parseInt(match[2], 16),
        b: parseInt(match[3], 16),
    };
}

/**
 * Convert RGB to hex string
 * @param rgb RGB object
 * @param prefix Optional prefix to add (e.g., "#")
 * @returns Hex string in format RRGGBB (with optional prefix)
 */
export function rgbToHex(rgb: RGB, prefix?: string): string {
    // Clamp defensively: an out-of-range component would otherwise emit three hex digits or a
    // leading "-", producing a malformed payload on the wire.
    const toHex = (value: number): string => {
        const clamped = Math.max(0, Math.min(255, Math.round(value) || 0));
        return clamped.toString(16).padStart(2, "0");
    };

    const hex = `${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`;
    return prefix ? prefix + hex : hex;
}

/**
 * Convert RGB to HSV (Matter format)
 * @param rgb RGB object with values 0-255
 * @returns HSV object with Matter's 0-254 range
 */
export function rgbToHsv(rgb: RGB): HSV {
    // Normalize RGB values to 0-1
    const r = rgb.r / 255;
    const g = rgb.g / 255;
    const b = rgb.b / 255;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;

    // Calculate hue (0-1)
    let hue = 0;
    if (delta !== 0) {
        if (max === r) {
            hue = ((g - b) / delta + (g < b ? 6 : 0)) / 6;
        } else if (max === g) {
            hue = ((b - r) / delta + 2) / 6;
        } else {
            hue = ((r - g) / delta + 4) / 6;
        }
    }

    // Calculate saturation (0-1)
    const saturation = max === 0 ? 0 : delta / max;

    // Calculate value (0-1)
    const value = max;

    // Convert to Matter's 0-254 range
    return {
        hue: Math.round(hue * 254),
        saturation: Math.round(saturation * 254),
        value: Math.round(value * 254),
    };
}

/**
 * Convert HSV (Matter format) to RGB
 * @param hsv HSV object with Matter's 0-254 range
 * @returns RGB object with values 0-255
 */
export function hsvToRgb(hsv: HSV): RGB {
    // Convert Matter's 0-254 range to 0-1
    const h = hsv.hue / 254;
    const s = hsv.saturation / 254;
    const v = hsv.value / 254;

    const i = Math.floor(h * 6);
    const f = h * 6 - i;
    const p = v * (1 - s);
    const q = v * (1 - f * s);
    const t = v * (1 - (1 - f) * s);

    let r = 0, g = 0, b = 0;
    switch (i % 6) {
        case 0: r = v; g = t; b = p; break;
        case 1: r = q; g = v; b = p; break;
        case 2: r = p; g = v; b = t; break;
        case 3: r = p; g = q; b = v; break;
        case 4: r = t; g = p; b = v; break;
        case 5: r = v; g = p; b = q; break;
    }

    // Convert to 0-255 range
    return {
        r: Math.round(r * 255),
        g: Math.round(g * 255),
        b: Math.round(b * 255),
    };
}

/**
 * Convert RGB hex string to HSV (Matter format)
 * Convenience function combining parseRgbHex and rgbToHsv
 * @param rgbHex Hex string in format RRGGBB
 * @param prefix Optional prefix to strip (e.g., "#")
 * @returns HSV object or null if invalid hex string
 */
export function hexToHsv(rgbHex: string, prefix?: string): HSV | null {
    const rgb = parseRgbHex(rgbHex, prefix);
    if (!rgb) {
        return null;
    }
    return rgbToHsv(rgb);
}

/**
 * Convert HSV (Matter format) to RGB hex string
 * Convenience function combining hsvToRgb and rgbToHex
 * @param hsv HSV object with Matter's 0-254 range
 * @param prefix Optional prefix to add (e.g., "#")
 * @returns Hex string in format RRGGBB (with optional prefix)
 */
export function hsvToHex(hsv: HSV, prefix?: string): string {
    const rgb = hsvToRgb(hsv);
    return rgbToHex(rgb, prefix);
}

/**
 * Encode a linear-light component as sRGB
 * @param value Linear component in 0-1
 * @returns Gamma-encoded component in 0-1
 */
function linearToSrgb(value: number): number {
    return value <= 0.0031308 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
}

/**
 * Convert Matter CIE xyY colour to RGB
 *
 * CurrentX/CurrentY are fixed-point values scaled by 65536. Conversion routinely produces
 * out-of-gamut linear components in both directions: negatives are clamped to zero, and
 * overflow above 1 is normalized (rather than clamped) so the hue is preserved.
 *
 * @param currentX Matter CurrentX attribute (0-65279)
 * @param currentY Matter CurrentY attribute (0-65279)
 * @param level Matter LevelControl currentLevel (1-254), used as luminance
 * @returns RGB object, or null if any input is not a finite number
 */
export function xyToRgb(currentX: number, currentY: number, level: number): RGB | null {
    if (!Number.isFinite(currentX) || !Number.isFinite(currentY) || !Number.isFinite(level)) {
        return null;
    }

    const x = currentX / MATTER_XY_SCALE;
    const y = currentY / MATTER_XY_SCALE;

    // y === 0 would divide by zero below; there is no colour to report.
    if (y <= 0) {
        return { r: 0, g: 0, b: 0 };
    }

    const luminance = Math.max(0, Math.min(1, level / MATTER_MAX_LEVEL));
    const scale = luminance / y;
    const bigX = scale * x;
    const bigY = luminance;
    const bigZ = scale * (1 - x - y);

    // sRGB D65 matrix
    let r = bigX * 3.2406 + bigY * -1.5372 + bigZ * -0.4986;
    let g = bigX * -0.9689 + bigY * 1.8758 + bigZ * 0.0415;
    let b = bigX * 0.0557 + bigY * -0.204 + bigZ * 1.057;

    // Out of gamut on the low side: clamp to the gamut boundary.
    r = Math.max(0, r);
    g = Math.max(0, g);
    b = Math.max(0, b);

    // Out of gamut on the high side: normalize so hue survives the trip.
    const max = Math.max(r, g, b);
    if (max > 1) {
        r /= max;
        g /= max;
        b /= max;
    }

    return {
        r: Math.round(linearToSrgb(r) * 255),
        g: Math.round(linearToSrgb(g) * 255),
        b: Math.round(linearToSrgb(b) * 255),
    };
}

/**
 * Convert a Matter colour temperature to RGB
 *
 * Uses the standard Planckian-locus approximation, valid across the 2000K-6800K span the
 * advertised mired range covers.
 *
 * @param mireds Matter ColorTemperatureMireds attribute, clamped to the advertised 147-500
 * @param level Matter LevelControl currentLevel (1-254), applied as a brightness scale
 * @returns RGB object, or null if any input is not a finite number
 */
export function miredsToRgb(mireds: number, level: number): RGB | null {
    if (!Number.isFinite(mireds) || !Number.isFinite(level)) {
        return null;
    }

    // Mireds of 0 (or anything outside the advertised range) would give a nonsense kelvin.
    const clampedMireds = Math.max(MIN_MIREDS, Math.min(MAX_MIREDS, mireds));
    const kelvin = 1_000_000 / clampedMireds;
    const temp = kelvin / 100;

    let r: number;
    let g: number;
    let b: number;

    if (temp <= 66) {
        r = 255;
        g = 99.4708025861 * Math.log(temp) - 161.1195681661;
        b = temp <= 19 ? 0 : 138.5177312231 * Math.log(temp - 10) - 305.0447927307;
    } else {
        r = 329.698727446 * Math.pow(temp - 60, -0.1332047592);
        g = 288.1221695283 * Math.pow(temp - 60, -0.0755148492);
        b = 255;
    }

    const brightness = Math.max(0, Math.min(1, level / MATTER_MAX_LEVEL));
    const scale = (value: number): number => Math.round(Math.max(0, Math.min(255, value)) * brightness);

    return { r: scale(r), g: scale(g), b: scale(b) };
}

/**
 * Convert Matter CIE xy plus level to an RGB hex string
 * @returns Hex string, or null if the inputs are unusable
 */
export function xyToHex(
    currentX: number,
    currentY: number,
    level: number,
    prefix?: string
): string | null {
    const rgb = xyToRgb(currentX, currentY, level);
    return rgb ? rgbToHex(rgb, prefix) : null;
}

/**
 * Convert Matter colour temperature plus level to an RGB hex string
 * @returns Hex string, or null if the inputs are unusable
 */
export function miredsToHex(mireds: number, level: number, prefix?: string): string | null {
    const rgb = miredsToRgb(mireds, level);
    return rgb ? rgbToHex(rgb, prefix) : null;
}
