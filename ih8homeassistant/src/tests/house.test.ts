/**
 * Tests for the house rules, against a fake broker.
 *
 * The rules that matter most: printers are never switched by a room or all_off, a bad name
 * sends nothing at all, and results only ever report what a device confirmed.
 */

import { strict as assert } from "node:assert";
import { after, before, beforeEach, describe, it } from "node:test";

import { HouseError } from "../house/names.js";
import type { SwitchSelector } from "../house/House.js";
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

    describe("kind", () => {
        it("with a room, switches only that kind there", async () => {
            try {
                const result = await harness.house.turnOff({ room: "den", kind: "light" });

                assert.deepEqual(result.switched.map(item => item.id), ["den_light", "reading_lamp"]);
                assert.equal(result.room, "den");
                assert.equal(result.kind, "light");
                assert.deepEqual(result.printers_skipped, []);
                assert.equal(result.summary, "In the den: switched off: den_light, reading_lamp.");
                assert.deepEqual(harness.fake.commandsTo("cmnd/tv/POWER"), []);
                assertNoPrinterCommands();
            } finally {
                await done();
            }
        });

        it("alone, switches that kind in the whole house", async () => {
            try {
                const result = await harness.house.turnOff({ kind: "light" });

                assert.deepEqual(result.switched.map(item => item.id), ["den_light", "reading_lamp"]);
                assert.deepEqual(result.already.map(item => item.id), ["lanterns", "nudge"]);
                assert.deepEqual(result.offline, ["living_room_light"]);
                assert.equal(result.room, undefined);
                assert.deepEqual(harness.fake.commandsTo("cmnd/tv/POWER"), []);
                assert.deepEqual(harness.fake.commandsTo("cmnd/cooler/POWER"), []);
            } finally {
                await done();
            }
        });

        it("as printer, counts each printer as named, so each needs a person's confirmation", async () => {
            try {
                const asked = (selector: SwitchSelector) =>
                    harness.house.printersToConfirm(selector).map(device => device.config.id);
                assert.deepEqual(asked({ kind: "printer" }), ["trident", "v0"]);
                assert.deepEqual(asked({ room: "den", kind: "printer" }), ["trident", "v0"]);
                assert.deepEqual(asked({ kind: "printer", except: ["trident"] }), ["v0"]);
                assert.deepEqual(asked({ room: "den", kind: "light" }), []);

                const declined = await harness.house.turnOff({ kind: "printer" }, { refusalReason: "the person declined" });
                assert.deepEqual(declined.refused, [
                    { id: "trident", reason: "the person declined" },
                    { id: "v0", reason: "the person declined" },
                ]);
                assert.deepEqual(declined.printers_skipped, []);
                assertNoPrinterCommands();

                // A confirmation covers only the printers it names
                const result = await harness.house.turnOff({ kind: "printer" }, { confirmedPrinters: new Set(["trident"]) });
                assert.deepEqual(result.switched, [{ id: "trident", state: "off", source: "reported" }]);
                assert.deepEqual(result.refused.map(item => item.id), ["v0"]);
                assert.deepEqual(harness.fake.commandsTo("cmnd/trident/POWER"), ["OFF"]);
                assert.deepEqual(harness.fake.commandsTo("cmnd/v0/POWER"), []);
            } finally {
                await done();
            }
        });

        it("can't be given with devices", async () => {
            try {
                await assert.rejects(
                    harness.house.turnOn({ devices: ["tv"], kind: "light" }),
                    /Give either devices or a kind, with or without a room, not both/
                );
                assert.deepEqual(harness.fake.published, []);
            } finally {
                await done();
            }
        });
    });

    describe("except", () => {
        it("leaves named devices alone, and lists them with their state", async () => {
            try {
                const result = await harness.house.turnOff({ devices: ["den light", "reading lamp", "tv"], except: ["television"] });

                assert.deepEqual(result.switched.map(item => item.id), ["den_light", "reading_lamp"]);
                assert.deepEqual(result.excepted, [{ id: "tv", state: "on", online: true }]);
                assert.deepEqual(harness.fake.commandsTo("cmnd/tv/POWER"), []);
            } finally {
                await done();
            }
        });

        it("leaves devices in a room alone", async () => {
            try {
                const result = await harness.house.turnOff({ room: "den", except: ["tv"] });

                assert.deepEqual(result.switched.map(item => item.id), ["den_light", "reading_lamp"]);
                assert.deepEqual(result.excepted, [{ id: "tv", state: "on", online: true }]);
                assert.deepEqual(result.printers_skipped.map(item => item.id), ["trident", "v0"]);
                assert.match(result.summary, /left alone as asked: tv \(on\); printers left alone: trident \(on\)/);
                assert.deepEqual(harness.fake.commandsTo("cmnd/tv/POWER"), []);
                assertNoPrinterCommands();
            } finally {
                await done();
            }
        });

        it("leaves devices of a kind alone", async () => {
            try {
                const result = await harness.house.turnOn({ kind: "light", except: ["nudge"] });

                assert.deepEqual(result.switched.map(item => item.id), ["lanterns"]);
                assert.deepEqual(result.already.map(item => item.id), ["den_light", "reading_lamp"]);
                assert.deepEqual(result.excepted, [{ id: "nudge", state: "off", online: true }]);
                assert.deepEqual(harness.fake.commandsTo("nudge/command/power"), []);
            } finally {
                await done();
            }
        });

        it("switches off everything but the lanterns, without touching them", async () => {
            try {
                harness.fake.power.set("lanterns", "ON");
                await harness.fake.reportAll();
                await waitFor(() => harness.house.getState({ devices: ["lanterns"] })[0].state.on === true);

                const result = await harness.house.allOff(["lanterns"]);

                assert.deepEqual(result.switched.map(item => item.id), ["den_light", "reading_lamp", "tv"]);
                assert.deepEqual(result.excepted, [{ id: "lanterns", state: "on", online: true }]);
                assert.deepEqual(result.printers_skipped.map(item => item.id), ["trident", "v0"]);
                assert.deepEqual(harness.fake.commandsTo("cmnd/lanterns/POWER"), []);
                assert.equal(harness.fake.power.get("lanterns"), "ON");
                assertNoPrinterCommands();
            } finally {
                await done();
            }
        });

        it("rejects an unknown name, and sends nothing", async () => {
            try {
                for (const call of [
                    () => harness.house.turnOff({ room: "den", except: ["kitchen light"] }),
                    () => harness.house.turnOn({ devices: ["den light"], except: ["kitchen light"] }),
                    () => harness.house.allOff(["kitchen light"]),
                ]) {
                    await assert.rejects(call, (error: unknown) => {
                        assert.ok(error instanceof HouseError);
                        assert.match(error.message, /Unknown device "kitchen light"/);
                        assert.match(error.message, /Nothing was sent/);
                        return true;
                    });
                }
                assert.deepEqual(harness.fake.published, []);
            } finally {
                await done();
            }
        });
    });

    describe("a selection that matches nothing", () => {
        it("is refused, and nothing is sent", async () => {
            try {
                await assert.rejects(harness.house.turnOff({ room: "bedroom", kind: "tv" }), (error: unknown) => {
                    assert.ok(error instanceof HouseError);
                    assert.equal(error.message, "No device of kind tv in the bedroom can be switched on or off. Nothing was sent.");
                    return true;
                });
                // blüp is the only notifier, and it presses rather than switches
                await assert.rejects(harness.house.turnOn({ kind: "notifier" }), /No device of kind notifier in the house/);
                await assert.rejects(
                    harness.house.turnOff({ devices: ["tv"], except: ["television"] }),
                    /No device among the devices given besides the ones in except/
                );
                await assert.rejects(
                    harness.house.turnOff({ kind: "printer", except: ["trident", "v0"] }),
                    /No device of kind printer in the house besides the ones in except/
                );
                assert.deepEqual(harness.fake.published, []);
            } finally {
                await done();
            }
        });

        it("is refused when only printers that would be skipped are left, live and as a dry run", async () => {
            try {
                for (const house of [harness.house, harness.house.asDryRun()]) {
                    await assert.rejects(
                        house.turnOff({ room: "den", except: ["den light", "reading lamp", "tv"] }),
                        (error: unknown) => {
                            assert.ok(error instanceof HouseError);
                            assert.equal(
                                error.message,
                                "No device in the den besides the ones in except can be switched on or off. Nothing was sent."
                            );
                            return true;
                        }
                    );
                    await assert.rejects(
                        house.allOff(["den light", "reading lamp", "tv", "living room light", "lanterns", "nudge", "cooler"]),
                        (error: unknown) => {
                            assert.ok(error instanceof HouseError);
                            assert.equal(
                                error.message,
                                "No device in the house besides the ones in except can be switched on or off. Nothing was sent."
                            );
                            return true;
                        }
                    );
                }
                assert.deepEqual(harness.fake.published, []);
            } finally {
                await done();
            }
        });

        it("still lets named devices leave just a printer, which then needs confirmation", async () => {
            try {
                assert.deepEqual(
                    harness.house.printersToConfirm({ devices: ["trident", "lanterns"], except: ["lanterns"] })
                        .map(device => device.config.id),
                    ["trident"]
                );
                const result = await harness.house.turnOff({ devices: ["trident", "lanterns"], except: ["lanterns"] });
                assert.deepEqual(result.refused.map(item => item.id), ["trident"]);
                assertNoPrinterCommands();
            } finally {
                await done();
            }
        });
    });

    describe("except without devices, a room or a kind", () => {
        it("is refused, pointing turn_off, and only turn_off, at all_off", async () => {
            try {
                await assert.rejects(harness.house.turnOn({ except: ["lanterns"] }), (error: unknown) => {
                    assert.ok(error instanceof HouseError);
                    assert.equal(error.message, "Give devices, a room or a kind alongside except.");
                    return true;
                });
                const toTurnOff = (error: unknown) => {
                    assert.ok(error instanceof HouseError);
                    assert.equal(
                        error.message,
                        "Give devices, a room or a kind alongside except. " +
                        "To switch off everything but some devices, use all_off with except."
                    );
                    return true;
                };
                await assert.rejects(harness.house.turnOff({ except: ["lanterns"] }), toTurnOff);
                assert.throws(() => harness.house.printersToConfirm({ except: ["lanterns"] }), toTurnOff);
                // Without except, the message is today's
                await assert.rejects(harness.house.turnOff({}), /^HouseError: Give either devices or a room, not both and not neither$/);
                assert.deepEqual(harness.fake.published, []);
            } finally {
                await done();
            }
        });
    });

    describe("calls without kind or except", () => {
        it("return the same fields as before", async () => {
            try {
                const room = await harness.house.turnOff({ room: "den" });
                assert.deepEqual(Object.keys(room), [
                    "action", "switched", "already", "not_confirmed", "offline", "printers_skipped", "refused",
                    "failed", "summary", "room",
                ]);
                const all = await harness.house.allOff();
                assert.deepEqual(Object.keys(all), [
                    "action", "switched", "already", "not_confirmed", "offline", "printers_skipped", "refused",
                    "failed", "summary",
                ]);
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
                assert.equal(byId.get("trident")?.kind, "printer");
                assert.equal(byId.get("reading_lamp")?.kind, "light");
                assert.ok(!("printer" in byId.get("trident")!));
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
