/**
 * Upstream GitHub update check disabled for private studio edition.
 * Never phones home to external GitHub repositories.
 */

export interface LatestRelease {
  tagName: string;
  htmlUrl: string;
  publishedAt: string;
}

export async function getLatestRelease(): Promise<LatestRelease | null> {
  return null;
}

export function isNewerVersion(_latest: string, _current: string): boolean {
  return false;
}
