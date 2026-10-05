"""
weather_ingest.py
-----------------
Automated Weather Station Data Ingestion Pipeline for PostGIS & QGIS.

This script:
  1. Connects to a PostgreSQL / PostGIS database using psycopg2.
  2. Identifies or initializes the Weather_Stations table.
  3. Queries weather stations and their spatial coordinates (Point geometry).
  4. Connects to a live Weather API (Open-Meteo by default, or OpenWeatherMap).
  5. Parses the JSON payload for:
       - Temperature (°C)
       - Relative Humidity (%)
       - Wind Speed & Direction
       - Atmospheric / Surface Pressure (hPa)
       - Precipitation / Gusts (when available)
  6. Updates the PostGIS table records and timestamps with parameterized queries.
  7. Supports both one-time ingestion (--once) and continuous scheduled polling (--interval).
"""

import os
import sys
import time
import logging
import argparse
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional, Tuple

import requests
import psycopg2
from psycopg2 import sql
from psycopg2.extras import RealDictCursor
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("weather_ingest")

# Database Configuration (environment variables or fallbacks)
DB_HOST = os.getenv("DB_HOST", "localhost")
DB_PORT = int(os.getenv("DB_PORT", "5432"))
DB_NAME = os.getenv("DB_NAME", "FEWS Dashboard ")
DB_USER = os.getenv("DB_USER", "postgres")
DB_PASSWORD = os.getenv("DB_PASSWORD", "postgres")
TABLE_NAME = os.getenv("DB_TABLE", "weather_stations")

# Weather API Configuration
API_PROVIDER = os.getenv("WEATHER_API_PROVIDER", "open-meteo").lower()
OPENWEATHER_API_KEY = os.getenv("OPENWEATHER_API_KEY", "")

# Sample reference stations for initialization or empty tables
DEFAULT_SAMPLE_STATIONS = [
    {"station_id": "WS_LOS_01", "name": "Lagos Marina Station", "lat": 6.4531, "lon": 3.4285},
    {"station_id": "WS_ABJ_02", "name": "Abuja Central Station", "lat": 9.0765, "lon": 7.3986},
    {"station_id": "WS_KAN_03", "name": "Kano Urban Station", "lat": 12.0022, "lon": 8.5920},
    {"station_id": "WS_PHC_04", "name": "Port Harcourt Station", "lat": 4.8156, "lon": 7.0498},
    {"station_id": "WS_IBD_05", "name": "Ibadan Mokola Station", "lat": 7.4019, "lon": 3.8966},
]


def get_db_connection(dbname: Optional[str] = None):
    """Establishes and returns a connection to PostgreSQL with fallback auto-resolution."""
    target_db = dbname or DB_NAME
    try:
        conn = psycopg2.connect(
            host=DB_HOST,
            port=DB_PORT,
            dbname=target_db,
            user=DB_USER,
            password=DB_PASSWORD,
        )
        conn.autocommit = False
        return conn
    except psycopg2.OperationalError as exc:
        err_msg = str(exc)
        # Attempt to auto-resolve exact database name (e.g. trailing spaces or casing)
        if "does not exist" in err_msg:
            try:
                m_conn = psycopg2.connect(
                    host=DB_HOST,
                    port=DB_PORT,
                    dbname="postgres",
                    user=DB_USER,
                    password=DB_PASSWORD,
                )
                with m_conn.cursor() as cur:
                    cur.execute(
                        "SELECT datname FROM pg_database WHERE LOWER(TRIM(datname)) = LOWER(TRIM(%s)) LIMIT 1;",
                        (target_db,),
                    )
                    row = cur.fetchone()
                m_conn.close()
                if row:
                    exact_name = row[0]
                    logger.info(f"Resolved database name to exact match: '{exact_name}'")
                    conn = psycopg2.connect(
                        host=DB_HOST,
                        port=DB_PORT,
                        dbname=exact_name,
                        user=DB_USER,
                        password=DB_PASSWORD,
                    )
                    conn.autocommit = False
                    return conn
            except Exception:
                pass

        logger.error(f"Failed to connect to PostgreSQL at {DB_HOST}:{DB_PORT}/{target_db}: {exc}")
        raise


def resolve_table_name_and_schema(conn, requested_name: str) -> Tuple[str, str]:
    """
    Resolves the actual table name and schema in PostgreSQL (case-insensitive check).
    Returns (schema_name, table_name).
    """
    clean_name = requested_name.strip('"')
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT table_schema, table_name 
            FROM information_schema.tables 
            WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
              AND LOWER(table_name) = LOWER(%s)
            LIMIT 1;
            """,
            (clean_name,),
        )
        row = cur.fetchone()
        if row:
            return row[0], row[1]
    return "public", clean_name.lower()


def get_table_columns(conn, schema: str, table: str) -> List[str]:
    """Retrieves all column names for the specified table."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_schema = %s AND table_name = %s;
            """,
            (schema, table),
        )
        return [r[0] for r in cur.fetchall()]


def get_geometry_srid(conn, schema: str, table: str, geom_col: str = "geom") -> int:
    """Detects the spatial reference system ID (SRID) of the geometry column."""
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT Find_SRID(%s, %s, %s);", (schema, table, geom_col))
            row = cur.fetchone()
            if row and row[0] and row[0] > 0:
                return row[0]
    except Exception as exc:
        logger.debug(f"Could not determine SRID via Find_SRID: {exc}")
        conn.rollback()

    # Fallback to WGS 84 (4326)
    return 4326


def ensure_table_exists(conn, schema: str, table: str):
    """
    Checks if the table exists; if not, enables PostGIS extension and creates the table.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT 1 FROM information_schema.tables 
            WHERE table_schema = %s AND table_name = %s;
            """,
            (schema, table),
        )
        if not cur.fetchone():
            logger.info(f"Table '{schema}.{table}' does not exist. Creating table with PostGIS geometry...")
            cur.execute("CREATE EXTENSION IF NOT EXISTS postgis;")
            create_sql = sql.SQL("""
                CREATE TABLE {schema}.{table} (
                    station_id VARCHAR(50) PRIMARY KEY,
                    station_name VARCHAR(100),
                    geom GEOMETRY(Point, 4326),
                    temperature DOUBLE PRECISION,
                    humidity DOUBLE PRECISION,
                    wind_speed DOUBLE PRECISION,
                    wind_direction INTEGER,
                    sea_level_pressure DOUBLE PRECISION,
                    pressure DOUBLE PRECISION,
                    rain_rate DOUBLE PRECISION,
                    heat_index DOUBLE PRECISION,
                    wind_gust DOUBLE PRECISION,
                    last_updated TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                    last_observation_time TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                );
                CREATE INDEX IF NOT EXISTS {idx} ON {schema}.{table} USING GIST (geom);
            """).format(
                schema=sql.Identifier(schema),
                table=sql.Identifier(table),
                idx=sql.Identifier(f"idx_{table}_geom"),
            )
            cur.execute(create_sql)
            conn.commit()
            logger.info(f"Created table '{schema}.{table}' successfully.")


def seed_stations(conn, schema: str, table: str, srid: int, stations: List[Dict[str, Any]] = DEFAULT_SAMPLE_STATIONS):
    """Seeds sample stations if the table is currently empty."""
    logger.info(f"Seeding {len(stations)} default stations into {schema}.{table} (SRID: {srid})...")
    with conn.cursor() as cur:
        for st in stations:
            insert_query = sql.SQL("""
                INSERT INTO {schema}.{table} (
                    station_id, station_name, geom, last_updated
                ) VALUES (
                    %s, %s, ST_SetSRID(ST_MakePoint(%s, %s), {srid}), CURRENT_TIMESTAMP
                )
                ON CONFLICT (station_id) DO NOTHING;
            """).format(
                schema=sql.Identifier(schema),
                table=sql.Identifier(table),
                srid=sql.Literal(srid),
            )
            cur.execute(insert_query, (st["station_id"], st["name"], st["lon"], st["lat"]))
        conn.commit()
    logger.info("Stations seeded successfully.")


def get_stations(conn, schema: str, table: str, columns: List[str]) -> List[Dict[str, Any]]:
    """
    Extracts all weather stations with coordinates from the table.
    Handles geometries via ST_Y/ST_X or fallback latitude/longitude columns.
    """
    has_geom = "geom" in columns
    has_lat = "latitude" in columns and "longitude" in columns

    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        if has_geom and has_lat:
            coord_expr = sql.SQL("COALESCE(latitude, ST_Y(geom::geometry)) AS latitude, COALESCE(longitude, ST_X(geom::geometry)) AS longitude")
        elif has_geom:
            coord_expr = sql.SQL("ST_Y(geom::geometry) AS latitude, ST_X(geom::geometry) AS longitude")
        elif has_lat:
            coord_expr = sql.SQL("latitude, longitude")
        else:
            raise ValueError(f"Table '{schema}.{table}' has neither 'geom' nor 'latitude/longitude' columns.")

        query = sql.SQL("""
            SELECT station_id, 
                   COALESCE(station_name, station_id) AS station_name,
                   {coord_expr}
            FROM {schema}.{table};
        """).format(
            schema=sql.Identifier(schema),
            table=sql.Identifier(table),
            coord_expr=coord_expr,
        )
        cur.execute(query)
        rows = cur.fetchall()
        return [dict(r) for r in rows]


def fetch_weather_open_meteo(lat: float, lon: float) -> Dict[str, Any]:
    """
    Queries the Open-Meteo weather API (no API key required).
    Parses the JSON payload for temperature, humidity, wind, pressure, and precipitation.
    """
    url = "https://api.open-meteo.com/v1/forecast"
    params = {
        "latitude": lat,
        "longitude": lon,
        "current": (
            "temperature_2m,relative_humidity_2m,apparent_temperature,"
            "surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation"
        ),
    }
    response = requests.get(url, params=params, timeout=12)
    response.raise_for_status()
    payload = response.json()

    current = payload.get("current", {})
    return {
        "temperature": current.get("temperature_2m"),
        "humidity": current.get("relative_humidity_2m"),
        "heat_index": current.get("apparent_temperature"),
        "pressure": current.get("surface_pressure"),
        "sea_level_pressure": current.get("surface_pressure"),
        "wind_speed": current.get("wind_speed_10m"),
        "wind_direction": current.get("wind_direction_10m"),
        "wind_gust": current.get("wind_gusts_10m"),
        "rain_rate": current.get("precipitation"),
        "timestamp": current.get("time", datetime.now(timezone.utc).isoformat()),
    }


def fetch_weather_openweathermap(lat: float, lon: float, api_key: str) -> Dict[str, Any]:
    """
    Queries the OpenWeatherMap API with provided API key.
    Parses the JSON response for temperature, humidity, wind speed/direction, and pressure.
    """
    if not api_key:
        raise ValueError("OpenWeatherMap requires an API key. Set OPENWEATHER_API_KEY in .env.")

    url = "https://api.openweathermap.org/data/2.5/weather"
    params = {
        "lat": lat,
        "lon": lon,
        "appid": api_key,
        "units": "metric",
    }
    response = requests.get(url, params=params, timeout=12)
    response.raise_for_status()
    payload = response.json()

    main = payload.get("main", {})
    wind = payload.get("wind", {})
    rain = payload.get("rain", {})

    return {
        "temperature": main.get("temp"),
        "humidity": main.get("humidity"),
        "heat_index": main.get("feels_like"),
        "pressure": main.get("pressure"),
        "sea_level_pressure": main.get("sea_level", main.get("pressure")),
        "wind_speed": wind.get("speed"),
        "wind_direction": wind.get("deg"),
        "wind_gust": wind.get("gust"),
        "rain_rate": rain.get("1h", 0.0),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


def fetch_weather(lat: float, lon: float, provider: str, api_key: str) -> Dict[str, Any]:
    """Fetches real-time weather from the selected provider."""
    if provider == "openweathermap":
        return fetch_weather_openweathermap(lat, lon, api_key)
    return fetch_weather_open_meteo(lat, lon)


def update_postgis_station(
    conn,
    schema: str,
    table: str,
    table_columns: List[str],
    station_id: str,
    weather: Dict[str, Any],
) -> bool:
    """
    Dynamically maps parsed weather attributes to existing table columns and
    executes an UPDATE query using psycopg2 parameterized statements.
    """
    update_fields = []
    values = []

    # Map candidate fields to available table columns
    column_mapping = {
        "temperature": weather.get("temperature"),
        "humidity": weather.get("humidity"),
        "wind_speed": weather.get("wind_speed"),
        "wind_direction": weather.get("wind_direction"),
        "pressure": weather.get("pressure"),
        "sea_level_pressure": weather.get("sea_level_pressure"),
        "wind_gust": weather.get("wind_gust"),
        "rain_rate": weather.get("rain_rate"),
        "heat_index": weather.get("heat_index"),
    }

    for col_name, val in column_mapping.items():
        if col_name in table_columns and val is not None:
            update_fields.append(sql.SQL("{col} = %s").format(col=sql.Identifier(col_name)))
            values.append(val)

    # Always update timestamp fields if present
    now_utc = datetime.now(timezone.utc)
    if "last_updated" in table_columns:
        update_fields.append(sql.SQL("last_updated = %s"))
        values.append(now_utc)
    if "last_observation_time" in table_columns:
        update_fields.append(sql.SQL("last_observation_time = %s"))
        values.append(now_utc)

    if not update_fields:
        logger.warning(f"No matching meteorological columns found in {schema}.{table} to update.")
        return False

    values.append(station_id)
    update_query = sql.SQL("""
        UPDATE {schema}.{table}
        SET {fields}
        WHERE station_id = %s;
    """).format(
        schema=sql.Identifier(schema),
        table=sql.Identifier(table),
        fields=sql.SQL(", ").join(update_fields),
    )

    with conn.cursor() as cur:
        cur.execute(update_query, tuple(values))
        updated = cur.rowcount > 0
        conn.commit()
        return updated


def run_ingestion_cycle(
    conn,
    schema: str,
    table: str,
    provider: str,
    api_key: str,
):
    """
    Executes a complete ingestion pass:
      1. Inspects table columns.
      2. Retrieves all weather stations.
      3. Calls the Weather API for each coordinate.
      4. Parses temperature, humidity, wind, pressure, etc.
      5. Commits updates to PostGIS.
    """
    columns = get_table_columns(conn, schema, table)
    stations = get_stations(conn, schema, table, columns)

    if not stations:
        logger.warning(f"No station records found in '{schema}.{table}'. Auto-seeding default stations...")
        srid = get_geometry_srid(conn, schema, table)
        seed_stations(conn, schema, table, srid)
        stations = get_stations(conn, schema, table, columns)

    logger.info(f"--- Starting Ingestion Cycle: {len(stations)} station(s) | Provider: {provider} ---")

    success_count = 0
    for station in stations:
        st_id = station["station_id"]
        st_name = station.get("station_name", st_id)
        lat = station.get("latitude")
        lon = station.get("longitude")

        if lat is None or lon is None:
            logger.warning(f"Station '{st_id}' ({st_name}) has NULL coordinates. Skipping.")
            continue

        try:
            logger.info(f"Querying weather for '{st_id}' ({st_name}) at ({lat:.4f}, {lon:.4f})...")
            weather = fetch_weather(lat, lon, provider, api_key)

            temp = weather.get("temperature")
            hum = weather.get("humidity")
            w_spd = weather.get("wind_speed")
            w_dir = weather.get("wind_direction")
            press = weather.get("pressure") or weather.get("sea_level_pressure")

            logger.info(
                f"Parsed JSON -> Temp: {temp}°C | Humidity: {hum}% | "
                f"Wind: {w_spd} km/h @ {w_dir}° | Pressure: {press} hPa"
            )

            updated = update_postgis_station(conn, schema, table, columns, st_id, weather)
            if updated:
                logger.info(f"Updated PostGIS table '{schema}.{table}' for station '{st_id}'.")
                success_count += 1
            else:
                logger.warning(f"Station '{st_id}' update matched 0 rows.")

        except requests.RequestException as req_err:
            logger.error(f"Weather API request failed for station '{st_id}': {req_err}")
        except Exception as err:
            logger.error(f"Unexpected error while processing station '{st_id}': {err}", exc_info=True)

    logger.info(f"--- Ingestion Cycle Completed: {success_count}/{len(stations)} stations updated ---")

    # Synchronize updated PostGIS records to Dashboard/data/weather_stations_5.js if folder exists
    dashboard_js_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "Dashboard", "data", "weather_stations_5.js")
    if os.path.exists(os.path.dirname(dashboard_js_path)):
        try:
            export_to_dashboard_geojson(conn, schema, table, dashboard_js_path)
            logger.info(f"Exported updated PostGIS telemetry to '{dashboard_js_path}'.")
        except Exception as ex:
            logger.warning(f"Could not export to dashboard js: {ex}")


def export_to_dashboard_geojson(conn, schema: str, table: str, output_path: str):
    """Exports all weather stations from PostGIS to Dashboard/data/weather_stations_5.js in GeoJSON format."""
    import json
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        query = sql.SQL("""
            SELECT 
                station_id,
                station_name,
                temperature,
                dew_point,
                heat_index,
                humidity,
                inside_temperature,
                inside_humidity,
                wind_speed,
                wind_gust,
                wind_direction,
                sea_level_pressure,
                rain_rate,
                last_observation_time,
                last_updated,
                ST_X(geom::geometry) AS lon,
                ST_Y(geom::geometry) AS lat
            FROM {schema}.{table};
        """).format(schema=sql.Identifier(schema), table=sql.Identifier(table))
        cur.execute(query)
        rows = cur.fetchall()

    features = []
    for r in rows:
        props = dict(r)
        lon = props.pop("lon", 0.0)
        lat = props.pop("lat", 0.0)
        # Format timestamps as isoformat
        if props.get("last_updated"):
            props["last_updated"] = props["last_updated"].isoformat()
        if props.get("last_observation_time"):
            props["last_observation_time"] = props["last_observation_time"].isoformat()

        features.append({
            "type": "Feature",
            "properties": props,
            "geometry": {
                "type": "Point",
                "coordinates": [lon, lat],
            }
        })

    geojson_obj = {
        "type": "FeatureCollection",
        "name": "weather_stations_5",
        "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}},
        "features": features,
    }

    with open(output_path, "w", encoding="utf-8") as f:
        f.write(f"var json_weather_stations_5 = {json.dumps(geojson_obj)};\n")



def parse_arguments():
    """Parses command-line arguments."""
    parser = argparse.ArgumentParser(
        description="Connects to a weather API, parses weather data, and updates a PostGIS table using psycopg2."
    )
    parser.add_argument(
        "--table",
        type=str,
        default=TABLE_NAME,
        help="Target PostGIS table name (default: 'weather_stations' or DB_TABLE env).",
    )
    parser.add_argument(
        "--dbname",
        type=str,
        default=DB_NAME,
        help=f"Target PostgreSQL database name (default: '{DB_NAME}').",
    )
    parser.add_argument(
        "--provider",
        type=str,
        default=API_PROVIDER,
        choices=["open-meteo", "openweathermap"],
        help="Weather API provider (default: 'open-meteo', no API key needed).",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Run ingestion once and exit immediately (ideal for scheduled tasks / cron).",
    )
    parser.add_argument(
        "--interval",
        type=int,
        default=int(os.getenv("INGEST_INTERVAL", "300")),
        help="Loop interval in seconds for continuous ingestion (default: 300s).",
    )
    parser.add_argument(
        "--seed",
        action="store_true",
        help="Seed sample stations into the table if empty.",
    )
    return parser.parse_args()


def main():
    args = parse_arguments()
    logger.info("Initializing PostGIS Weather Ingestion Service...")

    try:
        conn = get_db_connection(args.dbname)
        logger.info(f"Connected to PostgreSQL database '{args.dbname}' on {DB_HOST}:{DB_PORT}.")
    except Exception as exc:
        logger.critical(f"Cannot proceed without database connection: {exc}")
        sys.exit(1)

    try:
        schema, table = resolve_table_name_and_schema(conn, args.table)
        logger.info(f"Resolved target PostGIS table: '{schema}.{table}'")

        # Ensure table exists
        ensure_table_exists(conn, schema, table)

        if args.seed:
            srid = get_geometry_srid(conn, schema, table)
            seed_stations(conn, schema, table, srid)

        # Ingestion execution mode
        if args.once:
            run_ingestion_cycle(conn, schema, table, args.provider, OPENWEATHER_API_KEY)
            logger.info("Single run finished.")
        else:
            logger.info(f"Running in continuous mode (interval: {args.interval}s). Press Ctrl+C to exit.")
            while True:
                run_ingestion_cycle(conn, schema, table, args.provider, OPENWEATHER_API_KEY)
                logger.info(f"Sleeping for {args.interval} seconds...")
                time.sleep(args.interval)

    except KeyboardInterrupt:
        logger.info("Service interrupted by user (Ctrl+C).")
    finally:
        if conn and not conn.closed:
            conn.close()
            logger.info("PostgreSQL database connection closed.")


if __name__ == "__main__":
    main()
