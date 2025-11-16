# iH8HomeAssistant (MQTT to Matter Bridge)

## What is this?
The bridge subscribes to MQTT topics for various smart home devices and exposes them as Matter-compliant devices on the local network,
without the absurd UI of homeassistant.

## Architecture

```
[Matter Controllers]
    (iPhone, Google Home, etc.)
         |
         | Matter Protocol (UDP/mDNS)
         ↓
    [iH8HomeAssistant]
    (TypeScript Service)
         |
         | MQTT Protocol (TCP)
         ↓
    [MQTT Broker]
         |
         ↓
    [MQTT Devices]
    (Tasmota, ESPHome, etc.)
```

## Configuration

iH8HomeAssistant reads from a TOML configuration file (`config.toml`) with TypeScript type validation.
## TypeScript Type Definitions

```typescript
interface BridgeConfig {
  broker: {
    host: string;
    port: number;
    user?: string;
    pass?: string;
    qos? : number
  };
  devices: DeviceConfig[];
}

interface DeviceConfig {
  type: 'switch' | 'lightbulb-OnOff' | 'lightbulb-RGB';
  name: string;
  topics: {
    getOnline: string;
    getOn: string;
    setOn: string;
    getRGB?: string;  // RGB devices only
    setRGB?: string;  // RGB devices only
  };
  options?: {
    onValue?: string;     // Default: "ON"
    offValue?: string;    // Default: "OFF"
    hex?: boolean;        // RGB format
    hexPrefix?: string;   // RGB prefix
  };
}
```

## Supported Device Types

### Switch
- **Matter Type**: `OnOffPluginUnit`
- **MQTT → Matter**: Maps ON/OFF to boolean
- **Matter → MQTT**: Sends configured on/off values

### Lightbulb-OnOff
- **Matter Type**: `OnOffLight`
- **MQTT → Matter**: Maps ON/OFF to boolean
- **Matter → MQTT**: Sends configured on/off values

### Lightbulb-RGB
- **Matter Type**: `ExtendedColorLight`
- **MQTT → Matter**: Converts hex RGB to HSV
- **Matter → MQTT**: Converts HSV to hex RGB
- **Features**: On/Off, Color (Hue/Saturation), Brightness

## Development

```bash
# Run with hot-reload
npm run dev

# Type checking without building
npm run type-check

# Lint and fix issues
npm run lint -- --fix

# Clean build
npm run clean && npm run build
```
