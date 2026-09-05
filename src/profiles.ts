import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import keytar from "keytar";
import type { AccessLevel, ProfilePolicy } from "./policy.js";

export type AuthType = "token" | "bearer";
export interface Profile extends ProfilePolicy {
  name: string;
  host: string;
  authType: AuthType;
  createdAt: string;
  updatedAt: string;
}

interface StoredProfiles { active?: string; profiles: Profile[] }

const service = "forgejo-mcp";
const storePath = process.env.FORGEJO_MCP_CONFIG_PATH ?? join(homedir(), ".config", "forgejo-mcp", "profiles.json");

async function load(): Promise<StoredProfiles> {
  try { return JSON.parse(await readFile(storePath, "utf8")) as StoredProfiles; }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { profiles: [] };
    throw new Error(`Could not read Forgejo MCP profile metadata: ${(error as Error).message}`);
  }
}

async function save(data: StoredProfiles): Promise<void> {
  await mkdir(dirname(storePath), { recursive: true });
  const temp = `${storePath}.tmp`;
  await writeFile(temp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, storePath);
}

export function normalizeHost(host: string, allowHttp = false): string {
  let url: URL;
  try { url = new URL(host); } catch { throw new Error("host must be an absolute URL, such as https://forgejo.example.com"); }
  if (!allowHttp && url.protocol !== "https:") throw new Error("Only HTTPS Forgejo hosts are allowed. Set allowHttp only for a trusted local development server.");
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("host must be a plain http(s) origin without credentials, query, or fragment.");
  }
  return url.origin;
}

export async function listProfiles(): Promise<{ active?: string; profiles: Profile[] }> {
  const data = await load();
  return { active: data.active, profiles: data.profiles };
}

export async function getProfile(name?: string): Promise<Profile> {
  const data = await load();
  const selected = name ?? process.env.FORGEJO_MCP_PROFILE ?? data.active;
  if (!selected) throw new Error("No Forgejo profile is selected. Call forgejo_configure first.");
  const profile = data.profiles.find((item) => item.name === selected);
  if (!profile) throw new Error(`Forgejo profile '${selected}' was not found.`);
  return profile;
}

export async function getCredential(name: string): Promise<string> {
  const value = await keytar.getPassword(service, name);
  if (!value) throw new Error(`No credential is stored for profile '${name}'. Reconfigure it or select another profile.`);
  return value;
}

export async function upsertProfile(input: Omit<Profile, "createdAt" | "updatedAt">, credential: string, activate: boolean): Promise<Profile> {
  if (!credential.trim()) throw new Error("A non-empty access token or bearer JWT is required.");
  const data = await load();
  const index = data.profiles.findIndex((item) => item.name === input.name);
  const now = new Date().toISOString();
  const profile: Profile = { ...input, createdAt: index >= 0 ? data.profiles[index].createdAt : now, updatedAt: now };
  if (index >= 0) data.profiles[index] = profile; else data.profiles.push(profile);
  if (activate || !data.active) data.active = profile.name;
  await keytar.setPassword(service, profile.name, credential);
  await save(data);
  return profile;
}

export async function updateProfile(name: string, changes: Partial<Pick<Profile, "host" | "repositories" | "access" | "authType">>, credential?: string, activate?: boolean): Promise<Profile> {
  const current = await getProfile(name);
  return upsertProfile({ ...current, ...changes, name, host: changes.host ?? current.host }, credential ?? await getCredential(name), activate ?? false);
}

export async function revokeProfile(name: string): Promise<void> {
  const data = await load();
  if (!data.profiles.some((item) => item.name === name)) throw new Error(`Forgejo profile '${name}' was not found.`);
  data.profiles = data.profiles.filter((item) => item.name !== name);
  if (data.active === name) data.active = data.profiles[0]?.name;
  await keytar.deletePassword(service, name);
  await save(data);
}

export function validateAccess(value: string): AccessLevel {
  if (value === "read" || value === "write" || value === "admin") return value;
  throw new Error("access must be read, write, or admin.");
}
