import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ForgejoClient } from "./client.js";
import { assertPolicy } from "./policy.js";
import { listProfiles, normalizeHost, revokeProfile, updateProfile, upsertProfile, validateAccess } from "./profiles.js";

const server = new McpServer({ name: "forgejo-mcp", version: "0.1.0" });
const profile = z.string().min(1).optional().describe("Named Forgejo profile. Uses the active profile when omitted.");
const repo = z.object({ owner: z.string().min(1), repo: z.string().min(1), profile });
const json = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
const fail = (error: unknown) => ({ content: [{ type: "text" as const, text: `Error: ${(error as Error).message}` }], isError: true });
const run = <T>(work: () => Promise<T>) => work().then(json).catch(fail);
const client = (name?: string) => ForgejoClient.forProfile(name);
const repoPath = (owner: string, name: string) => `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64");

function resolveCredential(credential?: string, credentialEnvVar?: string): string {
  if (credential && credentialEnvVar) throw new Error("Provide credential or credentialEnvVar, not both.");
  if (credential) return credential;
  if (!credentialEnvVar) throw new Error("Provide a credential or credentialEnvVar.");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(credentialEnvVar)) throw new Error("credentialEnvVar must be a valid environment-variable name.");
  const value = process.env[credentialEnvVar];
  if (!value) throw new Error(`Environment variable ${credentialEnvVar} is not set or empty.`);
  return value;
}

server.registerTool("forgejo_configure", {
  description: "Save a Forgejo host and credential once in the OS credential vault. The local policy narrows the Forgejo token: use repositories=[] for every repository granted by the token, or an explicit owner/repo allowlist. Token scopes and Forgejo repository permissions remain the final authority.",
  inputSchema: z.object({
    name: z.string().regex(/^[a-zA-Z0-9_.-]+$/, "Use letters, digits, dots, underscores, or hyphens."),
    host: z.string().url(),
    credential: z.string().min(1).optional().describe("Forgejo personal access token or authorized-integration JWT. Avoid supplying this through a conversation; prefer credentialEnvVar."),
    credentialEnvVar: z.string().min(1).optional().describe("Name of an environment variable containing the credential. The value is stored in the OS credential vault and is never returned."),
    authType: z.enum(["token", "bearer"]).default("token"),
    repositories: z.array(z.string().regex(/^[^/]+\/[^/]+$/)).default([]),
    access: z.enum(["read", "write", "admin"]).default("write"),
    activate: z.boolean().default(true),
    allowHttp: z.boolean().default(false).describe("Only use for a trusted local development Forgejo instance.")
  })
}, async (input) => run(async () => {
  const host = normalizeHost(input.host, input.allowHttp);
  const credential = resolveCredential(input.credential, input.credentialEnvVar);
  const url = new URL("/api/v1/user", host);
  const verification = await fetch(url, { headers: { Authorization: input.authType === "bearer" ? `Bearer ${credential}` : `token ${credential}`, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!verification.ok) throw new Error(`Credential verification against ${url.origin}/api/v1/user failed (${verification.status}). Check the host, token, and its read:user scope.`);
  const account = await verification.json() as { login?: string };
  const saved = await upsertProfile({ name: input.name, host, authType: input.authType, repositories: [...new Set(input.repositories)], access: input.access }, credential, input.activate);
  return { configured: { ...saved, credentialStored: true }, authenticatedAs: account.login ?? "unknown" };
}));

server.registerTool("forgejo_permissions", {
  description: "List stored profile metadata, including the active profile and its local policy. Credentials are never returned.", inputSchema: z.object({})
}, async () => run(listProfiles));

server.registerTool("forgejo_update_permissions", {
  description: "Extend or narrow a saved profile's host, credential, repo allowlist, or local access ceiling. Replacing a Forgejo token is how its server-side scopes are extended or reduced.",
  inputSchema: z.object({ name: z.string().min(1), host: z.string().url().optional(), credential: z.string().min(1).optional(), credentialEnvVar: z.string().min(1).optional(), authType: z.enum(["token", "bearer"]).optional(), repositories: z.array(z.string().regex(/^[^/]+\/[^/]+$/)).optional(), access: z.enum(["read", "write", "admin"]).optional(), activate: z.boolean().optional(), allowHttp: z.boolean().default(false) })
}, async (input) => run(async () => {
  const host = input.host ? normalizeHost(input.host, input.allowHttp) : undefined;
  const credential = input.credential || input.credentialEnvVar ? resolveCredential(input.credential, input.credentialEnvVar) : undefined;
  const updated = await updateProfile(input.name, { host, authType: input.authType, repositories: input.repositories ? [...new Set(input.repositories)] : undefined, access: input.access ? validateAccess(input.access) : undefined }, credential, input.activate);
  return { updated: { ...updated, credentialStored: true } };
}));

server.registerTool("forgejo_revoke_permissions", {
  description: "Immediately delete a profile's local credential and policy metadata. Also revoke the corresponding access token or authorized integration in Forgejo if it might have been copied elsewhere.",
  inputSchema: z.object({ name: z.string().min(1) })
}, async ({ name }) => run(async () => { await revokeProfile(name); return { revoked: name }; }));

server.registerTool("forgejo_whoami", { description: "Verify the selected credential and return the Forgejo account it represents.", inputSchema: z.object({ profile }) }, async ({ profile: name }) => run(async () => (await client(name)).request("/user")));

server.registerTool("forgejo_list_repositories", {
  description: "List repositories visible to the selected Forgejo identity.", inputSchema: z.object({ profile, page: z.number().int().positive().default(1), limit: z.number().int().min(1).max(100).default(30) })
}, async ({ profile: name, page, limit }) => run(async () => (await client(name)).request("/user/repos", { query: { page, limit } })));

server.registerTool("forgejo_get_repository", { description: "Get repository metadata.", inputSchema: repo }, async ({ owner, repo: name, profile: selected }) => run(async () => (await client(selected)).request(repoPath(owner, name))));

server.registerTool("forgejo_create_repository", {
  description: "Create a repository under the authenticated user or an organization. An explicit repo allowlist must include the new owner/name.",
  inputSchema: z.object({ name: z.string().min(1), organization: z.string().min(1).optional(), description: z.string().optional(), private: z.boolean().default(true), autoInit: z.boolean().default(true), profile })
}, async ({ name, organization, description, private: isPrivate, autoInit, profile: selected }) => run(async () => {
  const c = await client(selected); const p = await import("./profiles.js"); const selectedProfile = await p.getProfile(selected);
  const owner = organization ?? (await c.request("/user") as { login: string }).login;
  assertPolicy(selectedProfile, "POST", repoPath(owner, name));
  return c.request(organization ? `/orgs/${encodeURIComponent(organization)}/repos` : "/user/repos", { method: "POST", body: { name, description, private: isPrivate, auto_init: autoInit }, approvedRepository: `${owner}/${name}` });
}));

server.registerTool("forgejo_list_files", {
  description: "List a directory or read a file from a repository. File content is returned by Forgejo base64-encoded.",
  inputSchema: repo.extend({ path: z.string().default(""), ref: z.string().optional() })
}, async ({ owner, repo: name, path, ref, profile: selected }) => run(async () => (await client(selected)).request(`${repoPath(owner, name)}/contents/${path.split("/").map(encodeURIComponent).join("/")}`, { query: { ref } })));

server.registerTool("forgejo_upsert_file", {
  description: "Create or update one UTF-8 repository file through Forgejo's Contents API. Specify newBranch to make the change on a new branch for a pull-request workflow.",
  inputSchema: repo.extend({ path: z.string().min(1), content: z.string(), message: z.string().min(1), branch: z.string().optional(), newBranch: z.string().optional(), expectedSha: z.string().optional() })
}, async ({ owner, repo: name, path, content, message, branch, newBranch, expectedSha, profile: selected }) => run(async () => {
  const c = await client(selected); const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  let sha = expectedSha;
  if (!sha) {
    try { const existing = await c.request(`${repoPath(owner, name)}/contents/${encodedPath}`, { query: { ref: branch } }) as { sha?: string }; sha = existing.sha; } catch (error) { if (!String((error as Error).message).includes("(404)")) throw error; }
  }
  return c.request(`${repoPath(owner, name)}/contents/${encodedPath}`, { method: "POST", body: { content: b64(content), message, branch, new_branch: newBranch, sha } });
}));

server.registerTool("forgejo_list_issues", { description: "List issues and pull requests in a repository.", inputSchema: repo.extend({ state: z.enum(["open", "closed", "all"]).default("open"), page: z.number().int().positive().default(1), limit: z.number().int().min(1).max(100).default(30) }) }, async ({ owner, repo: name, state, page, limit, profile: selected }) => run(async () => (await client(selected)).request(`${repoPath(owner, name)}/issues`, { query: { state, page, limit } })));

server.registerTool("forgejo_create_issue", { description: "Create a repository issue.", inputSchema: repo.extend({ title: z.string().min(1), body: z.string().default(""), labels: z.array(z.number().int()).default([]), assignees: z.array(z.string()).default([]) }) }, async ({ owner, repo: name, title, body, labels, assignees, profile: selected }) => run(async () => (await client(selected)).request(`${repoPath(owner, name)}/issues`, { method: "POST", body: { title, body, labels, assignees } })));

server.registerTool("forgejo_comment", { description: "Add a comment to an issue or pull request.", inputSchema: repo.extend({ index: z.number().int().positive(), body: z.string().min(1) }) }, async ({ owner, repo: name, index, body, profile: selected }) => run(async () => (await client(selected)).request(`${repoPath(owner, name)}/issues/${index}/comments`, { method: "POST", body: { body } })));

server.registerTool("forgejo_create_pull_request", { description: "Open a pull request, commonly after forgejo_upsert_file with newBranch.", inputSchema: repo.extend({ title: z.string().min(1), head: z.string().min(1), base: z.string().min(1), body: z.string().default(""), draft: z.boolean().default(false) }) }, async ({ owner, repo: name, title, head, base, body, draft, profile: selected }) => run(async () => (await client(selected)).request(`${repoPath(owner, name)}/pulls`, { method: "POST", body: { title, head, base, body, draft } })));

server.registerTool("forgejo_list_pull_requests", { description: "List pull requests in a repository.", inputSchema: repo.extend({ state: z.enum(["open", "closed", "all"]).default("open"), page: z.number().int().positive().default(1), limit: z.number().int().min(1).max(100).default(30) }) }, async ({ owner, repo: name, state, page, limit, profile: selected }) => run(async () => (await client(selected)).request(`${repoPath(owner, name)}/pulls`, { query: { state, page, limit } })));

server.registerTool("forgejo_read_action_logs", {
  description: "Read Forgejo Actions logs for a workflow run, or for one job in that run. Use this to diagnose failed pull-request checks. Requires Forgejo 16 or newer and repository read access; logs may contain sensitive output, so do not echo secrets into workflows.",
  inputSchema: repo.extend({ runId: z.number().int().positive().describe("The Action run ID, available from Forgejo's Actions page or API."), jobId: z.number().int().positive().optional().describe("Optional Action job ID. When omitted, returns the complete workflow-run log.") })
}, async ({ owner, repo: name, runId, jobId, profile: selected }) => run(async () => {
  const path = jobId
    ? `${repoPath(owner, name)}/actions/jobs/${jobId}/logs`
    : `${repoPath(owner, name)}/actions/runs/${runId}/logs`;
  return (await client(selected)).request(path, { responseType: "text" });
}));

server.registerTool("forgejo_review_pull_request", { description: "Submit an approve, request-changes, or comment review on a pull request.", inputSchema: repo.extend({ index: z.number().int().positive(), event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]), body: z.string().default("") }) }, async ({ owner, repo: name, index, event, body, profile: selected }) => run(async () => (await client(selected)).request(`${repoPath(owner, name)}/pulls/${index}/reviews`, { method: "POST", body: { event, body } })));

server.registerTool("forgejo_merge_pull_request", { description: "Merge a pull request. This is a write operation and Forgejo branch protection rules still apply.", inputSchema: repo.extend({ index: z.number().int().positive(), mergeStyle: z.enum(["merge", "rebase", "rebase-merge", "squash", "fast-forward-only"]).default("merge"), deleteBranchAfterMerge: z.boolean().default(false), mergeTitle: z.string().optional(), mergeMessage: z.string().optional() }) }, async ({ owner, repo: name, index, mergeStyle, deleteBranchAfterMerge, mergeTitle, mergeMessage, profile: selected }) => run(async () => (await client(selected)).request(`${repoPath(owner, name)}/pulls/${index}/merge`, { method: "POST", body: { Do: mergeStyle, delete_branch_after_merge: deleteBranchAfterMerge, merge_title_field: mergeTitle, merge_message_field: mergeMessage } })));

server.registerTool("forgejo_list_releases", { description: "List repository releases.", inputSchema: repo }, async ({ owner, repo: name, profile: selected }) => run(async () => (await client(selected)).request(`${repoPath(owner, name)}/releases`)));
server.registerTool("forgejo_create_release", { description: "Create a release for an existing tag.", inputSchema: repo.extend({ tagName: z.string().min(1), targetCommitish: z.string().optional(), name: z.string().optional(), body: z.string().default(""), draft: z.boolean().default(false), prerelease: z.boolean().default(false) }) }, async ({ owner, repo: name, tagName, targetCommitish, name: releaseName, body, draft, prerelease, profile: selected }) => run(async () => (await client(selected)).request(`${repoPath(owner, name)}/releases`, { method: "POST", body: { tag_name: tagName, target_commitish: targetCommitish, name: releaseName, body, draft, prerelease } })));

server.registerTool("forgejo_api_request", {
  description: "Escape hatch for Forgejo /api/v1 endpoints not covered by the focused tools. The selected profile's local policy checks HTTP method, admin level, and /repos/{owner}/{repo} allowlist before the request. Do not include /api/v1 in path or any credentials in body.",
  inputSchema: z.object({ path: z.string().regex(/^\/(?!\/)/), method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"), query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(), body: z.unknown().optional(), profile })
}, async ({ path, method, query, body, profile: selected }) => run(async () => (await client(selected)).request(path, { method, query, body })));

await server.connect(new StdioServerTransport());
