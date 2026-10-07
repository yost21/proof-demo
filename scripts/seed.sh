#!/usr/bin/env bash
# Records 6 FAKE imaging-equipment service visits on the local replica.
# Every serial, tech ID and part below is invented for the demo.
#
# Usage:  scripts/seed.sh            (local, as your default icp identity)
#         ICP_ENVIRONMENT=ic scripts/seed.sh   (mainnet)
set -euo pipefail
cd "$(dirname "$0")/.."

ENVIRONMENT="${ICP_ENVIRONMENT:-local}"

parts_hash() {
  # sha256 of a fake parts list, written as "sha256:<hex>"
  printf 'sha256:%s' "$(printf '%s' "$1" | shasum -a 256 | cut -d' ' -f1)"
}

record() {
  local wo="$1" serial="$2" tech="$3" parts="$4" done_at="$5"
  local ph
  ph="$(parts_hash "$parts")"
  echo "→ $wo  $serial  $tech  $done_at"
  icp canister call service_proof recordVisit \
    "(\"$wo\", \"$serial\", \"$tech\", \"$ph\", \"$done_at\")" -e "$ENVIRONMENT"
}

record "WO-DEMO-1001" "MRI-DEMO-0001" "TECH-07" "demo RF coil connector x1; demo cold-head seal kit x1"  "2026-09-14T15:20:00Z"
record "WO-DEMO-1002" "CT-DEMO-0002"  "TECH-07" "demo tube cooling fan x1; demo slip-ring brush set x2"   "2026-09-16T10:05:00Z"
record "WO-DEMO-1003" "MRI-DEMO-0001" "TECH-12" "demo helium level sensor x1"                            "2026-09-21T13:40:00Z"
record "WO-DEMO-1004" "XR-DEMO-0003"  "TECH-07" "demo collimator lamp x1; demo calibration phantom x1"   "2026-09-25T09:15:00Z"
record "WO-DEMO-1005" "CT-DEMO-0002"  "TECH-12" "demo gantry belt x1"                                    "2026-09-30T16:30:00Z"
record "WO-DEMO-1006" "US-DEMO-0004"  "TECH-07" "demo transducer cable x1; demo trackball assembly x1"   "2026-10-02T11:00:00Z"

echo
icp canister call service_proof count '()' -e "$ENVIRONMENT" --query
