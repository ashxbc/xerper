#!/usr/bin/env python3
"""Sum the view counts of a user's posts that mention a given project.

Reads a JSON request on stdin:  {"username": "...", "project": "..."}
Writes a single JSON payload to stdout. Diagnostics go to stderr so they
never corrupt the payload.

Auth is a burner X account's browser cookies - see x_search for why we talk to
X directly rather than through twikit.
"""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime

import cache
import x_endpoints
from x_search import AuthFailed, XSearch

# X timestamps look like "Wed Aug 12 16:26:07 +0000 2026"
X_TIME_FORMAT = "%a %b %d %H:%M:%S %z %Y"

# 25 pages x 20 ≈ 500 posts, enough for any realistic contributor history
MAX_PAGES = 25


def log(message: str) -> None:
    print(message, file=sys.stderr)


def build_query(username: str, project: str) -> str:
    """Build an X search query for a user's posts mentioning a project.

    A project may arrive as a handle (@base), a bare word (base) or a
    multi-word name (Base Club), so match the mention, the hashtag and the
    plain word to catch every way it gets referenced.
    """
    user = username.lstrip("@").strip()
    proj = project.lstrip("@").strip()

    if re.fullmatch(r"[A-Za-z0-9_]+", proj):
        terms = [f"@{proj}", f"#{proj}", proj]
    else:
        terms = [f'"{proj}"']
        squashed = re.sub(r"[^A-Za-z0-9]", "", proj)
        if squashed:
            terms.append(f"#{squashed}")

    seen: set[str] = set()
    unique = [t for t in terms if not (t.lower() in seen or seen.add(t.lower()))]

    # Retweets carry the original author's view count, not the user's own work
    return f"from:{user} ({' OR '.join(unique)}) -filter:retweets"


def growth_series(posts: list[dict]) -> list[dict]:
    """Cumulative impressions over time, oldest first.

    Impressions only ever accumulate, so the running total is the honest shape
    for "growth" - plotting per-post views would just be a spiky bar chart of
    individual posts, not a trajectory.
    """
    dated = []
    for post in posts:
        raw = post.get("created_at")
        if not raw:
            continue
        try:
            dated.append((datetime.strptime(raw, X_TIME_FORMAT), post["views"]))
        except (ValueError, TypeError):
            continue

    dated.sort(key=lambda pair: pair[0])

    series = []
    running = 0
    for when, views in dated:
        running += views
        series.append({"t": when.date().isoformat(), "v": running})
    return series


def credentials() -> tuple[str, str]:
    auth_token = os.environ.get("X_AUTH_TOKEN", "").strip()
    ct0 = os.environ.get("X_CT0", "").strip()
    if not auth_token or not ct0:
        raise RuntimeError(
            "No X session - set X_AUTH_TOKEN and X_CT0 from a logged-in browser"
        )
    return auth_token, ct0


def run(username: str, project: str) -> dict:
    query = build_query(username, project)
    log(f"query: {query}")

    auth_token, ct0 = credentials()

    # A repeat of the same card costs nothing and spends no rate limit
    cache_key = f"{username.lstrip('@').lower()}|{project.lstrip('@').lower()}"
    cached = cache.get("impressions", cache_key, cache.TTL_IMPRESSIONS)
    if cached is not None:
        log("cache hit")
        return {**cached, "cached": True}

    with XSearch(auth_token, ct0) as client:
        try:
            posts, rate_limited = client.search(query, MAX_PAGES)
        except LookupError:
            # X rotated the query ID - rediscover it and retry once
            log("search endpoint 404'd, refreshing GraphQL query IDs")
            ids = x_endpoints.discover(auth_token, ct0)
            new_id = ids.get("SearchTimeline")
            if not new_id:
                raise RuntimeError(
                    "X moved the search endpoint and the new ID could not be found"
                ) from None
            log(f"SearchTimeline -> {new_id}")
            client.query_id = new_id
            posts, rate_limited = client.search(query, MAX_PAGES)

        # Resolve the project's own account for its icon (cached separately,
        # so it survives the shorter lifetime of the results above)
        project_profile = client.resolve_project(project)

    handle = username.lstrip("@")
    for post in posts:
        post["url"] = f"https://x.com/{post.get('screen_name') or handle}/status/{post['id']}"

    profile = client.profile or {
        "name": handle,
        "screen_name": handle,
        "avatar": "",
        "followers": 0,
        "verified": False,
    }

    payload = {
        "ok": True,
        "username": handle,
        "project": project.lstrip("@"),
        "query": query,
        "profile": profile,
        "project_profile": project_profile,
        "post_count": len(posts),
        "total_impressions": sum(p["views"] for p in posts),
        "series": growth_series(posts),
        "partial": rate_limited,
        "cached": False,
        "posts": posts,
    }

    # Don't cache a truncated run - it would pin a wrong total for the TTL
    if not rate_limited:
        cache.set("impressions", cache_key, payload)

    return payload


def main() -> int:
    try:
        raw = sys.stdin.read().strip()
        if not raw:
            raise ValueError("no input received")
        request = json.loads(raw)

        username = str(request.get("username", "")).strip()
        project = str(request.get("project", "")).strip()
        if not username or not project:
            raise ValueError("both username and project are required")

        payload = run(username, project)
    except AuthFailed as exc:
        log(f"auth error: {exc}")
        json.dump({"ok": False, "error": str(exc)}, sys.stdout)
        return 1
    except Exception as exc:
        log(f"error: {type(exc).__name__}: {exc}")
        json.dump({"ok": False, "error": str(exc)}, sys.stdout)
        return 1

    json.dump(payload, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
