import test from "node:test";
import assert from "node:assert/strict";
import { assertPolicy, repoFromApiPath } from "./policy.js";

test("extracts repository names from API paths", () => {
  assert.equal(repoFromApiPath("/repos/acme/widget/issues"), "acme/widget");
  assert.equal(repoFromApiPath("/user/repos"), undefined);
});

test("allows only listed repositories", () => {
  const policy = { access: "write" as const, repositories: ["acme/widget"] };
  assert.doesNotThrow(() => assertPolicy(policy, "POST", "/repos/acme/widget/issues"));
  assert.throws(() => assertPolicy(policy, "POST", "/repos/acme/other/issues"), /outside this profile/);
});

test("blocks writes for a read-only profile and admin routes for a write profile", () => {
  assert.throws(() => assertPolicy({ access: "read", repositories: [] }, "PATCH", "/repos/acme/widget/issues/1"), /requires write/);
  assert.throws(() => assertPolicy({ access: "write", repositories: [] }, "DELETE", "/admin/users/1"), /requires admin/);
});
