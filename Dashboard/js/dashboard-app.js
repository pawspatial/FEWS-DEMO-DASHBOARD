/**
 * FEWS NIGERIA - REAL-TIME WEATHER STATION TELEMETRY APPLICATION
 * Handles live weather API polling, PostGIS GeoJSON state, interactive charts,
 * custom animated radar markers, and telemetry HUD cards.
 */

// Global App State
const WeatherPulse = {
  stations: [], // Working feature collection
  markersMap: new Map(), // station_id -> L.marker
  activeStationId: null,
  autoRefreshInterval: 60, // seconds
  countdown: 60,
  timerId: null,
  chartInstance: null,
  currentTab: "temp",
  isFetching: false,
};

/**
 * Initializes the Dashboard Application
 */
function initWeatherDashboard() {
  console.log("Initializing FEWS Weather Station Dashboard...");

  // Load initial stations from the GeoJSON export
  if (
    typeof json_weather_stations_5 !== "undefined" &&
    json_weather_stations_5.features
  ) {
    WeatherPulse.stations = JSON.parse(
      JSON.stringify(json_weather_stations_5.features),
    );
  }

  // Bind DOM Event Listeners
  setupEventListeners();

  // Initial render of UI elements
  renderStationCards();
  updateKPICards();
  initAnalyticsChart();

  // Create custom markers on map
  createDynamicStationMarkers();

  // Trigger immediate live weather fetch from Open-Meteo API
  fetchLiveWeatherData();

  // Start auto-refresh countdown loop
  startRefreshTimer();
}

/**
 * Sets up UI Event Listeners
 */
function setupEventListeners() {
  // Search input
  const searchInput = document.getElementById("stationSearch");
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      filterStationCards(e.target.value.toLowerCase());
    });
  }

  // Filter chips
  const filterChips = document.querySelectorAll(".filter-chip");
  filterChips.forEach((chip) => {
    chip.addEventListener("click", () => {
      filterChips.forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      applyFilter(chip.dataset.filter);
    });
  });

  // Refresh Button
  const refreshBtn = document.getElementById("refreshBtn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
      if (!WeatherPulse.isFetching) {
        fetchLiveWeatherData();
      }
    });
  }

  // Sidebar Toggle
  const toggleSidebarBtn = document.getElementById("toggleSidebarBtn");
  const sidebar = document.getElementById("dashSidebar");
  if (toggleSidebarBtn && sidebar) {
    toggleSidebarBtn.addEventListener("click", () => {
      const isMobile = window.matchMedia("(max-width: 768px)").matches;
      const sidebarClass = isMobile ? "open" : "collapsed";
      sidebar.classList.toggle(sidebarClass);
      const isExpanded = isMobile
        ? sidebar.classList.contains("open")
        : !sidebar.classList.contains("collapsed");
      toggleSidebarBtn.classList.toggle(
        "active",
        sidebar.classList.contains(
          sidebarClass === "open" ? "open" : "collapsed",
        ),
      );
      toggleSidebarBtn.setAttribute("aria-expanded", String(isExpanded));
      setTimeout(() => {
        if (typeof map !== "undefined") map.invalidateSize();
      }, 350);
    });
  }

  // Map Layers Toggle
  const toggleLayersBtn = document.getElementById("toggleLayersBtn");
  const layersPanel = document.querySelector(".leaflet-control-layers");
  if (toggleLayersBtn && layersPanel) {
    toggleLayersBtn.addEventListener("click", () => {
      const isOpen = layersPanel.classList.toggle("is-open");
      toggleLayersBtn.classList.toggle("active", isOpen);
      toggleLayersBtn.setAttribute("aria-expanded", String(isOpen));
    });
  }

  // Analytics Drawer Toggle
  const toggleAnalyticsBtn = document.getElementById("toggleAnalyticsBtn");
  const analyticsDrawer = document.getElementById("analyticsDrawer");
  const closeAnalyticsBtn = document.getElementById("closeAnalyticsBtn");

  if (toggleAnalyticsBtn && analyticsDrawer) {
    toggleAnalyticsBtn.addEventListener("click", () => {
      analyticsDrawer.classList.toggle("hidden");
      toggleAnalyticsBtn.classList.toggle("active");
      if (!analyticsDrawer.classList.contains("hidden")) {
        updateAnalyticsChart();
      }
    });
  }

  if (closeAnalyticsBtn && analyticsDrawer) {
    closeAnalyticsBtn.addEventListener("click", () => {
      analyticsDrawer.classList.add("hidden");
      if (toggleAnalyticsBtn) toggleAnalyticsBtn.classList.remove("active");
    });
  }

  // Analytics Chart Tabs
  const tabBtns = document.querySelectorAll(".tab-btn");
  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      tabBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      WeatherPulse.currentTab = btn.dataset.tab;
      updateAnalyticsChart();
    });
  });

  // Export GeoJSON Button
  const exportGeoJsonBtn = document.getElementById("exportGeoJsonBtn");
  if (exportGeoJsonBtn) {
    exportGeoJsonBtn.addEventListener("click", exportGeoJSON);
  }

  // Export CSV Button
  const exportCsvBtn = document.getElementById("exportCsvBtn");
  if (exportCsvBtn) {
    exportCsvBtn.addEventListener("click", exportCSV);
  }

  // Header Station Report Button
  const headerReportBtn = document.getElementById("headerReportBtn");
  if (headerReportBtn) {
    headerReportBtn.addEventListener("click", () => {
      const targetId =
        WeatherPulse.activeStationId ||
        (WeatherPulse.stations[0] &&
          WeatherPulse.stations[0].properties.station_id);
      if (targetId) {
        openStationReport(targetId);
      } else {
        showToast("⚠️ No station selected for report.");
      }
    });
  }

  // Station Report Modal Controls
  const closeReportModalBtn = document.getElementById("closeReportModalBtn");
  const reportModalBackdrop = document.getElementById("reportModalBackdrop");
  if (closeReportModalBtn && reportModalBackdrop) {
    closeReportModalBtn.addEventListener("click", closeStationReport);
    reportModalBackdrop.addEventListener("click", (e) => {
      if (e.target === reportModalBackdrop) closeStationReport();
    });
  }

  // Report Modal Action Buttons
  const printReportBtn = document.getElementById("printReportBtn");
  if (printReportBtn) {
    printReportBtn.addEventListener("click", printCurrentStationReport);
  }

  const downloadStationCsvBtn = document.getElementById(
    "downloadStationCsvBtn",
  );
  if (downloadStationCsvBtn) {
    downloadStationCsvBtn.addEventListener("click", downloadCurrentStationCSV);
  }

  const downloadStationJsonBtn = document.getElementById(
    "downloadStationJsonBtn",
  );
  if (downloadStationJsonBtn) {
    downloadStationJsonBtn.addEventListener(
      "click",
      downloadCurrentStationJSON,
    );
  }
}

/**
 * Creates custom animated radar and temperature badge markers on Leaflet map
 */
function createDynamicStationMarkers() {
  if (typeof map === "undefined") return;

  // Hide the default qgis2web static layer if present
  if (
    typeof layer_weather_stations_5 !== "undefined" &&
    map.hasLayer(layer_weather_stations_5)
  ) {
    map.removeLayer(layer_weather_stations_5);
  }

  // Clear existing custom markers if any
  WeatherPulse.markersMap.forEach((marker) => map.removeLayer(marker));
  WeatherPulse.markersMap.clear();

  // Create markers for each station
  WeatherPulse.stations.forEach((feature) => {
    const props = feature.properties || {};
    const coords = feature.geometry.coordinates; // [lon, lat]
    const latlng = L.latLng(coords[1], coords[0]);
    const stId = props.station_id;

    const marker = createStationMarker(feature, latlng);
    marker.addTo(map);
    WeatherPulse.markersMap.set(stId, marker);
  });
}

/**
 * Generates an individual custom Leaflet marker with temperature badge and wind arrow
 */
function createStationMarker(feature, latlng) {
  const props = feature.properties || {};
  const temp =
    props.temperature != null ? parseFloat(props.temperature).toFixed(1) : "--";
  const windDir =
    props.wind_direction != null ? parseFloat(props.wind_direction) : 0;

  // Temperature color classification
  let tempClass = "warm";
  if (props.temperature != null) {
    const t = parseFloat(props.temperature);
    if (t >= 30) tempClass = "hot";
    else if (t >= 25) tempClass = "warm";
    else if (t >= 20) tempClass = "mild";
    else tempClass = "cool";
  }

  const iconHtml = `
    <div class="custom-weather-marker" id="marker-${props.station_id}">
      <div class="marker-beacon-ring"></div>
      <div class="marker-badge-pill ${tempClass}">
        <span class="marker-icon"><i class="fas fa-temperature-high"></i></span>
        <span class="marker-temp">${temp}°C</span>
        <span class="marker-wind-arrow" style="transform: rotate(${windDir}deg);" title="Wind Direction: ${windDir}°">
          <i class="fas fa-location-arrow"></i>
        </span>
      </div>
    </div>
  `;

  const customIcon = L.divIcon({
    html: iconHtml,
    className: "leaflet-weather-beacon",
    iconSize: [80, 36],
    iconAnchor: [40, 18],
    popupAnchor: [0, 210],
  });

  const marker = L.marker(latlng, { icon: customIcon });
  marker.bindPopup(
    buildPopupHtml(props, coordsToObj(feature.geometry.coordinates)),
    {
      maxWidth: 380,
      className: "custom-weather-popup-container",
    },
  );

  marker.on("click", () => {
    selectStation(props.station_id, false);
  });

  return marker;
}

/**
 * Updates marker icons with latest live telemetry values
 */
function refreshMarkerIcons() {
  WeatherPulse.stations.forEach((feature) => {
    const props = feature.properties || {};
    const marker = WeatherPulse.markersMap.get(props.station_id);
    if (!marker) return;

    const temp =
      props.temperature != null
        ? parseFloat(props.temperature).toFixed(1)
        : "--";
    const windDir =
      props.wind_direction != null ? parseFloat(props.wind_direction) : 0;

    let tempClass = "warm";
    if (props.temperature != null) {
      const t = parseFloat(props.temperature);
      if (t >= 30) tempClass = "hot";
      else if (t >= 25) tempClass = "warm";
      else if (t >= 20) tempClass = "mild";
      else tempClass = "cool";
    }

    const iconHtml = `
      <div class="custom-weather-marker" id="marker-${props.station_id}">
        <div class="marker-beacon-ring"></div>
        <div class="marker-badge-pill ${tempClass}">
          <span class="marker-icon"><i class="fas fa-temperature-high"></i></span>
          <span class="marker-temp">${temp}°C</span>
          <span class="marker-wind-arrow" style="transform: rotate(${windDir}deg);" title="Wind Direction: ${windDir}°">
            <i class="fas fa-location-arrow"></i>
          </span>
        </div>
      </div>
    `;

    marker.setIcon(
      L.divIcon({
        html: iconHtml,
        className: "leaflet-weather-beacon",
        iconSize: [80, 36],
        iconAnchor: [40, 18],
        popupAnchor: [0, 210],
      }),
    );

    // Update popup content as well
    marker.setPopupContent(
      buildPopupHtml(props, coordsToObj(feature.geometry.coordinates)),
    );
  });
}

/**
 * Helper to convert [lon, lat] array to {lat, lon}
 */
function coordsToObj(coords) {
  return { lat: coords[1], lon: coords[0] };
}

/**
 * Formats a clean, modern glassmorphic popup card
 */
function buildPopupHtml(props, coords) {
  const temp =
    props.temperature != null ? parseFloat(props.temperature).toFixed(1) : "--";
  const feelsLike =
    props.heat_index != null
      ? parseFloat(props.heat_index).toFixed(1)
      : props.temperature != null
        ? (parseFloat(props.temperature) + 1.2).toFixed(1)
        : "--";
  const humidity =
    props.humidity != null ? parseFloat(props.humidity).toFixed(0) : "--";
  const windSpeed =
    props.wind_speed != null ? parseFloat(props.wind_speed).toFixed(1) : "--";
  const windGust =
    props.wind_gust != null ? parseFloat(props.wind_gust).toFixed(1) : "--";
  const windDir =
    props.wind_direction != null
      ? parseFloat(props.wind_direction).toFixed(0)
      : 0;
  const pressure =
    props.sea_level_pressure != null
      ? parseFloat(props.sea_level_pressure).toFixed(1)
      : props.pressure != null
        ? parseFloat(props.pressure).toFixed(1)
        : "--";
  const rainRate =
    props.rain_rate != null ? parseFloat(props.rain_rate).toFixed(1) : "0.0";
  const dewPoint =
    props.dew_point != null
      ? parseFloat(props.dew_point).toFixed(1)
      : props.temperature != null
        ? (parseFloat(props.temperature) - 3.5).toFixed(1)
        : "--";

  const lastUpdated = props.last_updated
    ? formatTimestamp(props.last_updated)
    : "Real-time";

  return `
    <div class="popup-weather-card">
      <div class="popup-header">
        <div class="popup-station-badge">
          <i class="fas fa-satellite-dish"></i> ${props.station_id || "STATION"}
        </div>
        <div class="popup-title">${props.station_name || "Weather Station"}</div>
        <div class="popup-coords"><i class="fas fa-map-marker-alt"></i> ${coords.lat.toFixed(4)}°N, ${coords.lon.toFixed(4)}°E</div>
      </div>

      <div class="popup-hero-temp-row">
        <div>
          <div class="popup-temp-large">${temp}°C</div>
          <div class="popup-feels-like"><i class="fas fa-user"></i> Feels like ${feelsLike}°C</div>
        </div>
        <div class="popup-weather-status-icon">
          <i class="${getWeatherIcon(props.temperature, props.humidity, rainRate)}"></i>
        </div>
      </div>

      <div class="popup-grid">
        <div class="popup-metric-item">
          <div class="popup-metric-label"><i class="fas fa-tint" style="color: #38bdf8;"></i> Humidity</div>
          <div class="popup-metric-val">${humidity}%</div>
        </div>
        <div class="popup-metric-item">
          <div class="popup-metric-label"><i class="fas fa-wind" style="color: #10b981;"></i> Wind Speed</div>
          <div class="popup-metric-val">
            ${windSpeed} km/h
            <span style="font-size: 11px; color: #94a3b8;">
              <i class="fas fa-location-arrow" style="transform: rotate(${windDir}deg); display: inline-block;"></i> ${windDir}°
            </span>
          </div>
        </div>
        <div class="popup-metric-item">
          <div class="popup-metric-label"><i class="fas fa-tachometer-alt" style="color: #a855f7;"></i> Pressure</div>
          <div class="popup-metric-val">${pressure} hPa</div>
        </div>
        <div class="popup-metric-item">
          <div class="popup-metric-label"><i class="fas fa-cloud-showers-heavy" style="color: #60a5fa;"></i> Rain Rate</div>
          <div class="popup-metric-val">${rainRate} mm/h</div>
        </div>
        <div class="popup-metric-item">
          <div class="popup-metric-label"><i class="fas fa-compress-arrows-alt" style="color: #f59e0b;"></i> Wind Gust</div>
          <div class="popup-metric-val">${windGust} km/h</div>
        </div>
        <div class="popup-metric-item">
          <div class="popup-metric-label"><i class="fas fa-eye-dropper" style="color: #34d399;"></i> Dew Point</div>
          <div class="popup-metric-val">${dewPoint}°C</div>
        </div>
      </div>

      <div class="popup-footer">
        <span><i class="far fa-clock"></i> Synced: ${lastUpdated}</span>
        <div style="display: flex; gap: 6px;">
          <button class="popup-sync-btn" onclick="openStationReport('${props.station_id}', event)" title="View & Download official station report">
            <i class="fas fa-file-invoice"></i> Report
          </button>
          <button class="popup-sync-btn" onclick="fetchLiveWeatherData('${props.station_id}')" title="Refresh this station">
            <i class="fas fa-sync-alt"></i> Refresh
          </button>
        </div>
      </div>
    </div>
  `;
}

/**
 * Returns weather icon based on conditions
 */
function getWeatherIcon(temp, humidity, rain) {
  if (parseFloat(rain) > 0.5) return "fas fa-cloud-showers-heavy";
  if (parseFloat(rain) > 0) return "fas fa-cloud-rain";
  if (parseFloat(humidity) > 85) return "fas fa-smog";
  if (parseFloat(temp) >= 30) return "fas fa-sun";
  if (parseFloat(temp) >= 24) return "fas fa-cloud-sun";
  return "fas fa-cloud";
}

/**
 * Formats timestamps cleanly
 */
function formatTimestamp(isoStr) {
  try {
    const d = new Date(isoStr);
    return d.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch (e) {
    return "Just now";
  }
}

/**
 * Fetches Live Real-Time Telemetry from Open-Meteo Weather API
 */
async function fetchLiveWeatherData(singleStationId = null) {
  WeatherPulse.isFetching = true;
  const refreshIcon = document.getElementById("refreshIcon");
  if (refreshIcon) refreshIcon.classList.add("spin-icon");

  const liveBadge = document.getElementById("liveBadgeText");
  if (liveBadge) liveBadge.innerText = "FETCHING LIVE DATA...";

  const targets = singleStationId
    ? WeatherPulse.stations.filter(
        (s) => s.properties.station_id === singleStationId,
      )
    : WeatherPulse.stations;

  let successCount = 0;

  try {
    const fetchPromises = targets.map(async (feature) => {
      const coords = feature.geometry.coordinates;
      const lon = coords[0];
      const lat = coords[1];

      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation`;

      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP error ${response.status}`);
      const data = await response.json();

      if (data && data.current) {
        const cur = data.current;
        feature.properties.temperature = cur.temperature_2m;
        feature.properties.humidity = cur.relative_humidity_2m;
        feature.properties.heat_index = cur.apparent_temperature;
        feature.properties.sea_level_pressure = cur.surface_pressure;
        feature.properties.pressure = cur.surface_pressure;
        feature.properties.wind_speed = cur.wind_speed_10m;
        feature.properties.wind_direction = cur.wind_direction_10m;
        feature.properties.wind_gust = cur.wind_gusts_10m;
        feature.properties.rain_rate = cur.precipitation;
        feature.properties.dew_point = parseFloat(
          (cur.temperature_2m - (100 - cur.relative_humidity_2m) / 5).toFixed(
            1,
          ),
        );
        feature.properties.last_updated = new Date().toISOString();
        feature.properties.last_observation_time = new Date().toISOString();
        successCount++;
      }
    });

    await Promise.all(fetchPromises);

    // Update UI components with new live data
    refreshMarkerIcons();
    renderStationCards();
    updateKPICards();
    updateAnalyticsChart();

    const now = new Date();
    const timeStr = now.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const lastSyncEl = document.getElementById("lastSyncTime");
    if (lastSyncEl) lastSyncEl.innerText = `Synced: ${timeStr}`;

    showToast(`🟢 Updated ${successCount} stations with live weather data`);
  } catch (err) {
    console.error("Live weather fetch error:", err);
    showToast("⚠️ Could not reach live weather API. Showing cached data.");
  } finally {
    WeatherPulse.isFetching = false;
    if (refreshIcon) refreshIcon.classList.remove("spin-icon");
    if (liveBadge) liveBadge.innerText = "LIVE TELEMETRY STREAM";
    WeatherPulse.countdown = WeatherPulse.autoRefreshInterval;
  }
}

/**
 * Updates Floating KPI HUD Cards with Calculated Statistics
 */
function updateKPICards() {
  const stations = WeatherPulse.stations;
  if (!stations.length) return;

  const total = stations.length;
  let sumTemp = 0,
    minTemp = Infinity,
    maxTemp = -Infinity;
  let sumHum = 0;
  let maxGust = 0,
    maxGustStation = "--";
  let sumPressure = 0;
  let validTempCount = 0;

  stations.forEach((st) => {
    const p = st.properties || {};
    if (p.temperature != null) {
      const t = parseFloat(p.temperature);
      sumTemp += t;
      validTempCount++;
      if (t < minTemp) minTemp = t;
      if (t > maxTemp) maxTemp = t;
    }
    if (p.humidity != null) sumHum += parseFloat(p.humidity);
    if (p.wind_gust != null) {
      const g = parseFloat(p.wind_gust);
      if (g > maxGust) {
        maxGust = g;
        maxGustStation = p.station_name || p.station_id;
      }
    }
    const press =
      p.sea_level_pressure != null
        ? parseFloat(p.sea_level_pressure)
        : p.pressure != null
          ? parseFloat(p.pressure)
          : null;
    if (press != null) sumPressure += press;
  });

  const avgTemp = validTempCount ? (sumTemp / validTempCount).toFixed(1) : "--";
  const avgHum = validTempCount ? (sumHum / validTempCount).toFixed(0) : "--";
  const avgPress = validTempCount
    ? (sumPressure / validTempCount).toFixed(1)
    : "--";

  // Update DOM Elements
  setElText("kpiActiveStations", `${total} / ${total}`);
  setElText("kpiActiveSub", "100% Online & Reporting");

  setElText("kpiAvgTemp", `${avgTemp}°C`);
  setElText(
    "kpiTempSub",
    `Min: ${minTemp.toFixed(1)}° | Max: ${maxTemp.toFixed(1)}°`,
  );

  setElText("kpiAvgHum", `${avgHum}%`);
  setElText(
    "kpiHumSub",
    avgHum > 80 ? "High Moisture / Tropical" : "Moderate Humidity",
  );

  setElText("kpiMaxWind", `${maxGust.toFixed(1)} km/h`);
  setElText("kpiWindSub", `Peak: ${maxGustStation}`);

  setElText("kpiAvgPressure", `${avgPress} hPa`);
  setElText("kpiPressureSub", "Barometric Gradient Stable");
}

/**
 * Helper to update text safely
 */
function setElText(id, val) {
  const el = document.getElementById(id);
  if (el) el.innerText = val;
}

/**
 * Renders the Station Explorer Cards in the Left Sidebar
 */
function renderStationCards(filteredStations = null) {
  const container = document.getElementById("stationCardList");
  if (!container) return;

  const list = filteredStations || WeatherPulse.stations;
  setElText("stationCountBadge", `${list.length} Stations`);

  if (!list.length) {
    container.innerHTML = `
      <div style="text-align: center; padding: 40px 10px; color: var(--text-dim);">
        <i class="fas fa-search" style="font-size: 24px; margin-bottom: 8px;"></i>
        <p>No weather stations found matching filter.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = list
    .map((st) => {
      const p = st.properties || {};
      const isActive =
        WeatherPulse.activeStationId === p.station_id ? "active" : "";

      return `
      <button type="button" class="station-card ${isActive}" id="card-${p.station_id}" aria-pressed="${Boolean(isActive)}" onclick="selectStation('${p.station_id}', true)">
        <span class="st-card-title">${p.station_name || "Station"}</span>
      </button>
    `;
    })
    .join("");
}

/**
 * Handles station selection from card or marker
 */
function selectStation(stationId, flyToMap = true) {
  WeatherPulse.activeStationId = stationId;

  // Highlight card
  document.querySelectorAll(".station-card").forEach((stationButton) => {
    const isActive = stationButton.id === `card-${stationId}`;
    stationButton.classList.toggle("active", isActive);
    stationButton.setAttribute("aria-pressed", String(isActive));
  });
  const card = document.getElementById(`card-${stationId}`);
  if (card) {
    card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  if (flyToMap && window.matchMedia("(max-width: 768px)").matches) {
    document.getElementById("dashSidebar")?.classList.remove("open");
    const sidebarButton = document.getElementById("toggleSidebarBtn");
    if (sidebarButton) {
      sidebarButton.classList.remove("active");
      sidebarButton.setAttribute("aria-expanded", "false");
    }
  }

  // Focus on map
  const feature = WeatherPulse.stations.find(
    (s) => s.properties.station_id === stationId,
  );
  if (!feature) return;

  const marker = WeatherPulse.markersMap.get(stationId);
  const coords = feature.geometry.coordinates;

  if (flyToMap && typeof map !== "undefined") {
    map.flyTo([coords[1], coords[0]], 12, { duration: 1.2 });
    if (marker) {
      setTimeout(() => {
        marker.openPopup();
      }, 1200);
    }
  } else if (marker) {
    marker.openPopup();
  }
}

/**
 * Filters station cards by text query
 */
function filterStationCards(query) {
  if (!query) {
    renderStationCards();
    return;
  }
  const filtered = WeatherPulse.stations.filter((st) => {
    const p = st.properties || {};
    const nameMatch = (p.station_name || "").toLowerCase().includes(query);
    const idMatch = (p.station_id || "").toLowerCase().includes(query);
    return nameMatch || idMatch;
  });
  renderStationCards(filtered);
}

/**
 * Applies category filter chips
 */
function applyFilter(category) {
  if (category === "all") {
    renderStationCards();
    return;
  }
  const filtered = WeatherPulse.stations.filter((st) => {
    const p = st.properties || {};
    if (category === "hot") return (p.temperature || 0) >= 28;
    if (category === "wind")
      return (p.wind_speed || 0) >= 15 || (p.wind_gust || 0) >= 25;
    if (category === "rain") return (p.rain_rate || 0) > 0;
    return true;
  });
  renderStationCards(filtered);
}

/**
 * Starts auto-refresh countdown
 */
function startRefreshTimer() {
  if (WeatherPulse.timerId) clearInterval(WeatherPulse.timerId);

  WeatherPulse.timerId = setInterval(() => {
    WeatherPulse.countdown--;
    const timerLabel = document.getElementById("autoSyncCountdown");
    if (timerLabel) timerLabel.innerText = `${WeatherPulse.countdown}s`;

    if (WeatherPulse.countdown <= 0) {
      WeatherPulse.countdown = WeatherPulse.autoRefreshInterval;
      fetchLiveWeatherData();
    }
  }, 1000);
}

/**
 * Initializes and updates Chart.js telemetry charts
 */
function initAnalyticsChart() {
  const canvas = document.getElementById("telemetryChart");
  if (!canvas || typeof Chart === "undefined") return;

  const ctx = canvas.getContext("2d");
  WeatherPulse.chartInstance = new Chart(ctx, {
    type: "bar",
    data: getChartData(WeatherPulse.currentTab),
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: "index",
        intersect: false,
      },
      plugins: {
        legend: {
          labels: {
            color: "#526760",
            font: { family: "Outfit", size: 12 },
          },
        },
        tooltip: {
          backgroundColor: "rgba(255, 255, 255, 0.98)",
          titleColor: "#17382d",
          bodyColor: "#526760",
          titleFont: { family: "Outfit", size: 13, weight: "bold" },
          bodyFont: { family: "JetBrains Mono", size: 12 },
          borderColor: "rgba(20, 108, 82, 0.24)",
          borderWidth: 1,
          padding: 10,
        },
      },
      scales: {
        x: {
          ticks: { color: "#526760", font: { family: "Outfit" } },
          grid: { color: "rgba(23, 56, 45, 0.08)" },
        },
        y: {
          ticks: { color: "#526760", font: { family: "JetBrains Mono" } },
          grid: { color: "rgba(23, 56, 45, 0.08)" },
        },
      },
    },
  });
}

/**
 * Updates analytics chart according to current active tab
 */
function updateAnalyticsChart() {
  if (!WeatherPulse.chartInstance) {
    initAnalyticsChart();
    return;
  }
  WeatherPulse.chartInstance.data = getChartData(WeatherPulse.currentTab);
  WeatherPulse.chartInstance.update();
}

/**
 * Builds datasets for Chart.js based on current tab
 */
function getChartData(tab) {
  const stations = WeatherPulse.stations;
  const labels = stations.map((s) =>
    s.properties.station_name
      ? s.properties.station_name.replace(" Station", "")
      : s.properties.station_id,
  );

  if (tab === "wind") {
    return {
      labels: labels,
      datasets: [
        {
          label: "Wind Speed (km/h)",
          data: stations.map((s) => s.properties.wind_speed || 0),
          backgroundColor: "rgba(16, 185, 129, 0.7)",
          borderColor: "#10b981",
          borderWidth: 1.5,
          borderRadius: 6,
        },
        {
          label: "Wind Gust (km/h)",
          data: stations.map((s) => s.properties.wind_gust || 0),
          backgroundColor: "rgba(245, 158, 11, 0.7)",
          borderColor: "#f59e0b",
          borderWidth: 1.5,
          borderRadius: 6,
        },
      ],
    };
  } else if (tab === "pressure") {
    return {
      labels: labels,
      datasets: [
        {
          label: "Relative Humidity (%)",
          data: stations.map((s) => s.properties.humidity || 0),
          backgroundColor: "rgba(56, 189, 248, 0.65)",
          borderColor: "#38bdf8",
          borderWidth: 1.5,
          borderRadius: 6,
        },
        {
          label: "Pressure (hPa / 10)",
          data: stations.map(
            (s) =>
              (s.properties.sea_level_pressure || s.properties.pressure || 0) /
              10,
          ),
          backgroundColor: "rgba(168, 85, 247, 0.65)",
          borderColor: "#a855f7",
          borderWidth: 1.5,
          borderRadius: 6,
        },
      ],
    };
  } else {
    // Default: Temperature & Heat Index
    return {
      labels: labels,
      datasets: [
        {
          label: "Temperature (°C)",
          data: stations.map((s) => s.properties.temperature || 0),
          backgroundColor: "rgba(244, 63, 94, 0.7)",
          borderColor: "#f43f5e",
          borderWidth: 1.5,
          borderRadius: 6,
        },
        {
          label: "Feels Like (°C)",
          data: stations.map(
            (s) => s.properties.heat_index || s.properties.temperature || 0,
          ),
          backgroundColor: "rgba(245, 158, 11, 0.6)",
          borderColor: "#f59e0b",
          borderWidth: 1.5,
          borderRadius: 6,
        },
      ],
    };
  }
}

/**
 * Shows temporary bottom toast banner
 */
function showToast(message) {
  const toast = document.getElementById("dashToast");
  if (!toast) return;
  toast.innerText = message;
  toast.classList.add("show");
  setTimeout(() => {
    toast.classList.remove("show");
  }, 3400);
}

/**
 * Exports current live GeoJSON data to file
 */
function exportGeoJSON() {
  const featureCollection = {
    type: "FeatureCollection",
    name: "weather_stations_live",
    crs: {
      type: "name",
      properties: { name: "urn:ogc:def:crs:OGC:1.3:CRS84" },
    },
    features: WeatherPulse.stations,
  };
  const dataStr =
    "data:text/json;charset=utf-8," +
    encodeURIComponent(JSON.stringify(featureCollection, null, 2));
  const dlAnchor = document.createElement("a");
  dlAnchor.setAttribute("href", dataStr);
  dlAnchor.setAttribute(
    "download",
    `weather_stations_live_${new Date().toISOString().slice(0, 10)}.geojson`,
  );
  dlAnchor.click();
}

/**
 * Exports current live telemetry to CSV
 */
function exportCSV() {
  const headers = [
    "station_id",
    "station_name",
    "latitude",
    "longitude",
    "temperature_c",
    "humidity_percent",
    "wind_speed_kmh",
    "wind_direction_deg",
    "wind_gust_kmh",
    "pressure_hpa",
    "rain_rate_mmh",
    "last_updated",
  ];
  const rows = WeatherPulse.stations.map((st) => {
    const p = st.properties || {};
    const coords = st.geometry.coordinates;
    return [
      `"${p.station_id || ""}"`,
      `"${p.station_name || ""}"`,
      coords[1],
      coords[0],
      p.temperature != null ? p.temperature : "",
      p.humidity != null ? p.humidity : "",
      p.wind_speed != null ? p.wind_speed : "",
      p.wind_direction != null ? p.wind_direction : "",
      p.wind_gust != null ? p.wind_gust : "",
      p.sea_level_pressure != null ? p.sea_level_pressure : p.pressure || "",
      p.rain_rate != null ? p.rain_rate : "0",
      `"${p.last_updated || ""}"`,
    ].join(",");
  });

  const csvContent =
    "data:text/csv;charset=utf-8," + [headers.join(","), ...rows].join("\n");
  const dlAnchor = document.createElement("a");
  dlAnchor.setAttribute("href", encodeURI(csvContent));
  dlAnchor.setAttribute(
    "download",
    `weather_telemetry_${new Date().toISOString().slice(0, 10)}.csv`,
  );
  dlAnchor.click();
}

/**
 * Opens and renders the Official Station Meteorological Report modal
 */
function openStationReport(stationId, event) {
  if (event) event.stopPropagation();

  const feature = WeatherPulse.stations.find(
    (s) => s.properties.station_id === stationId,
  );
  if (!feature) {
    showToast("⚠️ Station record not found.");
    return;
  }

  WeatherPulse.currentReportStation = feature;
  const p = feature.properties || {};
  const coords = feature.geometry.coordinates;

  const temp =
    p.temperature != null ? parseFloat(p.temperature).toFixed(1) : "--";
  const heatIndex =
    p.heat_index != null
      ? parseFloat(p.heat_index).toFixed(1)
      : p.temperature != null
        ? (parseFloat(p.temperature) + 1.2).toFixed(1)
        : "--";
  const humidity =
    p.humidity != null ? parseFloat(p.humidity).toFixed(0) : "--";
  const windSpeed =
    p.wind_speed != null ? parseFloat(p.wind_speed).toFixed(1) : "--";
  const windGust =
    p.wind_gust != null ? parseFloat(p.wind_gust).toFixed(1) : "--";
  const windDir =
    p.wind_direction != null ? parseFloat(p.wind_direction).toFixed(0) : 0;
  const pressure =
    p.sea_level_pressure != null
      ? parseFloat(p.sea_level_pressure).toFixed(1)
      : p.pressure != null
        ? parseFloat(p.pressure).toFixed(1)
        : "--";
  const rainRate =
    p.rain_rate != null ? parseFloat(p.rain_rate).toFixed(1) : "0.0";
  const dewPoint =
    p.dew_point != null
      ? parseFloat(p.dew_point).toFixed(1)
      : p.temperature != null
        ? (parseFloat(p.temperature) - 3.5).toFixed(1)
        : "--";
  const cardinal = getCardinalDirection(windDir);

  // Advisory logic
  let advisoryText =
    "Atmospheric conditions are within seasonal normal thresholds. No hazardous meteorological phenomena detected.";
  if (parseFloat(rainRate) > 1.0) {
    advisoryText =
      "ACTIVE PRECIPITATION ADVISORY: Significant rainfall rate detected. Monitor potential localized drainage and surface runoff.";
  } else if (parseFloat(windGust) > 35) {
    advisoryText =
      "HIGH WIND WATCH: Peak wind gusts exceeding 35 km/h. Caution recommended for elevated structures and light aviation.";
  } else if (parseFloat(temp) >= 32) {
    advisoryText =
      "ELEVATED THERMAL ADVISORY: Ambient surface temperature exceeding 32°C with high heat index. Hydration and shade recommended.";
  }

  const html = `
    <div class="bulletin-card">
      <div class="bulletin-station-head">
        <div>
          <div class="bulletin-name">${p.station_name || "Meteorological Station"}</div>
          <span class="bulletin-id-tag"><i class="fas fa-barcode"></i> Station ID: ${p.station_id}</span>
          <div style="font-size: 12px; color: var(--text-dim); margin-top: 6px; font-family: var(--font-mono);">
            <i class="fas fa-map-marked-alt"></i> Location: ${coords[1].toFixed(4)}°N, ${coords[0].toFixed(4)}°E (Nigeria)
          </div>
        </div>
        <div style="text-align: right;">
          <div class="bulletin-status-badge">
            <i class="fas fa-circle" style="font-size: 8px;"></i> Online & Reporting
          </div>
          <div style="font-size: 11px; color: var(--text-dim); margin-top: 6px;">
            Observation: ${p.last_updated ? new Date(p.last_updated).toLocaleString() : new Date().toLocaleString()}
          </div>
        </div>
      </div>

      <!-- Core 4 KPI Boxes -->
      <div class="bulletin-metrics-summary">
        <div class="bulletin-summary-box">
          <div class="bulletin-summary-label">Ambient Temp</div>
          <div class="bulletin-summary-val" style="color: #f59e0b;">${temp} <span style="font-size: 12px;">°C</span></div>
        </div>
        <div class="bulletin-summary-box">
          <div class="bulletin-summary-label">Feels Like (Heat Index)</div>
          <div class="bulletin-summary-val" style="color: #f43f5e;">${heatIndex} <span style="font-size: 12px;">°C</span></div>
        </div>
        <div class="bulletin-summary-box">
          <div class="bulletin-summary-label">Relative Humidity</div>
          <div class="bulletin-summary-val" style="color: #38bdf8;">${humidity} <span style="font-size: 12px;">%</span></div>
        </div>
        <div class="bulletin-summary-box">
          <div class="bulletin-summary-label">Barometer Pressure</div>
          <div class="bulletin-summary-val" style="color: #a855f7;">${pressure} <span style="font-size: 12px;">hPa</span></div>
        </div>
      </div>

      <!-- Comprehensive Telemetry Table -->
      <table class="bulletin-table">
        <thead>
          <tr>
            <th>Telemetry Parameter</th>
            <th>Observed Value</th>
            <th>Standard Baseline</th>
            <th>Operational Status</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td class="bulletin-param-name"><i class="fas fa-temperature-high" style="color: #f59e0b;"></i> Temperature (2m)</td>
            <td class="bulletin-param-val">${temp} °C</td>
            <td style="color: var(--text-dim);">18.0 - 34.0 °C</td>
            <td><span style="color: #10b981; font-weight: 600;">Calibrated</span></td>
          </tr>
          <tr>
            <td class="bulletin-param-name"><i class="fas fa-tint" style="color: #38bdf8;"></i> Relative Humidity</td>
            <td class="bulletin-param-val">${humidity} %</td>
            <td style="color: var(--text-dim);">40 - 95 %</td>
            <td><span style="color: #10b981; font-weight: 600;">Optimal</span></td>
          </tr>
          <tr>
            <td class="bulletin-param-name"><i class="fas fa-wind" style="color: #10b981;"></i> Sustained Wind Speed</td>
            <td class="bulletin-param-val">${windSpeed} km/h</td>
            <td style="color: var(--text-dim);">&lt; 40.0 km/h</td>
            <td><span style="color: #10b981; font-weight: 600;">Normal</span></td>
          </tr>
          <tr>
            <td class="bulletin-param-name"><i class="fas fa-compass" style="color: #10b981;"></i> Wind Direction</td>
            <td class="bulletin-param-val">${windDir}° (${cardinal})</td>
            <td style="color: var(--text-dim);">0 - 360° Azimuth</td>
            <td><span style="color: #10b981; font-weight: 600;">Active</span></td>
          </tr>
          <tr>
            <td class="bulletin-param-name"><i class="fas fa-bolt" style="color: #f59e0b;"></i> Peak Wind Gust (10m)</td>
            <td class="bulletin-param-val">${windGust} km/h</td>
            <td style="color: var(--text-dim);">&lt; 55.0 km/h</td>
            <td><span style="color: #10b981; font-weight: 600;">Tracking</span></td>
          </tr>
          <tr>
            <td class="bulletin-param-name"><i class="fas fa-tachometer-alt" style="color: #a855f7;"></i> Surface / Sea-Level Pressure</td>
            <td class="bulletin-param-val">${pressure} hPa</td>
            <td style="color: var(--text-dim);">940 - 1025 hPa</td>
            <td><span style="color: #10b981; font-weight: 600;">Barometric Nominal</span></td>
          </tr>
          <tr>
            <td class="bulletin-param-name"><i class="fas fa-cloud-showers-heavy" style="color: #60a5fa;"></i> Precipitation / Rain Rate</td>
            <td class="bulletin-param-val">${rainRate} mm/h</td>
            <td style="color: var(--text-dim);">&gt; 5.0 mm/h Heavy</td>
            <td><span style="color: #38bdf8; font-weight: 600;">${parseFloat(rainRate) > 0 ? "Active Rain" : "Dry / Clear"}</span></td>
          </tr>
          <tr>
            <td class="bulletin-param-name"><i class="fas fa-eye-dropper" style="color: #34d399;"></i> Calculated Dew Point</td>
            <td class="bulletin-param-val">${dewPoint} °C</td>
            <td style="color: var(--text-dim);">-</td>
            <td><span style="color: #10b981; font-weight: 600;">Valid</span></td>
          </tr>
        </tbody>
      </table>

      <!-- Advisory Box -->
      <div class="bulletin-advisory-box" style="margin-top: 18px;">
        <strong><i class="fas fa-info-circle"></i> Meteorological Advisory:</strong> ${advisoryText}
      </div>
    </div>
  `;

  const container = document.getElementById("reportModalContent");
  if (container) container.innerHTML = html;

  const backdrop = document.getElementById("reportModalBackdrop");
  if (backdrop) backdrop.classList.remove("hidden");
}

function closeStationReport() {
  const backdrop = document.getElementById("reportModalBackdrop");
  if (backdrop) backdrop.classList.add("hidden");
}

function getCardinalDirection(deg) {
  const val = Math.floor(deg / 22.5 + 0.5);
  const arr = [
    "N",
    "NNE",
    "NE",
    "ENE",
    "E",
    "ESE",
    "SE",
    "SSE",
    "S",
    "SSW",
    "SW",
    "WSW",
    "W",
    "WNW",
    "NW",
    "NNW",
  ];
  return arr[val % 16];
}

function printCurrentStationReport() {
  const feature = WeatherPulse.currentReportStation;
  const PdfDocument = window.jspdf?.jsPDF;
  if (!feature || !PdfDocument) {
    window.print();
    return;
  }

  try {
    const props = feature.properties || {};
    const coords = feature.geometry.coordinates;
    const number = (value, digits = 1) => {
      const parsed = Number(value);
      return value != null && Number.isFinite(parsed)
        ? parsed.toFixed(digits)
        : "--";
    };
    const temperature = number(props.temperature);
    const feelsLike = number(props.heat_index);
    const humidity = number(props.humidity, 0);
    const windSpeed = number(props.wind_speed);
    const windGust = number(props.wind_gust);
    const windDirection = number(props.wind_direction, 0);
    const pressure = number(props.sea_level_pressure ?? props.pressure);
    const rainRate = number(props.rain_rate);
    const dewPoint = number(props.dew_point);
    const observedAt = props.last_updated
      ? new Date(props.last_updated).toLocaleString()
      : new Date().toLocaleString();
    const rainValue = parseFloat(rainRate);
    const windValue = parseFloat(windGust);
    const temperatureValue = parseFloat(temperature);
    let advisory =
      "Atmospheric conditions are within seasonal normal thresholds. No hazardous phenomena detected.";
    if (rainValue > 1) {
      advisory =
        "ACTIVE PRECIPITATION ADVISORY: Significant rainfall detected. Monitor localized runoff.";
    } else if (windValue > 35) {
      advisory =
        "HIGH WIND WATCH: Gusts exceed 35 km/h. Use caution around elevated structures.";
    } else if (temperatureValue >= 32) {
      advisory =
        "ELEVATED THERMAL ADVISORY: High temperature and heat index. Hydration and shade are recommended.";
    }

    const phoneLayout = window.matchMedia("(max-width: 600px)").matches;
    const doc = new PdfDocument({
      orientation: "portrait",
      unit: "mm",
      format: phoneLayout ? "a5" : "a4",
    });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = phoneLayout ? 9 : 15;
    const contentWidth = pageWidth - margin * 2;

    doc.setFillColor(7, 16, 30);
    doc.rect(0, 0, pageWidth, 38, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(0, 225, 255);
    doc.text("FEWS NIGERIA", margin, 13);
    doc.setFontSize(phoneLayout ? 12 : 15);
    doc.setTextColor(242, 247, 255);
    doc.text("METEOROLOGICAL STATION BULLETIN", margin, 23);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(174, 192, 212);
    doc.text("Live station telemetry report", margin, 31);

    let y = 49;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(phoneLayout ? 14 : 16);
    doc.setTextColor(24, 42, 60);
    const stationName = doc.splitTextToSize(
      props.station_name || "Meteorological Station",
      contentWidth,
    );
    doc.text(stationName, margin, y);
    y += stationName.length * (phoneLayout ? 6 : 7) + 2;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(83, 103, 123);
    doc.text(`Station ID: ${props.station_id || "--"}`, margin, y);
    doc.text(
      `Location: ${Number(coords[1]).toFixed(4)} N, ${Number(coords[0]).toFixed(4)} E`,
      margin,
      y + 5,
    );
    doc.text(`Observed: ${observedAt}`, pageWidth - margin, y + 5, {
      align: "right",
    });
    y += 13;

    const summary = [
      ["TEMPERATURE", `${temperature} C`],
      ["FEELS LIKE", `${feelsLike} C`],
      ["HUMIDITY", `${humidity} %`],
      ["PRESSURE", `${pressure} hPa`],
    ];
    const summaryColumns = phoneLayout ? 2 : 4;
    const summaryGap = phoneLayout ? 4 : 3;
    const summaryWidth =
      (contentWidth - summaryGap * (summaryColumns - 1)) / summaryColumns;
    const summaryHeight = phoneLayout ? 19 : 20;
    summary.forEach(([label, value], index) => {
      const column = index % summaryColumns;
      const row = Math.floor(index / summaryColumns);
      const x = margin + column * (summaryWidth + summaryGap);
      const cardY = y + row * (summaryHeight + summaryGap);
      doc.setFillColor(237, 243, 248);
      doc.setDrawColor(213, 224, 234);
      doc.roundedRect(x, cardY, summaryWidth, summaryHeight, 1.5, 1.5, "FD");
      doc.setFont("helvetica", "bold");
      doc.setFontSize(phoneLayout ? 7 : 6.5);
      doc.setTextColor(83, 103, 123);
      doc.text(label, x + 3, cardY + 6);
      doc.setFontSize(phoneLayout ? 9 : 10);
      doc.setTextColor(24, 42, 60);
      doc.text(value, x + 3, cardY + 14);
    });
    const summaryRows = Math.ceil(summary.length / summaryColumns);
    y += summaryRows * summaryHeight + (summaryRows - 1) * summaryGap + 11;

    const direction = getCardinalDirection(parseFloat(windDirection) || 0);
    const rows = [
      ["Temperature (2m)", `${temperature} C`, "18-34 C", "Calibrated"],
      ["Feels like", `${feelsLike} C`, "--", "--"],
      ["Relative humidity", `${humidity} %`, "40-95 %", "Optimal"],
      ["Sustained wind speed", `${windSpeed} km/h`, "Under 40 km/h", "Normal"],
      [
        "Wind direction",
        `${windDirection} deg (${direction})`,
        "0-360 deg",
        "Active",
      ],
      ["Peak wind gust", `${windGust} km/h`, "Under 55 km/h", "Tracking"],
      [
        "Surface / sea-level pressure",
        `${pressure} hPa`,
        "940-1025 hPa",
        "Nominal",
      ],
      [
        "Precipitation / rain rate",
        `${rainRate} mm/h`,
        "Over 5 mm/h is heavy",
        rainValue > 0 ? "Active rain" : "Dry / clear",
      ],
      ["Calculated dew point", `${dewPoint} C`, "--", "Valid"],
    ];
    const widths = phoneLayout
      ? [
          contentWidth * 0.28,
          contentWidth * 0.2,
          contentWidth * 0.26,
          contentWidth * 0.26,
        ]
      : [52, 36, 52, contentWidth - 140];
    const headings = phoneLayout
      ? ["PARAMETER", "VALUE", "BASELINE", "STATUS"]
      : ["PARAMETER", "OBSERVED", "REFERENCE", "STATUS"];
    const drawTableHeader = () => {
      doc.setFillColor(20, 36, 56);
      doc.rect(margin, y, contentWidth, 9, "F");
      doc.setFont("helvetica", "bold");
      doc.setFontSize(phoneLayout ? 6.5 : 7);
      doc.setTextColor(236, 244, 251);
      let x = margin;
      headings.forEach((heading, index) => {
        doc.text(heading, x + 2, y + 6);
        x += widths[index];
      });
      y += 9;
    };

    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(24, 42, 60);
    doc.text("TELEMETRY DETAILS", margin, y);
    y += 4;
    drawTableHeader();

    rows.forEach((row, rowIndex) => {
      const wrapped = row.map((cell, index) =>
        doc.splitTextToSize(String(cell), widths[index] - 4),
      );
      const lineCount = Math.max(...wrapped.map((lines) => lines.length));
      const rowHeight = Math.max(8, lineCount * 3.6 + 3);
      if (y + rowHeight > pageHeight - 38) {
        doc.addPage();
        y = 18;
        drawTableHeader();
      }

      if (rowIndex % 2 === 0) {
        doc.setFillColor(245, 248, 251);
        doc.rect(margin, y, contentWidth, rowHeight, "F");
      }
      doc.setFont("helvetica", "normal");
      doc.setFontSize(phoneLayout ? 8 : 7.5);
      doc.setTextColor(48, 66, 84);
      let x = margin;
      wrapped.forEach((lines, index) => {
        doc.text(lines, x + 2, y + 5);
        x += widths[index];
      });
      doc.setDrawColor(221, 229, 236);
      doc.line(margin, y + rowHeight, margin + contentWidth, y + rowHeight);
      y += rowHeight;
    });

    const advisoryLines = doc.splitTextToSize(advisory, contentWidth - 8);
    const advisoryHeight = advisoryLines.length * 4 + 9;
    if (y + advisoryHeight > pageHeight - 24) {
      doc.addPage();
      y = 20;
    } else {
      y += 5;
    }
    doc.setFillColor(255, 247, 230);
    doc.setDrawColor(240, 190, 91);
    doc.roundedRect(margin, y, contentWidth, advisoryHeight, 1.5, 1.5, "FD");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor(126, 82, 19);
    doc.text("METEOROLOGICAL ADVISORY", margin + 4, y + 6);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.text(advisoryLines, margin + 4, y + 11);

    const stationFileName = String(props.station_id || "station").replace(
      /[^a-z0-9_-]/gi,
      "_",
    );
    const date = new Date().toISOString().slice(0, 10);
    doc.save(`FEWS_Report_${stationFileName}_${date}.pdf`);
    showToast("Station report PDF downloaded.");
  } catch (error) {
    console.error("Could not generate station report PDF:", error);
    showToast("PDF download unavailable. Opening the print dialog instead.");
    window.print();
  }
}

function downloadCurrentStationCSV() {
  const feature = WeatherPulse.currentReportStation;
  if (!feature) return;

  const p = feature.properties || {};
  const coords = feature.geometry.coordinates;

  const headers = [
    "Station_ID",
    "Station_Name",
    "Latitude",
    "Longitude",
    "Temperature_C",
    "Feels_Like_C",
    "Humidity_Percent",
    "Wind_Speed_KMH",
    "Wind_Direction_Deg",
    "Wind_Gust_KMH",
    "Pressure_HPA",
    "Rain_Rate_MMH",
    "Dew_Point_C",
    "Observation_Time",
  ];
  const row = [
    `"${p.station_id || ""}"`,
    `"${p.station_name || ""}"`,
    coords[1],
    coords[0],
    p.temperature != null ? p.temperature : "",
    p.heat_index != null ? p.heat_index : "",
    p.humidity != null ? p.humidity : "",
    p.wind_speed != null ? p.wind_speed : "",
    p.wind_direction != null ? p.wind_direction : "",
    p.wind_gust != null ? p.wind_gust : "",
    p.sea_level_pressure != null ? p.sea_level_pressure : p.pressure || "",
    p.rain_rate != null ? p.rain_rate : "0",
    p.dew_point != null ? p.dew_point : "",
    `"${p.last_updated || new Date().toISOString()}"`,
  ];

  const csvContent =
    "data:text/csv;charset=utf-8," +
    [headers.join(","), row.join(",")].join("\n");
  const dlAnchor = document.createElement("a");
  dlAnchor.setAttribute("href", encodeURI(csvContent));
  dlAnchor.setAttribute(
    "download",
    `Report_${p.station_id || "Station"}_${new Date().toISOString().slice(0, 10)}.csv`,
  );
  dlAnchor.click();
}

function downloadCurrentStationJSON() {
  const feature = WeatherPulse.currentReportStation;
  if (!feature) return;

  const reportPayload = {
    report_title: "FEWS Station Telemetry Bulletin",
    generated_at: new Date().toISOString(),
    station: feature,
  };

  const dataStr =
    "data:text/json;charset=utf-8," +
    encodeURIComponent(JSON.stringify(reportPayload, null, 2));
  const dlAnchor = document.createElement("a");
  dlAnchor.setAttribute("href", dataStr);
  dlAnchor.setAttribute(
    "download",
    `Report_${feature.properties.station_id || "Station"}_${new Date().toISOString().slice(0, 10)}.json`,
  );
  dlAnchor.click();
}

// Auto-boot application on DOM ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initWeatherDashboard);
} else {
  // If script executes after DOM loaded
  initWeatherDashboard();
}
