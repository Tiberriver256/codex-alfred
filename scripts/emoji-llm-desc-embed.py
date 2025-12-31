#!/usr/bin/env python3
# /// script
# dependencies = ["fastembed", "numpy", "pandas", "pyarrow"]
# ///

import json
import os
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from fastembed import TextEmbedding

MODEL_NAME = os.getenv("LOCAL_EMBEDDING_MODEL", "BAAI/bge-base-en-v1.5")
BATCH_SIZE = int(os.getenv("EMBEDDING_BATCH_SIZE", "32"))
FORCE = os.getenv("FORCE", "0") == "1"

ROOT = Path(__file__).resolve().parents[1]
DATASET_PATH = ROOT / "data" / "emoji-llm-desc" / "llm-emoji-descriptions.parquet"
SAFE_MODEL = re.sub(r"[^a-zA-Z0-9_-]+", "_", MODEL_NAME)
OUTPUT_PATH = ROOT / "data" / "emoji-llm-desc" / f"local-embeddings-{SAFE_MODEL}.jsonl"

if not DATASET_PATH.exists():
    print(f"Dataset not found at {DATASET_PATH}. Run the download script first.")
    sys.exit(1)

if OUTPUT_PATH.exists() and not FORCE:
    print(f"Embeddings already exist at {OUTPUT_PATH}. Set FORCE=1 to rebuild.")
    sys.exit(0)

OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
TMP_PATH = OUTPUT_PATH.with_suffix(OUTPUT_PATH.suffix + ".tmp")
start_index = 0
file_mode = "w"

if TMP_PATH.exists() and not FORCE:
    with TMP_PATH.open("rb") as existing:
        start_index = sum(1 for _ in existing)
    if start_index > 0:
        print(f"Resuming from {start_index} already-embedded rows in {TMP_PATH}.")
        file_mode = "a"

print(f"Loading dataset from {DATASET_PATH} ...")
df = pd.read_parquet(DATASET_PATH)

required_cols = {"character", "short description", "LLM description"}
missing = required_cols - set(df.columns)
if missing:
    print(f"Dataset missing columns: {missing}")
    sys.exit(1)

def normalize_tags(tags):
    if tags is None or (isinstance(tags, float) and np.isnan(tags)):
        return []
    if isinstance(tags, list):
        return [str(t) for t in tags]
    if isinstance(tags, tuple):
        return [str(t) for t in tags]
    if isinstance(tags, str):
        return [tags]
    return [str(tags)]


def build_description(row):
    parts = [str(row["short description"]).strip()]
    tags = normalize_tags(row.get("tags"))
    if tags:
        parts.append("Tags: " + ", ".join(tags))
    parts.append(str(row["LLM description"]).strip())
    return ". ".join([p for p in parts if p])

print(f"Loading FastEmbed model {MODEL_NAME} ...")
model = TextEmbedding(model_name=MODEL_NAME)

rows = df.to_dict(orient="records")
texts = [build_description(row) for row in rows]

with TMP_PATH.open(file_mode, encoding="utf-8") as handle:
    total = len(rows)
    for start in range(start_index, total, BATCH_SIZE):
        end = min(start + BATCH_SIZE, total)
        batch_rows = rows[start:end]
        batch_texts = texts[start:end]

        embeddings = list(model.embed(batch_texts, batch_size=BATCH_SIZE))

        for i, row in enumerate(batch_rows):
            vec = embeddings[i]
            if hasattr(vec, "tolist"):
                vec = vec.tolist()
            record = {
                "emoji": str(row["character"]),
                "shortDescription": str(row["short description"]),
                "description": batch_texts[i],
                "embedding": vec,
                "model": MODEL_NAME,
            }
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
        print(f"Embedded {end}/{total}")

if TMP_PATH.exists():
    TMP_PATH.replace(OUTPUT_PATH)
    print(f"Saved embeddings to {OUTPUT_PATH}.")
else:
    print(f"Warning: temp file {TMP_PATH} missing; output not updated.")
