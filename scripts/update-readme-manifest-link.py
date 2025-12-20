#!/usr/bin/env python3
"""Update README install link from slack-app-manifest.yaml."""

from __future__ import annotations

import sys
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
MANIFEST_PATH = ROOT / "slack-app-manifest.yaml"
README_PATH = ROOT / "README.md"

START_MARKER = "<!-- slack-manifest-link:start -->"
END_MARKER = "<!-- slack-manifest-link:end -->"

BUTTON_IMAGE = (
    "https://img.shields.io/badge/Slack-Create%20App-4A154B"
    "?logo=slack&logoColor=white"
)


def load_manifest() -> str:
    if not MANIFEST_PATH.exists():
        raise FileNotFoundError(f"Missing manifest: {MANIFEST_PATH}")
    return MANIFEST_PATH.read_text().strip()


def build_install_url(manifest_text: str) -> str:
    encoded = quote(manifest_text, safe="")
    return f"https://api.slack.com/apps?new_app=1&manifest_yaml={encoded}"


def update_readme(readme_text: str, install_url: str) -> str:
    start_index = readme_text.find(START_MARKER)
    end_index = readme_text.find(END_MARKER)
    if start_index == -1 or end_index == -1 or end_index < start_index:
        raise ValueError("README is missing slack manifest link markers")

    before = readme_text[: start_index + len(START_MARKER)]
    after = readme_text[end_index:]

    link = f"[{f'![Create Slack App]({BUTTON_IMAGE})'}]({install_url})"
    replacement = f"\n\n{link}\n\n"
    return before + replacement + after


def main() -> int:
    manifest_text = load_manifest()
    install_url = build_install_url(manifest_text)
    readme_text = README_PATH.read_text()
    updated = update_readme(readme_text, install_url)
    if updated != readme_text:
        README_PATH.write_text(updated)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
