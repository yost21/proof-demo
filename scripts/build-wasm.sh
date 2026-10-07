#!/usr/bin/env bash
# Reproducible build of the service_proof canister, outside icp-cli.
# Runs the same four steps as the pinned @dfinity/motoko@v4.1.0 recipe, writes
# build/service_proof.wasm, and prints its sha256. That hash must equal the
# "Module hash" from `icp canister status service_proof` (local) or the IC dashboard
# (mainnet). The recipe does not gzip, so the module hash is the sha256 of this raw wasm.
#
# Pinned inputs: moc 2.0.0 + core 2.5.0 + sha2 0.2.5 (mops.toml), ic-wasm (version printed
# below), src/backend/main.mo, src/backend/service_proof.did.
set -euo pipefail
cd "$(dirname "$0")/.."
export DFX_MOC_PATH="${DFX_MOC_PATH:-moc-wrapper}"   # mops refuses `toolchain bin` without it

mops install --lock check >/dev/null   # fails if any dependency file differs from mops.lock
MOC="$(mops toolchain bin moc)"
OUT=build/service_proof.wasm
mkdir -p build

"$MOC" src/backend/main.mo --omit-metadata candid:service $(mops sources) -o "$OUT"
ic-wasm "$OUT" -o "$OUT" metadata "moc:version" -d "$("$MOC" --version)" --keep-name-section
ic-wasm "$OUT" -o "$OUT" metadata "template:type" -d "motoko" --keep-name-section
ic-wasm "$OUT" -o "$OUT" metadata "candid:service" -f src/backend/service_proof.did -v public --keep-name-section

echo "moc:     $("$MOC" --version)"
echo "ic-wasm: $(ic-wasm --version)"
echo "wasm:    $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes)"
echo "sha256:  $(shasum -a 256 "$OUT" | cut -d' ' -f1)"
