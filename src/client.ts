import { assertPolicy } from "./policy.js";
import { getCredential, getProfile, type Profile } from "./profiles.js";

export class ForgejoClient {
  private constructor(private readonly profile: Profile, private readonly credential: string) {}

  static async forProfile(name?: string): Promise<ForgejoClient> {
    const profile = await getProfile(name);
    return new ForgejoClient(profile, await getCredential(profile.name));
  }

  async request(path: string, options: { method?: string; body?: unknown; query?: Record<string, string | number | boolean | undefined>; approvedRepository?: string; responseType?: "json" | "text" } = {}): Promise<unknown> {
    const method = options.method ?? "GET";
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) throw new Error("API path must start with one safe slash.");
    assertPolicy(this.profile, method, path);
    // These API routes create a repository but do not contain its name in the
    // URL. Never let the generic API route bypass an explicit allowlist.
    const orgMatch = path.match(/^\/orgs\/([^/]+)\/repos$/);
    if (isRepositoryCreationRoute(path, method) && this.profile.repositories.length > 0) {
      const owner = orgMatch ? decodeURIComponent(orgMatch[1]) : undefined;
      const name = typeof options.body === "object" && options.body !== null && "name" in options.body ? (options.body as { name?: unknown }).name : undefined;
      const proposed = owner && typeof name === "string" ? `${owner}/${name}` : options.approvedRepository;
      if (!proposed || !options.approvedRepository || !proposed.endsWith(`/${String(name ?? "")}`) || !this.profile.repositories.includes(proposed)) {
        throw new Error("Creating a repository with an allowlist requires forgejo_create_repository and an allowlist entry for the new owner/name.");
      }
    }
    const url = new URL(`/api/v1${path}`, this.profile.host);
    for (const [key, value] of Object.entries(options.query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
    const response = await fetch(url, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: this.profile.authType === "bearer" ? `Bearer ${this.credential}` : `token ${this.credential}`,
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" })
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(30_000)
    });
    const raw = await response.text();
    if (response.ok && options.responseType === "text") return raw;
    let payload: unknown = raw;
    try { payload = raw ? JSON.parse(raw) : null; } catch { /* Non-JSON error response. */ }
    if (!response.ok) throw new Error(`Forgejo API ${method} ${path} failed (${response.status}): ${typeof payload === "string" ? payload : JSON.stringify(payload)}`);
    return payload;
  }
}

function isRepositoryCreationRoute(path: string, method: string): boolean {
  return method.toUpperCase() === "POST" && (path === "/user/repos" || /^\/orgs\/[^/]+\/repos$/.test(path));
}
