#!/usr/bin/env node

// http://kartograph.org/

var d3 = require('d3');
var _ = require('underscore');
var async = require('async');
var topojson = require('topojson-client');
var mysql      = require('mysql');
var fs = require('fs');
var jsdom = require('jsdom');
var gju =      require('geojson-utils');
require('d3-geo');
require("d3-geo-projection");

input = process.argv[2]
input_type = "icao" // ENHANCEMENT: accept N number queries, translate them into ICAO hexes via FAA database.
airplane_nice_name = process.argv.length >= 4 ? process.argv[3] : input
output_fn = airplane_nice_name + ".svg"
output_metadata_fn = airplane_nice_name + ".metadata.json" //# [include neighborhood names, start/end times]

// I should probably invest in a cli args parser!
if (process.argv.length >= 6){
  trajectory_start_time = process.argv[4] // in mysql format, plz! -- and in UTC
  trajectory_end_time = process.argv[5] // in mysql format, plz!  -- and in UTC
}else{
  trajectory_start_time = null
  trajectory_end_time = null 
}

var nyntas = JSON.parse(fs.readFileSync(__dirname +"/basemap/json/nynta_17a.json", 'utf8')).features;

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


function mapPoints(this_trajectory_rows, this_trajectory_rows_grouped, cb){
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
            __dirname + '/node_modules/d3/build/d3.min.js',
            __dirname + '/node_modules/d3-geo/build/d3-geo.min.js',
            __dirname + '/node_modules/d3-geo-projection/dist/d3-geo-projection.min.js'
          ],
          done:
    function (err, window) {

      var width = 600,
          height = 600;
      // console.log("scale: 32000 * " + (8/Math.max(1,Math.abs(max_lat - min_lat), Math.abs(max_lon - min_lon)) ) )

      var zoom = 1.5 * Math.max((Math.abs(max_lat - min_lat) / 1.48), (Math.abs(max_lon - min_lon) / 1.87) ); // from 8 to 1

      // my receiver has a so, a range of 1.48 lat and 1.87 lon


      var projection = window.d3.geoAlbers()
        .center([0, mid_lat])      // 41   [0, desired_latitude] 41
        .rotate([-1 * mid_lon, 0]) // 73.5 [-desired_longitude, 0] 

        .parallels([29.5,44.5])
        .scale( 32000  / zoom ) // 32000 gets you most of my SDR rnage.
        .translate([width / 2, height / 2]);
      var padding = 0
      var path = window.d3.geoPath()
        .projection(projection);

      window.d3.select("body").style("background-color", "#e6f2ff");

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
        .data(nycstuffgeo.features) // iterates over geo feature
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
        .attr("class", function(d){ return "airplane " + input + (d.properties.interpolated ? ' interp' : ''); })
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
          .text(function(d) { return airplane_nice_name.toUpperCase() + " " + time_to_display(this_trajectory_rows[this_trajectory_rows.length-1].datetz); });

      var start_projected_coords = projection([this_trajectory_rows[0].lon, this_trajectory_rows[0].lat]);
      start_projected_coords[0] = start_projected_coords[0] + 10; // translate the label start 10px to the right.
      svg.selectAll("text.airplane-label.start")
        .data([0])
        .enter()
        .append("text")
          .attr("class", "airplane-label start")
          .attr("transform", function(d) { return "translate(" + start_projected_coords + ")"; })
          .text(function(d) { return airplane_nice_name.toUpperCase() + " " +  time_to_display(this_trajectory_rows[0].datetz);} );
      // stupidly, the D3 script tag is left in the generated SVG, so we have to remove it.
      cb( "<html>" + window.d3.select("html").html().replace(/\<script[^<]*\<\/script\>/, '') + "</html>" );

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
  var neighborhood_names = _(Object.keys(neighborhood_name_counts)).chain().sortBy(function(name){ return -neighborhood_name_counts[name] }).reject(function(name){ return name.indexOf("park-cemetery-etc") > -1 }).map(function(name){ return name == "North Side-South Side" ? "Williamsburg" : name.split("-")}).flatten().value()
  return neighborhood_names
}

function metadataForPoints(this_trajectory_rows, this_trajectory_rows_grouped){
  neighborhood_names = neighborhoodNamesForPoints(this_trajectory_rows)
  return {
      "nabes": neighborhood_names,
      "end_recd_time": this_trajectory_rows[0].datetz, // time received by ADSB device
      "start_recd_time": this_trajectory_rows[this_trajectory_rows.length-1].datetz, // time received by ADSB device
      // "start_ac_time": this_trajectory_rows[0].datetz, // time generated by aircraft (often off by hours due to DST/timezone settings, like a microwave)
      // "end_ac_time":  this_trajectory_rows[this_trajectory_rows.length-1].datetz, // time generated by aircraft (often off by hours due to DST/timezone settings, like a microwave)
      "points_cnt": this_trajectory_rows.length,
      "groups_cnt": this_trajectory_rows_grouped.length,
      "hovering_proba": 0, // TK
      "hovering_centerpoint": "TK" // TK
    }
}

function writeMapAndMetadataForTrajectory(this_trajectory_rows){
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

  mapPoints(this_trajectory_rows,this_trajectory_rows_grouped, (html) => {
    fs.writeFileSync(output_fn, html);
  })

  metadata = metadataForPoints(this_trajectory_rows, this_trajectory_rows_grouped)
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

  console.log(one_time_per_client)
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
    where icao_addr = conv('${input}', 16,10) 
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
      console.log("no geo data found for " + input)
      throw "no geo data found for " + input;
    } 

    _(_.zip(rows.slice(0, -2), rows.slice(1,-1))).each(function(two_rows){
      two_rows[1]["timediff"] = two_rows[0].datetz - two_rows[1].datetz;
    })

    writeMapAndMetadataForTrajectory(rows);
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
    where icao_addr = conv('${input}', 16,10) 
      and lat is not null 
    order by parsed_time desc;
  `;
  console.warn("query: " + query)
  connection.connect();
  connection.query(query, function(err, rows, fields) {
    if (err) throw err;

    var lats = _(rows).reduce(function(memo, row){ if(row["lat"]){memo.push(row["lat"])}; return memo; }, [])

    if (lats.length < 1){ // if there's only one point, or zero, this won't work, so we'll give up.
      console.log("no geo data found for " + input)
      throw "no geo data found for " + input;
    } 


    _(_.zip(rows.slice(0, -2), rows.slice(1,-1))).each(function(two_rows){
      two_rows[1]["timediff"] = two_rows[0].datetz - two_rows[1].datetz;
    })
    var firstRecordBeforeTheGap = _.findIndex(rows, function(row){ return Math.abs(row["timediff"]) > 60*MAX_TIME_DIFFERENCE_BETWEEN_TRAJECTORIES*1000; });
    var this_trajectory_rows = rows.slice(0, firstRecordBeforeTheGap);
    var this_trajectory_rows = sortRowsByCorrectedTime(this_trajectory_rows);
    writeMapAndMetadataForTrajectory(this_trajectory_rows);
  });
  connection.end();
  console.log(output_fn)
}
