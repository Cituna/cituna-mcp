// One version number, four copies.
//
// WHY THIS EXISTS: a release is an `mcp-v*` tag, and publish-mcp.yml checks the
// tag against package.json and nothing else. tools.ts VERSION is what /healthz
// and the MCP handshake report, and it lagged package.json once already (fixed
// in mcp-v1.0.1). server.json is what the MCP registry lists. The lockfile sat
// at 1.2.0 through the whole 1.5.0 release. Nothing but this test holds them
// together.
//
// Run: cd mcp && npx tsx src/version.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { VERSION } from "./tools.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const json = (rel: string) => JSON.parse(readFileSync(resolve(HERE, rel), "utf8"));
const pkg = json("../package.json");
const server = json("../server.json");
const lock = json("../package-lock.json");

assert.equal(VERSION, pkg.version, "tools.ts VERSION lags package.json");
assert.equal(server.version, pkg.version, "server.json version lags package.json");
for (const p of server.packages ?? []) assert.equal(p.version, pkg.version, `server.json package ${p.identifier} lags package.json`);
assert.equal(lock.version, pkg.version, "package-lock.json lags package.json");
assert.equal(lock.packages?.[""]?.version, pkg.version, "package-lock.json root package lags package.json");
console.log(`  ✓ tools.ts, package.json, server.json and the lockfile all say ${pkg.version}`);
