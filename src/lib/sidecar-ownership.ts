export function harnessOwnershipCompatible(
    agentHarnessEnabled: boolean,
    nativeOwned: boolean,
): boolean {
    return !agentHarnessEnabled || nativeOwned;
}
