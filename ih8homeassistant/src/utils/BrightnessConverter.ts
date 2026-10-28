/**
 * Brightness/Level conversion utilities
 * Different systems use different ranges for brightness:
 * - MQTT devices: typically 0-255
 * - Matter LevelControl: 1-254 (the Lighting feature reserves 0)
 */

/** Lowest level Matter's Lighting feature permits; 0 is reserved. */
const MATTER_MIN_LEVEL = 1;
/** Highest level Matter's LevelControl permits. */
const MATTER_MAX_LEVEL = 254;
/** Highest brightness a typical MQTT device reports. */
const MQTT_MAX_BRIGHTNESS = 255;

/**
 * Convert MQTT brightness (0-255) to Matter level (1-254)
 *
 * Scales rather than clamps, so 255 and 254 no longer collapse onto the same level. MQTT 0
 * maps to 1 because Matter expresses "off" through the OnOff cluster, not level 0; the
 * conversion is therefore intentionally lossy at the bottom of the range.
 *
 * @param mqttBrightness MQTT brightness value (0-255)
 * @returns Matter level value (1-254)
 */
export function mqttToMatterBrightness(mqttBrightness: number): number {
    const clamped = Math.max(0, Math.min(MQTT_MAX_BRIGHTNESS, mqttBrightness));
    const scaled = Math.round((clamped * MATTER_MAX_LEVEL) / MQTT_MAX_BRIGHTNESS);
    return Math.max(MATTER_MIN_LEVEL, Math.min(MATTER_MAX_LEVEL, scaled));
}

/**
 * Convert Matter level (1-254) to MQTT brightness (0-255)
 *
 * @param matterLevel Matter level value (1-254)
 * @returns MQTT brightness value (0-255)
 */
export function matterToMqttBrightness(matterLevel: number): number {
    const clamped = Math.max(0, Math.min(MATTER_MAX_LEVEL, matterLevel));
    const scaled = Math.round((clamped * MQTT_MAX_BRIGHTNESS) / MATTER_MAX_LEVEL);
    return Math.max(0, Math.min(MQTT_MAX_BRIGHTNESS, scaled));
}

/**
 * Parse brightness value from MQTT payload string
 *
 * Requires a bare decimal integer. parseInt would accept "100garbage", and Number() would
 * turn "" and "   " into 0 and accept "1.5".
 *
 * @param payload MQTT payload string
 * @returns Brightness value or null if invalid
 */
export function parseBrightness(payload: string): number | null {
    const trimmed = payload.trim();
    if (!/^\d+$/.test(trimmed)) {
        return null;
    }

    const brightness = Number(trimmed);
    if (!Number.isInteger(brightness) || brightness < 0 || brightness > MQTT_MAX_BRIGHTNESS) {
        return null;
    }

    return brightness;
}

/**
 * Convert MQTT brightness (0-255) to percent (0-100), the scale the MCP tools use
 */
export function mqttBrightnessToPercent(mqttBrightness: number): number {
    const clamped = Math.max(0, Math.min(MQTT_MAX_BRIGHTNESS, mqttBrightness));
    return Math.round((clamped * 100) / MQTT_MAX_BRIGHTNESS);
}

/**
 * Convert percent (0-100) to MQTT brightness (0-255)
 */
export function percentToMqttBrightness(percent: number): number {
    const clamped = Math.max(0, Math.min(100, percent));
    return Math.round((clamped * MQTT_MAX_BRIGHTNESS) / 100);
}
