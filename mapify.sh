#!/bin/bash 


# I have a dream of converting an N-Number to a ICAO address, but whatever
# ./get_faa_db.sh
# NNUM = $(csvcut -c 1,34 MASTER.txt | grep "$1") # | sed -Ei "s/[A-Z0-9]+,//g"
# # echo $NNUM
# # svgfn = mapify.js $nnum
SVGFN=$(./mapify.js $1)
java -jar batik-1.8/batik-rasterizer-1.8.jar ${SVGFN}