#!/usr/bin/env node
/**
 * Vendored packages: a read-only copy of a package another repository owns,
 * pinned to one of its commits. Each one has a `VENDORED.json` beside its
 * package.json naming the owner repository, the commit, the path there and a
 * digest of the copied files, so a local edit is caught in CI and a refresh
 * is one command.
 *
 *   node scripts/vendor.mjs check                      every vendored package matches its digest
 *   node scripts/vendor.mjs sync <package-dir> <owner-checkout> [commit]
 *                                                       copy the package from a checkout of its owner
 *
 * The digest is a SHA-256 over every file's path and bytes, in path order,
 * leaving out VENDORED.json, node_modules and dist.
 *
 * A pin may name `exclude`: top-level entries of the owner's package that are
 * not copied (its tests, its corpus). A pin with `testOnly: true` is a package
 * only this repository's tests use (the engine, to run real flows against
 * Connect): no package here may depend on it, and the API and size guards
 * leave it to its owner.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SKIP = new Set(["VENDORED.json", "node_modules", "dist"]);

function files(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files(path, out);
    else out.push(path);
  }
  return out;
}

export function treeDigest(dir) {
  const hash = createHash("sha256");
  for (const path of files(dir)) {
    const rel = relative(dir, path).split(sep).join("/");
    const bytes = readFileSync(path);
    hash.update(`${rel}\0${bytes.length}\0`);
    hash.update(bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

export function vendoredPackages() {
  const dir = join(ROOT, "packages");
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((path) => existsSync(join(path, "VENDORED.json")));
}

export function check() {
  const problems = [];
  for (const dir of vendoredPackages()) {
    const pin = JSON.parse(readFileSync(join(dir, "VENDORED.json"), "utf8"));
    const digest = treeDigest(dir);
    if (digest !== pin.digest) problems.push(`${relative(ROOT, dir)}: files changed since ${pin.repository}@${pin.commit.slice(0, 7)} (${digest} != ${pin.digest}); change it in ${pin.repository} and sync`);
  }
  return problems;
}

function sync(target, checkout, commit) {
  const pinPath = join(ROOT, target, "VENDORED.json");
  const pin = JSON.parse(readFileSync(pinPath, "utf8"));
  const source = join(checkout, pin.path);
  const head = commit ?? execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const keep = readFileSync(pinPath);
  // Everything but node_modules (pnpm's links) is replaced.
  for (const name of readdirSync(join(ROOT, target))) if (name !== "node_modules") rmSync(join(ROOT, target, name), { recursive: true, force: true });
  const exclude = new Set(pin.exclude ?? []);
  cpSync(source, join(ROOT, target), {
    recursive: true,
    filter: (src) => {
      const rel = relative(source, src).split(sep);
      return !rel.some((part) => part === "node_modules" || part === "dist") && !exclude.has(rel[0]);
    },
  });
  writeFileSync(pinPath, keep);
  const next = { ...pin, commit: head, digest: treeDigest(join(ROOT, target)) };
  writeFileSync(pinPath, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`${target}: ${pin.repository}@${head.slice(0, 7)} ${next.digest}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "check") {
    const problems = check();
    for (const p of problems) console.error(p);
    process.exit(problems.length === 0 ? 0 : 1);
  } else if (command === "sync" && args.length >= 2) {
    sync(args[0], args[1], args[2]);
  } else {
    console.error("usage: vendor.mjs check | sync <package-dir> <owner-checkout> [commit]");
    process.exit(2);
  }
}
