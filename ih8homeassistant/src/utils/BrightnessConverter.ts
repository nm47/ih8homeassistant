/**
 * Brightness/Level conversion utilities
 * Different systems use different ranges for brightness:
 * - MQTT devices: typically 0-255
 * - Matter LevelControl: 0-254
 */

/**
 * Convert MQTT brightness (0-255) to Matter level (0-254)
 * @param mqttBrightness MQTT brightness value (0-255)
 * @returns Matter level value (0-254)
 */
export function mqttToMatterBrightness(mqttBrightness: number): number {
    // Clamp to valid range
    const clamped = Math.max(0, Math.min(255, mqttBrightness));
    // Convert to Matter's 0-254 range
    return Math.min(clamped, 254);
}

/**
 * Convert Matter level (0-254) to MQTT brightness (0-255)
 * @param matterLevel Matter level value (0-254)
 * @returns MQTT brightness value (0-255)
 */
export function matterToMqttBrightness(matterLevel: number): number {
    // Clamp to valid range and return
    return Math.max(0, Math.min(254, matterLevel));
}

/**
 * Parse brightness value from MQTT payload string
 * @param payload MQTT payload string
 * @returns Brightness value or null if invalid
 */
export function parseBrightness(payload: string): number | null {
    const brightness = parseInt(payload, 10);
    if (isNaN(brightness) || brightness < 0 || brightness > 255) {
        return null;
    }
    return brightness;
}
