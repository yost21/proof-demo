#!/usr/bin/env node
// Independent verifier: the same three checks the page runs, from a terminal.
// Trusts nothing served by the frontend canister.
//
//   node scripts/verify.mjs            # local replica
//   node scripts/verify.mjs ic         # mainnet (uses the IC root key compiled into chain.js)
//   node scripts/verify.mjs local --tamper 2   # edit entry #2 in memory first → expect FAIL
//
// Needs `npm --prefix src/frontend ci && npm --prefix src/frontend run build` once
// (for node_modules and the generated Candid bindings).
import { execSync } from "node:child_process";
import { HttpAgent } from "../src/frontend/node_modules/@icp-sdk/core/lib/esm/agent/index.js";
import { Principal } from "../src/frontend/node_modules/@icp-sdk/core/lib/esm/principal/index.js";
import {
  MAINNET_ROOT_KEY_HEX,
  fetchAllEntries,
  hexToBytes,
  makeActor,
  verifyAll,
} from "../src/frontend/src/chain.js";

const env = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "local";
const tamperIdx = process.argv.indexOf("--tamper");
const tamperAt = tamperIdx > 0 ? Number(process.argv[tamperIdx + 1]) : null;

const sh = (cmd) => execSync(cmd, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const canisterId = Principal.fromText(sh(`icp canister status service_proof -e ${env} -i`));

let host;
let rootKey;
if (env === "ic") {
  host = "https://icp-api.io";
  rootKey = hexToBytes(MAINNET_ROOT_KEY_HEX);
} else {
  const net = JSON.parse(sh(`icp network status -e ${env} --json`));
  host = net.api_url;
  rootKey = hexToBytes(net.root_key);
}

const agent = await HttpAgent.create({ host, rootKey });
const actor = makeActor(agent, canisterId);

let entries = await fetchAllEntries(actor);
if (tamperAt !== null) {
  const backdate = (t) => {
    const d = new Date(t);
    if (Number.isNaN(d.getTime())) return `${t}*`;
    d.setUTCDate(d.getUTCDate() - 3);
    return d.toISOString().replace(".000Z", "Z");
  };
  entries = entries.map((e, i) => (i === tamperAt ? { ...e, completedAt: backdate(e.completedAt) } : e));
  console.log(`(tampered entry #${tamperAt} in memory: completedAt → ${entries[tamperAt].completedAt})`);
}

const result = await verifyAll({ actor, agent, canisterId, rootKey, entries });
console.log(`canister  ${canisterId.toText()}  (${env})`);
console.log(`entries   ${result.head.count}`);
console.log(`head      ${result.head.headHash}`);
for (const s of result.steps) console.log(`${s.ok ? "✓" : "✗"} ${s.label}\n    ${s.detail}`);
console.log(result.pass ? "\nPASS" : "\nFAIL");
process.exit(result.pass ? 0 : 1);
