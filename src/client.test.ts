import assert from "node:assert/strict";
import test from "node:test";
import { ForgejoClient } from "./client.js";

const testProfile = {
  name: "test",
  host: "https://forgejo.example.com",
  authType: "token" as const,
  repositories: ["acme/widget"],
  access: "read" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};

test("returns plain-text responses for action logs", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = async (input) => {
    requestedUrl = String(input);
    return new Response("build failed\\nexpected: green\\nreceived: red", { status: 200 });
  };

  try {
    const Client = ForgejoClient as unknown as new (selectedProfile: typeof testProfile, credential: string) => ForgejoClient;
    const client = new Client(testProfile, "credential");
    const logs = await client.request("/repos/acme/widget/actions/runs/42/logs", { responseType: "text" });
    assert.equal(logs, "build failed\\nexpected: green\\nreceived: red");
    assert.equal(requestedUrl, "https://forgejo.example.com/api/v1/repos/acme/widget/actions/runs/42/logs");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
