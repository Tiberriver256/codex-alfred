#!/usr/bin/env python3
"""Search and fetch Slack Developer Docs as markdown."""

from __future__ import annotations

import argparse
import os
import re
import sys
import tempfile
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import urljoin

from bs4 import BeautifulSoup
import subprocess

BASE_URL = "https://docs.slack.dev"
SITEMAP_URL = f"{BASE_URL}/sitemap.xml"
DEFAULT_CACHE_DIR = Path(
    os.environ.get("SLACK_DOCS_CACHE_DIR", Path.home() / ".cache" / "slack-docs")
)


def _ensure_cache_dir(cache_dir: Path) -> None:
    cache_dir.mkdir(parents=True, exist_ok=True)


def _fetch_url(url: str) -> bytes:
    with urllib.request.urlopen(url) as response:
        return response.read()


def _load_sitemap(cache_dir: Path, refresh: bool) -> list[str]:
    _ensure_cache_dir(cache_dir)
    cache_file = cache_dir / "sitemap.txt"
    if cache_file.exists() and not refresh:
        return [line.strip() for line in cache_file.read_text().splitlines() if line.strip()]

    xml_bytes = _fetch_url(SITEMAP_URL)
    root = ET.fromstring(xml_bytes)
    urls: list[str] = []
    for loc in root.iter("{http://www.sitemaps.org/schemas/sitemap/0.9}loc"):
        if loc.text:
            urls.append(loc.text.strip())
    cache_file.write_text("\n".join(urls) + "\n")
    return urls


def _normalize_url(raw: str) -> str:
    raw = raw.strip()
    if raw.startswith("http://") or raw.startswith("https://"):
        return raw
    if not raw.startswith("/"):
        raw = f"/{raw}"
    return urljoin(BASE_URL, raw)


def _rewrite_links(soup: BeautifulSoup, base_url: str) -> None:
    for tag in soup.find_all(["a", "img"]):
        attr = "href" if tag.name == "a" else "src"
        value = tag.get(attr)
        if not value:
            continue
        tag[attr] = urljoin(base_url, value)


def _find_language(tag: BeautifulSoup) -> str | None:
    current = tag
    while current is not None:
        classes = current.get("class") if hasattr(current, "get") else None
        for cls in classes or []:
            if cls.startswith("language-"):
                return cls.split("language-", 1)[1]
        current = current.parent if hasattr(current, "parent") else None
    return None


def _extract_pre_text(pre: BeautifulSoup) -> str:
    code_el = pre.find("code")
    if code_el:
        token_lines = code_el.find_all("span", class_="token-line", recursive=False)
        if token_lines:
            lines = []
            for line in token_lines:
                text = line.get_text()
                if text.endswith("\n"):
                    text = text[:-1]
                lines.append(text)
            return "\n".join(lines).rstrip("\n")
        return code_el.get_text().rstrip("\n")
    return pre.get_text().rstrip("\n")


def _normalize_code_blocks(main: BeautifulSoup) -> None:
    for pre in main.find_all("pre"):
        code_text = _extract_pre_text(pre)
        language = _find_language(pre)

        pre.attrs = {}
        pre.clear()
        code_tag = BeautifulSoup("", "html.parser").new_tag("code")
        if language:
            code_tag["class"] = [f"language-{language}"]
        code_tag.string = code_text
        pre.append(code_tag)


def _clean_main_content(main: BeautifulSoup) -> None:
    _normalize_code_blocks(main)

    for tag in main.select("a.hash-link"):
        tag.decompose()

    for tag in main.find_all(
        ["nav", "aside", "script", "style", "svg", "button", "footer"]
    ):
        tag.decompose()

    for tag in main.find_all(["header", "section"]):
        tag.unwrap()

    for tag in main.find_all("a"):
        href = tag.get("href")
        tag.attrs = {"href": href} if href else {}

    for tag in main.find_all("img"):
        src = tag.get("src")
        alt = tag.get("alt")
        attrs = {}
        if src:
            attrs["src"] = src
        if alt:
            attrs["alt"] = alt
        tag.attrs = attrs

    for tag in main.find_all("div"):
        tag.unwrap()


def _extract_main_html(html: bytes, base_url: str) -> str:
    soup = BeautifulSoup(html, "html.parser")
    main = soup.select_one("div.theme-doc-markdown")
    if main is None:
        main = soup.find("article") or soup.find("main") or soup.body
    if main is None:
        raise RuntimeError("Could not locate main content")
    _rewrite_links(main, base_url)
    _clean_main_content(main)
    return main.decode_contents()


def _pandoc_to_markdown(html_fragment: str) -> str:
    try:
        result = subprocess.run(
            [
                "pandoc",
                "-f",
                "html",
                "-t",
                "gfm",
                "--wrap=none",
                "--markdown-headings=atx",
            ],
            input=html_fragment,
            text=True,
            capture_output=True,
            check=True,
        )
    except FileNotFoundError as exc:
        raise RuntimeError("pandoc is required but not found in PATH") from exc
    if result.stderr:
        # pandoc warns on some inline HTML; keep output but surface warning in debug usage.
        pass
    return result.stdout.strip() + "\n"


def _write_output(content: str, out_path: str | None) -> str:
    if out_path:
        path = Path(out_path)
        path.write_text(content)
        return str(path)

    with tempfile.NamedTemporaryFile(prefix="slack-docs-", suffix=".md", delete=False) as tmp:
        Path(tmp.name).write_text(content)
        return tmp.name


def cmd_search(args: argparse.Namespace) -> int:
    urls = _load_sitemap(Path(args.cache_dir), args.refresh)

    if args.regex:
        pattern = re.compile(args.query, re.IGNORECASE)
        matches = [url for url in urls if pattern.search(url)]
    else:
        q = args.query.lower()
        matches = [url for url in urls if q in url.lower()]

    if args.limit:
        matches = matches[: args.limit]

    for url in matches:
        print(url)
    return 0


def cmd_fetch(args: argparse.Namespace) -> int:
    url = _normalize_url(args.page)
    html = _fetch_url(url)
    main_html = _extract_main_html(html, url)
    markdown = _pandoc_to_markdown(main_html)

    if args.stdout:
        sys.stdout.write(markdown)
        return 0

    out_path = _write_output(markdown, args.out)
    print(out_path)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        formatter_class=argparse.RawDescriptionHelpFormatter,
        description="""Search and fetch https://docs.slack.dev pages as markdown.

Examples:
  slack_docs.py search "oauth" --limit 5
  slack_docs.py fetch /tools/python-slack-sdk/ --out /tmp/python-sdk.md
  slack_docs.py fetch https://docs.slack.dev/reference/methods/chat.postMessage
""",
    )
    parser.add_argument(
        "--cache-dir",
        default=str(DEFAULT_CACHE_DIR),
        help="Directory to store cached sitemap (default: %(default)s)",
    )

    subparsers = parser.add_subparsers(dest="command", required=True)

    search_parser = subparsers.add_parser("search", help="Search sitemap URLs")
    search_parser.add_argument("query", help="Substring or regex to match")
    search_parser.add_argument("--regex", action="store_true", help="Treat query as regex")
    search_parser.add_argument("--limit", type=int, default=0, help="Limit results")
    search_parser.add_argument("--refresh", action="store_true", help="Refresh sitemap")
    search_parser.set_defaults(func=cmd_search)

    fetch_parser = subparsers.add_parser("fetch", help="Fetch a page and convert to markdown")
    fetch_parser.add_argument("page", help="Full URL or path under docs.slack.dev")
    fetch_parser.add_argument("--out", help="Write markdown to this file")
    fetch_parser.add_argument(
        "--stdout", action="store_true", help="Write markdown to stdout instead"
    )
    fetch_parser.set_defaults(func=cmd_fetch)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
