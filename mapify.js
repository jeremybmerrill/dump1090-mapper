#!/usr/bin/env node

// http://kartograph.org/

var d3 = require('d3');
var _ = require('underscore');
var async = require('async');
var topojson = require('topojson');
var mysql      = require('mysql');
var fs = require('fs');
var jsdom = require('jsdom');
var gju =      require('geojson-utils');
var commander = require('commander');
 
commander
  .version('0.0.0')
  .option('-n, --n-number <N12345>', 'aircraft N-Number (or other label)')
  .option('-s, --start-time <mysqlFormatTime>', 'start time for trajectory to be mapped (must also supply end-time), e.g. 2019-04-02 04:37:38)')
  .option('-e, --end-time <mysqlFormatTime>', 'end time for trajectory to be mapped (must also supply start-time, e.g. 2019-04-02 04:37:38)')
  .option('-a, --arbitrary-marker <lonlat>', 'arbitrary point to be mapped, in lon,lat format, e.g. -73.9037267,40.708143')
  .option('-b, --exclude-background', 'Exclude the map background/labels; show just trajectory')
  .parse(process.argv);
 
// haversine formula. 
function distance(lat1, lon1, lat2, lon2){
  // var lat2 = 42.741; 
  // var lon2 = -71.3161; 
  // var lat1 = 42.806911; 
  // var lon1 = -71.290611; 

  var R = 3958.8; // 3958.8 mi; 6371 km 
  //has a problem with the .toRad() method below.
  var x1 = lat2-lat1;
  var dLat = x1.toRad();  
  var x2 = lon2-lon1;
  var dLon = x2.toRad();  
  var a = Math.sin(dLat/2) * Math.sin(dLat/2) + 
                  Math.cos(lat1.toRad()) * Math.cos(lat2.toRad()) * 
                  Math.sin(dLon/2) * Math.sin(dLon/2);  
  var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); 
  var d = R * c; 

  return d;
}
Number.prototype.toRad = function() {
 return this * Math.PI / 180;
}

function pointAtDistance(lat1_deg, lon1_deg, distance_mi, bearing_deg){
  R = 3958.8 // 3958.8 mi; 6371 km 
  bearing_rad = bearing_deg.toRad()

  lat1 = lat1_deg * (Math.PI / 180) // Current lat point converted to radians
  lon1 = lon1_deg * (Math.PI / 180) // Current long point converted to radians

  lat2 = Math.asin( Math.sin(lat1)*Math.cos(distance_mi/R) +
               Math.cos(lat1)*Math.sin(distance_mi/R)*Math.cos(bearing_rad))
  lon2 = lon1 + Math.atan2(Math.sin(bearing_rad)*Math.sin(distance_mi/R)*Math.cos(lat1),
                       Math.cos(distance_mi/R)-Math.sin(lat1)*Math.sin(lat2))
  return {lat: lat2 / (Math.PI / 180), lon: lon2 / (Math.PI / 180)}
}



input_icao_hex = commander.args[0]
input_type = "icao" // ENHANCEMENT: accept N number queries, translate them into ICAO hexes via FAA database.
airplane_nice_name = commander.nNumber
output_fn = airplane_nice_name + ".svg"
output_metadata_fn = airplane_nice_name + ".metadata.json" //# [include neighborhood names, start/end times]
include_background = !commander.excludeBackground
arbitrary_marker_location = commander.arbitraryMarker ? commander.arbitraryMarker.split(",").map((num) => parseFloat(num)) : null;
// I should probably invest in a cli args parser!
if (commander.startTime && commander.endTime){
  trajectory_start_time = commander.startTime // in mysql format, plz! -- and in UTC
  trajectory_end_time = commander.endTime // in mysql format, plz!  -- and in UTC
}else{
  trajectory_start_time = null
  trajectory_end_time = null 
}

var nyntas = JSON.parse(fs.readFileSync(__dirname +"/basemap/json/nynta_17a.json", 'utf8')).features;
var bridge_areas = JSON.parse(fs.readFileSync(__dirname +"/basemap/json/bridges_buffered.geojson", 'utf8')).features;

var connection = mysql.createConnection({
  host     : process.env.MYSQLHOST,
  port     : process.env.MYSQLPORT,
  user     : process.env.MYSQLUSER || process.env.MYSQLUSERNAME || process.env.USER,
  password : process.env.MYSQLPASSWORD,
  database : process.env.MYSQLDATABASE || 'dump1090'
});
MAX_TIME_DIFFERENCE_BETWEEN_TRAJECTORIES = process.env.MAXTIMEDIFF || 10 // minutes
MAX_UNMARKED_INTERPOLATION_SECS = 60 * 1000// milliseconds; how long between points to connect with a solid versus dotted line

function time_to_display(datetz){
  let split = datetz.toLocaleString("en-US", {timeZone: "America/New_York"}).split(", ");
  let timeChars = split[1].split('');
  timeChars.reverse();
  let revMeridian = timeChars.slice(0, 2);
  revMeridian.reverse();
  let meridian = revMeridian.join('');
  let revhhmm = timeChars.slice(6);
  revhhmm.reverse();
  let hhmm = revhhmm.join('');
  let date = split[0];
  return hhmm + " " + meridian + " " + date;
}


function mapPoints(this_trajectory_rows, this_trajectory_rows_grouped, include_background, cb){
  var this_trajectory_lats = _(this_trajectory_rows).reduce(function(memo, row){ if(row["lat"]){memo.push(row["lat"])}; return memo; }, [])
  var this_trajectory_lons = _(this_trajectory_rows).reduce(function(memo, row){ if(row["lon"]){memo.push(row["lon"])}; return memo; }, [])
  var max_lat = Math.max.apply(null, this_trajectory_lats);
  var min_lat = Math.min.apply(null, this_trajectory_lats);
  var avg_lat = this_trajectory_lats.reduce(function(a, b){ return a+b}) / this_trajectory_lats.length
  var mid_lat = (max_lat + min_lat) / 2
  var max_lon = Math.max.apply(null, this_trajectory_lons);
  var min_lon = Math.min.apply(null, this_trajectory_lons);
  var avg_lon = this_trajectory_lons.reduce(function(a, b){ return a+b}) / this_trajectory_lons.length
  var mid_lon = (max_lon + min_lon) / 2

  console.warn(this_trajectory_lons.length + " points");
  console.warn("Lat bounds: " + max_lat +" to " + min_lat  + "; mid: " + mid_lat)
  console.warn("Long bounds: " + max_lon +" to " + min_lon + "; mid: " + mid_lon)
  console.warn("Time: " + this_trajectory_rows[0]["generated_datetime"] + " to " + this_trajectory_rows[this_trajectory_rows.length - 1]["generated_datetime"])



  let features = this_trajectory_rows_grouped.map(function(grouped_rows){
    return {
        "type": "Feature",
        "properties": {
          "interpolated": grouped_rows.length == 2 && grouped_rows[1].timediff > MAX_UNMARKED_INTERPOLATION_SECS
        },
        "geometry": {
          "type": "LineString",
          "coordinates":  grouped_rows.map(function(row){ return [row["lon"], row["lat"]] }).reverse()
        }
    }
  })

  // linestring["features"][0]["geometry"]["coordinates"] = _(this_trajectory_rows).map(function(row){ return [row["lon"], row["lat"]]}).reverse();
  linestring = {
      "type": "FeatureCollection",
  }
  linestring["features"] = features;

  jsdom.env({
          html: "<html><head></head><body></body></html>",
          scripts: [
            __dirname + '/node_modules/d3/d3.min.js'
          ],
          done:
    function (err, window) {

      var width = 600,
          height = 600;
      // console.log("scale: 32000 * " + (8/Math.max(1,Math.abs(max_lat - min_lat), Math.abs(max_lon - min_lon)) ) )

      var zoom = 1.5 * Math.max((Math.abs(max_lat - min_lat) / 1.48), (Math.abs(max_lon - min_lon) / 1.87) ); // from 8 to 1

      // my receiver has a so, a range of 1.48 lat and 1.87 lon


      var projection = window.d3.geo.albers()
        .center([0, mid_lat])      // 41   [0, desired_latitude] 41
        .rotate([-1 * mid_lon, 0]) // 73.5 [-desired_longitude, 0] 

        .parallels([29.5,44.5])
        .scale( 32000  / zoom ) // 32000 gets you most of my SDR rnage.
        .translate([width / 2, height / 2]);
      var padding = 0
      var path = window.d3.geo.path()
        .projection(projection);

      window.d3.select("body").style("background-color", "#e6f2ff").style("overflow", "hidden");

// .solid{
//    stroke:solid;
// }

// .dashed{
//    stroke-dasharray: 5,5; 
// }

      var svg = window.d3.select("body").append("svg")
          .attr("width", width)
          .attr("height", height)
          .attr("xmlns", "http://www.w3.org/2000/svg");
      svg.append("rect")
          .attr("width", "100%")
          .attr("height", "100%")
          .attr("fill", "white");
      // basemap
      var nytopojson = JSON.parse(fs.readFileSync(__dirname +"/basemap/json/counties.json", 'utf8'));
      var nygeojson = topojson.feature(nytopojson, nytopojson.objects['counties']);
      if(include_background){ 
          svg.selectAll(".county") // selects path elements, will make them if they don't exist
              .data(nygeojson.features) // iterates over geo feature
              .enter() // adds feature if it doesn't exist as an element
              .append("path") // defines element as a path
              .attr("class", function(d) { return "county " + "state"+d.properties["STATEFP"]+ " " +"cty"+d.properties["COUNTYFP"]+ " " + d.properties["NAME"]; })
              .style("fill", "#ffffca")
              .style("stroke", "black")
              .attr("d", path) // path generator translates geo data to SVG
  
  
          svg.append("path")
            .datum(topojson.mesh(nytopojson, nytopojson.objects.counties, function(a, b) { return a !== b && (a.properties.STATEFP || '036') !== ( b.properties.STATEFP || '036'); })) // the five boros have a null STATEFP because they're from a different shapefile.
            .attr("d", path)
            .attr("class", "state-boundary")
            .style("fill", "none")
            .style("stroke", "black");
  
          svg.append("path")
            .datum(topojson.mesh(nytopojson, nytopojson.objects.counties, function(a, b) { return a !== b && (a.properties.STATEFP || '036') === ( b.properties.STATEFP || '036'); })) // the five boros have a null STATEFP because they're from a different shapefile.
            .attr("d", path)
            .attr("class", "county-boundary")
            .style("fill", "none")
            .style("stroke", "#ccc")
            .style("stroke-dasharray", "1");
  
          var bridgestopo = JSON.parse(fs.readFileSync(__dirname +"/basemap/json/bridges.json", 'utf8'));
          var bridgesgeo = topojson.feature(bridgestopo, bridgestopo.objects['bridges']);
          svg.selectAll(".bridge") // selects path elements, will make them if they don't exist
            .data(bridgesgeo.features) // iterates over geo feature
            .enter() // adds feature if it doesn't exist as an element
            .append("path") // defines element as a path
            .attr("class", function(d){ return "bridge " + d.properties.linearid; })
            .style("stroke", "#ddd")
            .style("stroke-width","0.5")
            .style("fill", "none")
            .attr("d", path) // path generator translates geo data to SVG
  
          var nycstufftopo = JSON.parse(fs.readFileSync(__dirname +"/basemap/json/nyc_parks_airports.json", 'utf8'));
          var nycstuffgeo = topojson.feature(nycstufftopo, nycstufftopo.objects['nyc_parks_airports']);
          svg.selectAll(".nycstuff") // selects path elements, will make them if they don't exist
            .data(nycstuffgeo.features) // iterates over geo feature (Parks, airports)
            .enter() // adds feature if it doesn't exist as an element
            .append("path") // defines element as a path
            .attr("class", function(d){ return "nycstuff " + d.properties["ntaname"]; })
            .style("fill", function(d){ return d.properties.ntaname == "Airport" ? "#ffcccc" : "#339933"; })
            .attr("d", path) // path generator translates geo data to SVG
          var airportstopo = JSON.parse(fs.readFileSync(__dirname +"/basemap/json/airports.json", 'utf8'));
          var airportsgeo = topojson.feature(airportstopo, airportstopo.objects['airports']);
          svg.selectAll(".airport") // selects path elements, will make them if they don't exist
            .data(airportsgeo.features) // iterates over geo feature
            .enter() // adds feature if it doesn't exist as an element
            .append("path") // defines element as a path
            .attr("class", function(d){ return "airport " + d.properties["LOCID"]; })
            .style("stroke", "#fff")
            .attr("d", path) // path generator translates geo data to SVG
      }

      // hovering location, if set on CLI.
      if (arbitrary_marker_location) {
        console.warn(arbitrary_marker_location);
        var arbitrary_marker = projection(arbitrary_marker_location); //[lon, lat], [-73.9637267, 40.678143]
        svg.selectAll("text.arbitrary-marker")
          .data([0])
          .enter()
          .append("circle")
            .attr("class", "arbitrary-marker")
            .attr("fill", "#4253f4")
            .attr("r", 8)
            .attr("cx", arbitrary_marker[0])
            .attr("cy", arbitrary_marker[1]);
      }

      let strokeWidth = 2;
      svg.selectAll('marker.airplane.start')
        .data([0]) // we're just defining this marker, data here doesn't matter
        .enter()
        .append('svg:marker')
          .attr('id', "marker-airplane-start")
          .attr('markerHeight', 15.0/strokeWidth)
          .attr('markerWidth', 15.0/strokeWidth)
          .attr('markerUnits', 'strokeWidth')
          .attr('orient', 'auto')
          .attr('refX', 0)
          .attr('refY', 0)
          .attr('viewBox', '-8 -5 16 10' )
          .append('svg:path')
            .attr('d', 'M 0,0 m -8,-5 L 8,0 L -8,5 Z' )
            .attr('fill', '#f00');
      svg.selectAll('marker.airplane.end')
        .data([0]) // we're just defining this marker, data here doesn't matter
        .enter()
        .append('svg:marker')
          .attr('id', "marker-airplane-end")
          .attr('markerHeight', 15.0/strokeWidth)
          .attr('markerWidth', 15.0/strokeWidth)
          .attr('markerUnits', 'strokeWidth')
          .attr('orient', 'auto')
          .attr('refX', 0)
          .attr('refY', 0)
          .attr('viewBox', '-8 -5 16 10' )
          .append('svg:path')
            .attr('d', 'M 0,0 m -8,-5 L 8,0 L -8,5 Z' )
            .attr('fill', '#f00');

      const util = require('util')

      svg.selectAll(".airplane") // selects path elements, will make them if they don't exist
        .data(linestring.features) // iterates over geo feature
        .enter() // adds feature if it doesn't exist as an element
        .append("path") // defines element as a path
        .attr("class", function(d){ return "airplane " + input_icao_hex + (d.properties.interpolated ? ' interp' : ''); })
        .attr("id", function(d, i){ return "airplane-" + i.toString() })
        .style("stroke", function(d){ return d.properties.interpolated ? "#ef6e17" : "#f00" })
        .style("stroke-width", strokeWidth)
        .style("stroke-dasharray", function(d){ return d.properties.interpolated ? "5,5" : "none" })
        .style("fill", "none")
        .attr("d", path) // path generator translates geo data to SVG
        .attr('marker-start', function(d,i){ return (i == linestring.features.length - 1) ? 'url(#marker-airplane-end)' : 'none' }) // this reversal is on purpose
        .attr('marker-end', function(d,i){ return (i == 0) ? 'url(#marker-airplane-start)' : 'none' }) // this reversal is on purpose

      // label the start and end points of the trajectory.
      var end_projected_coords = projection([this_trajectory_rows[this_trajectory_rows.length-1].lon, this_trajectory_rows[this_trajectory_rows.length-1].lat]);
      end_projected_coords[0] = end_projected_coords[0] + 10; // translate the label start 10px to the right.
      svg.selectAll("text.airplane-label.end")
        .data([0])
        .enter()
        .append("text")
          .attr("class", "airplane-label end")
          .attr("transform", function(d) { return "translate(" + end_projected_coords + ")"; })
          .text(function(d) { return include_background ? airplane_nice_name + " " + time_to_display(this_trajectory_rows[this_trajectory_rows.length-1].datetz) : ''; });

      var start_projected_coords = projection([this_trajectory_rows[0].lon, this_trajectory_rows[0].lat]);
      start_projected_coords[0] = start_projected_coords[0] + 10; // translate the label start 10px to the right.
      svg.selectAll("text.airplane-label.start")
        .data([0])
        .enter()
        .append("text")
          .attr("class", "airplane-label start")
          .attr("transform", function(d) { return "translate(" + start_projected_coords + ")"; })
          .text(function(d) { return include_background ? airplane_nice_name + " " +  time_to_display(this_trajectory_rows[0].datetz) : '';} );
      // stupidly, the D3 script tag is left in the generated SVG, so we have to remove it.
      //cb( "<html>" + window.d3.select("html").html().replace(/\<script[^<]*\<\/script\>/, '') + "</html>" );
      cb( window.d3.select("body").html().replace(/\<script[^<]*\<\/script\>/, '') );
    }
  });
}

function neighborhoodNamesForPoints(this_trajectory_rows){
  var neighborhood_name_counts = _(this_trajectory_rows).reduce(function(memo, row, idx){ 
    var nta = _(nyntas).find(function(nta){
      return gju.pointInPolygon({"type":"Point","coordinates":[row["lon"], row["lat"]]},
                 nta["geometry"]);
    });
    if(nta){
      memo[nta["properties"]["NTAName"]] = (memo[nta["properties"]["NTAName"]] || 0) + 1;
    }
    return memo;
  }, {});
  _(this_trajectory_rows).each(function(row){ 
    var nta = _(bridge_areas).find(function(nta){
      return gju.pointInPolygon({"type":"Point","coordinates":[row["lon"], row["lat"]]},
                 nta["geometry"]);
    });
    if(nta){
      neighborhood_name_counts[nta["properties"]["fullname"]] = (neighborhood_name_counts[nta["properties"]["fullname"]] || 0) + 1;
    }
  }, {});
  var neighborhood_names = _(Object.keys(neighborhood_name_counts)).chain().sortBy(function(name){ return -neighborhood_name_counts[name] }).reject(function(name){ return name.indexOf("park-cemetery-etc") > -1 }).map(function(name){ return name == "North Side-South Side" ? "Williamsburg" : name.split("-")}).flatten().value()

  return neighborhood_names;
}

function centerpointOfRows(this_trajectory_rows){
  // https://stackoverflow.com/questions/6671183/calculate-the-center-point-of-multiple-latitude-longitude-coordinate-pairs
  // Convert lat/lon (must be in radians) to Cartesian coordinates for each location.
  var xyzs = this_trajectory_rows.filter((row) => row.lat && row.lon ).map((row) => [Math.cos(row.lat * (Math.PI / 180)) * Math.cos(row.lon * (Math.PI / 180)), Math.cos(row.lat * (Math.PI / 180) ) * Math.sin(row.lon* (Math.PI / 180)), Math.sin(row.lat * (Math.PI / 180))])

  // Compute average x, y and z coordinates.
  var x = xyzs.reduce((memo, row) => memo + row[0], 0) / xyzs.length
  var y = xyzs.reduce((memo, row) => memo + row[1], 0) / xyzs.length
  var z = xyzs.reduce((memo, row) => memo + row[2], 0) / xyzs.length

  // Convert average x, y, z coordinate to latitude and longitude.
  var centerpoint_lon = Math.atan2(y, x) * (180 / Math.PI)
  var hyp = Math.sqrt(x * x + y * y)
  var centerpoint_lat = Math.atan2(z, hyp) * (180 / Math.PI)

  var dists = this_trajectory_rows.map((row) => distance(row.lat, row.lon, centerpoint_lat, centerpoint_lon ));
  dists = _(dists).sortBy((dist) => Math.abs(dist))
  dists = dists.slice(dists.length * 0.2, dists.length * 0.8)
  var radius = dists.reduce((memo, nxt) => memo + nxt, 0) / dists.length;

  return {'lat': centerpoint_lat, 'lon': centerpoint_lon, 'radius': radius}
}

function metadataForPoints(this_trajectory_rows, this_trajectory_rows_grouped){
  var neighborhood_names = neighborhoodNamesForPoints(this_trajectory_rows);
  var centerpoint = centerpointOfRows(this_trajectory_rows);
  // var hover_neighborhood_names = neighborhoodNamesForPoints(this_trajectory_rows.slice(this_trajectory_rows.length * 0.3, this_trajectory_rows.length * 0.7))
  // experiment 7/10/2019: trying to fix the listed neighborhoods being "out of date" when teh helicopter has hovered in one place but now hovers elsewhere.
  // WAS var hover_neighborhood_names = neighborhoodNamesForPoints(this_trajectory_rows.slice(this_trajectory_rows.length * 0.3, this_trajectory_rows.length * 0.7))
  if(arbitrary_marker_location){


    var nearby_points = [
      pointAtDistance(arbitrary_marker_location[1], arbitrary_marker_location[0], centerpoint["radius"], 0),
      pointAtDistance(arbitrary_marker_location[1], arbitrary_marker_location[0], centerpoint["radius"], 90),
      pointAtDistance(arbitrary_marker_location[1], arbitrary_marker_location[0], centerpoint["radius"], 180),
      pointAtDistance(arbitrary_marker_location[1], arbitrary_marker_location[0], centerpoint["radius"], 270)
    ]

    var hover_neighborhood_names = neighborhoodNamesForPoints([{"lat": arbitrary_marker_location[1], "lon": arbitrary_marker_location[0]}] + nearby_points);
    console.log(hover_neighborhood_names)
  }else{
    var hover_neighborhood_names = neighborhoodNamesForPoints(this_trajectory_rows.slice(this_trajectory_rows.length * 0.3, this_trajectory_rows.length * 0.7));
  }
  


  return {
      "nabes": neighborhood_names,
      "hover_nabes": hover_neighborhood_names,
      "end_recd_time": this_trajectory_rows[0].datetz, // time received by ADSB device
      "start_recd_time": this_trajectory_rows[this_trajectory_rows.length-1].datetz, // time received by ADSB device
      // "start_ac_time": this_trajectory_rows[0].datetz, // time generated by aircraft (often off by hours due to DST/timezone settings, like a microwave)
      // "end_ac_time":  this_trajectory_rows[this_trajectory_rows.length-1].datetz, // time generated by aircraft (often off by hours due to DST/timezone settings, like a microwave)
      "points_cnt": this_trajectory_rows.length,
      "groups_cnt": this_trajectory_rows_grouped.length,
      "centerpoint": centerpoint // TK
    }
}

function writeMapAndMetadataForTrajectory(this_trajectory_rows, include_background=true){
  // create a list of sub-trajectories grouped either into those whose constituent points are 
  //  - separated by under MAX_UNMARKED_INTERPOLATION_SECS (e.g. 30 secs)
  //  - separated by more
  // so that those separated by more can be marked with a dashed line to signal interpolation.
  var this_trajectory_rows_grouped = _(this_trajectory_rows).reduce(function(memo, row, idx){
    if(memo.length == 0){
      return [[row]];
    }
    if(row.timediff > MAX_UNMARKED_INTERPOLATION_SECS ){
      memo.push([memo[memo.length - 1][memo[memo.length - 1].length - 1], row]) // the interpolated group
      memo.push([row])  // a new group
    }else{
      memo[memo.length - 1].push(row)
    }
    return memo;
  }, [])

  mapPoints(this_trajectory_rows,this_trajectory_rows_grouped, include_background, (html) => {
    fs.writeFileSync(output_fn, html);
  })

  var metadata = metadataForPoints(this_trajectory_rows, this_trajectory_rows_grouped)
  fs.writeFileSync(output_metadata_fn, JSON.stringify(metadata))
}

// TODO: My original thought was points should be ordered by time from the aircraft, generated_datetime; and
//       and whether to tweet should be based on parsed time)
//       But generated_datetime and logged_datetime differ (from parsed_time) by 5 hours for squitters from the two sites. Odd!
//      
//       I think we have to do something more complicated, otherwise you end up with stuff like this
//       https://twitter.com/nypdhelicopters/status/1097569009455845376 due to generated_time being the right order
//       and parsed_time being the wrong order (but guaranteed right hour). (node mapify.js ACB1F5 N917PD '2019-02-18 18:40:17' '2019-02-18 18:43:11')
//     
//       An example of having multiple sites with mis-ordered generated_time is... TK
//       
//       Proposed solution is to calculate the difference in hours between the sites and 'correct' generated_datetime that way.
function sortRowsByCorrectedTime(rows){
  // var rows_by_client = _(rows).groupBy(function(row){ return row["client_id"]});
  // var any_time_by_client = _(Object.keys(rows_by_client)).reduce(function(acc, client_id){ acc.push([client_id, rows_by_client[client_id][0]['generated_datetime']]); return acc}, [])

  // this finds a time per client at the time closest to when we have one time from each
  // so that they *should* be close enough in time to each other that we don't end up an hour off.
  var unique_client_ids = [...new Set(_(rows).map(function(row){ return row["client_id"]}))]; 
  var one_time_per_client = Object.entries(_(rows).reduce(function(memo, row){
    if( _.some(unique_client_ids, function(client_id){ return !memo[client_id] }) ){
      memo[row["client_id"]] = row["generated_datetime"]
    }
    return memo;
  }, {}))

  var first_client = one_time_per_client.pop()
  // if the difference is 50+ minutes, it's an hour difference. Less than that, we assume it's because we're comparing points that were legitimately seen at different times.
  var hour_differences = _(one_time_per_client).reduce(function(acc, client_id_time){ acc.push([client_id_time[0], Math.floor((Date.parse(client_id_time[1]) - Date.parse(first_client[1]) + 1000 * 60 * 10) / 1000 / 60 / 60) ]); return acc }, [[first_client[0], 0]])
  hour_differences = hour_differences.reduce(function(acc, cur){ acc[cur[0]] = cur[1]; return acc}  , {})

  // e.g. {0: 0, 1: -4} to show that client 1 has a relative time difference of -4 hours from client ID zero.
  _(rows).each(function(row){ row["corrected_time"] = Date.parse(row["generated_datetime"]) - (1000 * 60 * 60 * hour_differences[row["client_id"]]); })

  return _(rows).sortBy(function(row){ return -(row["corrected_time"]) })
}


// if the third and fourth CLI args are provided, that's the temporal "bounds" of the trajectory
// as a strt and end time, so we don't have to find breaks.
if (trajectory_start_time && trajectory_end_time){
  var query = `
    select *, convert_tz(parsed_time, '+00:00', 'US/Eastern') as datetz 
    from squitters 
    where icao_addr = conv('${input_icao_hex}', 16,10) 
      and lat is not null 
      and parsed_time <= '${trajectory_end_time}' and parsed_time >= '${trajectory_start_time}'
    order by parsed_time desc;
  `;
  console.warn("query: " + query)
  connection.connect();
  connection.query(query, function(err, rows, fields) {
    if (err) throw err;

    rows = sortRowsByCorrectedTime(rows);

    // _(rows).each(function(row){ console.log(row["datetz"], row["client_id"], new Date(row["corrected_time"])); })

    var lats = _(rows).reduce(function(memo, row){ if(row["lat"]){memo.push(row["lat"])}; return memo; }, [])

    if (lats.length < 1){ // if there's only one point, or zero, this won't work, so we'll give up.
      console.log("no geo data found for " + input_icao_hex)
      throw "no geo data found for " + input_icao_hex;
    } 

    _(_.zip(rows.slice(0, -2), rows.slice(1,-1))).each(function(two_rows){
      two_rows[1]["timediff"] = two_rows[0].datetz - two_rows[1].datetz;
    })

    writeMapAndMetadataForTrajectory(rows, include_background);
  });
  connection.end();
  console.log(output_fn)
}else{ // for generating via nypdcopterbot.rb
  // this query's time handling is funny, I know.
  // we SORT by `generated_time` because that's internally consistent to the aircraft (so points are guaranteed to be in the right order)
  //   (note that aircraft, much like your microwave, frequently don't have the right timezone/DST setting)
  // but we calculate the timestamp for display (`datetz`) based on the time on the ADSB receiver (`parsed_time`)because that's in a controllable time zone.
  //    even if the received timestamps may vary by a few seconds thanks to slightly different system clocks, processing speed, internet speed and general relativity...
  var query = `
    select *, convert_tz(parsed_time, '+00:00', 'US/Eastern')  as datetz 
    from squitters 
    where icao_addr = conv('${input_icao_hex}', 16,10) 
      and lat is not null 
    order by parsed_time desc;
  `;
  console.warn("query: " + query)
  connection.connect();
  connection.query(query, function(err, rows, fields) {
    if (err) throw err;

    var lats = _(rows).reduce(function(memo, row){ if(row["lat"]){memo.push(row["lat"])}; return memo; }, [])

    if (lats.length < 1){ // if there's only one point, or zero, this won't work, so we'll give up.
      console.log("no geo data found for " + input_icao_hex)
      throw "no geo data found for " + input_icao_hex;
    } 


    _(_.zip(rows.slice(0, -2), rows.slice(1,-1))).each(function(two_rows){
      two_rows[1]["timediff"] = two_rows[0].datetz - two_rows[1].datetz;
    })
    var firstRecordBeforeTheGap = _.findIndex(rows, function(row){ return Math.abs(row["timediff"]) > 60*MAX_TIME_DIFFERENCE_BETWEEN_TRAJECTORIES*1000; });
    var this_trajectory_rows = rows.slice(0, firstRecordBeforeTheGap);
    var this_trajectory_rows = sortRowsByCorrectedTime(this_trajectory_rows);
    writeMapAndMetadataForTrajectory(this_trajectory_rows, include_background);
  });
  connection.end();
  console.log(output_fn)
}
