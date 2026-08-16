"""crawl4ai bridge used by the Telegram bot.

Crawls ONE url with crawl4ai (stealth mode for bot protection, pruning content
filter for best readability) and prints a single JSON object to stdout:

    {"ok": true, "url": ..., "title": ..., "markdown": ..., "error": null}
    {"ok": false, "url": ..., "title": null, "markdown": null, "error": "..."}

Usage:
    python scripts/crawl.py <url>

Requires: pip install -U crawl4ai && crawl4ai-setup   (installs Playwright
Chromium; crawl4ai-setup may need `python -m playwright install chromium`)

Exit code 0 even on crawl failure (the JSON carries the error), so the caller
can always parse stdout.
"""

import argparse
import asyncio
import json
import sys

from crawl4ai import AsyncWebCrawler, BrowserConfig, CacheMode, CrawlerRunConfig
from crawl4ai.content_filter_strategy import PruningContentFilter
from crawl4ai.markdown_generation_strategy import DefaultMarkdownGenerator


def build_configs():
    """Browser + run config: headless, stealth (anti-bot), text-only for speed,
    and a pruning filter so the returned markdown is the readable main content
    instead of nav/footer boilerplate."""
    browser_conf = BrowserConfig(
        headless=True,
        enable_stealth=True,
        user_agent_mode="random",
        text_mode=True,
        avoid_css=True,
        avoid_ads=True,
        verbose=False,
    )
    md_generator = DefaultMarkdownGenerator(
        content_filter=PruningContentFilter(
            threshold=0.45,
            threshold_type="fixed",
        )
    )
    run_conf = CrawlerRunConfig(
        cache_mode=CacheMode.BYPASS,
        markdown_generator=md_generator,
        word_count_threshold=10,
        wait_until="domcontentloaded",
        page_timeout=60_000,
        verbose=False,
    )
    return browser_conf, run_conf


async def crawl(url: str) -> dict:
    browser_conf, run_conf = build_configs()
    try:
        async with AsyncWebCrawler(config=browser_conf) as crawler:
            result = await crawler.arun(url=url, config=run_conf)
    except Exception as exc:  # noqa: BLE001 - report any crawl-level failure
        return {
            "ok": False,
            "url": url,
            "title": None,
            "markdown": None,
            "error": f"crawl4ai failed: {exc}",
        }

    if not result.success:
        return {
            "ok": False,
            "url": url,
            "title": None,
            "markdown": None,
            "error": result.error_message or "crawl4ai reported failure",
        }

    # fit_markdown is the pruned, readability-filtered version - that is what
    # we want for the bot. Fall back to raw markdown if the filter emptied it.
    markdown = result.markdown.fit_markdown or result.markdown.raw_markdown or ""
    return {
        "ok": True,
        "url": url,
        "title": result.metadata.get("title") if result.metadata else None,
        "markdown": markdown,
        "error": None,
    }


def main() -> None:
    # Windows consoles default to cp1252, which cannot encode emoji and other
    # characters pages commonly contain - force UTF-8 so the JSON is always
    # parseable by the caller regardless of platform.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    parser = argparse.ArgumentParser(description="crawl4ai one-URL bridge")
    parser.add_argument("url", help="URL to crawl")
    args = parser.parse_args()

    if not args.url:
        print(json.dumps({"ok": False, "url": "", "title": None, "markdown": None, "error": "no URL given"}))
        sys.exit(0)

    result = asyncio.run(crawl(args.url))
    print(json.dumps(result, ensure_ascii=False))
    sys.exit(0)


if __name__ == "__main__":
    main()
