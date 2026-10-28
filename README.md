# iH8HomeAssistant (MQTT to Matter Bridge)

## What is this?
The bridge subscribes to MQTT topics for various smart home devices and exposes them as Matter-compliant devices on the local network,
without the absurd UI of homeassistant.

It also serves the same devices as MCP tools, so Claude Code, the Sophie voice assistant, or any other MCP client can
switch them with one set of safety rules: rooms, no guessing at names, and printers that only switch off when a person
confirms.

## Architecture

```
[Matter controllers]                [MCP clients]
(iPhone, Google Home, etc.)         (Claude Code, Sophie)
         |                                  |
         | Matter (UDP/mDNS)                | Streamable HTTP, /mcp
         ↓                                  ↓
              [iH8HomeAssistant]
     one device list, one live state per device
                     |
                     | MQTT (TCP)
                     ↓
               [MQTT broker]
                     |
                     ↓
               [MQTT devices]
            (Tasmota, ESPHome, etc.)
```

Matter and MCP are independent ways in: each publishes to MQTT itself. Both read the same live state, which the
bridge keeps from the devices' MQTT reports.

## Configuration

The bridge reads `config/config.toml` if it exists (the Docker deployment mounts it at `/app/config`), and otherwise
`config.toml` next to it. `config.toml` in this repo is the live config.

### Broker

```toml
[broker]
host = "127.0.0.1"
port = 1883
user = ""        # optional
pass = ""        # optional
qos  = 0         # 0, 1 or 2
```

### MCP server

```toml
[mcp]
host  = "0.0.0.0"   # bind address; the default
port  = 8540        # the default
token = ""          # optional; when set, clients must send "Authorization: Bearer <token>"
confirmTimeoutMs = 3000   # how long to wait for a device to confirm a command; the default
```

The whole table is optional. The endpoint is `http://<host>:<port>/mcp`.

### Devices

Every device in the house is a `[[devices]]` entry, whether or not Matter sees it:

```toml
[[devices]]
type    = "OnOffPlugInUnitDevice"
name    = "Trident"
id      = "trident"
room    = "den"
aliases = ["printer", "3d printer"]
kind    = "printer"
matter  = true

[devices.topics]
getOnline = "tele/trident/LWT"
getOn     = "stat/trident/POWER"
setOn     = "cmnd/trident/POWER"
getState  = "tele/trident/STATE"
```

| Field | Required | Meaning |
|---|---|---|
| `type` | yes | One of the device types below |
| `name` | yes | Display name. **Matter derives the endpoint ID from it**, so renaming a Matter device makes every phone and hub see a new device and lose the old one's room and automations. |
| `id` | yes | Stable name for the MCP tools: lowercase letters, digits and underscores |
| `room` | yes | Room-wide MCP commands switch everything in the room except printers |
| `kind` | yes | What the device is to a person, not its hardware: `light`, `tv`, `printer`, `notifier` or `cooler`. A lamp on a plug is a `light`; "the lights in the den" means the den's devices of kind `light`. See [Printers](#printers) for `printer`, which only on/off types can be. |
| `matter` | yes | Whether Matter controllers see the device. Required, so an old config fails loudly instead of dropping devices from Matter. |
| `aliases` | no | Other names the MCP tools accept |
| `topics`, `options` | | Per device type, below |

A device's id and name may not match another device's id, name or alias. Two devices may share an alias, and the
MCP tools then reject that name as ambiguous rather than picking one.

## Supported Device Types

Config `type` values, and the Matter device each maps to:

- `OnOffPlugInUnitDevice` — On/Off Plug-in Unit (switches)
- `OnOffLightDevice` — On/Off Light
- `DimmableLightDevice` — Dimmable Light (brightness)
- `ExtendedColorLightDevice` — Extended Color Light (rgb and dimmable lights)
- `TVDevice` — On/Off Plug-in Unit, parsing a JSON `STATE` payload for its `POWER` and `INPUT` fields
- `GenericSwitchDevice` — a button

The button's `type` string is historical. Matter's Switch cluster reports physical input and
exposes no commands, so a controller can never press it; the endpoint is an On/Off Plug-in
Unit treated as a pulse instead. Switching it on publishes `commandValue` to `setCommand` and
the endpoint reverts to off a second later, ready for the next press.

Optional topics:

- **On/off devices: `getState`.** A periodic JSON report with a `POWER` field, such as Tasmota's
  `tele/<topic>/STATE`. Tasmota doesn't retain its power state, so without it the bridge only learns a device's state
  when the device switches.
- **TV: `setInput`, with option `inputs`.** For example `setInput = "cmnd/tv/INPUT"` and
  `inputs = ["HDMI1", "HDMI2", "HDMI3", "HDMI4"]`.

## Printers

`kind = "printer"` marks a plug that powers a 3D printer, which may be in the middle of a print:

- **In Matter it's on-only.** A phone or hub can turn it on, but every Matter "off" (Off, Toggle, OffWithEffect, timed
  off) is ignored and it stays reported as on. "Turn off everything" from a phone can't cut a print. The bridge still
  mirrors the real state from MQTT, so a printer switched off another way shows as off.
- **Through MCP,** room-wide actions and `all_off` never include it. Switching off a named printer asks the person
  through the client (MCP elicitation), and is refused if the client can't ask, the person declines, or nobody answers.
  Turning one on needs no confirmation.

## MCP tools

| Tool | Does |
|---|---|
| `list_devices` | Every device: id, name, aliases, room, kind, which tools work on it, online, state, and where the state came from |
| `get_state` | State of `devices`, a `room`, or everything |
| `turn_on` / `turn_off` | Switch `devices` or a `room` (not both). A room skips printers. |
| `all_off` | Switch off everything except printers |
| `set_light` | Brightness (percent) and/or color (`#rrggbb` or a name like `red`, `warm white`), e.g. for Nudge |
| `set_tv_input` | Switch the TV's input, e.g. `HDMI2` |
| `bubble` | Make blüp blow bubbles |

The rules hold for every client:

- **Names** match a device's id, name or alias, ignoring case, spacing, `_`/`-` and diacritics ("blüp" is `blup`).
  Nothing fuzzier: an unknown or ambiguous name fails with the valid candidates, and nothing in that call is sent.
- **Results report what the devices confirmed.** After a command the bridge waits up to `confirmTimeoutMs` for the
  device's own report. Anything that doesn't report back is listed as sent but not confirmed. Switching results list
  what was switched, what was already that way (nothing sent), what wasn't confirmed, what was offline (skipped), and
  the printers a room or `all_off` left alone, with their state, so the client can offer to switch them off as well.
- **State** is `null` until the device has reported since the bridge started, or since the broker connection last
  dropped. The TV's source is `"last sent"`: over HDMI-CEC it can't be queried, so its state is the last command.
- **Confirmations come from a person, not the model.** The question goes to the client as an MCP elicitation, and
  the answer comes back outside the tool arguments. The confirmation is signed, tied to the printers asked about, and
  good once, for two minutes.

Clients on MCP protocol 2026-07-28 are served statelessly. 2025-era clients get a session each, because their
confirmation is a server-to-client request that has to come back to the same server.

### Claude Code

```bash
claude mcp add --transport http house http://192.168.50.74:8540/mcp
# with a token:
claude mcp add --transport http house http://192.168.50.74:8540/mcp --header "Authorization: Bearer <token>"
```

Claude Code shows the printer confirmation as a dialog in interactive sessions. Headless (`claude -p`, and the Agent
SDK's non-interactive mode) it answers the confirmation with "cancel" itself, so a printer is never switched off
headless.

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

The container uses the host network (Matter needs mDNS), so the MCP endpoint is on the host's port 8540 by default,
with nothing to map. Anyone on the LAN can reach it, as they can the broker; set `[mcp] token` to require a bearer
token.

## Development

```bash
# Compile
npm run build

# Compile on change
npm run build:watch

# Compile and run
npm run dev

# Compile and run the tests, against an in-process fake broker
npm test

# Clean build
npm run clean && npm run build
```

### Trying it without the real house

`npm test` builds a fake house as well: an in-process broker with fake Tasmota plugs, TV, Nudge and blüp, which
records every command it receives. To point a local bridge and Claude Code at it:

```bash
npm run build
node dist/tests/support/fakeHouse.js --port 18830 --on trident,den_light --silent v0
# in another shell, from a directory with a config.toml whose broker is 127.0.0.1:18830
MATTER_PORT=5545 MATTER_STORAGE_PATH=/tmp/ih8-matter node /path/to/dist/index.js
```

`IH8_MQTT_READ_ONLY=1` makes the bridge refuse every MQTT publish, for running a second bridge against the live broker
to see real states without any way to switch a device.
