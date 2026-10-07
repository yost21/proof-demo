// service_proof — an append-only, hash-chained log of equipment service visits.
//
// What it does:
//   * recordVisit appends one entry. There is no method that edits or deletes an entry.
//   * Every entry carries the hash of the entry before it (a hash chain), so changing
//     any past field changes every hash after it.
//   * After each append the latest hash is written into the subnet's certified state
//     (CertifiedData.set). getCertifiedHead returns that hash plus a certificate signed
//     by the subnet, so a browser can check it against the IC root key without trusting
//     whichever replica answered the query.
//   * State lives in the actor itself (enhanced orthogonal persistence — the default and
//     only mode since moc 2.0): every non-`transient` field survives upgrades with no
//     database and no serialization. If new code would drop or retype a stored field,
//     the runtime rejects the upgrade and the old code and data stay in place.
//
// Hash rule (also implemented in src/frontend/src/chain.js and scripts/verify.mjs):
//   entryHash = sha256( lines joined by "\n" ):
//     service-proof/v1
//     <prevHash, 64 hex chars; 64 zeros for the first entry>
//     <index>
//     <workOrderId>
//     <equipmentSerial>
//     <techId>
//     <partsHash>
//     <completedAt>
//     <recordedBy, principal text>
//     <recordedAt, IC time in nanoseconds>
//   Fields may not contain line breaks, so the encoding is unambiguous.
//
// Built with moc 2.0.0 (pinned in mops.toml).

import CertifiedData "mo:core/CertifiedData";
import Int "mo:core/Int";
import List "mo:core/List";
import Nat "mo:core/Nat";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Set "mo:core/Set";
import Text "mo:core/Text";
import Time "mo:core/Time";
import Sha256 "mo:sha2/Sha256";

actor ServiceProof {

  // ---------- Types (these become the Candid interface) ----------

  public type Entry = {
    index : Nat;
    workOrderId : Text;
    equipmentSerial : Text;
    techId : Text;
    partsHash : Text;
    completedAt : Text;
    recordedBy : Principal;
    recordedAt : Int; // IC time, nanoseconds since 1970
    prevHash : Text;
    entryHash : Text;
  };

  public type Receipt = {
    index : Nat;
    entryHash : Text;
    prevHash : Text;
    recordedBy : Principal;
    recordedAt : Int;
  };

  public type CertifiedHead = {
    count : Nat;
    headHash : Text;
    certificate : ?Blob; // null when called as an update instead of a query
  };

  // ---------- Constants (transient: always taken from the current code) ----------

  transient let GENESIS : Text = "0000000000000000000000000000000000000000000000000000000000000000";
  transient let MAX_FIELD_BYTES : Nat = 128;
  transient let MAX_PAGE : Nat = 100;
  transient let HEX : [Char] = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f'];

  // ---------- Stored state (survives upgrades) ----------

  let entries = List.empty<Entry>();
  let recorders = Set.empty<Principal>();
  var headHash : Blob = "\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00";

  // The IC clears certified data on every install and upgrade. The actor body runs on
  // both, so this line re-publishes the current head each time.
  CertifiedData.set(headHash);

  // ---------- Access control ----------

  func isController(p : Principal) : Bool {
    not p.isAnonymous() and p.isController();
  };

  func isRecorder(p : Principal) : Bool {
    isController(p) or (not p.isAnonymous() and recorders.contains(Principal.compare, p));
  };

  /// Allow a principal to append visits. Controllers only.
  public shared ({ caller }) func addRecorder(p : Principal) : async () {
    if (not isController(caller)) Runtime.trap("only a controller can change the recorder allowlist");
    if (p.isAnonymous()) Runtime.trap("the anonymous principal cannot be a recorder");
    recorders.add(Principal.compare, p);
  };

  /// Stop a principal from appending new visits. Controllers only.
  /// Touches the allowlist only; entries already written are never changed.
  public shared ({ caller }) func revokeRecorder(p : Principal) : async () {
    if (not isController(caller)) Runtime.trap("only a controller can change the recorder allowlist");
    recorders.remove(Principal.compare, p);
  };

  // ---------- Append ----------

  func checkField(name : Text, value : Text) {
    let bytes = value.encodeUtf8().size();
    if (bytes == 0) Runtime.trap(name # " is empty");
    if (bytes > MAX_FIELD_BYTES) Runtime.trap(name # " is longer than " # MAX_FIELD_BYTES.toText() # " bytes");
    if (value.contains(#char '\n') or value.contains(#char '\r')) {
      Runtime.trap(name # " contains a line break");
    };
  };

  /// Append one service visit. Returns a receipt holding the new entry's hash.
  public shared ({ caller }) func recordVisit(
    workOrderId : Text,
    equipmentSerial : Text,
    techId : Text,
    partsHash : Text,
    completedAt : Text,
  ) : async Receipt {
    if (not isRecorder(caller)) Runtime.trap("caller is not an allowed recorder");
    checkField("workOrderId", workOrderId);
    checkField("equipmentSerial", equipmentSerial);
    checkField("techId", techId);
    checkField("partsHash", partsHash);
    checkField("completedAt", completedAt);

    let index = entries.size();
    let prevHash = toHex(headHash);
    let recordedAt = Time.now();
    let preimage = Text.join(
      [
        "service-proof/v1",
        prevHash,
        index.toText(),
        workOrderId,
        equipmentSerial,
        techId,
        partsHash,
        completedAt,
        caller.toText(),
        recordedAt.toText(),
      ].values(),
      "\n",
    );
    let digest = Sha256.fromBlob(#sha256, preimage.encodeUtf8());
    let entryHash = toHex(digest);

    entries.add({
      index;
      workOrderId;
      equipmentSerial;
      techId;
      partsHash;
      completedAt;
      recordedBy = caller;
      recordedAt;
      prevHash;
      entryHash;
    });
    headHash := digest;
    CertifiedData.set(digest);

    { index; entryHash; prevHash; recordedBy = caller; recordedAt };
  };

  // ---------- Read ----------

  public query func count() : async Nat {
    entries.size();
  };

  public query func getEntry(index : Nat) : async ?Entry {
    entries.get(index);
  };

  /// Entries in append order, starting at `offset`, at most 100 per call.
  public query func list(offset : Nat, limit : Nat) : async [Entry] {
    let size = entries.size();
    if (offset >= size) return [];
    let end = Nat.min(size, offset + Nat.min(limit, MAX_PAGE));
    entries.sliceToArray(offset, end);
  };

  /// The latest entry hash plus the subnet certificate that vouches for it.
  /// The certificate's certified_data for this canister equals the head hash bytes.
  public query func getCertifiedHead() : async CertifiedHead {
    {
      count = entries.size();
      headHash = if (entries.size() == 0) GENESIS else toHex(headHash);
      certificate = CertifiedData.getCertificate();
    };
  };

  // ---------- Cycle-drain guard (an optimization, not the security boundary) ----------
  // Rejects writes from callers who would fail the checks above anyway, before the
  // canister pays to decode their arguments. The real checks stay inside each method.

  system func inspect({
    caller : Principal;
    msg : {
      #addRecorder : Any;
      #revokeRecorder : Any;
      #recordVisit : Any;
      #count : Any;
      #getEntry : Any;
      #list : Any;
      #getCertifiedHead : Any;
    };
  }) : Bool {
    switch msg {
      case (#recordVisit _) isRecorder(caller);
      case (#addRecorder _) isController(caller);
      case (#revokeRecorder _) isController(caller);
      case _ true;
    };
  };

  // ---------- Helpers ----------

  func toHex(b : Blob) : Text {
    var out = "";
    for (byte in b.values()) {
      let n = byte.toNat();
      out #= Text.fromChar(HEX[n / 16]) # Text.fromChar(HEX[n % 16]);
    };
    out;
  };
};
