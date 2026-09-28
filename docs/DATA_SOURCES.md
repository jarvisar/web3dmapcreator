# Data Sources and Attribution

The site downloads map data from these sources when you generate a model. It doesn't include or redistribute any map data. Check the current terms of each source for your use.

## Overture Maps

Buildings, roads, railways, water, land, land use, land cover and infrastructure come from the latest [Overture Maps Foundation](https://overturemaps.org) release. They're read straight from Overture's GeoParquet files on Amazon S3. The release used is shown after a model is generated.

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

Some building footprints come from other sources (Esri Community Maps and Google Open Buildings under CC BY 4.0, Microsoft Global ML Building Footprints under ODbL). See Overture's [attribution page](https://docs.overturemaps.org/attribution/).

## Elevation

Terrain heights come from the AWS Terrain Tiles open dataset (`elevation-tiles-prod`, Terrarium encoding). Its [attribution list](https://github.com/tilezen/joerd/blob/master/docs/attribution.md) covers the sources below. Use the lines that apply to your area.

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

## Map and place search

The map on the site uses [OpenFreeMap](https://openfreemap.org) vector tiles (© OpenFreeMap, © OpenMapTiles, data © OpenStreetMap contributors). The satellite option uses Esri World Imagery. Place search uses [Photon](https://photon.komoot.io) by komoot, which searches OpenStreetMap data. Your search text is sent to Photon.

## Printed models

Exported 3MF files carry the map-data attribution in their metadata, and STL files carry it in their header.

Under the ODbL a printed model made from this data is a Produced Work. If you sell or display one publicly, include the attribution with it, for example on the product listing, the packaging or a label on the base. This is not legal advice.
