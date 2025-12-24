/**
 * Device exports and registration
 * Import this file to automatically register all device types
 */

import { DeviceRegistry } from "./registry.js";
import { OnOffDevice } from "./OnOffDevice.js";
import { DimmableDevice } from "./DimmableDevice.js";
import { ColorDevice } from "./ColorDevice.js";
import { MomentarySwitchDevice } from "./MomentarySwitchDevice.js";
import { TVDevice } from "./TVDevice.js";

/**
 * Register OnOffDevice for both PlugInUnit and Light types
 */
DeviceRegistry.register("OnOffPlugInUnitDevice", OnOffDevice.metadata, OnOffDevice as any);
DeviceRegistry.register("OnOffLightDevice", OnOffDevice.metadata, OnOffDevice as any);

/**
 * Register DimmableDevice
 */
DeviceRegistry.register("DimmableLightDevice", DimmableDevice.metadata, DimmableDevice as any);

/**
 * Register ColorDevice
 */
DeviceRegistry.register("ExtendedColorLightDevice", ColorDevice.metadata, ColorDevice as any);

/**
 * Register MomentarySwitchDevice
 */
DeviceRegistry.register("GenericSwitchDevice", MomentarySwitchDevice.metadata, MomentarySwitchDevice as any);

/**
 * Register TVDevice
 */
DeviceRegistry.register("TVDevice", TVDevice.metadata, TVDevice as any);

/**
 * Export all device classes
 */
export { OnOffDevice } from "./OnOffDevice.js";
export { DimmableDevice } from "./DimmableDevice.js";
export { ColorDevice } from "./ColorDevice.js";
export { MomentarySwitchDevice } from "./MomentarySwitchDevice.js";
export { TVDevice } from "./TVDevice.js";

/**
 * Export metadata and registry
 */
export { DeviceRegistry } from "./registry.js";
export type { DeviceMetadata, BaseDeviceInterface } from "./metadata.js";
