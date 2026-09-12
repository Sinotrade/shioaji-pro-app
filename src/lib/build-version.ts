// Display identity is distinct from Tauri/Cargo schema placeholder versions.
export function buildVersionLabel(input: {
    command: string;
    refType?: string;
    refName?: string;
    revision?: string;
    dirty?: boolean;
}): string {
    if (input.command === 'build' && input.refType === 'tag' &&
        /^v\d+\.\d+\.\d+$/.test(input.refName ?? '')) {
        return input.refName!;
    }
    const revision = /^[0-9a-f]{7,40}$/.test(input.revision ?? '')
        ? input.revision!.slice(0, 8) : 'unknown';
    return `dev · ${revision}${input.dirty ? '+dirty' : ''}`;
}
