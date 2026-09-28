"""Typed coordinates, Nominatim URLs and response parsing. Never touches the network."""

import io
import json
import math
import os
import socket
import unittest
from unittest import mock
import urllib.error
import urllib.request

from jarvizar_city_model.data import geocode

# Trimmed from a real jsonv2 response: strings for numbers, and boundingbox
# as min lat, max lat, min lon, max lon.
EIFFEL = [
    {
        "place_id": 81950000, "licence": "Data © OpenStreetMap contributors, ODbL 1.0.",
        "osm_type": "way", "osm_id": 5013364, "lat": "48.8582599", "lon": "2.2945006",
        "category": "man_made", "type": "tower", "place_rank": 30, "importance": 0.61,
        "addresstype": "man_made", "name": "Tour Eiffel",
        "display_name": "Tour Eiffel, 5, Avenue Anatole France, Quartier du Gros-Caillou, "
                        "Paris 7e Arrondissement, Paris, Île-de-France, France métropolitaine, 75007, France",
        "boundingbox": ["48.8574753", "48.8590453", "2.2933119", "2.2956897"],
    },
    {
        "place_id": 81950001, "lat": "32.8870", "lon": "-97.0880", "name": "",
        "display_name": "Eiffel Tower, Paris, Lamar County, Texas, United States",
        "boundingbox": ["32.88", "32.89", "-97.09", "-97.08"],
    },
]


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


class FakeOpener:
    def __init__(self, body=b"[]", error=None):
        self.body, self.error, self.requests = body, error, []

    def __call__(self, request, timeout=None):
        self.requests.append((request, timeout))
        if self.error is not None:
            raise self.error
        return FakeResponse(self.body)


def refuse_network(*args, **kwargs):
    raise AssertionError("tests must not use the network")


class CoordinateTests(unittest.TestCase):
    def place(self, text):
        return geocode.parse_coordinates(text)

    def test_reads_latitude_then_longitude(self):
        for text in ("41.8781, -87.6298", "41.8781,-87.6298", "41.8781 -87.6298", " 41.8781 ; -87.6298 ",
                     "41.8781° N, 87.6298° W", "41.8781N 87.6298W", "+41.8781, −87.6298"):
            with self.subTest(text=text):
                place = self.place(text)
                self.assertEqual((place.latitude, place.longitude), (41.8781, -87.6298))
                self.assertEqual(place.name, "41.8781, -87.6298")
        place = self.place("33.8568 S, 151.2153 E")
        self.assertEqual((place.latitude, place.longitude), (-33.8568, 151.2153))
        self.assertEqual((self.place("0, 0").latitude, self.place(".5 .25").longitude), (0.0, 0.25))

    def test_place_names_and_postcodes_are_left_to_the_search(self):
        for text in ("Eiffel Tower", "10 Downing Street", "75007", "00-950", "SW1A 2AA", "", "   ",
                     "news", "Route 66", "5 E"):
            with self.subTest(text=text):
                self.assertIsNone(self.place(text))

    def test_refuses_ambiguous_or_wrong_coordinates(self):
        cases = {
            "-122.4194, 37.7749": "first number is the latitude",
            "41.88, 187.2": "Longitude must be between",
            "41,88": "decimal point",
            "41,88, -87,63": "decimal point",
            "-87.64,41.87,-87.60,41.89": "bounding box",
            "41.8, -87.6, 200": "Could not read two numbers",
            "-41.88 S, 87.6 E": "sign or a hemisphere letter",
            "41°52′55″N 87°37′40″W": "Could not read two numbers",
            "87.6298 W, 41.8781 N": "Could not read two numbers",
        }
        for text, message in cases.items():
            with self.subTest(text=text):
                with self.assertRaises(geocode.GeocodeError) as caught:
                    self.place(text)
                self.assertIn(message, str(caught.exception))


class UrlTests(unittest.TestCase):
    def test_search_url(self):
        with mock.patch.dict(os.environ, {geocode.URL_ENVIRONMENT: ""}):
            self.assertEqual(geocode.search_url("Eiffel Tower"),
                             "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=Eiffel+Tower")
            self.assertEqual(geocode.search_url("Köln & Bonn", language="de-DE,de"),
                             "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5"
                             "&q=K%C3%B6ln+%26+Bonn&accept-language=de-DE%2Cde")

    def test_the_service_can_be_switched_without_an_update(self):
        with mock.patch.dict(os.environ, {geocode.URL_ENVIRONMENT: "https://geo.example.com/search"}):
            self.assertTrue(geocode.search_url("x").startswith("https://geo.example.com/search?format=jsonv2"))
        with mock.patch.dict(os.environ, {geocode.URL_ENVIRONMENT: "file:///etc/passwd"}):
            with self.assertRaises(geocode.GeocodeError):
                geocode.search_url("x")

    def test_language_and_user_agent(self):
        self.assertEqual(geocode.language_code("en_US"), "en-US,en")
        self.assertEqual(geocode.language_code("fr"), "fr")
        self.assertEqual(geocode.language_code("zh_HANS"), "zh-HANS,zh")
        self.assertEqual(geocode.language_code(""), "")
        self.assertEqual(geocode.language_code("../x"), "")
        self.assertEqual(geocode.user_agent("0.25.8"), "JarvizarCityModel/0.25.8 (Blender add-on)")


class ParseTests(unittest.TestCase):
    def test_reads_names_positions_and_place_bounds(self):
        first, second = geocode.parse_results(EIFFEL)
        self.assertEqual(first.name, "Tour Eiffel")
        self.assertTrue(first.display_name.startswith("Tour Eiffel, 5, Avenue Anatole France"))
        self.assertEqual((first.latitude, first.longitude), (48.8582599, 2.2945006))
        self.assertEqual(first.bounds, (2.2933119, 48.8574753, 2.2956897, 48.8590453))
        self.assertEqual(second.name, "Eiffel Tower")

    def test_an_address_is_named_by_house_number_and_street(self):
        place, = geocode.parse_results([{
            "lat": "51.5034", "lon": "-0.1276", "name": "",
            "display_name": "10, Downing Street, St. James's, Westminster, London, SW1A 2AA, United Kingdom"}])
        self.assertEqual(place.name, "10 Downing Street")

    def test_skips_unusable_entries_and_repeats(self):
        payload = [
            {"lat": "nan", "lon": "2.0", "display_name": "Bad"},
            {"lon": "2.0", "display_name": "No latitude"},
            {"lat": "95", "lon": "2.0", "display_name": "Off the globe"},
            "not a result",
            {"lat": "10", "lon": "20", "display_name": "Here", "boundingbox": ["11", "10", "20", "21"]},
            {"lat": "10.000001", "lon": "20", "display_name": "here"},
        ]
        places = geocode.parse_results(payload)
        self.assertEqual([place.display_name for place in places], ["Here"])
        self.assertIsNone(places[0].bounds)

    def test_an_error_object_is_not_a_result_list(self):
        with self.assertRaises(geocode.GeocodeError):
            geocode.parse_results({"error": {"code": 400, "message": "Nothing to search for."}})


class SearchTests(unittest.TestCase):
    def setUp(self):
        geocode.clear_cache()
        geocode._last_request[0] = -math.inf
        patcher = mock.patch.object(urllib.request, "urlopen", refuse_network)
        patcher.start()
        self.addCleanup(patcher.stop)
        environment = mock.patch.dict(os.environ, {geocode.URL_ENVIRONMENT: ""})
        environment.start()
        self.addCleanup(environment.stop)

    def search(self, query, opener, **options):
        options.setdefault("interval", 0.0)
        return geocode.search(query, version="1.2.3", opener=opener, **options)

    def test_sends_one_identified_request_and_caches_it(self):
        opener = FakeOpener(json.dumps(EIFFEL).encode("utf-8"))
        places = self.search("  Eiffel   Tower ", opener, language="en-US,en")
        self.assertEqual(len(places), 2)
        request, timeout = opener.requests[0]
        self.assertEqual(request.full_url, "https://nominatim.openstreetmap.org/search?format=jsonv2"
                                           "&limit=5&q=Eiffel+Tower&accept-language=en-US%2Cen")
        self.assertEqual(request.get_header("User-agent"), "JarvizarCityModel/1.2.3 (Blender add-on)")
        self.assertEqual(timeout, geocode.TIMEOUT_S)
        self.assertEqual(self.search("Eiffel Tower", opener, language="en-US,en"), places)
        self.assertEqual(len(opener.requests), 1)

    def test_waits_a_second_between_requests(self):
        sleeps = []
        opener = FakeOpener()
        self.search("first", opener, clock=lambda: 100.0, sleep=sleeps.append, interval=1.0)
        self.search("second", opener, clock=lambda: 100.25, sleep=sleeps.append, interval=1.0)
        self.assertEqual(sleeps, [0.75])

    def test_failures_give_short_messages(self):
        http = lambda code: urllib.error.HTTPError("https://x", code, "error", {}, None)
        cases = (
            (FakeOpener(error=http(429)), "busy"),
            (FakeOpener(error=http(503)), "HTTP 503"),
            (FakeOpener(error=urllib.error.URLError(OSError("getaddrinfo failed"))), "Could not reach"),
            (FakeOpener(error=urllib.error.URLError(socket.timeout("timed out"))), "timed out"),
            (FakeOpener(error=socket.timeout("timed out")), "timed out"),
            (FakeOpener(b"<html>maintenance</html>"), "unexpected response"),
            (FakeOpener(b"[" + b" " * geocode.MAX_RESPONSE_BYTES + b"]"), "unexpected response"),
        )
        for index, (opener, message) in enumerate(cases):
            with self.subTest(message=message), mock.patch("builtins.print"):
                with self.assertRaises(geocode.GeocodeError) as caught:
                    self.search(f"query {index}", opener)
                self.assertIn(message, str(caught.exception))

    def test_refuses_empty_or_long_text_without_a_request(self):
        opener = FakeOpener()
        for query in ("", "   ", "x" * (geocode.QUERY_LIMIT + 1)):
            with self.subTest(query=query[:10]), self.assertRaises(geocode.GeocodeError):
                self.search(query, opener)
        self.assertEqual(opener.requests, [])


if __name__ == "__main__":
    unittest.main()
