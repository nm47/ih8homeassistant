/**
 * Device type definitions for Matter.js device classes
 */

/**
 * Supported Matter.js device types
 */
export type MatterDeviceType =
    | "OnOffPlugInUnitDevice"
    | "OnOffLightDevice"
    | "DimmableLightDevice"
    | "ExtendedColorLightDevice";

/**
 * Type guard to check if a device type supports color
 */
export function isColorDevice(type: MatterDeviceType): type is "ExtendedColorLightDevice" {
    return type === "ExtendedColorLightDevice";
}

/**
 * Type guard to check if a device type supports brightness/level control
 */
export function isDimmableDevice(
    type: MatterDeviceType
): type is "DimmableLightDevice" | "ExtendedColorLightDevice" {
    return type === "DimmableLightDevice" || type === "ExtendedColorLightDevice";
}

/**
 * Type guard to check if a device type is on/off only
 */
export function isOnOffDevice(
    type: MatterDeviceType
): type is "OnOffPlugInUnitDevice" | "OnOffLightDevice" {
    return type === "OnOffPlugInUnitDevice" || type === "OnOffLightDevice";
}

/**
 * Validate that a string is a valid Matter device type
 */
export function isValidDeviceType(type: string): type is MatterDeviceType {
    return (
        type === "OnOffPlugInUnitDevice" ||
        type === "OnOffLightDevice" ||
        type === "DimmableLightDevice" ||
        type === "ExtendedColorLightDevice"
    );
}
