/**
 * Configuration type definitions for TOML parsing
 */

/**
 * MQTT broker configuration
 */
export interface BrokerConfig {
    host: string;
    port: number;
    user?: string;
    pass?: string;
    /** Maximum number of reconnection attempts (default: 10) */
    maxReconnectAttempts?: number;
    /** Base reconnection delay in milliseconds (default: 1000) */
    baseReconnectDelay?: number;
    /** Maximum reconnection delay in milliseconds (default: 60000) */
    maxReconnectDelay?: number;
    /** Connection timeout in milliseconds (default: 10000) */
    connectTimeout?: number;
    /** MQTT QoS level for publishing (0, 1, or 2; default: 0 for low latency) */
    qos?: 0 | 1 | 2;
}

/**
 * Base MQTT topics for on/off devices
 */
interface BaseTopics {
    /** Topic to check device online status */
    getOnline: string;
    /** Topic to get current on/off state */
    getOn: string;
    /** Topic to set on/off state */
    setOn: string;
}

/**
 * Topics for dimmable devices (adds brightness control)
 */
interface LevelTopics extends BaseTopics {
    /** Topic to get current brightness level */
    getBrightness: string;
    /** Topic to set brightness level */
    setBrightness: string;
}

/**
 * Topics for color-capable devices (adds RGB control)
 */
interface ColorTopics extends LevelTopics {
    /** Topic to get RGB color */
    getRGB: string;
    /** Topic to set RGB color */
    setRGB: string;
}

/**
 * Common options for all devices
 */
interface BaseOptions {
    /** Value representing "on" state (default: "ON") */
    onValue?: string;
    /** Value representing "off" state (default: "OFF") */
    offValue?: string;
    /** Value representing "online" state (default: "Online") */
    onlineValue?: string;
    /** Value representing "offline" state (default: "Offline") */
    offlineValue?: string;
}

/**
 * Options for color-capable devices
 */
interface ColorOptions extends BaseOptions {
    /** Whether RGB values use hex format (default: false) */
    hex?: boolean;
    /** Hex prefix if hex is true (default: "#") */
    hexPrefix?: string;
}

/**
 * Configuration for on/off devices (switches and basic lights)
 */
export interface OnOffDeviceConfig {
    type: "OnOffPlugInUnitDevice" | "OnOffLightDevice";
    name: string;
    topics: BaseTopics;
    options: Required<BaseOptions>;
}

/**
 * Configuration for dimmable lights (on/off + brightness)
 */
export interface DimmableDeviceConfig {
    type: "DimmableLightDevice";
    name: string;
    topics: LevelTopics;
    options: Required<BaseOptions>;
}

/**
 * Configuration for RGB color lights (on/off + brightness + color)
 */
export interface ExtendedColorDeviceConfig {
    type: "ExtendedColorLightDevice";
    name: string;
    topics: ColorTopics;
    options: Required<ColorOptions>;
}

/**
 * Discriminated union of all device configurations
 */
export type DeviceConfig = OnOffDeviceConfig | DimmableDeviceConfig | ExtendedColorDeviceConfig;

/**
 * Complete bridge configuration
 */
export interface BridgeConfig {
    /** MQTT broker connection settings */
    broker: BrokerConfig;
    /** List of devices to bridge */
    devices: DeviceConfig[];
}

/**
 * Default values for base device options
 */
export const DEFAULT_BASE_OPTIONS: Required<BaseOptions> = {
    onValue: "ON",
    offValue: "OFF",
    onlineValue: "Online",
    offlineValue: "Offline",
};

/**
 * Default values for color device options
 */
export const DEFAULT_COLOR_OPTIONS: Required<ColorOptions> = {
    ...DEFAULT_BASE_OPTIONS,
    hex: false,
    hexPrefix: "#",
};

/**
 * Default values for MQTT broker reconnection settings
 */
export const DEFAULT_MQTT_SETTINGS = {
    maxReconnectAttempts: 10,
    baseReconnectDelay: 1000, // 1 second
    maxReconnectDelay: 60000, // 60 seconds
    connectTimeout: 10000, // 10 seconds
    qos: 0 as 0 | 1 | 2, // QoS 0 for lowest latency
};
