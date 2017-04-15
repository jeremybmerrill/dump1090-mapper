#!/bin/bash 

#
# creates a PNG map of the most recent observed flight of a plane
# specified as an ICAO hex address OR an N-Number
# 
# this should probably be refactored to use a sqlite database (with just N-number and ICAO)
# rather than csvcut and grep over the whole MASTER.txt
# but then the very first run would be SUPER slow because you'd have to go to the FAA to download the DB
# then load it into sqlite and index it...
#
# by Jeremy B. Merrill
# June 2016
# https://github.com/jeremybmerrill/dump1090-mapper

# goes to the FAA and downloads, unzips the latest database (god help you if the URL format changes)
./get_faa_db.sh

# TODO: skip this step if it matches /[A-F0-9a-f]{6}/

# gets the ICAO address by grepping a list of N-Numbers and ICAO hex addresses
# if the user supplies an ICAO address, it'll still be the result from grep.
# $NNUM looks something like `917PD,ACB1F5`
NNUM=$(csvcut -c 1,34 MASTER.txt | grep $1 | head -n1) 
echo $NNUM
# if there is no match, e.g. non-US planes,
# just try the argument the user gave, hopefully...
# it's a valid ICAO hex address that's in the database
if [ -z "$NNUM" ]; then
  NNUM=$1
fi

# get just the ICAO address out of NNUM
ICAO=$(echo $NNUM | sed -E "s/[A-Z0-9]+,//gi")

# now the fun part: running mapify.js to generate map; return value is the filename of the SVG
SVGFN=$(./mapify.js $ICAO)

# turn the SVG into a PNG with Batik.
java -jar batik-1.8/batik-rasterizer-1.8.jar ${SVGFN}