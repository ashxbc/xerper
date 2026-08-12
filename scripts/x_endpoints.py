"""Track X's GraphQL query IDs, which rotate on every front-end deploy.

X embeds a `queryId` for each GraphQL operation in its JS bundles and changes
them regularly. Hardcoding one means the app breaks silently a few weeks later
with a bodyless 404 - exactly how twikit's retired SearchTimeline ID failed.

So we scrape the live ID and cache it, and re-scrape when a call 404s.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
CACHE_FILE = ROOT / ".x_query_ids.json"

# Last IDs seen working; only a starting point, refreshed on any 404
FALLBACKS = {
    "SearchTimeline": "hyPfJYJ_XAtDYoslQc-Rgg",
    "UserByScreenName": "Gb-d6r0vxPOADdG62OEBpQ",
}

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
)

# Bundles declare operations in either field order
_PATTERNS = (
    re.compile(r'queryId:"([\w-]{15,})",operationName:"(\w+)"'),
    re.compile(r'operationName:"(\w+)",queryId:"([\w-]{15,})"'),
)


def _read_cache() -> dict[str, str]:
    if not CACHE_FILE.exists():
        return {}
    try:
        return json.loads(CACHE_FILE.read_text())
    except (json.JSONDecodeError, OSError):
        return {}


def _write_cache(ids: dict[str, str]) -> None:
    try:
        CACHE_FILE.write_text(json.dumps(ids, indent=2, sort_keys=True))
    except OSError:
        pass  # a cache we cannot persist is not worth failing the run over


def query_id(operation: str) -> str:
    return _read_cache().get(operation) or FALLBACKS.get(operation, "")


def search_query_id() -> str:
    return query_id("SearchTimeline")


def discover(auth_token: str, ct0: str) -> dict[str, str]:
    """Scrape current query IDs from X's bundles.

    Needs a logged-in session: the logged-out page ships a slimmer bundle that
    does not contain the operation table.
    """
    headers = {"User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9"}
    cookies = {"auth_token": auth_token, "ct0": ct0}
    found: dict[str, str] = {}

    with httpx.Client(
        timeout=60, follow_redirects=True, headers=headers, cookies=cookies
    ) as session:
        home = session.get("https://x.com/home").text
        scripts = set(re.findall(r'src="(https://abs\.twimg\.com[^"]+\.js)"', home))
        scripts |= {
            "https://abs.twimg.com" + path
            for path in re.findall(r'"(/x-web/[^"]+?\.js)"', home)
        }

        for url in scripts:
            try:
                body = session.get(url).text
            except httpx.HTTPError:
                continue
            for index, pattern in enumerate(_PATTERNS):
                for match in pattern.finditer(body):
                    # group order flips between the two patterns
                    operation, query_id = (
                        (match.group(2), match.group(1))
                        if index == 0
                        else (match.group(1), match.group(2))
                    )
                    found[operation] = query_id

    if found:
        _write_cache({**_read_cache(), **found})

    return found
