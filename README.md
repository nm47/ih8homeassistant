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

Config `type` values, and the Matter device each maps to:

- `OnOffPlugInUnitDevice` — On/Off Plug-in Unit (switches)
- `OnOffLightDevice` — On/Off Light
- `DimmableLightDevice` — Dimmable Light (brightness)
- `ExtendedColorLightDevice` — Extended Color Light (rgb and dimmable lights)
- `TVDevice` — On/Off Plug-in Unit, parsing a JSON `STATE` payload for its `POWER` field
- `GenericSwitchDevice` — a button

The button's `type` string is historical. Matter's Switch cluster reports physical input and
exposes no commands, so a controller can never press it; the endpoint is an On/Off Plug-in
Unit treated as a pulse instead. Switching it on publishes `commandValue` to `setCommand` and
the endpoint reverts to off a second later, ready for the next press.

## Deployment

Dependencies and TypeScript compilation happen when the image is built, so the container only
runs Node. Rebuild after changing source or dependencies; a plain restart is enough for a
config change.

```bash
# After source or dependency changes
docker compose up -d --build ih8homeassistant

# After a config change
docker compose restart ih8homeassistant
```

Docker caches the `npm ci` layer until `package.json` or `package-lock.json` changes, so
ordinary restarts need no registry access.

## Development

```bash
# Compile
npm run build

# Compile on change
npm run build:watch

# Compile and run
npm run dev

# Compile and run the unit tests
npm test

# Clean build
npm run clean && npm run build
```
