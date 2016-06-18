#!/usr/bin/env node

// http://kartograph.org/

var d3 = require('d3');
var _ = require('underscore');
var async = require('async');
var topojson = require('topojson');
var mysql      = require('mysql');
var fs = require('fs');
var jsdom = require('jsdom');

input = process.argv[2]
input_type = "icao"
output_fn = input + ".svg"

var linestring_template = {
      "type": "FeatureCollection",
      "features": [{
        "type": "Feature",
        "properties": {},
        "geometry": {
          "type": "LineString"
        }
      }]
}

var connection = mysql.createConnection({
  host     : process.env.MYSQLHOST,
  port     : process.env.MYSQLPORT,
  user     : process.env.MYSQLUSER || process.env.MYSQLUSERNAME || process.env.USER,
  password : process.env.MYSQLPASSWORD,
  database : process.env.MYSQLDATABASE || 'dump1090'
});

var query = "select *, convert_tz(generated_datetime, '+00:00', @@global.time_zone) as datetz from squitters where icao_addr = conv('"+input+"', 16,10) and lat is not null order by generated_datetime desc;";
console.warn("query: " + query)
connection.connect();
connection.query(query, function(err, rows, fields) {
  if (err) throw err;

  var lats = _(rows).reduce(function(memo, row){ if(row["lat"]){memo.push(row["lat"])}; return memo; }, [])
  var lons = _(rows).reduce(function(memo, row){ if(row["lon"]){memo.push(row["lon"])}; return memo; }, [])

  if (lats.length < 1){ // if there's only one point, or zero, this won't work, so we'll give up.
    console.log("no geo data found for " + input)
    throw "no geo data found for " + input;
  } 

  _(_.zip(rows.slice(0, -2), rows.slice(1,-1))).each(function(two_rows){
    two_rows[1]["timediff"] = two_rows[0].datetz - two_rows[1].datetz;
  })
  var firstMoreThanAnHourBefore = _.findIndex(rows, function(row){ return Math.abs(row["timediff"]) > 360*1000; });
  var this_trajectory_rows = rows.slice(0, firstMoreThanAnHourBefore);


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


  linestring_template["features"][0]["geometry"]["coordinates"] = _(this_trajectory_rows).map(function(row){ return [row["lon"], row["lat"]]}).reverse();

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
      var path = window.d3.geo.path()
        .projection(projection);

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
        .style("fill", "#EEE8AA")
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

      var nycstufftopo = JSON.parse(fs.readFileSync(__dirname +"/basemap/json/nyc_parks_airports.json", 'utf8'));
      var nycstuffgeo = topojson.feature(nycstufftopo, nycstufftopo.objects['nyc_parks_airports']);
      svg.selectAll(".nycstuff") // selects path elements, will make them if they don't exist
        .data(nycstuffgeo.features) // iterates over geo feature
        .enter() // adds feature if it doesn't exist as an element
        .append("path") // defines element as a path
        .attr("class", function(d){ return "nycstuff " + d.properties["ntaname"]; })
        .style("fill", function(d){ return d.properties.ntaname == "Airport" ? "#ffcccc" : "#006400"; })
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

      svg.selectAll('marker.airplane.start')
        .data(linestring_template.features)
        .enter()
        .append('svg:marker')
          .attr('id', "marker-airplane-start")
          .attr('markerHeight', 15)
          .attr('markerWidth', 15)
          .attr('markerUnits', 'strokeWidth')
          .attr('orient', 'auto')
          .attr('refX', 0)
          .attr('refY', 0)
          .attr('viewBox', function(d){ return '-8 -5 16 10' })
          .append('svg:path')
            .attr('d', function(d){ return 'M 0,0 m -8,-5 L 8,0 L -8,5 Z' })
            .attr('fill', '#f00');
      svg.selectAll('marker.airplane.end')
        .data(linestring_template.features)
        .enter()
        .append('svg:marker')
          .attr('id', "marker-airplane-end")
          .attr('markerHeight', 15)
          .attr('markerWidth', 15)
          .attr('markerUnits', 'strokeWidth')
          .attr('orient', 'auto')
          .attr('refX', 0)
          .attr('refY', 0)
          .attr('viewBox', function(d){ return '-8 -5 16 10' })
          .append('svg:path')
            .attr('d', function(d){ return 'M 0,0 m -8,-5 L 8,0 L -8,5 Z' })
            .attr('fill', '#f00');


      svg.selectAll(".airplane") // selects path elements, will make them if they don't exist
        .data(linestring_template.features) // iterates over geo feature
        .enter() // adds feature if it doesn't exist as an element
        .append("path") // defines element as a path
        .attr("class", function(d){ return "airplane " + input; })
        .attr("id", function(d, i){ return "airplane-i"})
        .style("stroke", "#f00")
        .style("fill", "none")
        .attr("d", path) // path generator translates geo data to SVG
        .attr('marker-start', function(d,i){ return 'url(#marker-airplane-end)' }) // this reversal is on purpose
        .attr('marker-end', function(d,i){ return 'url(#marker-airplane-start)' }) // this reversal is on purpose

      // label the start and end points of the trajectory.
      var end_projected_coords = projection([this_trajectory_rows[this_trajectory_rows.length-1].lon, this_trajectory_rows[this_trajectory_rows.length-1].lat]);
      end_projected_coords[0] = end_projected_coords[0] + 10; // translate the label start 10px to the right.
      svg.selectAll("text.airplane-label.end")
        .data(linestring_template.features)
        .enter()
        .append("text")
          .attr("class", "airplane-label end")
          .attr("transform", function(d) { return "translate(" + end_projected_coords + ")"; })
          .text(function(d) { return input.toUpperCase() + " " + this_trajectory_rows[this_trajectory_rows.length-1].datetz.toISOString().replace("T", " ").slice(0,16);} );

      var start_projected_coords = projection([this_trajectory_rows[0].lon, this_trajectory_rows[0].lat]);
      start_projected_coords[0] = start_projected_coords[0] + 10; // translate the label start 10px to the right.
      svg.selectAll("text.airplane-label.start")
        .data(linestring_template.features)
        .enter()
        .append("text")
          .attr("class", "airplane-label start")
          .attr("transform", function(d) { return "translate(" + start_projected_coords + ")"; })
          .text(function(d) { return input.toUpperCase() + " " + this_trajectory_rows[0].datetz.toISOString().replace("T", " ").slice(0,16);} );

        // stupidly, the D3 script tag is left in the generated SVG, so we have to remove it.
        fs.writeFileSync(output_fn, window.d3.select("body").html().replace(/\<script[^<]*\<\/script\>/, ''));
      }
    });


      

});
connection.end();

console.log(output_fn)