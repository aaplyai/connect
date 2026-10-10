import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "./entries.js";

/**
 * A vendored package is a read-only copy of a package another repository
 * owns (see scripts/vendor.mjs). Its files must match the digest pinned in
 * its VENDORED.json: a change belongs in the owner repository, then a sync.
 */
describe("vendored packages", () => {
  it("match the commit they are pinned to", () => {
    expect(() => execFileSync(process.execPath, [join(ROOT, "scripts/vendor.mjs"), "check"], { encoding: "utf8", stdio: "pipe" })).not.toThrow();
  });
});
