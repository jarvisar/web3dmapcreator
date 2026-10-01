# Data Sources and Attribution

The site downloads map data from these sources when you generate a model or an SVG map. It doesn't include or redistribute any map data. Check the current terms of each source for your use.

## Overture Maps

Buildings, roads, railways, water, land, land use, land cover and infrastructure come from the latest [Overture Maps Foundation](https://overturemaps.org) release. They're read straight from Overture's GeoParquet files on Amazon S3. The release used is shown after a model is generated.

| Overture theme | Used for | License |
| --- | --- | --- |
| Buildings | Buildings and building parts | ODbL |
| Transportation | Roads, paths, railways, bridges | ODbL |
| Base: land, water, land use, infrastructure | Water cuts, parks, piers, airports | ODbL |
| Base: land cover | Satellite forest and grass, when `Satellite land cover` or `Scatter in satellite forest` is on | ODbL, with ESA WorldCover content under CC BY 4.0 |

Attribution:

```text
© OpenStreetMap contributors, Overture Maps Foundation
```

Models made with land cover also need:

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

## LiDAR

Only downloaded for LiDAR buildings (`LiDAR` on) and LiDAR only models. The surveys a model used are listed under `Model details` and in the attribution of exported 3MF files.

| Source | Where | License |
| --- | --- | --- |
| [USGS 3DEP](https://www.usgs.gov/3d-elevation-program), through [Hobu's EPT mirror](https://github.com/hobuinc/usgs-lidar), and USGS's own LAZ for work units the mirror lacks | United States | Public domain |
| [NOAA Digital Coast](https://coast.noaa.gov/digitalcoast/) | United States and its territories, mostly coasts and cities | Public domain, attribution requested. Some local surveys ask for credit to their agency, like NYC DoITT |
| [KyFromAbove](https://kyfromabove.ky.gov/) | Kentucky | Public domain with attribution |
| [IndianaMap elevation](https://registry.opendata.aws/in-elevation/) | Indiana's Lake Michigan shore | CC0 |
| [Illinois Height Modernization](https://clearinghouse.isgs.illinois.edu/data/elevation/illinois-height-modernization-ilhmp), ISGS | Illinois | No restrictions |
| [WisconsinView](https://www.sco.wisc.edu/data/elevationlidar/) | Madison, Milwaukee and the 2024 Wisconsin counties | Public |
| [DC 2024 LiDAR](https://opendata.dc.gov/datasets/8035c633024e49c29a3ee1206a474e7a), DC OCTO | Washington, DC | CC0 |
| [Alaska DNR elevation](https://elevation.alaska.gov/) | Alaskan towns and villages | Public, no licence named |
| [NRCan CanElevation](https://open.canada.ca/data/en/dataset/7069387e-9986-4297-9f55-0288e9676947) | Canada | Open Government Licence - Canada |
| [GeoNB](https://geonb.snb.ca/) | New Brunswick | Open Government Licence - New Brunswick |
| [IGN LiDAR HD](https://geoservices.ign.fr/lidarhd) | France | Licence Ouverte 2.0 |
| [swisstopo swissSURFACE3D](https://www.swisstopo.admin.ch/en/height-model-swisssurface3d) | Switzerland, Liechtenstein | swisstopo open government data terms |
| [Geobasis NRW 3D-Messdaten](https://www.opengeodata.nrw.de/produkte/geobasis/hm/3dm_l_las/) | North Rhine-Westphalia | Datenlizenz Deutschland - Zero 2.0 |
| [LVermGeo RLP Laserscan](https://lvermgeo.rlp.de/) | Rhineland-Palatinate | Datenlizenz Deutschland - Namensnennung 2.0 |
| [LGB Brandenburg ALS](https://geobroker.geobasis-bb.de/) | Brandenburg | Datenlizenz Deutschland - Namensnennung 2.0 |
| [Geoportal Berlin ALS 2021](https://gdi.berlin.de/data/a_als/atom/0.atom) | Berlin | Datenlizenz Deutschland - Zero 2.0 |
| [LVermGeo Sachsen-Anhalt open data](https://www.lvermgeo.sachsen-anhalt.de/de/gdp-open-data.html) | Halle (Saale) | Datenlizenz Deutschland - Namensnennung 2.0 |
| [ACT Lidar 2024](https://data.public.lu/fr/datasets/lidar-2024-releve-3d-du-territoire-luxembourgeois/) | Luxembourg | CC0 |
| [Scottish Remote Sensing Portal](https://remotesensingdata.gov.scot/) | Scotland | Open Government Licence v3 |
| [GURS CLSS](https://clss.si/) | Slovenia | CC BY 4.0 |
| [geoEuskadi LiDAR](https://www.geo.euskadi.eus/) | Basque Country | CC BY 4.0 |
| [Provincia autonoma di Trento LiDAR](https://siat.provincia.tn.it/stem/) | Trentino | CC BY 4.0 |
| [Comune di Genova LAS 2018](https://mappe.comune.genova.it/MapStore2/) | Genoa | CC BY 4.0 |
| [City of Helsinki laser data](https://hri.fi/data/en_GB/dataset/helsingin-laserkeilausaineistot) | Helsinki | CC BY 4.0 |
| [City of Turku laser data 2021](https://www.avoindata.fi/data/fi/dataset/turun-kaupungin-kaupunkitietomalli) | Turku | CC BY 4.0 |
| Tokyo, Kanagawa and Yamanashi point clouds, through [G-Spatial Information Center](https://www.geospatial.jp/) | Tokyo, Yokohama, Yamanashi | CC BY 4.0 |
| Tokyo 23 wards, Open Nagasaki and Hyogo point clouds as COPC, through [AIST 3DDB](https://www.digiarc.aist.go.jp/team/gsvrt/information/) | Tokyo, Nagasaki, Kobe's hills | CC BY 4.0 |
| [PMSP M3DC](https://registry.opendata.aws/pmsp-lidar/) | São Paulo | GPL 3.0, as the city lists it |
| [OpenTopography](https://opentopography.org/) | New Zealand (LINZ), Montreal 2015 and research sites | Per dataset, cited by its DOI |
| [Open LiDAR Data](https://github.com/flai-ai/open-lidar-data) by Flai | Much of the rest of Europe | Per dataset, listed in its inventory |

Credit the survey's publisher, for example `LiDAR: IGN - LiDAR HD` or `LiDAR: USGS 3DEP`. The 3MF metadata already carries the credit each survey asks for, such as `Land NRW, Datenlizenz Deutschland - Zero - Version 2.0` or OpenTopography's dataset citation. For Open LiDAR Data, include the original agency and the dataset's license. [LiDAR sources](LIDAR_SOURCES.md) has more on each, and on the open surveys a browser can't read.

## Map, SVG maps and place search

The map on the site uses [OpenFreeMap](https://openfreemap.org) vector tiles (© OpenFreeMap, © OpenMapTiles, data © OpenStreetMap contributors). SVG maps are drawn from the same tiles, or from another source in the OpenMapTiles schema set under `Map data`. Models get their racetracks from these tiles too, since Overture leaves OpenStreetMap's raceways out. The satellite option uses Esri World Imagery. Place search uses [Photon](https://photon.komoot.io) by komoot, which searches OpenStreetMap data. Your search text is sent to Photon.

## Fonts

The SVG title fonts are Montserrat, Josefin Sans, Cinzel, Oswald, Bebas Neue and Bitter, under the SIL Open Font License. Their license files are next to them in `public/fonts`.

The Hershey Fonts were originally created by Dr. A. V. Hershey while working at the U.S. National Bureau of Standards. The format of the font data was originally created by James Hurt, Cognition, Inc. Glyph data from [hersheytext](https://github.com/techninja/hersheytextjs).

## Printed models

Exported 3MF files carry the map-data attribution in their metadata, and STL files carry it in their header. With LiDAR on, the 3MF metadata lists the surveys used as well. An STL header only has room for the map-data line.

A LiDAR only model uses no elevation tiles, and no map data unless `Water outlines from map data` is on (the default), so without it the 3MF metadata and STL header credit only the surveys.

An SVG map carries the attribution in its description (`<desc>`), along with the centre, bearing and scale it was made at. Credit "© OpenStreetMap contributors" on anything made from one that you publish or sell.

Under the ODbL a printed model made from this data is a Produced Work. If you sell or display one publicly, include the attribution with it, for example on the product listing, the packaging or a label on the base. This is not legal advice.
