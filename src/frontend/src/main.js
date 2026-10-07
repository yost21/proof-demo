import { HttpAgent } from "@icp-sdk/core/agent";
import { safeGetCanisterEnv } from "@icp-sdk/core/agent/canister-env";
import { Principal } from "@icp-sdk/core/principal";
import {
  MAINNET_ROOT_KEY_HEX,
  fetchAllEntries,
  hexToBytes,
  makeActor,
  parseMethods,
  readCanisterFacts,
  verifyAll,
} from "./chain.js";

const $ = (id) => document.getElementById(id);

const host = location.hostname;
const isLocal = host === "localhost" || host === "127.0.0.1" || host.endsWith(".localhost");
const env = safeGetCanisterEnv();

// On mainnet the root key is the IC's published key, compiled into this page.
// On a local replica it comes from the ic_env cookie (the replica's own throwaway key).
const rootKey = isLocal ? env?.IC_ROOT_KEY : hexToBytes(MAINNET_ROOT_KEY_HEX);
const canisterIdText = env?.["PUBLIC_CANISTER_ID:service_proof"];

let agent;
let actor;
let canisterId;
let entries = [];
let tampered = null; // a locally edited copy of `entries`, or null

const METHOD_ROLE = {
  recordVisit: ["append", "add one visit · allowlisted callers"],
  addRecorder: ["allowlist", "controllers only"],
  revokeRecorder: ["allowlist", "controllers only · entries untouched"],
};

function short(text, head = 10, tail = 6) {
  return text.length > head + tail + 1 ? `${text.slice(0, head)}…${text.slice(-tail)}` : text;
}

function icTime(ns) {
  return new Date(Number(ns / 1_000_000n)).toISOString().replace(/\.\d+Z$/, "Z");
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function renderVisits() {
  const list = tampered ?? entries;
  const ol = $("visits");
  ol.replaceChildren();
  $("visit-count").textContent = `${list.length} · newest first`;
  for (const e of [...list].reverse()) {
    const i = Number(e.index);
    const li = el("li", "plate visit");
    li.dataset.index = String(i);
    if (tampered && tampered[i] !== entries[i]) li.classList.add("edited");

    const top = el("div", "visit-top");
    top.append(el("span", "visit-index mono", `#${i}`), el("span", "visit-wo mono", e.workOrderId));
    li.append(top);
    li.append(el("p", "visit-serial", e.equipmentSerial));

    const meta = el("dl", "visit-meta");
    const row = (k, v, cls = "") => {
      meta.append(el("dt", "mono", k), el("dd", cls, v));
    };
    row("tech", e.techId, "mono");
    row("completed", e.completedAt, "mono");
    row("parts", short(e.partsHash, 12, 6), "mono");
    row("on chain", icTime(e.recordedAt), "mono");
    row("by", short(e.recordedBy.toText(), 11, 3), "mono");
    li.append(meta);

    li.append(el("p", "hash-label mono", "entry hash"));
    li.append(el("p", "hash mono", e.entryHash));
    li.append(el("p", "prev mono", `prev ${short(e.prevHash, 12, 6)}`));
    if (li.classList.contains("edited")) li.append(el("p", "edited-flag mono", "edited in this browser"));
    ol.append(li);
  }
}

function renderResult(result) {
  const stamp = $("stamp");
  stamp.hidden = false;
  stamp.className = `stamp ${result.pass ? "pass" : "fail"}`;
  stamp.textContent = result.pass ? "PASS" : "FAIL";
  const ol = $("steps");
  ol.replaceChildren();
  for (const s of result.steps) {
    const li = el("li", s.ok ? "ok" : "bad");
    li.append(el("span", "mark", s.ok ? "✓" : "✗"));
    const body = el("div", "step-body");
    body.append(el("p", "step-label", s.label), el("p", "step-detail mono", s.detail));
    li.append(body);
    ol.append(li);
  }
  document.querySelectorAll(".visit.fail").forEach((n) => n.classList.remove("fail"));
  if (result.failedAt !== null && result.failedAt !== undefined) {
    document.querySelector(`.visit[data-index="${result.failedAt}"]`)?.classList.add("fail");
  }
}

async function runVerify() {
  const btn = $("verify");
  btn.disabled = true;
  btn.textContent = "Verifying…";
  $("stamp").hidden = true;
  $("steps").replaceChildren();
  try {
    if (!tampered) {
      entries = await fetchAllEntries(actor);
      renderVisits();
    }
    const result = await verifyAll({ actor, agent, canisterId, rootKey, entries: tampered ?? entries });
    renderResult(result);
  } catch (err) {
    renderResult({ pass: false, steps: [{ ok: false, label: "Verification error", detail: String(err?.message ?? err) }] });
  } finally {
    btn.disabled = false;
    btn.textContent = "Verify";
  }
}

function backdate(text) {
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) return `${text}*`;
  d.setUTCDate(d.getUTCDate() - 3);
  return d.toISOString().replace(".000Z", "Z");
}

async function simulateTamper() {
  if (entries.length === 0) return;
  const target = Math.min(2, entries.length - 1);
  tampered = entries.map((e, i) => (i === target ? { ...e, completedAt: backdate(e.completedAt) } : e));
  $("tamper").hidden = true;
  $("untamper").hidden = false;
  $("tamper-hint").textContent = `Entry #${target}'s completion date moved back 3 days in this browser. The canister still holds the original.`;
  renderVisits();
  await runVerify();
}

async function undoTamper() {
  tampered = null;
  $("tamper").hidden = false;
  $("untamper").hidden = true;
  $("tamper-hint").textContent = "Changes one entry in this browser only, then verifies. The canister is never touched.";
  renderVisits();
  await runVerify();
}

async function renderInterface() {
  try {
    const facts = await readCanisterFacts(agent, canisterId);
    $("module-hash").textContent = facts.moduleHash ?? "unavailable";
    const methods = parseMethods(facts.candid);
    const ul = $("methods");
    ul.replaceChildren();
    for (const m of methods) {
      const [role, note] = METHOD_ROLE[m.name] ?? ["read", "query · anyone"];
      const li = el("li", `method role-${role}`);
      li.append(el("span", "method-name mono", m.name), el("span", "method-role mono", role));
      li.append(el("span", "method-note", note));
      ul.append(li);
    }
  } catch (err) {
    $("methods").replaceChildren(el("li", "muted", `could not read candid: ${err?.message ?? err}`));
  }
}

async function main() {
  $("network").textContent = isLocal ? "SERVICE PROOF · LOCAL REPLICA" : "SERVICE PROOF · IC MAINNET";
  if (!canisterIdText || !rootKey) {
    $("canister").textContent = "canister: not configured (ic_env cookie missing)";
    return;
  }
  canisterId = Principal.fromText(canisterIdText);
  $("canister").textContent = `canister ${canisterIdText}`;
  agent = await HttpAgent.create({ host: isLocal ? location.origin : "https://icp-api.io", rootKey });
  actor = makeActor(agent, canisterId);

  $("verify").addEventListener("click", runVerify);
  $("tamper").addEventListener("click", simulateTamper);
  $("untamper").addEventListener("click", undoTamper);

  await Promise.all([
    renderInterface(),
    fetchAllEntries(actor).then((list) => {
      entries = list;
      renderVisits();
    }),
  ]);
}

main();
