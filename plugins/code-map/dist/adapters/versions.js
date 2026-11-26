export const ADAPTER_VERSIONS = { typescript: '1.1.0', python: '1.1.1' };
export const DEFAULT_ADAPTER_FINGERPRINT = Object.entries(ADAPTER_VERSIONS).sort(([a], [b]) => a.localeCompare(b)).map(([id, version]) => `${id}@${version}`).join(',');
