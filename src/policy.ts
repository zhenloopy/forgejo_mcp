export type AccessLevel = "read" | "write" | "admin";

export interface ProfilePolicy {
  /** Empty means every repository the Forgejo token itself can access. */
  repositories: string[];
  access: AccessLevel;
}

const accessRank: Record<AccessLevel, number> = { read: 0, write: 1, admin: 2 };

export function isWrite(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

export function requiredAccess(method: string, path: string): AccessLevel {
  if (!isWrite(method)) return "read";
  // Administrative endpoints are intentionally not exposed by the generic API
  // unless the profile explicitly permits them.
  return path.startsWith("/admin/") ? "admin" : "write";
}

export function repoFromApiPath(path: string): string | undefined {
  const match = path.match(/^\/repos\/([^/]+)\/([^/?#]+)/);
  return match ? `${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}` : undefined;
}

export function assertPolicy(policy: ProfilePolicy, method: string, path: string): void {
  const required = requiredAccess(method, path);
  if (accessRank[policy.access] < accessRank[required]) {
    throw new Error(`Profile permits ${policy.access} operations, but ${method.toUpperCase()} ${path} requires ${required} access.`);
  }

  const repo = repoFromApiPath(path);
  if (repo && policy.repositories.length > 0 && !policy.repositories.includes(repo)) {
    throw new Error(`Repository ${repo} is outside this profile's allowlist.`);
  }
}
