"""WGS84-to-miniature coordinate conversion without external dependencies.

The conversion intentionally has two distinct stages:

* :class:`LocalENUProjection` converts WGS84 longitude, latitude, and ellipsoid
  height to a numerically stable local East/North/Up frame measured in metres.
* :class:`MiniatureTransform` scales that shared local frame into Blender model
  coordinates measured in millimetres.

Keeping the stages separate makes the metric coordinates useful to geometry
algorithms while guaranteeing that every generated feature uses one model
transform.  Heights are WGS84 ellipsoid heights; terrain providers that return
orthometric heights must apply their documented datum correction upstream.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import math
import re
from typing import Any, Dict, Tuple


# WGS84 defining constants.  Values derived from these are calculated rather
# than rounded so projection results are reproducible across supported Python
# versions.
WGS84_SEMI_MAJOR_AXIS_M = 6_378_137.0
WGS84_INVERSE_FLATTENING = 298.257_223_563
WGS84_FLATTENING = 1.0 / WGS84_INVERSE_FLATTENING
WGS84_ECCENTRICITY_SQUARED = WGS84_FLATTENING * (
    2.0 - WGS84_FLATTENING
)

Vector3 = Tuple[float, float, float]


def _finite_float(value: Any, name: str) -> float:
    """Return *value* as a finite float or raise a useful ``ValueError``."""

    if isinstance(value, bool):
        raise ValueError(f"{name} must be a finite number, not a boolean")
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be a finite number") from exc
    if not math.isfinite(number):
        raise ValueError(f"{name} must be finite")
    return number


def _validate_boundary_samples(value: Any) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 2:
        raise ValueError("boundary_samples must be an integer of at least 2")


@dataclass(frozen=True)
class WGS84Bounds:
    """A validated, non-antimeridian-crossing WGS84 bounding box."""

    west: float
    south: float
    east: float
    north: float

    def __post_init__(self) -> None:
        for name in ("west", "south", "east", "north"):
            object.__setattr__(self, name, _finite_float(getattr(self, name), name))

        if not -180.0 <= self.west <= 180.0:
            raise ValueError("west must be between -180 and 180 degrees")
        if not -180.0 <= self.east <= 180.0:
            raise ValueError("east must be between -180 and 180 degrees")
        if not -90.0 <= self.south <= 90.0:
            raise ValueError("south must be between -90 and 90 degrees")
        if not -90.0 <= self.north <= 90.0:
            raise ValueError("north must be between -90 and 90 degrees")
        if self.east <= self.west:
            raise ValueError(
                "east must be greater than west; antimeridian-crossing bounds "
                "are not supported"
            )
        if self.north <= self.south:
            raise ValueError("north must be greater than south")

    @property
    def center_longitude(self) -> float:
        return (self.west + self.east) * 0.5

    @property
    def center_latitude(self) -> float:
        return (self.south + self.north) * 0.5

    @property
    def width_degrees(self) -> float:
        return self.east - self.west

    @property
    def height_degrees(self) -> float:
        return self.north - self.south

    def contains(self, longitude: float, latitude: float) -> bool:
        """Return whether a WGS84 point lies inside the closed bounds."""

        lon = _finite_float(longitude, "longitude")
        lat = _finite_float(latitude, "latitude")
        return self.west <= lon <= self.east and self.south <= lat <= self.north

    def as_dict(self) -> Dict[str, float]:
        return {
            "west": self.west,
            "south": self.south,
            "east": self.east,
            "north": self.north,
        }


BOUNDS_TEXT_ORDER = ("west", "south", "east", "north")
BOUNDS_TEXT_EXAMPLE = "-84.53576,39.08541,-84.48473,39.11475"

_BOUNDS_TEXT_SEPARATORS = re.compile(r"[,;\s]+")
_BOUNDS_TEXT_WRAPPERS = "()[]{}<>\"' \t\r\n"


def parse_bounds_text(text: str) -> WGS84Bounds:
    """Read ``west,south,east,north`` decimal degrees out of one pasted line.

    That is what the Copy button on prochitecture.com/blender-osm puts on the
    clipboard, and what most bbox pickers emit.  Separators are read loosely --
    commas, semicolons, tabs, newlines, surrounding brackets and quotes, and a
    ``bbox=`` style prefix all mean the same thing -- but the *order* is never
    guessed.  Four numbers in another order describe a different place, and
    several other orders still validate as a legal box (a lat/lon swap of a
    Cincinnati box is a legal box in the Indian Ocean), so guessing would
    silently model the wrong city instead of reporting a problem.
    """

    if not isinstance(text, str):
        raise ValueError("Bounding-box text must be a string")
    cleaned = text.strip()
    if "=" in cleaned:
        # A box copied out of a URL or a query arrives as "bbox=w,s,e,n".
        cleaned = cleaned.rsplit("=", 1)[1]
    cleaned = cleaned.strip(_BOUNDS_TEXT_WRAPPERS)
    tokens = [token for token in _BOUNDS_TEXT_SEPARATORS.split(cleaned) if token]
    if len(tokens) != 4:
        raise ValueError(
            f"Expected 4 numbers as west,south,east,north; found {len(tokens)}"
        )
    values = []
    for name, token in zip(BOUNDS_TEXT_ORDER, tokens):
        try:
            values.append(_finite_float(token, name))
        except ValueError:
            raise ValueError(f"{name} is not a number: {token}") from None
    return WGS84Bounds(*values)


def format_degrees(value: float) -> str:
    """Render one degree value for a text field: exact, without trailing noise.

    Seven decimals is roughly a centimetre and is the precision the cache key
    is written at (:meth:`data.cache.Bounds.canonical`), so a box that passes
    through these fields lands in the cache directory it names.
    """

    number = _finite_float(value, "degrees")
    text = f"{number:.7f}".rstrip("0").rstrip(".")
    return "0" if text in ("", "-", "-0") else text


@dataclass(frozen=True)
class MetricBounds:
    """Axis-aligned horizontal bounds in a local metric frame."""

    min_east_m: float
    max_east_m: float
    min_north_m: float
    max_north_m: float

    @property
    def width_m(self) -> float:
        return self.max_east_m - self.min_east_m

    @property
    def height_m(self) -> float:
        return self.max_north_m - self.min_north_m

    def as_dict(self) -> Dict[str, float]:
        return {
            "min_east_m": self.min_east_m,
            "max_east_m": self.max_east_m,
            "min_north_m": self.min_north_m,
            "max_north_m": self.max_north_m,
            "width_m": self.width_m,
            "height_m": self.height_m,
        }


@dataclass(frozen=True)
class ModelBounds:
    """Axis-aligned horizontal bounds in miniature millimetres."""

    min_x_mm: float
    max_x_mm: float
    min_y_mm: float
    max_y_mm: float

    @property
    def width_mm(self) -> float:
        return self.max_x_mm - self.min_x_mm

    @property
    def height_mm(self) -> float:
        return self.max_y_mm - self.min_y_mm

    def as_dict(self) -> Dict[str, float]:
        return {
            "min_x_mm": self.min_x_mm,
            "max_x_mm": self.max_x_mm,
            "min_y_mm": self.min_y_mm,
            "max_y_mm": self.max_y_mm,
            "width_mm": self.width_mm,
            "height_mm": self.height_mm,
        }


@dataclass(frozen=True)
class LocalENUProjection:
    """WGS84 ECEF-to-local-ENU projection centred on a bounding box.

    This is a local tangent-plane projection, appropriate for the small city
    selections targeted by the add-on.  Longitude and latitude are in degrees;
    input height and returned East/North/Up coordinates are in metres.
    """

    bounds: WGS84Bounds
    reference_height_m: float = 0.0
    _origin_ecef: Vector3 = field(init=False, repr=False)
    _sin_lon: float = field(init=False, repr=False)
    _cos_lon: float = field(init=False, repr=False)
    _sin_lat: float = field(init=False, repr=False)
    _cos_lat: float = field(init=False, repr=False)

    def __post_init__(self) -> None:
        if not isinstance(self.bounds, WGS84Bounds):
            raise TypeError("bounds must be a WGS84Bounds instance")

        reference_height = _finite_float(
            self.reference_height_m, "reference_height_m"
        )
        object.__setattr__(self, "reference_height_m", reference_height)

        lon_radians = math.radians(self.origin_longitude)
        lat_radians = math.radians(self.origin_latitude)
        object.__setattr__(self, "_sin_lon", math.sin(lon_radians))
        object.__setattr__(self, "_cos_lon", math.cos(lon_radians))
        object.__setattr__(self, "_sin_lat", math.sin(lat_radians))
        object.__setattr__(self, "_cos_lat", math.cos(lat_radians))
        object.__setattr__(
            self,
            "_origin_ecef",
            self._geodetic_to_ecef(
                self.origin_longitude,
                self.origin_latitude,
                self.reference_height_m,
            ),
        )

    @property
    def origin_longitude(self) -> float:
        return self.bounds.center_longitude

    @property
    def origin_latitude(self) -> float:
        return self.bounds.center_latitude

    @staticmethod
    def _geodetic_to_ecef(
        longitude: float, latitude: float, height_m: float
    ) -> Vector3:
        lon = math.radians(longitude)
        lat = math.radians(latitude)
        sin_lat = math.sin(lat)
        cos_lat = math.cos(lat)
        prime_vertical_radius = WGS84_SEMI_MAJOR_AXIS_M / math.sqrt(
            1.0 - WGS84_ECCENTRICITY_SQUARED * sin_lat * sin_lat
        )

        x = (prime_vertical_radius + height_m) * cos_lat * math.cos(lon)
        y = (prime_vertical_radius + height_m) * cos_lat * math.sin(lon)
        z = (
            prime_vertical_radius * (1.0 - WGS84_ECCENTRICITY_SQUARED)
            + height_m
        ) * sin_lat
        return x, y, z

    def forward(
        self, longitude: float, latitude: float, height_m: float = 0.0
    ) -> Vector3:
        """Convert WGS84 longitude/latitude/height to local ENU metres.

        Points outside the original bounds are allowed so clipped source
        features can retain continuous geometry at the selection boundary.
        """

        lon = _finite_float(longitude, "longitude")
        lat = _finite_float(latitude, "latitude")
        height = _finite_float(height_m, "height_m")
        if not -180.0 <= lon <= 180.0:
            raise ValueError("longitude must be between -180 and 180 degrees")
        if not -90.0 <= lat <= 90.0:
            raise ValueError("latitude must be between -90 and 90 degrees")

        x, y, z = self._geodetic_to_ecef(lon, lat, height)
        dx = x - self._origin_ecef[0]
        dy = y - self._origin_ecef[1]
        dz = z - self._origin_ecef[2]

        east = -self._sin_lon * dx + self._cos_lon * dy
        north = (
            -self._sin_lat * self._cos_lon * dx
            - self._sin_lat * self._sin_lon * dy
            + self._cos_lat * dz
        )
        up = (
            self._cos_lat * self._cos_lon * dx
            + self._cos_lat * self._sin_lon * dy
            + self._sin_lat * dz
        )
        return east, north, up

    def inverse(
        self, east_m: float, north_m: float, up_m: float = 0.0
    ) -> Vector3:
        """Convert local ENU metres back to WGS84 longitude/latitude/height.

        Generators build road ribbons and scatter points directly in the local
        metric frame, then need the geographic position again to ask a terrain
        provider for an elevation.  Rotating back to ECEF is exact; the
        geodetic step uses Bowring's closed-form solution, which is accurate to
        well below a millimetre for terrestrial heights.
        """

        east = _finite_float(east_m, "east_m")
        north = _finite_float(north_m, "north_m")
        up = _finite_float(up_m, "up_m")

        # Transpose of the forward ENU rotation matrix.
        dx = (
            -self._sin_lon * east
            - self._sin_lat * self._cos_lon * north
            + self._cos_lat * self._cos_lon * up
        )
        dy = (
            self._cos_lon * east
            - self._sin_lat * self._sin_lon * north
            + self._cos_lat * self._sin_lon * up
        )
        dz = self._cos_lat * north + self._sin_lat * up

        x = dx + self._origin_ecef[0]
        y = dy + self._origin_ecef[1]
        z = dz + self._origin_ecef[2]
        return self._ecef_to_geodetic(x, y, z)

    @staticmethod
    def _ecef_to_geodetic(x: float, y: float, z: float) -> Vector3:
        semi_minor_axis = WGS84_SEMI_MAJOR_AXIS_M * (1.0 - WGS84_FLATTENING)
        second_eccentricity_squared = (
            WGS84_SEMI_MAJOR_AXIS_M * WGS84_SEMI_MAJOR_AXIS_M
            - semi_minor_axis * semi_minor_axis
        ) / (semi_minor_axis * semi_minor_axis)

        radius = math.hypot(x, y)
        longitude = math.degrees(math.atan2(y, x))
        if radius < 1.0e-9:
            latitude = 90.0 if z >= 0.0 else -90.0
            height = abs(z) - semi_minor_axis
            return longitude, latitude, height

        theta = math.atan2(z * WGS84_SEMI_MAJOR_AXIS_M, radius * semi_minor_axis)
        sin_theta = math.sin(theta)
        cos_theta = math.cos(theta)
        latitude_radians = math.atan2(
            z + second_eccentricity_squared * semi_minor_axis * sin_theta**3,
            radius
            - WGS84_ECCENTRICITY_SQUARED * WGS84_SEMI_MAJOR_AXIS_M * cos_theta**3,
        )
        sin_latitude = math.sin(latitude_radians)
        prime_vertical_radius = WGS84_SEMI_MAJOR_AXIS_M / math.sqrt(
            1.0 - WGS84_ECCENTRICITY_SQUARED * sin_latitude * sin_latitude
        )
        height = radius / math.cos(latitude_radians) - prime_vertical_radius
        return longitude, math.degrees(latitude_radians), height

    def horizontal_bounds(self, boundary_samples: int = 33) -> MetricBounds:
        """Calculate local horizontal bounds by sampling the bbox perimeter.

        A local ENU projection curves geographic rectangle edges slightly.  A
        perimeter sample therefore gives a safer fit than using only its four
        corners, while remaining negligible work for a one-time transform.
        """

        _validate_boundary_samples(boundary_samples)

        east_values = []
        north_values = []
        for index in range(boundary_samples):
            fraction = index / (boundary_samples - 1)
            longitude = self.bounds.west + self.bounds.width_degrees * fraction
            latitude = self.bounds.south + self.bounds.height_degrees * fraction
            perimeter_points = (
                (longitude, self.bounds.south),
                (longitude, self.bounds.north),
                (self.bounds.west, latitude),
                (self.bounds.east, latitude),
            )
            for lon, lat in perimeter_points:
                east, north, _up = self.forward(lon, lat, 0.0)
                east_values.append(east)
                north_values.append(north)

        metric_bounds = MetricBounds(
            min_east_m=min(east_values),
            max_east_m=max(east_values),
            min_north_m=min(north_values),
            max_north_m=max(north_values),
        )
        if metric_bounds.width_m <= 0.0 or metric_bounds.height_m <= 0.0:
            raise ValueError("bounds are too small to produce a stable local frame")
        return metric_bounds


@dataclass(frozen=True)
class MiniatureTransform:
    """Scale a local ENU projection into a printable millimetre footprint."""

    projection: LocalENUProjection
    target_width_mm: float = 0.0
    target_height_mm: float = 0.0
    preserve_aspect: bool = True
    boundary_samples: int = 33
    # When set, the model is built at this exact scale and the target
    # dimensions are ignored.  A printable map is designed around real feature
    # sizes -- a 6.5 m street must land on a printable ribbon width -- so the
    # scale is the input and the finished size is the consequence, not the
    # other way round.
    fixed_scale_mm_per_m: float | None = None
    metric_bounds: MetricBounds = field(init=False)
    scale_x_mm_per_m: float = field(init=False)
    scale_y_mm_per_m: float = field(init=False)
    scale_z_mm_per_m: float = field(init=False)
    model_bounds: ModelBounds = field(init=False)

    def __post_init__(self) -> None:
        if not isinstance(self.projection, LocalENUProjection):
            raise TypeError("projection must be a LocalENUProjection instance")
        if not isinstance(self.preserve_aspect, bool):
            raise ValueError("preserve_aspect must be a boolean")
        _validate_boundary_samples(self.boundary_samples)

        fixed_scale = self.fixed_scale_mm_per_m
        if fixed_scale is not None:
            fixed_scale = _finite_float(fixed_scale, "fixed_scale_mm_per_m")
            if fixed_scale <= 0.0:
                raise ValueError("fixed_scale_mm_per_m must be greater than zero")
            object.__setattr__(self, "fixed_scale_mm_per_m", fixed_scale)

        target_width = _finite_float(self.target_width_mm, "target_width_mm")
        target_height = _finite_float(self.target_height_mm, "target_height_mm")
        if fixed_scale is None:
            if target_width <= 0.0:
                raise ValueError("target_width_mm must be greater than zero")
            if target_height <= 0.0:
                raise ValueError("target_height_mm must be greater than zero")

        object.__setattr__(self, "target_width_mm", target_width)
        object.__setattr__(self, "target_height_mm", target_height)
        metric_bounds = self.projection.horizontal_bounds(self.boundary_samples)
        object.__setattr__(self, "metric_bounds", metric_bounds)

        if fixed_scale is not None:
            scale_x = fixed_scale
            scale_y = fixed_scale
        else:
            fit_x = target_width / metric_bounds.width_m
            fit_y = target_height / metric_bounds.height_m
            if self.preserve_aspect:
                uniform_scale = min(fit_x, fit_y)
                scale_x = uniform_scale
                scale_y = uniform_scale
            else:
                scale_x = fit_x
                scale_y = fit_y

        # Vertical dimensions must never inherit the larger scale when the map
        # is stretched non-uniformly.  This single conservative scale keeps
        # elevations/building heights internally consistent and predictable.
        scale_z = min(scale_x, scale_y)
        object.__setattr__(self, "scale_x_mm_per_m", scale_x)
        object.__setattr__(self, "scale_y_mm_per_m", scale_y)
        object.__setattr__(self, "scale_z_mm_per_m", scale_z)

        object.__setattr__(
            self,
            "model_bounds",
            ModelBounds(
                min_x_mm=metric_bounds.min_east_m * scale_x,
                max_x_mm=metric_bounds.max_east_m * scale_x,
                min_y_mm=metric_bounds.min_north_m * scale_y,
                max_y_mm=metric_bounds.max_north_m * scale_y,
            ),
        )

    def local_to_model(
        self, east_m: float, north_m: float, up_m: float = 0.0
    ) -> Vector3:
        """Scale local ENU metres to miniature XYZ millimetres."""

        east = _finite_float(east_m, "east_m")
        north = _finite_float(north_m, "north_m")
        up = _finite_float(up_m, "up_m")
        return (
            east * self.scale_x_mm_per_m,
            north * self.scale_y_mm_per_m,
            up * self.scale_z_mm_per_m,
        )

    def forward(
        self, longitude: float, latitude: float, height_m: float = 0.0
    ) -> Vector3:
        """Convert WGS84 longitude/latitude/height to miniature XYZ mm."""

        return self.local_to_model(
            *self.projection.forward(longitude, latitude, height_m)
        )

    # Explicit alias used by geometry code and UI-facing callers.
    geographic_to_model = forward

    def model_to_local(
        self, x_mm: float, y_mm: float, z_mm: float = 0.0
    ) -> Vector3:
        """Convert miniature millimetres back to local ENU metres."""

        return (
            _finite_float(x_mm, "x_mm") / self.scale_x_mm_per_m,
            _finite_float(y_mm, "y_mm") / self.scale_y_mm_per_m,
            _finite_float(z_mm, "z_mm") / self.scale_z_mm_per_m,
        )

    def model_to_geographic(
        self, x_mm: float, y_mm: float, z_mm: float = 0.0
    ) -> Vector3:
        """Convert miniature millimetres back to WGS84 longitude/latitude/height."""

        return self.projection.inverse(*self.model_to_local(x_mm, y_mm, z_mm))

    def local_to_geographic(
        self, east_m: float, north_m: float, up_m: float = 0.0
    ) -> Vector3:
        """Convert local ENU metres back to WGS84 longitude/latitude/height."""

        return self.projection.inverse(east_m, north_m, up_m)

    def vertical_meters_to_model_mm(self, distance_m: float) -> float:
        """Scale a relative vertical distance using the one shared Z scale."""

        return _finite_float(distance_m, "distance_m") * self.scale_z_mm_per_m

    @property
    def bounds_metadata(self) -> Dict[str, Any]:
        """Return JSON-serializable bounds and scale metadata."""

        return {
            "geographic_wgs84": self.projection.bounds.as_dict(),
            "origin_wgs84": {
                "longitude": self.projection.origin_longitude,
                "latitude": self.projection.origin_latitude,
                "height_m": self.projection.reference_height_m,
            },
            "local_enu_m": self.metric_bounds.as_dict(),
            "model_mm": self.model_bounds.as_dict(),
            "target_mm": {
                "width": self.target_width_mm,
                "height": self.target_height_mm,
            },
            "scale_mm_per_m": {
                "x": self.scale_x_mm_per_m,
                "y": self.scale_y_mm_per_m,
                "z": self.scale_z_mm_per_m,
            },
            "scale_ratio": self.scale_ratio,
            "scale_mode": "fixed" if self.fixed_scale_mm_per_m else "fit",
            "preserve_aspect": self.preserve_aspect,
        }

    @property
    def scale_ratio(self) -> float:
        """Return N in a 1:N scale ratio, using the horizontal scale."""

        return 1000.0 / self.scale_x_mm_per_m

    def real_metres_for_model_mm(self, millimetres: float) -> float:
        """Return the real-world width a printed millimetre corresponds to.

        This is the question that decides whether a road class survives: a
        0.45 mm minimum printable ribbon is 6.4 m of real street at 0.07 mm/m
        but 13.6 m at half that scale, which is why the same setting can look
        correct at one scale and far too coarse at another.
        """

        return _finite_float(millimetres, "millimetres") / self.scale_x_mm_per_m


def create_miniature_transform(
    west: float,
    south: float,
    east: float,
    north: float,
    target_width_mm: float,
    target_height_mm: float,
    preserve_aspect: bool = True,
) -> MiniatureTransform:
    """Convenience factory that fits a bbox into a target rectangle."""

    bounds = WGS84Bounds(west=west, south=south, east=east, north=north)
    projection = LocalENUProjection(bounds)
    return MiniatureTransform(
        projection=projection,
        target_width_mm=target_width_mm,
        target_height_mm=target_height_mm,
        preserve_aspect=preserve_aspect,
    )


def create_fixed_scale_transform(
    west: float,
    south: float,
    east: float,
    north: float,
    mm_per_metre: float,
) -> MiniatureTransform:
    """Convenience factory for a model built at an exact printing scale."""

    bounds = WGS84Bounds(west=west, south=south, east=east, north=north)
    projection = LocalENUProjection(bounds)
    return MiniatureTransform(
        projection=projection,
        fixed_scale_mm_per_m=mm_per_metre,
    )

