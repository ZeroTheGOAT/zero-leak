export function displayVersion(version: string): string {
  return `v${version.replace(/^v/, "")}`;
}
