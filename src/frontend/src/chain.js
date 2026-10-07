// Verification logic shared by the browser page and scripts/verify.mjs.
//
// Three independent checks, all done on the client:
//   1. The certificate returned by getCertifiedHead carries a valid BLS signature from
//      the subnet, chained to the Internet Computer root key, and is fresh (≤5 min).
//   2. The certificate's certified_data for this canister equals the head hash.
//   3. Re-hashing every listed entry from the genesis hash reproduces that head hash,
//      and every stored entryHash / prevHash link matches.
// If anyone changed, removed, reordered or inserted a past entry, check 3 fails.

import { Actor, Certificate, lookupResultToBuffer, StatePaths } from "@icp-sdk/core/agent";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { idlFactory } from "./bindings/declarations/service_proof.did.js";

export const GENESIS = "0".repeat(64);
export const PAGE = 100n;

// IC mainnet root public key (DER). Used on mainnet instead of anything the page is served with.
export const MAINNET_ROOT_KEY_HEX =
  "308182301d060d2b0601040182dc7c0503010201060c2b0601040182dc7c05030201036100814c0e6ec71fab583b08bd81373c255c3c371b2e84863c98a4f1e08b74235d14fb5d9c0cd546d9685f913a0c0b2cc5341583bf4b4392e467db96d65b9bb4cb717112f8472e0d5a4d14505ffd7484b01291091c5f87b98883463f98091a0baaae";

export function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function makeActor(agent, canisterId) {
  return Actor.createActor(idlFactory, { agent, canisterId });
}

// The exact preimage the canister hashes (see src/backend/main.mo).
export function preimage(e, prevHash) {
  return [
    "service-proof/v1",
    prevHash,
    e.index.toString(),
    e.workOrderId,
    e.equipmentSerial,
    e.techId,
    e.partsHash,
    e.completedAt,
    e.recordedBy.toText(),
    e.recordedAt.toString(),
  ].join("\n");
}

export function hashEntry(e, prevHash) {
  return bytesToHex(sha256(new TextEncoder().encode(preimage(e, prevHash))));
}

export async function fetchAllEntries(actor) {
  const total = await actor.count();
  const all = [];
  for (let offset = 0n; offset < total; offset += PAGE) {
    all.push(...(await actor.list(offset, PAGE)));
  }
  return all;
}

// Check 3: recompute the chain. Returns { ok, head, failedAt, reason }.
export function checkChain(entries) {
  let prev = GENESIS;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.index !== BigInt(i)) return { ok: false, head: prev, failedAt: i, reason: `entry #${i} is out of order` };
    if (e.prevHash !== prev) return { ok: false, head: prev, failedAt: i, reason: `entry #${i} does not link to the entry before it` };
    const h = hashEntry(e, prev);
    if (h !== e.entryHash) return { ok: false, head: prev, failedAt: i, reason: `entry #${i}: its fields no longer match its hash` };
    prev = h;
  }
  return { ok: true, head: prev, failedAt: null, reason: null };
}

function leb128(bytes) {
  let result = 0n;
  let shift = 0n;
  for (const b of bytes) {
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7n;
  }
  return result;
}

// Checks 1 + 2. Throws if the certificate is forged, stale, or for another canister.
export async function verifyCertifiedHead({ head, canisterId, rootKey, agent }) {
  const certBytes = head.certificate[0];
  if (!certBytes) throw new Error("no certificate returned (was this called as a query?)");
  const cert = await Certificate.create({
    certificate: certBytes,
    rootKey,
    principal: { canisterId },
    maxAgeInMinutes: 5,
    agent,
  });
  const certified = lookupResultToBuffer(
    cert.lookup_path(["canister", canisterId.toUint8Array(), "certified_data"]),
  );
  if (!certified) throw new Error("certificate holds no certified data for this canister");
  const certifiedHex = bytesToHex(certified);
  const timeBytes = lookupResultToBuffer(cert.lookup_path(["time"]));
  const signedAt = timeBytes ? new Date(Number(leb128(timeBytes) / 1_000_000n)) : null;
  return { certifiedHex, matchesHead: certifiedHex === head.headHash, signedAt };
}

// Full run used by both clients. `entries` may be supplied (e.g. a tampered copy).
export async function verifyAll({ actor, agent, canisterId, rootKey, entries }) {
  const head = await actor.getCertifiedHead();
  const steps = [];
  let cert;
  try {
    cert = await verifyCertifiedHead({ head, canisterId, rootKey, agent });
    steps.push({ ok: true, label: "Certificate signed by the IC", detail: `BLS signature valid · signed ${cert.signedAt?.toISOString() ?? "?"}` });
  } catch (err) {
    steps.push({ ok: false, label: "Certificate signed by the IC", detail: String(err?.message ?? err) });
    return { pass: false, head, steps };
  }
  steps.push({
    ok: cert.matchesHead,
    label: "Certified head = head hash",
    detail: cert.matchesHead ? cert.certifiedHex : `certified ${cert.certifiedHex} ≠ returned ${head.headHash}`,
  });
  const list = entries ?? (await fetchAllEntries(actor));
  const chain = checkChain(list);
  const countOk = BigInt(list.length) === head.count;
  const chainOk = chain.ok && countOk && chain.head === cert.certifiedHex;
  steps.push({
    ok: chainOk,
    label: `Re-hashed ${list.length} entries`,
    detail: !chain.ok
      ? chain.reason
      : !countOk
        ? `listed ${list.length} entries, certified head covers ${head.count}`
        : chainOk
          ? `chain ends at ${chain.head}`
          : `chain ends at ${chain.head}, certified head is ${cert.certifiedHex}`,
    failedAt: chain.failedAt,
  });
  return { pass: steps.every((s) => s.ok), head, steps, failedAt: chain.failedAt };
}

export async function readCanisterFacts(agent, canisterId) {
  const moduleHash = StatePaths.canisterModuleHash(canisterId);
  const candid = StatePaths.canisterCandid(canisterId);
  const res = await agent.readState({ canisterId }, { paths: [moduleHash, candid] });
  const mh = res.values.get(moduleHash);
  return { moduleHash: mh ? bytesToHex(mh) : null, candid: res.values.get(candid) };
}

// Pull method names + signatures out of the canister's on-chain candid:service text.
export function parseMethods(candidText) {
  if (!candidText) return [];
  const noComments = candidText.replace(/\/\/[^\n]*/g, "");
  const service = noComments.slice(noComments.indexOf("service"));
  const body = service.slice(service.indexOf("{") + 1, service.lastIndexOf("}")).replace(/\s+/g, " ");
  const re = /([A-Za-z_][\w]*)\s*:\s*\(([^)]*)\)\s*->\s*\(([^)]*)\)\s*(query|composite_query)?\s*;/g;
  const out = [];
  for (const m of body.matchAll(re)) {
    out.push({ name: m[1], args: m[2].trim(), ret: m[3].trim(), query: Boolean(m[4]) });
  }
  return out;
}
