#!/usr/bin/env python3
"""Merge per-track .progress-fragments/*.json into each plugin's PROGRESS.json.

Each track writes its own fragment so parallel agents never race on one file.
This merges them, preserving the ledger schema from the specs:
  milestones: map<id, {status, evidence, updated_at}>
  decisions:  [{when, what, why}]
  deviations: [{when, spec_ref, what, why}]
Later fragments win per-milestone only if they report a more advanced status.
"""
import json, os, sys, glob

RANK = {"pending": 0, "blocked": 1, "in_progress": 2, "done": 3}
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def load(p):
    try:
        with open(p) as f:
            return json.load(f)
    except Exception as e:
        print(f"  ! skipped {p}: {e}", file=sys.stderr)
        return None

def merge(ledger_path, fragment_dirs, allowed):
    ledger = load(ledger_path) or {"milestones": {}, "decisions": [], "deviations": []}
    ledger.setdefault("milestones", {}); ledger.setdefault("decisions", []); ledger.setdefault("deviations", [])
    seen_d = {json.dumps(d, sort_keys=True) for d in ledger["decisions"]}
    seen_v = {json.dumps(d, sort_keys=True) for d in ledger["deviations"]}
    used = []
    for fd in fragment_dirs:
        tag = os.path.basename(os.path.dirname(fd.rstrip("/"))) if fd.endswith("/") else None
        for fp in sorted(glob.glob(os.path.join(fd, "*.json"))):
            frag = load(fp)
            if not frag: continue
            used.append(os.path.relpath(fp, ROOT))
            src = os.path.relpath(fp, ROOT)
            for mid, m in (frag.get("milestones") or {}).items():
                if mid not in allowed:
                    continue
                cur = ledger["milestones"].get(mid)
                if cur is None or RANK.get(m.get("status","pending"),0) >= RANK.get(cur.get("status","pending"),0):
                    ledger["milestones"][mid] = m
            for key, seen in (("decisions", seen_d), ("deviations", seen_v)):
                for item in (frag.get(key) or []):
                    item = dict(item)
                    item.setdefault("source", src)
                    k = json.dumps(item, sort_keys=True)
                    if k not in seen:
                        seen.add(k); ledger[key].append(item)
    for mid in allowed:
        ledger["milestones"].setdefault(mid, {"status": "pending", "evidence": "", "updated_at": ""})
    ledger["milestones"] = {m: ledger["milestones"][m] for m in allowed}
    with open(ledger_path, "w") as f:
        json.dump(ledger, f, indent=2)
        f.write("\n")
    return ledger, used

# Only the milestone ids each spec actually defines belong in that ledger. Fragments
# may carry their own internal milestone ids (e.g. the infra track's); their decisions
# and deviations still merge, but their milestones do not pollute a spec ledger.
COMPANION_MS = ["M1_skeleton","M2_manifest","M3_validator","M4_harness",
                "M5_block_library","M6_tokens_and_export","M7_hardening_and_docs"]
AGENT_MS = ["M1_scaffold","M2_client_and_validate","M3_compiler_session","M4_oracle",
            "M5_factory","M6_spec_and_tokens","M7_skill_and_e2e"]

TARGETS = [
    (os.path.join(ROOT, "x-companion/PROGRESS.json"),
     [os.path.join(ROOT, "x-companion/.progress-fragments"), os.path.join(ROOT, "tools/.progress-fragments")],
     COMPANION_MS),
    (os.path.join(ROOT, "x-agent/PROGRESS.json"),
     [os.path.join(ROOT, "x-agent/.progress-fragments"), os.path.join(ROOT, "tools/.progress-fragments")],
     AGENT_MS),
]

fail = False
for path, dirs, allowed in TARGETS:
    led, used = merge(path, dirs, allowed)
    name = os.path.relpath(path, ROOT)
    print(f"\n{name}   (from: {', '.join(used) or 'no fragments yet'})")
    for mid, m in led["milestones"].items():
        print(f"   {m.get('status','?'):<12} {mid}")
    print(f"   decisions={len(led['decisions'])} deviations={len(led['deviations'])}")
    if any(m.get("status") == "blocked" for m in led["milestones"].values()):
        fail = True
print()
sys.exit(0)
