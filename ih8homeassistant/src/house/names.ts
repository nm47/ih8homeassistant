/**
 * Name matching for devices and rooms
 *
 * Matching is exact after normalization, never fuzzy: an unknown or ambiguous name fails
 * with the valid candidates rather than guessing the nearest device.
 */

/**
 * Normalize a device or room name for comparison
 *
 * Lowercases, strips diacritics ("blüp" matches "blup") and treats any run of
 * non-alphanumerics as one space, so "den_light", "Den Light" and "den-light" are equal.
 */
export function normalizeName(name: string): string {
    return name
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase()
        .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
        .trim();
}

/**
 * Raised for requests the house refuses before sending anything: unknown or ambiguous
 * names, unsupported actions, a missing broker. The message is meant for the caller.
 */
export class HouseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "HouseError";
    }
}

/**
 * What a name index needs to know about each device
 */
export interface NamedDevice {
    id: string;
    name: string;
    aliases: readonly string[];
    room: string;
}

/**
 * Resolves device and room names to device ids
 */
export class NameIndex {
    private readonly byName = new Map<string, Set<string>>();
    private readonly byRoom = new Map<string, string[]>();
    private readonly roomLabels = new Map<string, string>();

    constructor(private readonly devices: readonly NamedDevice[]) {
        for (const device of devices) {
            for (const name of [device.id, device.name, ...device.aliases]) {
                const key = normalizeName(name);
                const ids = this.byName.get(key) ?? new Set<string>();
                ids.add(device.id);
                this.byName.set(key, ids);
            }

            const room = normalizeName(device.room);
            this.byRoom.set(room, [...(this.byRoom.get(room) ?? []), device.id]);
            if (!this.roomLabels.has(room)) {
                this.roomLabels.set(room, device.room);
            }
        }
    }

    /**
     * Resolve one device name, failing with the candidates when it is unknown or ambiguous
     */
    resolveDevice(name: string): string {
        const ids = this.byName.get(normalizeName(name));

        if (ids === undefined || ids.size === 0) {
            const known = this.devices
                .map(device => {
                    const others = [device.name, ...device.aliases].filter(
                        other => normalizeName(other) !== normalizeName(device.id)
                    );
                    return others.length > 0 ? `${device.id} (${others.join(", ")})` : device.id;
                })
                .join("; ");
            throw new HouseError(`Unknown device "${name}". Known devices: ${known}`);
        }

        if (ids.size > 1) {
            throw new HouseError(
                `"${name}" is ambiguous: it could be ${[...ids].join(" or ")}. Name one of them.`
            );
        }

        return [...ids][0];
    }

    /**
     * Resolve several device names. Every name must resolve, or none are used.
     */
    resolveDevices(names: readonly string[]): string[] {
        if (names.length === 0) {
            throw new HouseError("No devices named");
        }

        const errors: string[] = [];
        const ids = new Set<string>();
        for (const name of names) {
            try {
                ids.add(this.resolveDevice(name));
            } catch (error) {
                if (!(error instanceof HouseError)) {
                    throw error;
                }
                errors.push(error.message);
            }
        }

        if (errors.length > 0) {
            throw new HouseError(`${errors.join("\n")}\nNothing was sent.`);
        }
        return [...ids];
    }

    /**
     * Resolve a room name to the ids of every device in it
     */
    resolveRoom(room: string): { room: string; ids: string[] } {
        const key = normalizeName(room);
        const ids = this.byRoom.get(key);
        if (ids === undefined) {
            throw new HouseError(`Unknown room "${room}". Rooms: ${this.rooms().join(", ")}`);
        }
        return { room: this.roomLabels.get(key)!, ids };
    }

    /**
     * Every room, as the config spells it
     */
    rooms(): string[] {
        return [...this.roomLabels.values()];
    }
}
