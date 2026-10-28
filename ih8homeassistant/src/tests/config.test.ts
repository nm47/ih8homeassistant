/**
 * Tests for the device list in the config.
 *
 * The repo's config.toml is the live one, so it is tested directly: Matter controllers key
 * their pairings, rooms and automations on endpoint IDs, and an endpoint ID comes from the
 * device name. A renamed Matter device is a new device to every phone and hub.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { ConfigParser, ConfigValidationError } from "../config/ConfigParser.js";
import { assertUniqueDevices, createEndpointId } from "../config/deviceIds.js";

const LIVE_CONFIG = readFileSync(new URL("../../config.toml", import.meta.url), "utf-8");

/**
 * The endpoint IDs Matter controllers knew on 2026-10-27, minus the TV, which the user
 * chose to rename from "Living Room TV" to "TV"
 */
const PAIRED_ENDPOINT_IDS = [
    "den-light",
    "dining-room-light",
    "closet-light",
    "nudge",
    "living-room-light",
    "lanterns",
    "reading-lamp",
    "blup",
    "trident",
    "v0",
];

describe("the live config", () => {
    const config = ConfigParser.parse(LIVE_CONFIG);
    const byId = new Map(config.devices.map(device => [device.id, device]));

    it("lists all 13 devices", () => {
        assert.deepEqual([...byId.keys()].sort(), [
            "bedroom_overhead", "blup", "closet_light", "cooler", "den_light", "dining_room_light",
            "lanterns", "living_room_light", "nudge", "reading_lamp", "trident", "tv", "v0",
        ]);
    });

    it("keeps every paired Matter device's endpoint ID, and adds the renamed TV", () => {
        const endpointIds = config.devices.filter(device => device.matter).map(device => createEndpointId(device.name));

        assert.deepEqual(endpointIds.filter(id => id !== "tv").sort(), [...PAIRED_ENDPOINT_IDS].sort());
        assert.ok(endpointIds.includes("tv"));
        assert.ok(!endpointIds.includes("living-room-tv"));
        assertUniqueDevices(config.devices.filter(device => device.matter));
    });

    it("keeps the new devices out of Matter", () => {
        assert.equal(byId.get("bedroom_overhead")?.matter, false);
        assert.equal(byId.get("cooler")?.matter, false);
    });

    it("gives every device the kind the ticket lists for it", () => {
        assert.deepEqual(Object.fromEntries(config.devices.map(device => [device.id, device.kind])), {
            den_light: "light",
            dining_room_light: "light",
            closet_light: "light",
            nudge: "light",
            living_room_light: "light",
            lanterns: "light",
            reading_lamp: "light",
            blup: "notifier",
            tv: "tv",
            trident: "printer",
            v0: "printer",
            bedroom_overhead: "light",
            cooler: "cooler",
        });
    });

    it("puts the closet in the bedroom and the TV and V0 in the den", () => {
        assert.equal(byId.get("closet_light")?.room, "bedroom");
        assert.equal(byId.get("tv")?.room, "den");
        assert.equal(byId.get("v0")?.room, "den");
    });

    it("configures the TV's inputs and the MCP endpoint", () => {
        assert.deepEqual(byId.get("tv")?.options.inputs, ["HDMI1", "HDMI2", "HDMI3", "HDMI4"]);
        assert.deepEqual(config.mcp, { host: "0.0.0.0", port: 8540, token: undefined, confirmTimeoutMs: 3000 });
    });
});

describe("device field validation", () => {
    const BROKER = `[broker]\nhost = "localhost"\nport = 1883\n`;

    function device(fields: string, name = "Den Light", id = "den_light"): string {
        return `
[[devices]]
type = "OnOffPlugInUnitDevice"
name = "${name}"
id = "${id}"
room = "den"
kind = "light"
${fields}
topics = { getOnline = "tele/${id}/LWT", getOn = "stat/${id}/POWER", setOn = "cmnd/${id}/POWER" }
`;
    }

    function parse(...devices: string[]) {
        return ConfigParser.parse(BROKER + devices.join(""));
    }

    it("accepts a minimal device and fills in the defaults", () => {
        const [parsed] = parse(device("matter = false")).devices;
        assert.deepEqual({ aliases: parsed.aliases, kind: parsed.kind }, { aliases: [], kind: "light" });
    });

    it("requires a kind from the fixed set, so a printer can't fall back to another kind", () => {
        const withoutKind = device("matter = true").replace(`kind = "light"\n`, "");
        assert.throws(() => parse(withoutKind), /kind must be one of light, tv, printer, notifier, cooler/);
        assert.throws(
            () => parse(device("matter = true").replace(`kind = "light"`, `kind = "plug"`)),
            /kind must be one of/
        );
    });

    it("rejects the old printer flag, so an old config fails instead of losing printer safety", () => {
        assert.throws(() => parse(device("matter = true\nprinter = true")), /printer was removed; set kind = "printer"/);
    });

    it("requires matter, so an old config can't silently drop devices from Matter", () => {
        assert.throws(() => parse(device("")), /matter must be true or false/);
    });

    it("rejects ids that aren't lowercase words", () => {
        assert.throws(() => parse(device("matter = true", "Den Light", "Den-Light")), /id must be lowercase/);
    });

    it("rejects a duplicate id", () => {
        assert.throws(
            () => parse(device("matter = true"), device("matter = true", "Other", "den_light")),
            /Duplicate device id/
        );
    });

    it("rejects a name that matches another device's id", () => {
        assert.throws(
            () => parse(device("matter = true"), device("matter = true", "den light", "other")),
            (error: unknown) => error instanceof ConfigValidationError && /both answer to the name "den light"/.test(error.message)
        );
    });

    it("rejects an alias that is another device's name", () => {
        assert.throws(
            () => parse(device("matter = true"), device(`matter = true\naliases = ["Den Light"]`, "Other", "other")),
            /Alias "Den Light" of "other" is the id or name of "den_light"/
        );
    });

    it("allows two devices to share an alias, which then resolves as ambiguous", () => {
        const config = parse(
            device(`matter = true\naliases = ["lamp"]`),
            device(`matter = true\naliases = ["lamp"]`, "Other", "other")
        );
        assert.equal(config.devices.length, 2);
    });

    it("only allows kind printer on on/off devices", () => {
        assert.throws(
            () => ConfigParser.parse(BROKER + `
[[devices]]
type = "GenericSwitchDevice"
name = "Button"
id = "button"
room = "den"
kind = "printer"
matter = false
topics = { getOnline = "button/online", setCommand = "button/press" }
`),
            /kind "printer" is only supported for/
        );
    });

    it("rejects a malformed optional topic", () => {
        assert.throws(() => parse(device(`matter = true\n`).replace(`setOn = "cmnd/den_light/POWER"`, `setOn = "cmnd/den_light/POWER", getState = ""`)), /Optional topic getState/);
    });
});
