/**
 * Tests for the house rules, against a fake broker.
 *
 * The rules that matter most: printers are never switched by a room or all_off, a bad name
 * sends nothing at all, and results only ever report what a device confirmed.
 */

import { strict as assert } from "node:assert";
import { after, before, beforeEach, describe, it } from "node:test";

import { HouseError } from "../house/names.js";
import { quietLogs, startHarness, waitFor } from "./support/harness.js";
import type { Harness } from "./support/harness.js";

quietLogs();

/** Topics that must never see a command in these tests unless one says otherwise */
const PRINTER_COMMANDS = ["cmnd/trident/POWER", "cmnd/v0/POWER"];

describe("House", () => {
    let harness: Harness;

    beforeEach(async () => {
        harness = await startHarness();
    });

    // Each test gets its own broker and devices, so states never leak between tests
    const done = async () => harness.close();

    function assertNoPrinterCommands(): void {
        for (const topic of PRINTER_COMMANDS) {
            assert.deepEqual(harness.fake.commandsTo(topic), [], `${topic} must not be published to`);
        }
    }

    describe("room-wide turn_off of the den", () => {
        it("switches off the light, the lamp and the TV, and leaves the printers alone", async () => {
            try {
                const result = await harness.house.turnOff({ room: "den" });

                assert.deepEqual(
                    result.switched.map(item => item.id),
                    ["den_light", "reading_lamp", "tv"]
                );
                assert.ok(result.switched.every(item => item.state === "off"));
                assert.equal(result.switched.find(item => item.id === "tv")?.source, "last sent");
                assert.equal(result.switched.find(item => item.id === "den_light")?.source, "reported");

                assert.deepEqual(result.printers_skipped, [
                    { id: "trident", state: "on", online: true },
                    { id: "v0", state: null, online: null },
                ]);
                assert.match(result.summary, /trident \(on\)/);

                assertNoPrinterCommands();
                assert.equal(harness.fake.power.get("trident"), "ON");
                assert.deepEqual(harness.fake.commandsTo("blup/command/bubble"), []);
            } finally {
                await done();
            }
        });
    });

    describe("all_off", () => {
        it("switches off everything that is on, except printers", async () => {
            try {
                harness.fake.power.set("lanterns", "OFF");
                const result = await harness.house.allOff();

                assert.deepEqual(result.switched.map(item => item.id), ["den_light", "reading_lamp", "tv"]);
                assert.deepEqual(result.already.map(item => item.id), ["lanterns", "nudge", "cooler"]);
                assert.deepEqual(result.offline, ["living_room_light"]);
                assert.deepEqual(result.printers_skipped.map(item => item.id), ["trident", "v0"]);
                assert.deepEqual(result.refused, []);

                assertNoPrinterCommands();
            } finally {
                await done();
            }
        });
    });

    describe("names", () => {
        it("rejects an unknown name with the known devices, and sends nothing", async () => {
            try {
                await assert.rejects(
                    harness.house.turnOff({ devices: ["den light", "kitchen light"] }),
                    (error: unknown) => {
                        assert.ok(error instanceof HouseError);
                        assert.match(error.message, /Unknown device "kitchen light"/);
                        // Names that only restate the id are left out of the list
                        assert.match(error.message, /Known devices: den_light; reading_lamp \(lamp, reading light\);/);
                        assert.match(error.message, /Nothing was sent/);
                        return true;
                    }
                );
                assert.deepEqual(harness.fake.published, []);
            } finally {
                await done();
            }
        });

        it("rejects an ambiguous name with its candidates instead of picking one", async () => {
            try {
                await assert.rejects(harness.house.turnOff({ devices: ["lamp"] }), (error: unknown) => {
                    assert.ok(error instanceof HouseError);
                    assert.match(error.message, /"lamp" is ambiguous/);
                    assert.match(error.message, /reading_lamp/);
                    assert.match(error.message, /lanterns/);
                    return true;
                });
                assert.deepEqual(harness.fake.published, []);
            } finally {
                await done();
            }
        });

        it("rejects an unknown room with the known rooms", async () => {
            try {
                await assert.rejects(harness.house.turnOff({ room: "kitchen" }), /Unknown room "kitchen". Rooms: den, living room, bedroom/);
                assert.deepEqual(harness.fake.published, []);
            } finally {
                await done();
            }
        });

        it("matches ids, names and aliases regardless of case, spacing and diacritics", async () => {
            try {
                const states = harness.house.getState({ devices: ["Den-Light", "READING LIGHT", "blüp", "Television"] });
                assert.deepEqual(states.map(state => state.id), ["den_light", "reading_lamp", "blup", "tv"]);
            } finally {
                await done();
            }
        });

        it("requires exactly one of devices and room", async () => {
            try {
                await assert.rejects(harness.house.turnOn({ devices: ["tv"], room: "den" }), HouseError);
                await assert.rejects(harness.house.turnOn({}), HouseError);
            } finally {
                await done();
            }
        });
    });

    describe("confirmation", () => {
        it("says sent, not confirmed, when the device doesn't answer", async () => {
            try {
                const result = await harness.house.turnOn({ devices: ["cooler"] });

                assert.deepEqual(result.switched, []);
                assert.deepEqual(result.not_confirmed, [{ id: "cooler", sent: "on", last_reported: "off" }]);
                assert.deepEqual(harness.fake.commandsTo("cmnd/cooler/POWER"), ["ON"]);
                assert.match(result.summary, /sent but not confirmed: cooler/);
            } finally {
                await done();
            }
        });

        it("doesn't send to a device that already reported the requested state", async () => {
            try {
                const result = await harness.house.turnOn({ devices: ["den light"] });

                assert.deepEqual(result.already, [{ id: "den_light", state: "on" }]);
                assert.deepEqual(harness.fake.commandsTo("cmnd/den_light/POWER"), []);
            } finally {
                await done();
            }
        });

        it("skips offline devices and says so", async () => {
            try {
                const result = await harness.house.turnOn({ room: "living room" });

                assert.deepEqual(result.offline, ["living_room_light"]);
                assert.deepEqual(result.switched.map(item => item.id), ["lanterns", "nudge"]);
                assert.deepEqual(harness.fake.commandsTo("cmnd/living_room_light/POWER"), []);
            } finally {
                await done();
            }
        });

        it("refuses everything when the broker is down", async () => {
            try {
                await harness.mqttClient.disconnect();
                await assert.rejects(harness.house.allOff(), /broker is unavailable/);
            } finally {
                await done();
            }
        });
    });

    describe("printers", () => {
        it("refuses to switch off a named printer without a confirmation, and still switches the rest", async () => {
            try {
                const result = await harness.house.turnOff(
                    { devices: ["printer", "den light"] },
                    { refusalReason: "the person declined" }
                );

                assert.deepEqual(result.refused, [{ id: "trident", reason: "the person declined" }]);
                assert.deepEqual(result.switched.map(item => item.id), ["den_light"]);
                assertNoPrinterCommands();
            } finally {
                await done();
            }
        });

        it("switches off a named printer the person confirmed", async () => {
            try {
                const result = await harness.house.turnOff(
                    { devices: ["trident"] },
                    { confirmedPrinters: new Set(["trident"]) }
                );

                assert.deepEqual(result.switched, [{ id: "trident", state: "off", source: "reported" }]);
                assert.deepEqual(harness.fake.commandsTo("cmnd/trident/POWER"), ["OFF"]);
            } finally {
                await done();
            }
        });

        it("names only the printers in the request as needing confirmation", async () => {
            try {
                assert.deepEqual(
                    harness.house.printersToConfirm({ devices: ["trident", "den light"] }).map(device => device.config.id),
                    ["trident"]
                );
                assert.deepEqual(harness.house.printersToConfirm({ room: "den" }), []);
            } finally {
                await done();
            }
        });

        it("needs no confirmation for a printer that already reported itself off", async () => {
            try {
                harness.fake.power.set("trident", "OFF");
                await harness.fake.reportAll();
                await waitFor(() => harness.house.getState({ devices: ["trident"] })[0].state.on === false);

                assert.deepEqual(harness.house.printersToConfirm({ devices: ["trident"] }), []);
                const result = await harness.house.turnOff({ devices: ["trident"] });
                assert.deepEqual(result.already, [{ id: "trident", state: "off" }]);
                assertNoPrinterCommands();
            } finally {
                await done();
            }
        });

        it("turns a printer on without confirmation", async () => {
            try {
                harness.fake.power.set("trident", "OFF");
                await harness.fake.reportAll();
                await new Promise(resolve => setTimeout(resolve, 50));

                const result = await harness.house.turnOn({ devices: ["trident"] });
                assert.deepEqual(result.switched, [{ id: "trident", state: "on", source: "reported" }]);
            } finally {
                await done();
            }
        });

        it("leaves printers out of a room-wide turn_on too", async () => {
            try {
                harness.fake.power.set("trident", "OFF");
                const result = await harness.house.turnOn({ room: "den" });
                assert.deepEqual(result.printers_skipped.map(item => item.id), ["trident", "v0"]);
                assertNoPrinterCommands();
            } finally {
                await done();
            }
        });
    });

    describe("other commands", () => {
        it("sets Nudge's brightness and color and reports what Nudge confirmed", async () => {
            try {
                const result = await harness.house.setLight("nudge", { brightness: 40, color: "red" });

                assert.equal(result.confirmed, true);
                assert.equal(result.state.brightness, 40);
                assert.equal(result.state.color, "#ff0000");
                assert.deepEqual(harness.fake.commandsTo("nudge/command/brightness"), ["102"]);
                assert.deepEqual(harness.fake.commandsTo("nudge/command/color"), ["#ff0000"]);
            } finally {
                await done();
            }
        });

        it("rejects set_light on a device without brightness or color", async () => {
            try {
                await assert.rejects(harness.house.setLight("den light", { brightness: 50 }), /no brightness or color/);
                await assert.rejects(harness.house.setLight("nudge", { color: "chartreuse" }), /Unknown color/);
                assert.deepEqual(harness.fake.published, []);
            } finally {
                await done();
            }
        });

        it("switches the TV input, with the TV as the default device", async () => {
            try {
                const result = await harness.house.setTvInput(undefined, "hdmi2");

                assert.equal(result.confirmed, true);
                assert.equal(result.state.input, "HDMI2");
                assert.equal(result.source, "last sent");
                assert.deepEqual(harness.fake.commandsTo("cmnd/tv/INPUT"), ["HDMI2"]);

                await assert.rejects(harness.house.setTvInput("tv", "HDMI9"), /Inputs: HDMI1, HDMI2, HDMI3, HDMI4/);
            } finally {
                await done();
            }
        });

        it("blows bubbles and says it can't be confirmed", async () => {
            try {
                const result = await harness.house.bubble(undefined);

                assert.equal(result.id, "blup");
                assert.equal(result.confirmed, false);
                // Nothing confirms a press, so wait for the broker to have it
                await waitFor(() => harness.fake.bubbles === 1);
                assert.deepEqual(harness.fake.commandsTo("blup/command/bubble"), [""]);
            } finally {
                await done();
            }
        });

        it("lists every device with what it can do and where its state came from", async () => {
            try {
                const devices = harness.house.listDevices();
                const byId = new Map(devices.map(device => [device.id, device]));

                assert.equal(devices.length, 10);
                assert.deepEqual(byId.get("nudge")?.can, ["turn_on", "turn_off", "set_light"]);
                assert.deepEqual(byId.get("tv")?.can, ["turn_on", "turn_off", "set_tv_input"]);
                assert.deepEqual(byId.get("tv")?.inputs, ["HDMI1", "HDMI2", "HDMI3", "HDMI4"]);
                assert.deepEqual(byId.get("blup")?.can, ["bubble"]);
                assert.equal(byId.get("tv")?.source, "last sent");
                assert.equal(byId.get("trident")?.printer, true);
                assert.equal(byId.get("cooler")?.matter, false);
                assert.equal(byId.get("v0")?.online, null);
                assert.equal(byId.get("v0")?.state.on, null);
                assert.equal(byId.get("living_room_light")?.online, false);
            } finally {
                await done();
            }
        });
    });
});

describe("House after a broker outage", () => {
    let harness: Harness;

    before(async () => {
        harness = await startHarness();
    });

    after(async () => {
        await harness.close();
    });

    it("forgets states rather than keeping ones it can no longer vouch for", () => {
        for (const { bridge } of harness.devices) {
            bridge.handleBrokerLost();
        }
        const states = harness.house.listDevices();
        assert.ok(states.every(device => device.online === null && device.state.on === null));
    });
});
