# Data Sources and Attribution

The add-on downloads map data when **Download / Cache Data** is pressed. It does
not include or redistribute any map data. Check the current terms of each source
for your use.

## Overture Maps

Buildings, roads, railways, water, land, land use, land cover and
infrastructure come from the [Overture Maps Foundation](https://overturemaps.org)
through the official `overturemaps` Python client. The release used is recorded
in each cache bundle's `manifest.json`.

| Overture theme | Used for | License |
| --- | --- | --- |
| Buildings | Buildings and building parts | ODbL |
| Transportation | Roads, paths, railways, bridges | ODbL |
| Base: land, water, land use, infrastructure | Water cuts, parks, piers, airports | ODbL |
| Base: land cover | Forest and other land cover | ODbL, with ESA WorldCover content under CC BY 4.0 |

Attribution:

```text
© OpenStreetMap contributors, Overture Maps Foundation
```

Land cover also requires:

```text
© ESA WorldCover project 2020 / Contains modified Copernicus Sentinel data (2020) processed by ESA WorldCover consortium
```

Some building footprints come from other sources (Esri Community Maps and Google
Open Buildings under CC BY 4.0, Microsoft Global ML Building Footprints under
ODbL). See Overture's [attribution page](https://docs.overturemaps.org/attribution/).

## Elevation

Terrain heights come from the AWS Terrain Tiles open dataset
(`elevation-tiles-prod`, Terrarium encoding). Its
[attribution list](https://github.com/tilezen/joerd/blob/master/docs/attribution.md)
covers the sources below; use the lines that apply to your area.

- ArcticDEM terrain data DEM(s) were created from DigitalGlobe, Inc., imagery and funded under National Science Foundation awards 1043681, 1559691, and 1542736
- Australia terrain data © Commonwealth of Australia (Geoscience Australia) 2017
- Austria terrain data © offene Daten Österreichs – Digitales Geländemodell (DGM) Österreich
- Canada terrain data contains information licensed under the Open Government Licence – Canada
- Europe terrain data produced using Copernicus data and information funded by the European Union - EU-DEM layers
- Global ETOPO1 terrain data U.S. National Oceanic and Atmospheric Administration
- Mexico terrain data source: INEGI, Continental relief, 2016
- New Zealand terrain data Copyright 2011 Crown copyright (c) Land Information New Zealand and the New Zealand Government (All rights reserved)
- Norway terrain data © Kartverket
- United Kingdom terrain data © Environment Agency copyright and/or database right 2015. All rights reserved
- United States 3DEP (formerly NED) and global GMTED2010 and SRTM terrain data courtesy of the U.S. Geological Survey

## LiDAR (optional)

Prepared LiDAR buildings use public surveys such as USGS 3DEP, IGN LiDAR HD,
NRCan, Environment Agency England and others. Each survey's licence and
attribution is stored with the prepared buildings and shown in the LiDAR offer
details. See [official LiDAR sources](LIDAR_OFFICIAL_SOURCES.md).

## Printed models

Under the ODbL a printed model made from this data is a Produced Work. If you
sell or display one publicly, include the attribution with it, for example on
the product listing, the packaging or a label on the base. This is not legal
advice.
