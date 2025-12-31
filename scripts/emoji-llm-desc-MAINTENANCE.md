# Emoji embeddings maintenance

This repo ships the emoji embeddings file in `data/emoji-llm-desc/local-embeddings-BAAI_bge-small-en-v1_5.jsonl`.
When you want to refresh quality with new status messages, use this loop:

1) Pull a fresh sample from logs
```
SAMPLE_LIMIT=100 node --import=tsx scripts/emoji-llm-desc-maintenance.ts
```

2) Inspect the output for odd picks and append anchors
- Add rows to `data/emoji-llm-desc/custom-anchors.jsonl` (one JSON per line).
- Then append them:
```
uv run scripts/emoji-llm-desc-append-anchors.py
```

3) Re-run the same sample
```
SAMPLE_LIMIT=100 node --import=tsx scripts/emoji-selector-poc-llm-desc.ts
```

4) When ready, rebuild/re-pack embeddings (optional)
```
uv run scripts/emoji-llm-desc-embed.py
```

Build-time packaging
- The build copies embeddings into `dist/emoji-llm-desc/` via `scripts/emoji-llm-desc-copy-embeddings.ts`.
