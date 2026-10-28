/**
 * Matter endpoint identity for configured devices
 *
 * Kept apart from index.ts so tests can check that existing Matter devices keep their
 * endpoint IDs: controllers key their pairings, rooms and automations on them.
 */

/**
 * Create a sanitized endpoint ID from device name
 */
export function createEndpointId(deviceName: string): string {
    return deviceName.toLowerCase().replace(/\s+/g, "-");
}

/**
 * Reject configurations whose devices would collide at runtime
 *
 * createEndpointId lowercases and hyphenates, so "Living Room" and "living-room" produce the
 * same endpoint, and duplicates would silently overwrite each other.
 */
export function assertUniqueDevices(devices: Array<{ name: string }>): void {
    const namesSeen = new Map<string, string>();
    const idsSeen = new Map<string, string>();

    for (const device of devices) {
        const previousName = namesSeen.get(device.name);
        if (previousName !== undefined) {
            throw new Error(`Duplicate device name: "${device.name}" is used more than once`);
        }
        namesSeen.set(device.name, device.name);

        const endpointId = createEndpointId(device.name);
        const previousId = idsSeen.get(endpointId);
        if (previousId !== undefined) {
            throw new Error(
                `Devices "${previousId}" and "${device.name}" both map to endpoint ID "${endpointId}"`
            );
        }
        idsSeen.set(endpointId, device.name);
    }
}
