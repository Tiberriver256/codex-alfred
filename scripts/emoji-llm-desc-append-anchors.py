#!/usr/bin/env python3
# /// script
# dependencies = ["fastembed", "numpy"]
# ///

import json
import os
import re
import sys
from pathlib import Path

from fastembed import TextEmbedding

MODEL_NAME = os.getenv("LOCAL_EMBEDDING_MODEL", "BAAI/bge-small-en-v1.5")
BATCH_SIZE = int(os.getenv("EMBEDDING_BATCH_SIZE", "32"))

ROOT = Path(__file__).resolve().parents[1]
ANCHORS_PATH = ROOT / "data" / "emoji-llm-desc" / "custom-anchors.jsonl"
SAFE_MODEL = re.sub(r"[^a-zA-Z0-9_-]+", "_", MODEL_NAME)
OUTPUT_PATH = ROOT / "data" / "emoji-llm-desc" / f"local-embeddings-{SAFE_MODEL}.jsonl"

if not OUTPUT_PATH.exists():
    print(f"Embeddings not found at {OUTPUT_PATH}. Run the embed script first.")
    sys.exit(1)

if not ANCHORS_PATH.exists():
    print(f"Anchors file not found at {ANCHORS_PATH}.")
    sys.exit(1)

anchors = []
with ANCHORS_PATH.open("r", encoding="utf-8") as handle:
    for line in handle:
        if not line.strip():
            continue
        try:
            anchors.append(json.loads(line))
        except json.JSONDecodeError:
            continue

if not anchors:
    print("No anchors found to append.")
    sys.exit(0)

existing = set()
with OUTPUT_PATH.open("r", encoding="utf-8") as handle:
    for line in handle:
        if not line.strip():
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        key = (obj.get("emoji"), obj.get("description"))
        existing.add(key)

pending = []
for anchor in anchors:
    key = (anchor.get("emoji"), anchor.get("description"))
    if key in existing:
        continue
    pending.append(anchor)

if not pending:
    print("All anchors already present in embeddings file.")
    sys.exit(0)

model = TextEmbedding(model_name=MODEL_NAME)
texts = [anchor["description"] for anchor in pending]
embeddings = list(model.embed(texts, batch_size=BATCH_SIZE))

with OUTPUT_PATH.open("a", encoding="utf-8") as handle:
    for anchor, vec in zip(pending, embeddings):
        if hasattr(vec, "tolist"):
            vec = vec.tolist()
        record = {
            "emoji": anchor.get("emoji"),
            "shortDescription": anchor.get("shortDescription"),
            "description": anchor.get("description"),
            "embedding": vec,
            "model": MODEL_NAME,
            "anchor": True,
        }
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")

print(f"Appended {len(pending)} anchors to {OUTPUT_PATH}.")
