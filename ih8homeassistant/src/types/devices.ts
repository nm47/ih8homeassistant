/**
 * Device type definitions for Matter.js device classes
 *
 * Note: This file is now minimal as device types are registered dynamically
 * via the DeviceRegistry. Each device class exports its own metadata and config types.
 */

/**
 * Supported Matter.js device types
 * These are now dynamically registered in the DeviceRegistry
 * Query DeviceRegistry.getRegisteredTypes() for the current list
 */
export type MatterDeviceType =
    | "OnOffPlugInUnitDevice"
    | "OnOffLightDevice"
    | "DimmableLightDevice"
    | "ExtendedColorLightDevice"
    | "GenericSwitchDevice";
