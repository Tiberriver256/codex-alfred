#!/usr/bin/env python3
# /// script
# dependencies = ["fastembed", "numpy"]
# ///

import json
import os
import sys

from fastembed import TextEmbedding

MODEL_NAME = os.getenv("LOCAL_EMBEDDING_MODEL", "BAAI/bge-base-en-v1.5")
BATCH_SIZE = int(os.getenv("EMBEDDING_BATCH_SIZE", "32"))

payload = sys.stdin.read().strip()
if not payload:
    print("[]")
    sys.exit(0)

queries = json.loads(payload)
if not isinstance(queries, list):
    raise ValueError("Input must be a JSON list.")

model = TextEmbedding(model_name=MODEL_NAME)
embeddings = list(model.embed(queries, batch_size=BATCH_SIZE))

output = []
for vec in embeddings:
    if hasattr(vec, "tolist"):
        vec = vec.tolist()
    output.append(vec)

print(json.dumps(output))
