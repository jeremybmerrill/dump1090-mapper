make maps of planes
===================

a node app to generate a map of an airplane's flight path, using its ICAO address and a [mtigas/dump1090-stream-parser](https://github.com/mtigas/dump1090-stream-parser) database

`nodejs mapify.js ACB963` will generate an SVG map of the most recent path of the NYPD helicopter with the registration number N919PD.

`nodejs mapify.js ACB963 --n-number N920PD` will do the same, but using the aircraft's registration number instead of its ICAO hex address in the map.

`nodejs mapify.js ACB963 --n-number N920PD --start-time '2019-04-02 03:51:57' --end-time '2019-04-02 04:37:38'` will map the trajectory of the aircraft between 3:51am and 4:37am  on 4/2/2019 (rather than the most recent trajectory).

```
Usage: mapify [options]

Options:
  -V, --version                       output the version number
  -n, --n-number [N12345]             aircraft N-Number (or other label)
  -s, --start-time [mysqlFormatTime]  start time for trajectory to be mapped (must also supply end-time), e.g. 2019-04-02 04:37:38)
  -e, --end-time [mysqlFormatTime]    end time for trajectory to be mapped (must also supply start-time, e.g. 2019-04-02 04:37:38)
  -b, --exclude-background            Exclude the map background/labels; show just trajectory
  -h, --help                          output usage information
```

`sh mapify.sh ACB963` will generate a PNG map (by creating the SVG, then converting it to PNG with Apache Batik)

If your MySQL database is not named `dump1090` or isn't accessible by the current user on localhost, specify how to reach it with the environment variables `MYSQLHOST`, `MYSQLPORT`, `MYSQLUSER`, `MYSQLPASSWORD` and `MYSQLDATABASE`.

prereqs and dependencies
------------------------

  - ADSB radio, etc.
  - github.com/mutability/dump1090
  - github.com/mtigas/dump1090-stream-parser (which requires a MySQL database someplace)
  - a mysql client
  - nodejs, etc.
  - the mapify.sh script depends on [csvkit](https://github.com/wireservice/csvkit)'s `csvcut` and Java for Apache Batik. These are not hard dependencies; it's just conveniences for converting SVG image to PNG image and a US N-Number to an ICAO address.


TODO
----

  - plane path should indicate altitude or speed or something with a gradient (https://developer.mozilla.org/en-US/docs/Web/SVG/Tutorial/Gradients)
  - maybe label airports?
  - use an API or the FAA airplane ownership database to allow planes to be specified by registration, not ICAO address.
  - map drones. this gets model codes: grep "DJI " ACFTREF.txt | csvcut -c 1, which are in MASTER

Some useful resources.
- http://geoexamples.com/d3/2015/05/29/d3-maps-nodejs.html
- https://bost.ocks.org/mike/map/
- http://stackoverflow.com/questions/5433806/convert-embedded-svg-to-png-in-place


Location and Zoom
-----------------

The base map is centered around New York City: it includes county boundaries and airports in New York, New Jersey and Connecticut, and additional features in New York City. The zoom mechanism assumes your ADSB receiver has the same boundaries (or close to it) as mine. Generalizing this is work that still remains to be done (and I'm probably not going to do it... but I'd happily accept pull requests with data for other cities).

I made the bridges by taking a road shapefile, taking the difference from the land area of NYC (to get just over-water sections of road), then filtering by length to eliminate the tiny little bridges along the Belt Pkwy, then took multipart to singlepart, buffered and exported.
