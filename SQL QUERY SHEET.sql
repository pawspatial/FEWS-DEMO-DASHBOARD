create table Weather_Stations (
	station_id varchar(50) primary key,
	station_name varchar(100),
	geom geometry(Point, 4236),
	--Temperature and Humidity
	temperature float,		
	dew_point float,		
	heat_index float,		
	humidity float,			
	inside_temperature float,
	inside_humidity float,
	--Wind Metrics
	wind_speed float,
	wind_gust float,
	wind_direction int,
	--Pressure and Precipitation
	sea_level_pressure float,
	rain_rate float,
	--Metadata/Timestamps
	last_observation_time timestamp with time zone,
	last_updated timestamp with time zone
);