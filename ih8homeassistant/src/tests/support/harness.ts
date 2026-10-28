/**
 * Builds a House on the fake broker, with no Matter at all: every device gets a null
 * endpoint, exactly as non-Matter devices do in the bridge.
 */

import { ConfigParser } from "../../config/ConfigParser.js";
import { MqttClient } from "../../mqtt/MqttClient.js";
import { DeviceFactory } from "../../mqtt/devices/DeviceFactory.js";
import { House } from "../../house/House.js";
import type { HouseDevice } from "../../house/House.js";
import { FakeHouse } from "./fakeHouse.js";
import type { FakeHouseOptions } from "./fakeHouse.js";

/**
 * A small house: the den with its printer, a second printer with no plug, an offline
 * light, a device that never answers, two devices sharing the alias "lamp", Nudge and blüp
 */
export const TEST_CONFIG = `
[broker]
host = "127.0.0.1"
port = 1

[[devices]]
type = "OnOffPlugInUnitDevice"
name = "Den Light"
id = "den_light"
room = "den"
matter = true
topics = { getOnline = "tele/den_light/LWT", getOn = "stat/den_light/POWER", setOn = "cmnd/den_light/POWER", getState = "tele/den_light/STATE" }

[[devices]]
type = "OnOffLightDevice"
name = "Reading Lamp"
id = "reading_lamp"
room = "den"
aliases = ["lamp", "reading light"]
matter = true
topics = { getOnline = "tele/reading_lamp/LWT", getOn = "stat/reading_lamp/POWER", setOn = "cmnd/reading_lamp/POWER", getState = "tele/reading_lamp/STATE" }

[[devices]]
type = "TVDevice"
name = "TV"
id = "tv"
room = "den"
aliases = ["television"]
matter = true
topics = { getOnline = "tele/tv/LWT", getState = "tele/tv/STATE", setPower = "cmnd/tv/POWER", setInput = "cmnd/tv/INPUT" }
options = { inputs = ["HDMI1", "HDMI2", "HDMI3", "HDMI4"] }

[[devices]]
type = "OnOffPlugInUnitDevice"
name = "Trident"
id = "trident"
room = "den"
aliases = ["printer"]
printer = true
matter = true
topics = { getOnline = "tele/trident/LWT", getOn = "stat/trident/POWER", setOn = "cmnd/trident/POWER", getState = "tele/trident/STATE" }

[[devices]]
type = "OnOffPlugInUnitDevice"
name = "V0"
id = "v0"
room = "den"
printer = true
matter = true
topics = { getOnline = "tele/v0/LWT", getOn = "stat/v0/POWER", setOn = "cmnd/v0/POWER", getState = "tele/v0/STATE" }

[[devices]]
type = "GenericSwitchDevice"
name = "blup"
id = "blup"
room = "den"
aliases = ["bubbles"]
matter = true
topics = { getOnline = "blup/status/online", setCommand = "blup/command/bubble" }
options = { onlineValue = "online", offlineValue = "offline", commandValue = "" }

[[devices]]
type = "OnOffLightDevice"
name = "Living Room Light"
id = "living_room_light"
room = "living room"
matter = true
topics = { getOnline = "tele/living_room_light/LWT", getOn = "stat/living_room_light/POWER", setOn = "cmnd/living_room_light/POWER", getState = "tele/living_room_light/STATE" }

[[devices]]
type = "OnOffLightDevice"
name = "Lanterns"
id = "lanterns"
room = "living room"
aliases = ["lamp"]
matter = true
topics = { getOnline = "tele/lanterns/LWT", getOn = "stat/lanterns/POWER", setOn = "cmnd/lanterns/POWER", getState = "tele/lanterns/STATE" }

[[devices]]
type = "ExtendedColorLightDevice"
name = "Nudge"
id = "nudge"
room = "living room"
matter = true
topics = { getOnline = "nudge/status/online", getOn = "nudge/status/power", setOn = "nudge/command/power", getBrightness = "nudge/status/brightness", setBrightness = "nudge/command/brightness", getRGB = "nudge/status/color", setRGB = "nudge/command/color" }
options = { onlineValue = "online", hex = true, hexPrefix = "#" }

[[devices]]
type = "OnOffPlugInUnitDevice"
name = "Cooler"
id = "cooler"
room = "bedroom"
matter = false
topics = { getOnline = "tele/cooler/LWT", getOn = "stat/cooler/POWER", setOn = "cmnd/cooler/POWER", getState = "tele/cooler/STATE" }
`;

/** Tasmota topics in TEST_CONFIG */
const TASMOTA = ["den_light", "reading_lamp", "trident", "v0", "living_room_light", "lanterns", "cooler"];

/** Short, so "sent, not confirmed" tests don't take seconds */
export const TEST_CONFIRM_TIMEOUT_MS = 300;

export interface Harness {
    fake: FakeHouse;
    mqttClient: MqttClient;
    house: House;
    devices: HouseDevice[];
    close(): Promise<void>;
}

/**
 * Start the fake broker and a House connected to it, and wait until every device that
 * reports has been heard from
 *
 * By default: everything in the den is on, v0 has no plug (silent), the living room light
 * is offline, and the cooler never answers commands but did report its state once.
 */
export async function startHarness(options: Partial<FakeHouseOptions> = {}): Promise<Harness> {
    const fake = await FakeHouse.start({
        tasmota: TASMOTA,
        silent: ["v0"],
        offline: ["living_room_light"],
        on: ["den_light", "reading_lamp", "trident"],
        ...options,
    });
    fake.tv.POWER = "ON";

    const config = ConfigParser.parse(TEST_CONFIG);
    const mqttClient = new MqttClient({ ...config.broker, port: fake.port });
    const devices: HouseDevice[] = config.devices.map(device => ({
        config: device,
        bridge: DeviceFactory.createDevice(device, null, mqttClient),
    }));

    mqttClient.onMessage((topic, payload) => {
        for (const { bridge } of devices) {
            bridge.handleMqttMessage(topic, payload);
        }
    });
    await mqttClient.connect();
    for (const { bridge } of devices) {
        await bridge.initialize();
    }

    await fake.reportAll();
    await waitFor(() => devices.every(({ config, bridge }) =>
        config.id === "v0" || config.id === "blup" || (bridge.state.online !== null && bridge.state.on !== null)
    ));

    // From here on the cooler stops answering, so commands to it go unconfirmed
    fake.silence("cooler");

    const house = new House(devices, mqttClient, TEST_CONFIRM_TIMEOUT_MS);

    return {
        fake,
        mqttClient,
        house,
        devices,
        async close() {
            for (const { bridge } of devices) {
                await bridge.close();
            }
            await mqttClient.disconnect();
            await fake.close();
        },
    };
}

/**
 * Poll until a condition holds, failing after a couple of seconds
 */
export async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error("Timed out waiting for condition");
        }
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

/**
 * Silence the bridge's chatty per-message logging for the duration of the tests
 */
export function quietLogs(): void {
    console.log = () => {};
}
