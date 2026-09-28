"""Place search with OpenStreetMap Nominatim, and typed coordinates (stdlib, no ``bpy``).

One request per user search, at most one per second, with results cached for
the session, as the Nominatim usage policy requires. The service can be
switched without an update by setting ``JARVIZAR_PLACE_SEARCH_URL`` to another
Nominatim-compatible search endpoint.
"""

from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass
import json
import math
import os
import re
import socket
import time
import urllib.error
import urllib.parse
import urllib.request

from .projection import format_degrees

SEARCH_URL = "https://nominatim.openstreetmap.org/search"
URL_ENVIRONMENT = "JARVIZAR_PLACE_SEARCH_URL"
ATTRIBUTION = "Search © OpenStreetMap contributors"
USER_AGENT = "JarvizarCityModel/{version} (Blender add-on)"
RESULT_LIMIT = 5
TIMEOUT_S = 10.0
MIN_INTERVAL_S = 1.0
QUERY_LIMIT = 200
MAX_RESPONSE_BYTES = 1 << 20
COORDINATE_EXAMPLE = "41.8781, -87.6298"

# Text of only these characters, with two or more numbers and a separator, is
# read as coordinates and never sent.
_COORDINATE_CHARS = re.compile(r"^[\s\d.,;+\-°'\"′″NSEWnsew]*$")
_NUMBER = r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)"
_COORDINATES = re.compile(
    rf"^\s*(?P<lat>{_NUMBER})\s*°?\s*(?P<ns>[NSns])?\s*(?P<sep>,|;|\s)\s*"
    rf"(?P<lon>{_NUMBER})\s*°?\s*(?P<ew>[EWew])?\s*$")
_BARE_INTEGER_PAIR = re.compile(r"^\s*[+-]?\d+,\d+\s*$")

_cache: OrderedDict = OrderedDict()
_CACHE_SIZE = 32
_last_request = [-math.inf]


class GeocodeError(Exception):
    """A search that could not run or failed, with a message for the user."""


@dataclass(frozen=True)
class Place:
    name: str
    display_name: str
    latitude: float
    longitude: float
    # west, south, east, north of the place itself, when the service gives one.
    bounds: tuple[float, float, float, float] | None = None


def user_agent(version: str) -> str:
    return USER_AGENT.format(version=version or "unknown")


def language_code(locale: str) -> str:
    """An Accept-Language value from a Blender locale such as ``en_US``."""
    code = str(locale or "").strip().replace("_", "-")
    if not code or not re.fullmatch(r"[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*", code):
        return ""
    primary = code.split("-", 1)[0]
    return code if primary == code else f"{code},{primary}"


def search_url(query: str, limit: int = RESULT_LIMIT, language: str = "", endpoint: str = "") -> str:
    base = endpoint or os.environ.get(URL_ENVIRONMENT, "").strip() or SEARCH_URL
    if urllib.parse.urlsplit(base).scheme not in ("http", "https"):
        raise GeocodeError(f"Place search URL must start with https://: {base}")
    params = {"format": "jsonv2", "limit": str(int(limit)), "q": query}
    if language:
        params["accept-language"] = language
    return f"{base}?{urllib.parse.urlencode(params)}"


def _coordinate_error(message: str) -> GeocodeError:
    return GeocodeError(f"{message}. Enter latitude, longitude in decimal degrees, "
                        f"for example {COORDINATE_EXAMPLE}")


def parse_coordinates(text: str) -> Place | None:
    """A typed ``latitude, longitude`` as a place, or None for a place name.

    Strict: two decimal numbers, latitude first. N/S and E/W letters may
    replace the signs, never accompany them. Coordinate-like text that does
    not meet this is refused rather than searched for, since a guess could
    silently pick another place. A lone number or digits joined by a hyphen
    are left to the search as postcodes.
    """
    cleaned = str(text).replace("−", "-").strip()
    if not _COORDINATE_CHARS.match(cleaned):
        return None
    groups = re.findall(r"\d+(?:\.\d+)?", cleaned)
    if len(groups) < 2 or not re.search(r"[\s,;°'\"′″NSEWnsew]", cleaned):
        return None
    match = _COORDINATES.match(cleaned)
    if match is None:
        if "." not in cleaned and re.search(r"\d,\d", cleaned):
            raise _coordinate_error("Use a decimal point, not a comma")
        if len(groups) == 4:
            raise GeocodeError("Four numbers are a bounding box: use Paste Coordinates for "
                               "west,south,east,north")
        raise _coordinate_error("Could not read two numbers")
    if _BARE_INTEGER_PAIR.match(cleaned):
        raise _coordinate_error("Use a decimal point, not a comma")
    if (match["ns"] and match["lat"][0] in "+-") or (match["ew"] and match["lon"][0] in "+-"):
        raise _coordinate_error("Use either a sign or a hemisphere letter, not both")
    latitude, longitude = float(match["lat"]), float(match["lon"])
    if match["ns"] and match["ns"] in "Ss":
        latitude = -latitude
    if match["ew"] and match["ew"] in "Ww":
        longitude = -longitude
    if not -90.0 <= latitude <= 90.0:
        raise _coordinate_error("Latitude must be between -90 and 90; the first number is the latitude")
    if not -180.0 <= longitude <= 180.0:
        raise _coordinate_error("Longitude must be between -180 and 180")
    name = f"{format_degrees(latitude)}, {format_degrees(longitude)}"
    return Place(name=name, display_name=name, latitude=latitude, longitude=longitude)


def _number(value) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _place_bounds(box) -> tuple[float, float, float, float] | None:
    # Nominatim's boundingbox is [min lat, max lat, min lon, max lon].
    if not isinstance(box, (list, tuple)) or len(box) != 4:
        return None
    south, north, west, east = (_number(value) for value in box)
    if None in (south, north, west, east):
        return None
    if not (-180.0 <= west <= east <= 180.0 and -90.0 <= south <= north <= 90.0):
        return None
    return west, south, east, north


def parse_results(payload) -> list[Place]:
    """Places from a decoded Nominatim ``jsonv2`` search response."""
    if not isinstance(payload, list):
        raise GeocodeError("Place search returned an unexpected response")
    places, seen = [], set()
    for item in payload:
        if not isinstance(item, dict):
            continue
        latitude, longitude = _number(item.get("lat")), _number(item.get("lon"))
        if latitude is None or longitude is None:
            continue
        if not (-90.0 <= latitude <= 90.0 and -180.0 <= longitude <= 180.0):
            continue
        display = " ".join(str(item.get("display_name") or "").split())
        display = display or f"{format_degrees(latitude)}, {format_degrees(longitude)}"
        # An address has no name; its display name starts "10, Downing Street, ...".
        parts = [part.strip() for part in display.split(",")]
        fallback = f"{parts[0]} {parts[1]}" if len(parts) > 1 and parts[0].isdigit() else parts[0]
        name = " ".join(str(item.get("name") or "").split()) or fallback
        key = (display.casefold(), round(latitude, 5), round(longitude, 5))
        if key in seen:
            continue
        seen.add(key)
        places.append(Place(name=name, display_name=display, latitude=latitude,
                            longitude=longitude, bounds=_place_bounds(item.get("boundingbox"))))
    return places


def _wait_turn(clock, sleep, interval: float) -> None:
    delay = interval - (clock() - _last_request[0])
    if delay > 0.0:
        sleep(delay)


def clear_cache() -> None:
    _cache.clear()


def search(query: str, *, version: str = "", language: str = "", endpoint: str = "",
           opener=None, timeout: float = TIMEOUT_S, clock=time.monotonic, sleep=time.sleep,
           interval: float = MIN_INTERVAL_S) -> list[Place]:
    """Search for places by name or address; raises GeocodeError."""
    text = " ".join(str(query).split())
    if not text:
        raise GeocodeError("Enter a place to search for")
    if len(text) > QUERY_LIMIT:
        raise GeocodeError(f"Search text is limited to {QUERY_LIMIT} characters")
    url = search_url(text, language=language, endpoint=endpoint)
    if url in _cache:
        _cache.move_to_end(url)
        return list(_cache[url])

    request = urllib.request.Request(url, headers={
        "User-Agent": user_agent(version), "Accept": "application/json"})
    _wait_turn(clock, sleep, interval)
    try:
        with (opener or urllib.request.urlopen)(request, timeout=timeout) as response:
            body = response.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as exc:
        if exc.code == 429:
            raise GeocodeError("Place search is busy; wait a minute and try again") from None
        raise GeocodeError(f"Place search failed (HTTP {exc.code})") from None
    except (urllib.error.URLError, OSError) as exc:
        reason = getattr(exc, "reason", exc)
        if isinstance(reason, (socket.timeout, TimeoutError)) or isinstance(exc, (socket.timeout, TimeoutError)):
            raise GeocodeError("Place search timed out; check the internet connection") from None
        print(f"Jarvizar place search: {exc!r}")
        raise GeocodeError("Could not reach the place search; check the internet connection") from None
    finally:
        _last_request[0] = clock()
    if len(body) > MAX_RESPONSE_BYTES:
        raise GeocodeError("Place search returned an unexpected response")
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise GeocodeError("Place search returned an unexpected response") from None
    places = parse_results(payload)
    _cache[url] = tuple(places)
    while len(_cache) > _CACHE_SIZE:
        _cache.popitem(last=False)
    return places
