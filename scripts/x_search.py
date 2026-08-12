"""Minimal X search client.

Twikit is unusable against X's current API - four separate breakages sit in
the single call path we need:

  1. It builds an X-Client-Transaction-Id by scraping an `ondemand.s` bundle
     hash that X's rebuilt front end no longer publishes, so every request
     raised `Couldn't get KEY_BYTE indices`.
  2. Its SearchTimeline query ID (flaR-PUMshxFWZWPNpq4zA) has been rotated out.
  3. X now answers SearchTimeline on POST only; twikit sends GET and gets a
     bodyless 404 that looks like a bad query ID.
  4. X dropped the `legacy` block from user objects, so twikit's User model
     raises KeyError - swallowed by a bare `except KeyError`, which turns a
     full page of results into a silent zero.

Fixing (4) means synthesising a legacy-shaped user dict for a model we do not
otherwise use. Since all we need is view counts, talking to the endpoint
directly is both smaller and steadier than maintaining four monkey-patches.

Auth is a logged-in session's cookies (auth_token + ct0) plus X's public web
bearer token, which is what the site itself ships to browsers.
"""

from __future__ import annotations

import json
import math
import re
from typing import Any, Iterator

import httpx

import cache
import x_endpoints

BEARER = (
    "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D"
    "1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA"
)

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
)

# X rejects the call outright if these are not all present
FEATURES = {
    "creator_subscriptions_tweet_preview_api_enabled": True,
    "c9s_tweet_anatomy_moderator_badge_enabled": True,
    "tweetypie_unmention_optimization_enabled": True,
    "responsive_web_edit_tweet_api_enabled": True,
    "graphql_is_translatable_rweb_tweet_is_translatable_enabled": True,
    "view_counts_everywhere_api_enabled": True,
    "longform_notetweets_consumption_enabled": True,
    "responsive_web_twitter_article_tweet_consumption_enabled": True,
    "tweet_awards_web_tipping_enabled": False,
    "longform_notetweets_rich_text_read_enabled": True,
    "longform_notetweets_inline_media_enabled": True,
    "rweb_video_timestamps_enabled": True,
    "responsive_web_graphql_exclude_directive_enabled": True,
    "verified_phone_label_enabled": False,
    "freedom_of_speech_not_reach_fetch_enabled": True,
    "standardized_nudges_misinfo": True,
    "tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled": True,
    "responsive_web_media_download_video_enabled": False,
    "responsive_web_graphql_skip_user_profile_image_extensions_enabled": False,
    "responsive_web_graphql_timeline_navigation_enabled": True,
    "responsive_web_enhance_cards_enabled": False,
}


class RateLimited(Exception):
    pass


class AuthFailed(Exception):
    pass


def _walk(node: Any, key: str) -> Iterator[Any]:
    """Yield every value stored under `key`, at any depth."""
    if isinstance(node, dict):
        for k, v in node.items():
            if k == key:
                yield v
            yield from _walk(v, key)
    elif isinstance(node, list):
        for item in node:
            yield from _walk(item, key)


def bottom_cursor(payload: Any) -> str | None:
    """Find the 'load older results' cursor.

    X sends it two different ways: on the first page it is an entry inside
    `entries`, but on later pages it arrives as a TimelineReplaceEntry holding
    a singular `entry`. Matching on the cursor object itself covers both -
    reading only `entries` silently caps pagination at two pages.
    """
    for content in _walk(payload, "content"):
        if (
            isinstance(content, dict)
            and content.get("__typename") == "TimelineTimelineCursor"
            and content.get("cursorType") == "Bottom"
        ):
            return content.get("value")
    return None


def to_int(value: Any) -> int:
    if value is None:
        return 0
    try:
        return int(str(value).replace(",", ""))
    except (TypeError, ValueError):
        return 0


class XSearch:
    def __init__(self, auth_token: str, ct0: str) -> None:
        # Filled from the first result; the search response already carries the
        # author's profile, so no separate profile lookup is needed
        self.profile: dict | None = None
        self.session = httpx.Client(
            timeout=45,
            cookies={"auth_token": auth_token, "ct0": ct0},
            headers={
                "Authorization": f"Bearer {BEARER}",
                "User-Agent": USER_AGENT,
                "Content-Type": "application/json",
                "X-Csrf-Token": ct0,
                "X-Twitter-Auth-Type": "OAuth2Session",
                "X-Twitter-Active-User": "yes",
                "X-Twitter-Client-Language": "en",
                "Referer": "https://x.com/",
            },
        )
        self.query_id = x_endpoints.search_query_id()

    def close(self) -> None:
        self.session.close()

    def __enter__(self) -> "XSearch":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def _post(
        self, query: str, cursor: str | None, count: int, product: str = "Latest"
    ) -> dict:
        variables: dict[str, Any] = {
            "rawQuery": query,
            "count": count,
            "querySource": "typed_query",
            "product": product,
        }
        if cursor:
            variables["cursor"] = cursor

        url = f"https://x.com/i/api/graphql/{self.query_id}/SearchTimeline"
        response = self.session.post(
            url,
            json={
                "variables": variables,
                "features": FEATURES,
                "queryId": self.query_id,
            },
        )

        if response.status_code in (401, 403):
            raise AuthFailed(
                "X rejected the session - grab a fresh auth_token and ct0 "
                "from a logged-in browser"
            )
        if response.status_code == 429:
            raise RateLimited("rate limited by X")
        if response.status_code == 404:
            raise LookupError("search endpoint moved")
        response.raise_for_status()
        return response.json()

    def search(self, query: str, max_pages: int, page_size: int = 20):
        """Page through results, yielding (posts, hit_rate_limit)."""
        posts: list[dict] = []
        seen: set[str] = set()
        cursor: str | None = None
        rate_limited = False

        for _ in range(max_pages):
            try:
                payload = self._post(query, cursor, page_size)
            except RateLimited:
                rate_limited = True
                break

            entries: list[dict] = []
            for group in _walk(payload, "entries"):
                if isinstance(group, list):
                    entries.extend(group)
            if not entries:
                break

            fresh = 0
            next_cursor = bottom_cursor(payload)
            for entry in entries:
                entry_id = entry.get("entryId", "")

                if not entry_id.startswith("tweet"):
                    continue

                post = self._parse(entry)
                if post and post["id"] not in seen:
                    seen.add(post["id"])
                    posts.append(post)
                    fresh += 1
                    if self.profile is None:
                        self.profile = self._parse_profile(entry)

            # No new posts, or nowhere left to go
            if fresh == 0 or not next_cursor or next_cursor == cursor:
                break
            cursor = next_cursor

        return posts, rate_limited

    # ---- project identity -------------------------------------------------

    def resolve_project(self, project: str) -> dict | None:
        """Find the X account behind a project name, for its icon.

        Taking the matching handle at face value gets this wrong often: for
        "caldera", @caldera is a 156-follower account while the actual project
        is @Calderaxyz with 328k. So gather candidates from both an exact
        handle lookup and a people search, then score them - a project's real
        account is the one with the audience.
        """
        key = project.lstrip("@").strip().lower()
        if not key:
            return None

        hit = cache.get("project", key, cache.TTL_PROJECT)
        if hit is not None:
            return hit or None  # cached miss is stored as {}

        candidates: list[dict] = []
        slug = re.sub(r"[^A-Za-z0-9_]", "", key)
        if slug:
            exact = self._user_by_screen_name(slug)
            if exact:
                candidates.append(exact)
        candidates.extend(self._search_people(key))

        best = self._best_match(key, candidates)
        cache.set("project", key, best or {})
        return best

    @staticmethod
    def _best_match(query: str, candidates: list[dict]) -> dict | None:
        normalise = lambda s: re.sub(r"[^a-z0-9]", "", (s or "").lower())
        target = normalise(query)
        if not target:
            return None

        best, best_score = None, 0.0
        for user in candidates:
            handle, name = normalise(user["screen_name"]), normalise(user["name"])
            # Must actually mention the project, or followers alone would win
            if target not in handle and target not in name:
                continue

            score = math.log10(max(user["followers"], 1)) * 2
            if handle == target or name == target:
                score += 3
            elif handle.startswith(target) or name.startswith(target):
                score += 1.5
            if user["verified"]:
                score += 1

            if score > best_score:
                best, best_score = user, score

        return best

    def _user_by_screen_name(self, handle: str) -> dict | None:
        qid = x_endpoints.query_id("UserByScreenName")
        try:
            response = self.session.get(
                f"https://x.com/i/api/graphql/{qid}/UserByScreenName",
                params={
                    "variables": json.dumps(
                        {"screen_name": handle, "withSafetyModeUserFields": True}
                    ),
                    "features": json.dumps(FEATURES),
                },
            )
            user = response.json()["data"]["user"]["result"]
        except (httpx.HTTPError, KeyError, TypeError, ValueError):
            return None
        return self._user_fields(user)

    def _search_people(self, query: str) -> list[dict]:
        try:
            payload = self._post(query, None, 10, product="People")
        except (httpx.HTTPError, RateLimited, AuthFailed, LookupError):
            return []

        users = []
        for holder in _walk(payload, "user_results"):
            user = holder.get("result") if isinstance(holder, dict) else None
            fields = self._user_fields(user) if user else None
            if fields:
                users.append(fields)
        return users

    @staticmethod
    def _user_fields(user: dict | None) -> dict | None:
        if not user or not user.get("core"):
            return None
        core = user["core"]
        avatar = user.get("avatar", {}).get("image_url", "")
        return {
            "name": core.get("name", ""),
            "screen_name": core.get("screen_name", ""),
            "avatar": avatar.replace("_normal.", "_400x400."),
            "followers": to_int(user.get("relationship_counts", {}).get("followers")),
            "verified": bool(user.get("verification", {}).get("verified")),
        }

    @staticmethod
    def _parse_profile(entry: dict) -> dict | None:
        """Pull the author's profile out of a search result.

        X moved these off the old `legacy` block into `core`/`avatar`/
        `verification`, which is what broke twikit's User model.
        """
        result = (
            entry.get("content", {})
            .get("itemContent", {})
            .get("tweet_results", {})
            .get("result", {})
        )
        if "tweet" in result:
            result = result["tweet"]
        user = result.get("core", {}).get("user_results", {}).get("result")
        if not user:
            return None

        core = user.get("core", {})
        counts = user.get("relationship_counts", {})
        avatar = user.get("avatar", {}).get("image_url", "")

        return {
            "name": core.get("name", ""),
            "screen_name": core.get("screen_name", ""),
            # _normal is a 48px thumbnail; _400x400 is the crisp version
            "avatar": avatar.replace("_normal.", "_400x400."),
            "followers": to_int(counts.get("followers")),
            "verified": bool(user.get("verification", {}).get("verified")),
        }

    @staticmethod
    def _parse(entry: dict) -> dict | None:
        result = (
            entry.get("content", {})
            .get("itemContent", {})
            .get("tweet_results", {})
            .get("result")
        )
        if not result:
            return None
        # Visibility-limited posts nest the real payload one level down
        if "tweet" in result:
            result = result["tweet"]

        legacy = result.get("legacy")
        if not legacy:
            return None

        user = (
            result.get("core", {}).get("user_results", {}).get("result", {}).get("core", {})
        )

        return {
            "id": result.get("rest_id") or legacy.get("id_str"),
            "screen_name": user.get("screen_name", ""),
            "created_at": legacy.get("created_at"),
            # X reports views as a string
            "views": to_int(result.get("views", {}).get("count")),
            "likes": to_int(legacy.get("favorite_count")),
            "reposts": to_int(legacy.get("retweet_count")),
            "replies": to_int(legacy.get("reply_count")),
            "quotes": to_int(legacy.get("quote_count")),
            "text": legacy.get("full_text", ""),
        }
