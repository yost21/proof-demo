# service-proof

An Internet Computer demo of an equipment service log that nobody can quietly change. Built to be filmed.

**What it does:** a technician's system calls `recordVisit` and gets back a receipt. Every visit is stored with the hash of the visit before it, so the visits form a hash chain. After each write, the canister publishes the newest hash to the subnet's certified state. The web page then checks three things in the viewer's own browser:

1. The subnet signed the certificate, and the signature chains to the Internet Computer root key.
2. The certified hash in that certificate matches the head hash the canister returned.
3. Re-hashing every visit from the start reproduces that head hash.

If any past field had been edited, deleted, reordered or inserted, check 3 fails. The canister has no method that edits or deletes a visit.

All data is fake: serials like `MRI-DEMO-0001`, techs like `TECH-07`, and hashes of invented part lists.

| | |
|---|---|
| Entity | Earthside Labs LLC (demo / media asset) |
| Status | **Local replica only.** Never deployed to mainnet. |
| Compiler | **moc 2.0.0** (released 2026-10-06), pinned in `mops.toml`. It fixes bug #6432, in which an upgrade that dropped one stable variable and added another could pass the runtime check and lose the dropped value. |
| Libraries | core 2.5.0, sha2 0.2.5, locked file by file in `mops.lock` |
| Frontend | Vite 8, `@icp-sdk/core` 6.1, `@icp-sdk/bindgen` 0.4.1 |
| Module hash (canonical build) | `fe389a3e5ea837250c5187b4c70bfed17c09ca7a9958cc8d8b0f14b01e97765f` |

---

## The interface (all of it)

This is read from the canister's on-chain `candid:service` metadata. The page shows the same list.

```candid
service : {
  addRecorder:      (p: principal) -> ();                               // controllers only
  count:            () -> (nat) query;
  getCertifiedHead: () -> (CertifiedHead) query;                        // head hash + subnet certificate
  getEntry:         (index: nat) -> (opt Entry) query;
  list:             (offset: nat, limit: nat) -> (vec Entry) query;     // ≤100 per call
  recordVisit:      (workOrderId: text, equipmentSerial: text, techId: text,
                     partsHash: text, completedAt: text) -> (Receipt);  // allowlisted callers
  revokeRecorder:   (p: principal) -> ();                               // controllers only; entries untouched
}
```

- **No method edits or deletes an entry.** `revokeRecorder` only removes a principal from the writer allowlist. It is there because access you grant should be revocable. If you want the on-camera list to be a pure append-or-read story, it can be cut; controllers can still change the allowlist by upgrading the code.
- **Who can write:** the canister's controllers, plus principals a controller adds with `addRecorder`. The anonymous principal is always rejected, both as a caller and as an `addRecorder` argument.
- **Input limits:** each field must be 1–128 bytes with no line breaks. That keeps storage bounded and makes the hash encoding unambiguous.
- `inspect_message` rejects writes from callers who aren't allowed, before their arguments are decoded. This only saves cycles. The real checks run inside every method, and were tested by calling through a proxy canister, which skips `inspect_message`.

### Hash rule

`entryHash = sha256` of these lines, joined by `\n`:

```
service-proof/v1
<prevHash — 64 hex chars; 64 zeros for entry #0>
<index>
<workOrderId>
<equipmentSerial>
<techId>
<partsHash>
<completedAt>
<recordedBy — caller principal, text form>
<recordedAt — IC time in nanoseconds>
```

The same rule is implemented three times: in Motoko (`src/backend/main.mo`), in the browser (`src/frontend/src/chain.js`) and in the terminal verifier (`scripts/verify.mjs`, which reuses `chain.js`). The canister writes the newest `entryHash` as raw 32 bytes with `CertifiedData.set`. Certified data is cleared on every install and upgrade, so the actor body re-publishes it each time.

---

## What a PASS proves, and what it doesn't

Say this carefully on camera.

- **It proves** the subnet vouches for the head hash, and that the visits on screen hash exactly to it. A lying replica, a tampered page cache or an edited row fails the check.
- **It does not prove** that a controller never upgraded the code. A controller could ship new code that rewrites history and recomputes the whole chain, and a fresh Verify would still PASS. Three things stop that from being quiet:
  1. Every code install, upgrade or reinstall is recorded in the canister's public history (the IC keeps each change with its **module hash**). A reinstall of the *same* module wipes state without changing the hash, so watch the history, not just the hash.
  2. Every **receipt** issued before the rewrite stops matching. Anyone holding an old `entryHash` or head hash can see the change.
  3. The upgrade runtime **rejects** new code that would drop or retype stored data (tested below). This protects the data's shape. It does not stop a controller from adding new methods.
- So the honest line is **"nobody can change it quietly."** That is different from "nobody can ever change it." To get "never", remove all controllers or hand control to a DAO after launch. That is a separate decision for the operator.

---

## Run it locally

Prerequisites, already on this Mac: `icp` 0.2.2, `mops`, `ic-wasm` 0.9.10, Node 24. `export DFX_MOC_PATH=moc-wrapper` is already in `~/.zshrc`. mops refuses `toolchain bin` without it.

```bash
cd ~/proof-demo
icp network start -d          # project-local replica on http://localhost:8040 (not 8000)
icp deploy -y                 # builds both canisters (frontend: npm ci + vite build) and uploads assets
./scripts/seed.sh             # records the 6 fake visits
node scripts/verify.mjs       # the same three checks from the terminal → PASS
node scripts/verify.mjs local --tamper 2   # edits entry #2 in memory → FAIL (expected)
open http://frontend.local.localhost:8040/ # or http://<frontend-id>.localhost:8040/
icp network stop              # when done
```

Useful calls:

```bash
icp canister call service_proof count '()' --query
icp canister call service_proof getEntry '(0)' --query
icp canister call service_proof getCertifiedHead '()' --query   # --query is required to get a certificate
icp canister metadata service_proof candid:service             # the interface, read from the chain
icp canister status service_proof                              # module hash, controllers
```

The local replica belongs to this project and runs on its own port, 8040. **Its state does not survive `icp network stop`:** after every `icp network start -d`, run `icp deploy -y` and then `./scripts/seed.sh` again. The canister IDs come back the same (`t63gs-up777-77776-aaaba-cai` for `service_proof`), but the `recordedAt` times and therefore every hash will be new.

---

## Local test results (2026-10-06, local replica on :8040)

| Test | Result |
|---|---|
| Seed 6 visits → `node scripts/verify.mjs` | **PASS** (certificate valid, certified head = head hash, 6 entries re-hash to it) |
| Browser Verify (375 px mobile viewport) | **PASS**. "Simulate a backdated record" → **FAIL** at entry #2; Undo → **PASS** |
| Terminal tamper test (`--tamper 0`, `2`, `4`, `5`) | **FAIL** at the edited entry (expected) |
| Rewrite entry #2 *and* recompute every hash after it (a chain that is consistent on its own) | **FAIL**: chain ends at `8d88…`, but the certified head is `4f2c…` |
| Verify with the wrong root key (mainnet key against the local replica) | **FAIL** at step 1: BLS signature invalid |
| Anonymous / non-allowlisted caller → `recordVisit` | Rejected |
| Call through a proxy canister (skips `inspect_message`) | Rejected inside the method: "caller is not an allowed recorder" |
| Non-controller → `addRecorder` | Rejected: "only a controller can change the recorder allowlist" |
| Controller → `addRecorder(anonymous)` | Rejected |
| `addRecorder(B)` → B records → `revokeRecorder(B)` → B rejected | Works (run on the earlier moc 1.3.0 build, then the canister was reinstalled clean) |
| 129-byte field / field with a line break | Rejected |
| **Upgrade with a compatible code change** (field limit 128→160) | **Accepted.** 6 entries and head hash preserved, verify PASS, module hash changed to `46182b20…` |
| **Upgrade that renames a stable variable** (`recorders`→`allowlist`, the #6432 drop+add case) | **Rejected:** `RTS error: Memory-incompatible program upgrade`. Old module and data untouched |
| **Upgrade that changes a stored type** (adds a required field to stored `Entry` records) | **Rejected**, same error; data untouched |
| Upgrade from the moc 1.3.0 build to the moc 2.0.0 build (3 stable constants became `transient`) | **Rejected**, same error. Demo canister was then reinstalled clean on moc 2.0.0 |
| Restore canonical source → upgrade | Module hash back to exactly `fe389a3e…765f`; verify PASS |
| `scripts/build-wasm.sh` (outside icp-cli) | sha256 `fe389a3e…765f`, equal to the deployed module hash |

To repeat an upgrade test: edit `src/backend/main.mo`, run `icp deploy service_proof --mode upgrade -y`, check `count` and `node scripts/verify.mjs`, then restore the file (`git checkout` once this is a repo) and upgrade again.

---

## Reproducible build

```bash
./scripts/build-wasm.sh
# moc:     Motoko compiler 2.0.0 (source af4cbaqi-d501kjgh-2sgjc78a-a87f0j5x)
# ic-wasm: ic-wasm 0.9.10
# wasm:    build/service_proof.wasm (446484 bytes)
# sha256:  fe389a3e5ea837250c5187b4c70bfed17c09ca7a9958cc8d8b0f14b01e97765f
```

- The script runs the same four steps as the pinned `@dfinity/motoko@v4.1.0` recipe: compile with moc, then use `ic-wasm` to add the `moc:version`, `template:type` and public `candid:service` metadata. The recipe does **not** gzip, so the IC module hash is the plain `sha256` of the raw `.wasm`.
- Pinned inputs: `mops.toml` (moc 2.0.0, core 2.5.0, sha2 0.2.5) + `mops.lock` (per-file hashes; the script runs `mops install --lock check`), `ic-wasm 0.9.10`, `src/backend/main.mo`, `src/backend/service_proof.did`.
- Anyone can rebuild from the same commit and compare the result to the dashboard's "Module hash". The `reproducible-build` GitHub Actions workflow rebuilds the wasm on a clean Linux runner on every push and fails unless its sha256 equals the pinned hash. Note: `moc --version` carries a platform-specific "(source …)" id; the build embeds the version without it, so Mac and Linux builds produce identical bytes.
- Frontend: the asset canister runs the stock DFINITY `assetstorage.wasm.gz` 0.30.2 (module hash `63d122d0…5bb6`). The page itself is certified asset content.

---

## Mainnet deploy

> It spends real ICP and creates permanent public canisters. Anything recorded on mainnet stays forever. There is no delete, and wiping it by reinstalling shows up in the canister's public history. **Expected cost**, measured locally (each canister used ~0.52 T cycles for creation, install and asset upload; idle burn is ~0.2 B cycles/day for both canisters together):

| Item | Cycles |
|---|---|
| Create 2 canisters (0.5 T creation fee each) | 1.0 T |
| Install + asset upload + seed calls | ~0.05 T |
| Working balance left in the canisters (years of idle burn at ~6 B/month) | ~0.95 T |
| **Total with `--cycles 1t` per canister** | **≈ 2 T cycles ≈ 2 XDR ≈ $2.70 ≈ 0.85 ICP** (at the 2.384 T cycles/ICP rate noted 2026-10-01; re-check the rate first) |
| Total with icp-cli's default (2 T per canister) | ≈ 4 T cycles ≈ $5.40 ≈ 1.7 ICP |

**Steps:**

```bash
cd ~/proof-demo
export DFX_MOC_PATH=moc-wrapper
icp identity default                    # confirm the intended controller identity (do not create/switch without deciding)
icp identity principal
icp cycles balance -n ic                # need ≥ 2.1 T cycles
# only if short:
# icp cycles mint --cycles 2.2t -n ic

./scripts/build-wasm.sh                 # note the sha256; it must match after deploy
icp deploy -e ic --cycles 1t            # creates service_proof + frontend, installs, uploads assets
git add .icp/data/ && git commit -m "mainnet canister ids"   # .icp/data/mappings/ic.ids.json — never lose this

# safety settings for the canister that holds the record
icp canister settings update service_proof --freezing-threshold 7776000 -e ic   # 90 days
icp canister settings update service_proof --add-controller <BACKUP_PRINCIPAL> -e ic  # backup controller, if you have one

ICP_ENVIRONMENT=ic ./scripts/seed.sh    # optional: the same 6 fake visits (permanent)
node scripts/verify.mjs ic              # verifies against the hardcoded IC mainnet root key
icp canister status service_proof -e ic # module hash must equal the build-wasm.sh sha256
```

Then open `https://<frontend-id>.icp0.io/` and `https://dashboard.internetcomputer.org/canister/<service_proof-id>`.

On mainnet the page verifies against the IC root key compiled into the page (`MAINNET_ROOT_KEY_HEX` in `chain.js`), not a key the server sends. Raw (uncertified) asset access is disabled in `.ic-assets.json5`.

---

## Shot list (screen capture)

Browser window at phone width (375–430 px) and 100% zoom. Terminal font ≥ 20 pt.

1. **Record.** Terminal: one `icp canister call service_proof recordVisit '("WO-DEMO-1007", "CT-DEMO-0002", "TECH-07", "sha256:…", "2026-10-06T14:00:00Z")'`. Hold on the call going out.
2. **Receipt.** The returned `record { index; entryHash; prevHash; recordedBy; recordedAt }`. Zoom on `entryHash`, then cut to the browser, where the same hash sits on the newest card. The card's `prev` equals the previous card's entry hash: that's the chain.
3. **Verify → PASS.** Tap VERIFY. The green PASS stamp appears, followed by three lines: certificate signed by the IC, certified head = head hash, re-hashed N entries.
4. **Tamper → FAIL** (the money shot). Tap "Simulate a backdated record". Entry #2's completion date moves back 3 days *in this browser only*, the card gets a pink outline, and FAIL appears: "entry #2: its fields no longer match its hash". Tap Undo to go back to PASS.
5. **"No edit method."** Scroll to *The whole interface (read from the chain)*: seven methods, one APPEND, and "No edit. No delete." Optional cut: `icp canister metadata service_proof candid:service` in the terminal shows the same list straight from the chain.
6. *(Optional B-roll)* **Upgrade guard.** A rejected upgrade printing `Memory-incompatible program upgrade`, then `count` still returns 6.
7. **Module hash.** Run `./scripts/build-wasm.sh`; its `sha256` equals the page's MODULE HASH, which (mainnet only) equals "Module hash" on dashboard.internetcomputer.org for the canister.

Before filming: `icp network start -d && icp deploy -y && ./scripts/seed.sh` (the replica starts empty every time). Click Verify once to warm up. The certificate stays fresh while the replica idles: it was tested after ~5 minutes idle and still PASSed.

---

## Files

```
icp.yaml                     canisters (Motoko recipe v4.1.0, asset recipe v2.1.0) + local network on :8040
mops.toml / mops.lock        moc 2.0.0, core 2.5.0, sha2 0.2.5 (pinned + per-file hashes)
src/backend/main.mo          the canister
src/backend/service_proof.did  Candid interface (committed; embedded as public metadata)
src/frontend/                Vite page: index.html, src/main.js (UI), src/chain.js (verification), src/styles.css
src/frontend/public/.ic-assets.json5  standard security policy, raw access off
scripts/seed.sh              6 fake visits
scripts/verify.mjs           terminal verifier (local or ic; --tamper N)
scripts/build-wasm.sh        reproducible build + sha256
```
