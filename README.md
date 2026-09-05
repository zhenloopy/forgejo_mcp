# Forgejo MCP

A policy-aware [Model Context Protocol](https://modelcontextprotocol.io/) server that lets an agent work with a Forgejo instance without repeatedly handling credentials.

It provides normal Forgejo workflows—repositories, files, issues, comments, pull requests and reviews, releases—and a guarded `forgejo_api_request` escape hatch for the rest of the `/api/v1` surface.

## Authorization model

Authorization has two independent layers:

1. **Forgejo authority**: a personal access token (PAT) or short-lived Authorized Integration JWT. Forgejo evaluates its scopes, membership and branch protections for every API call.
2. **Local MCP policy**: each named profile has a `read`, `write`, or `admin` ceiling and an optional `owner/repository` allowlist. The MCP rejects anything outside it before sending a request.

Profiles are stored in `~/.config/forgejo-mcp/profiles.json`; that file contains only metadata. The credential is stored in the operating system credential vault through Keytar (Windows Credential Manager, macOS Keychain, or the Linux secret service). The server never returns credentials in tool output.

Forgejo's current scoped-token model supports permissions such as `read:user`, `read:repository`, `write:repository`, `read:issue`, and `write:issue`; newer Forgejo releases can also restrict access tokens to specific repositories. Create the token with only the scopes the intended workflow needs. Forgejo's own permissions are always the final authority.

For an MCP agent, a PAT is generally the simplest option. If this runs in a CI or supported identity environment, use Forgejo **Authorized Integrations** with a short-lived JWT instead of a long-lived secret.

## Install and run

```powershell
npm install
npm run build
node dist/index.js
```

Example MCP client configuration after building:

```json
{
  "mcpServers": {
    "forgejo": {
      "command": "node",
      "args": ["C:/absolute/path/to/forgejo-mcp/dist/index.js"]
    }
  }
}
```

Do not paste a production token into an agent conversation. Prefer passing it as a process environment variable, then have the first agent call `forgejo_configure` with only the variable name:

```toml
# ~/.codex/config.toml — the secret itself stays in the parent environment.
[mcp_servers.forgejo]
command = "node"
args = ["C:/absolute/path/to/forgejo-mcp/dist/index.js"]
env_vars = ["FORGEJO_MCP_BOOTSTRAP_TOKEN"]
```

```json
{
  "name": "work",
  "host": "https://forgejo.example.com",
  "credentialEnvVar": "FORGEJO_MCP_BOOTSTRAP_TOKEN",
  "authType": "token",
  "access": "write",
  "repositories": ["acme/widget"],
  "activate": true
}
```

After successful configuration, remove that environment variable and restart the client; the credential remains in the OS vault. Direct `credential` input remains available only for trusted, non-conversational setup automation.

For reference, a direct setup payload looks like this:

```json
{
  "name": "work",
  "host": "https://forgejo.example.com",
  "credential": "<a scoped Forgejo PAT>",
  "authType": "token",
  "access": "write",
  "repositories": ["acme/widget"],
  "activate": true
}
```

`repositories: []` means “all repositories already permitted by the Forgejo credential.” HTTPS is required by default; `allowHttp` exists solely for a trusted local test server.

Use `FORGEJO_MCP_PROFILE=name` to pick a profile per process, or select one with `activate: true` during configuration.

## Permission lifecycle

- `forgejo_permissions` shows profiles and their local policies, never secrets.
- `forgejo_update_permissions` changes the local allowlist/ceiling, changes host, activates a profile, or replaces a token/JWT. Replacing the credential is the way to change Forgejo-side token scopes.
- `forgejo_revoke_permissions` deletes the local vault entry and profile metadata immediately. Revoke the corresponding PAT or Authorized Integration in the Forgejo UI too, in case it was copied elsewhere.

## Included tools

| Area | Tools |
| --- | --- |
| Setup and safety | `forgejo_configure`, `forgejo_permissions`, `forgejo_update_permissions`, `forgejo_revoke_permissions`, `forgejo_whoami` |
| Repositories | `forgejo_list_repositories`, `forgejo_get_repository`, `forgejo_create_repository` |
| Files and changes | `forgejo_list_files`, `forgejo_upsert_file` |
| Issues | `forgejo_list_issues`, `forgejo_create_issue`, `forgejo_comment` |
| Pull requests | `forgejo_create_pull_request`, `forgejo_list_pull_requests`, `forgejo_review_pull_request`, `forgejo_merge_pull_request` |
| CI diagnostics | `forgejo_read_action_logs` |
| Releases | `forgejo_list_releases`, `forgejo_create_release` |
| Additional API coverage | `forgejo_api_request` |

The normal agent flow for a small code change is `forgejo_upsert_file` with `newBranch`, then `forgejo_create_pull_request`, followed by an optional review and merge. All write operations still require both the local policy and appropriate Forgejo token/repository permission.

For a failed pull-request check, call `forgejo_read_action_logs` with the repository and the Action run ID. Passing a `jobId` returns only that job's log. Forgejo added these log APIs in version 16, so earlier instances return an API error instead.

## Development

```powershell
npm run build
npm test
```

The unit tests cover the local policy guard. Integration testing can be run against any Forgejo instance with a dedicated low-privilege test token.
