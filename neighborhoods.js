#!/usr/bin/env node

// http://kartograph.org/

var _ =        require('underscore');
var topojson = require('topojson');
var mysql    = require('mysql');
var gju =      require('geojson-utils');
var fs =       require('fs');

input = process.argv[2]
input_type = "icao"
output_fn = input + ".svg"

var connection = mysql.createConnection({
  host     : process.env.MYSQLHOST,
  port     : process.env.MYSQLPORT,
  user     : process.env.MYSQLUSER || process.env.MYSQLUSERNAME,
  password : process.env.MYSQLPASSWORD,
  database : process.env.MYSQLDATABASE || 'dump1090'
});

var nyntas = JSON.parse(fs.readFileSync(__dirname +"/basemap/json/nynta_17a.json", 'utf8')).features;
var query = "select * from squitters where icao_addr = conv('"+input+"', 16,10) and lat is not null order by generated_datetime desc;";
console.warn("query: " + query)
connection.connect();
connection.query(query, function(err, rows, fields) {
  if (err) throw err;

  var lats = _(rows).reduce(function(memo, row){ if(row["lat"]){memo.push(row["lat"])}; return memo; }, [])
  var lons = _(rows).reduce(function(memo, row){ if(row["lon"]){memo.push(row["lon"])}; return memo; }, [])

  if (lats.length == 0){
    console.log("no geo data found for " + input)
    throw "no geo data found for " + input;
  }

  _(_.zip(rows.slice(0, -2), rows.slice(1,-1))).each(function(two_rows){
    two_rows[1]["timediff"] = two_rows[0].generated_datetime - two_rows[1].generated_datetime;
  })
  var firstMoreThanAnHourBefore = _.findIndex(rows, function(row){ return Math.abs(row["timediff"]) > 360*1000; });
  var this_trajectory_rows = rows.slice(0, firstMoreThanAnHourBefore);

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
  console.log(neighborhood_names.join("|"));
  });
connection.end();
