# FEWS Nigeria - Real-Time Weather Station Dashboard

An interactive, high-performance GIS Weather Station Dashboard for meteorological monitoring and early warning systems.

---

## 🌟 Key Features

1. **Live Weather Telemetry Engine**:
   - Fetches live meteorological observations directly from Open-Meteo API in real-time.
   - Live 60-second polling loop with automatic countdown timer and manual instant refresh.
   - Synchronized with PostgreSQL / PostGIS database via `weather_ingest.py`.

2. **Geospatial Visualization (Leaflet)**:
   - **Default Basemap**: **OpenStreetMap Standard** tiles with OpenStreetMap contributor attribution.
   - **Alternative Basemaps**: Esri Satellite (World Imagery), Esri World Topographic, Wikimedia OSM International (working alternative while HOT tiles are unavailable), and Esri World Streets.
   - **Collapsible & Visible Layers Panel**: Docked at the top-right below the KPI bar, expanded and visible by default with an interactive collapse/expand toggle and header shortcut.
   - **Boundary Overlays**: National Boundary (glowing contour), State Boundaries, and LGA Boundaries with tooltips.
   - **Pulsing Radar Station Markers**: Animated radar ping beacons with live temperature badges and wind direction arrows.

3. **Meteorological Reporting & Downloads**:
   - **Official Meteorological Station Bulletin**: Formatted telemetry report for each station.
   - **Download Formats**:
     - **Print / PDF**: Professional formatted document ready for export or archiving (`window.print()`).
     - **CSV**: Structured sensor data export (`.csv`).
     - **JSON**: Raw telemetry GeoJSON payload (`.json`).
     - **Full Network GeoJSON & CSV**: Bulk download of all monitored stations from header and analytics drawer.

4. **Telemetry Analytics**:
   - Multi-metric comparative charts powered by Chart.js.
   - Comparative analysis for Temperature & Heat Index, Wind Velocity & Gusts, Relative Humidity, and Barometric Pressure.

---

## 🚀 How to Run

### Method 1: Local HTTP Server (Recommended)

Run a local Python server:

```bash
python -m http.server 8085 --directory "Dashboard"
```

Then open your browser at:
👉 **http://localhost:8085/index.html**

### Method 2: Standalone File

Open `Dashboard/index.html` directly in your browser. All required dependencies and APIs support standalone execution.

---

## 🔄 Live Ingestion & PostGIS Database Integration

To continuously update your local PostgreSQL / PostGIS database:

```bash
python weather_ingest.py --interval 300
```

This updates the `weather_stations` table and automatically synchronizes `Dashboard/data/weather_stations_5.js`.
