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
    const rHex = Math.round(rgb.r).toString(16).padStart(2, "0");
    const gHex = Math.round(rgb.g).toString(16).padStart(2, "0");
    const bHex = Math.round(rgb.b).toString(16).padStart(2, "0");

    const hex = `${rHex}${gHex}${bHex}`;
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
