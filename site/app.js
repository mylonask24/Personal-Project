(() => {
  const config = window.ARCHAEOLOGY_MAP_CONFIG;
  const panel = document.querySelector("#site-sidebar");
  const mapElement = document.querySelector(".folium-map");

  if (!config || !panel || !mapElement) {
    throw new Error("The archaeology map interface could not find its map configuration.");
  }

  const map = window[config.mapName];
  if (!map) {
    throw new Error(`The Leaflet map "${config.mapName}" was not initialized.`);
  }

  const categoriesElement = panel.querySelector("#category-list");
  const searchInput = panel.querySelector("#place-search");
  const searchResults = panel.querySelector("#search-results");
  const searchStatus = panel.querySelector("#search-status");
  const mapLoadStatus = panel.querySelector("#map-load-status");
  const totalCount = panel.querySelector("#total-count");
  const menuButton = document.querySelector("#menu-button");
  const closeButton = panel.querySelector("#close-sidebar");
  const backdrop = document.querySelector("#sidebar-backdrop");
  const nearbySection = document.createElement("section");
  nearbySection.className = "nearby-section";
  nearbySection.setAttribute("aria-labelledby", "nearby-heading");
  nearbySection.innerHTML =
    '<h2 id="nearby-heading" class="section-heading">Find nearby places</h2>' +
    '<form id="nearby-address-form" class="nearby-address-form">' +
    '<label class="sr-only" for="nearby-address">Address in Greece</label>' +
    '<input id="nearby-address" type="search" placeholder="Enter an address in Greece" autocomplete="street-address" />' +
    '<button class="nearby-button" type="submit">Search</button></form>' +
    '<button id="use-current-location" class="nearby-button nearby-location-button" type="button">Use my current location</button>' +
    '<p id="nearby-status" role="status" aria-live="polite">Search an address or use your current location.</p>' +
    '<div id="nearby-results"></div>' +
    '<p class="nearby-attribution">Address search by <a href="https://nominatim.org/" target="_blank" rel="noopener">OpenStreetMap Nominatim</a>.</p>';
  panel.querySelector(".category-section").before(nearbySection);

  const addressForm = nearbySection.querySelector("#nearby-address-form");
  const addressInput = nearbySection.querySelector("#nearby-address");
  const addressButton = addressForm.querySelector("button");
  const locationButton = nearbySection.querySelector("#use-current-location");
  const nearbyStatus = nearbySection.querySelector("#nearby-status");
  const nearbyResults = nearbySection.querySelector("#nearby-results");
  const trendingSection = document.createElement("section");
  trendingSection.className = "trending-panel";
  trendingSection.setAttribute("aria-labelledby", "trending-heading");
  const trendingHeading = document.createElement("h2");
  trendingHeading.id = "trending-heading";
  trendingHeading.className = "trending-heading";
  trendingHeading.textContent = "Trending this week";
  const trendingToggle = document.createElement("button");
  trendingToggle.className = "panel-toggle trending-toggle";
  trendingToggle.type = "button";
  trendingToggle.textContent = "Hide";
  trendingToggle.setAttribute("aria-label", "Hide Trending this week panel");
  trendingToggle.setAttribute("aria-expanded", "true");
  const trendingStatus = document.createElement("p");
  trendingStatus.className = "trending-status";
  trendingStatus.setAttribute("role", "status");
  trendingStatus.setAttribute("aria-live", "polite");
  trendingStatus.textContent = "Connecting to shared activity...";
  const trendingCards = document.createElement("div");
  trendingCards.className = "trending-cards";
  const trendingHeader = document.createElement("div");
  trendingHeader.className = "trending-header";
  trendingHeader.append(trendingHeading, trendingToggle);
  trendingSection.append(trendingHeader, trendingStatus, trendingCards);
  trendingToggle.addEventListener("click", () => {
    const collapsed = trendingSection.classList.toggle("is-collapsed");
    trendingToggle.textContent = collapsed ? "Show trending" : "Hide";
    trendingToggle.setAttribute("aria-expanded", String(!collapsed));
    trendingToggle.setAttribute(
      "aria-label",
      `${collapsed ? "Show" : "Hide"} Trending this week panel`,
    );
  });
  const trendingControl = L.control({ position: "topright" });
  trendingControl.onAdd = () => {
    L.DomEvent.disableClickPropagation(trendingSection);
    L.DomEvent.disableScrollPropagation(trendingSection);
    return trendingSection;
  };
  trendingControl.addTo(map);

  const layers = config.layers.map((item) => {
    const layer = window[item.variable];
    if (!layer) {
      throw new Error(`The map layer "${item.category}" was not initialized.`);
    }

    const markerCluster = item.clusterVariable
      ? window[item.clusterVariable]
      : null;
    if (item.clusterVariable && !markerCluster) {
      throw new Error(`The marker cluster for "${item.category}" was not initialized.`);
    }

    return { ...item, layer, markerCluster };
  });
  addressForm.addEventListener("submit", (event) => {
    event.preventDefault();
    searchAddress(addressInput.value);
  });
  locationButton.addEventListener("click", findNearbyByCurrentLocation);

  const countFormatter = new Intl.NumberFormat();
  layers.forEach((item) => {
    if (!item.markerCluster) {
      return;
    }

    const museumCluster = item.category === "Museums (points)";
    item.markerCluster.options.iconCreateFunction = (cluster) => {
      const count = cluster.getChildCount();
      const size = count >= 100 ? 48 : count >= 20 ? 42 : 36;
      const className = museumCluster
        ? "arch-cluster arch-cluster-museum"
        : "arch-cluster arch-cluster-monument";
      return L.divIcon({
        html: `<span>${countFormatter.format(count)}</span>`,
        className,
        iconSize: L.point(size, size),
        iconAnchor: L.point(size / 2, size / 2),
      });
    };
  });

  const searchableFeatures = [];
  let indexBuilt = false;
  let searchTimer;
  let userLocationMarker;
  let trendingFirebase;
  let trendingReady;
  const recordedInteractions = new Set();
  const trendingPhotos = new Map();
  const photoStopWords = new Set([
    "the", "and", "for", "from", "with", "site", "sites", "place", "places",
    "archaeological", "historic", "monument", "monuments", "museum", "museums",
    "island", "city", "church", "section", "street", "facility", "junction",
    "greece", "of", "in", "at",
  ]);
  const trendableCategories = new Set([
    "Archaeological sites",
    "Historic places",
    "Monuments (points)",
    "Museums (points)",
  ]);
  const trendingCollection = "trending";

  totalCount.textContent = countFormatter.format(
    layers.reduce((sum, item) => sum + item.count, 0),
  );

  function createLayerControls() {
    layers.forEach((item, index) => {
      const wrapper = document.createElement("label");
      wrapper.className = "category-option";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = map.hasLayer(item.layer);
      checkbox.setAttribute("aria-label", `Show ${item.category}`);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          item.layer.addTo(map);
        } else {
          map.removeLayer(item.layer);
        }
      });

      const text = document.createElement("span");
      text.className = "category-name";
      text.textContent = item.category;

      const count = document.createElement("span");
      count.className = "category-count";
      count.textContent = countFormatter.format(item.count);

      wrapper.append(checkbox, text, count);
      wrapper.dataset.categoryIndex = String(index);
      categoriesElement.append(wrapper);
    });
  }

  function textFromContent(content) {
    if (typeof content !== "string") {
      return "";
    }
    const template = document.createElement("template");
    template.innerHTML = content;
    return template.content.textContent.trim();
  }

  function collectFeatures(layer, category, markerCluster = null) {
    if (typeof layer.eachLayer === "function") {
      const nextCluster =
        typeof layer.zoomToShowLayer === "function" ? layer : markerCluster;
      layer.eachLayer((child) => collectFeatures(child, category, nextCluster));
      return;
    }

    const properties = layer.feature?.properties ?? {};
    const tooltip = layer.getTooltip?.();
    const popup = layer.getPopup?.();
    const name =
      properties.name_en ||
      properties.name ||
      textFromContent(tooltip?.getContent?.()) ||
      textFromContent(popup?.getContent?.()) ||
      "Unnamed place";
    const geometry = layer.feature?.geometry;
    if (!geometry) {
      return;
    }

    searchableFeatures.push({
      category,
      layer,
      feature: layer.feature,
      markerCluster,
      name,
      geometry,
      region: properties.region_unit_en || "",
      placeId: createPlaceId(layer.feature, layer, category),
      searchText: `${name} ${properties.name || ""} ${properties.region_unit_en || ""} ${category}`.toLocaleLowerCase(),
    });
  }

  function buildSearchIndex() {
    if (indexBuilt) {
      return;
    }

    layers.forEach((item) => collectFeatures(item.layer, item.category));
    indexBuilt = true;
  }

  function createPopup(feature) {
    const properties = feature.properties ?? {};
    const content = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = properties.name_en || properties.name || "Unnamed place";
    content.append(title);

    if (properties.category) {
      const category = document.createElement("div");
      category.textContent = properties.category;
      content.append(category);
    }
    if (properties.name && properties.name_en) {
      const sourceName = document.createElement("div");
      sourceName.textContent = properties.name;
      content.append(sourceName);
    }

    const link = document.createElement("a");
    link.href = "https://www.arxaiologikoktimatologio.gov.gr/map";
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "Greek Archaeological Cadastre";
    content.append(link);
    return content;
  }

  function createPlaceId(feature, layer, category) {
    const properties = feature?.properties ?? {};
    const center = typeof layer.getBounds === "function"
      ? layer.getBounds().getCenter()
      : layer.getLatLng();
    const name = properties.name_en || properties.name || "Unnamed place";
    return encodeURIComponent(JSON.stringify([
      category,
      name,
      properties.region_unit_en || "",
      center.lat.toFixed(5),
      center.lng.toFixed(5),
    ]));
  }

  function renderTrending(snapshot) {
    const totals = new Map();
    snapshot.docs.forEach((document) => {
      const activity = document.data();
      if (!activity.placeId || !activity.name) {
        return;
      }
      const current = totals.get(activity.placeId) ?? {
        placeId: activity.placeId,
        name: activity.name,
        category: activity.category,
        region: activity.region,
        count: 0,
      };
      current.count += 1;
      totals.set(activity.placeId, current);
    });

    const ranked = [...totals.values()]
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
      .slice(0, 5);
    trendingCards.replaceChildren();
    if (ranked.length === 0) {
      trendingStatus.textContent = "No place activity yet this week.";
      return;
    }

    trendingStatus.textContent =
      "Popular from map detail views this week · one view per person per place daily.";
    ranked.forEach((place, index) => {
      const card = document.createElement("article");
      card.className = "trending-card";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "trending-card-button";
      button.setAttribute(
        "aria-label",
        `View trending place: ${place.name}, ${place.count} detail ${place.count === 1 ? "view" : "views"}`,
      );
      const photoFrame = document.createElement("span");
      photoFrame.className = "trending-photo";
      const fallback = document.createElement("span");
      fallback.className = "trending-photo-fallback";
      fallback.textContent = "Explore Greece";
      fallback.setAttribute("aria-hidden", "true");
      photoFrame.append(fallback);
      const rank = document.createElement("span");
      rank.className = "trending-rank";
      rank.textContent = String(index + 1);
      photoFrame.append(rank);
      const details = document.createElement("span");
      details.className = "trending-card-details";
      const name = document.createElement("span");
      name.className = "trending-card-name";
      name.textContent = place.name;
      const category = document.createElement("span");
      category.className = "trending-card-category";
      category.textContent = [place.category, place.region].filter(Boolean).join(" · ");
      details.append(name, category);
      const count = document.createElement("span");
      count.className = "trending-count";
      count.textContent = `${countFormatter.format(place.count)} ${place.count === 1 ? "view" : "views"}`;
      button.append(photoFrame, details, count);
      button.addEventListener("click", () => {
        buildSearchIndex();
        const feature = searchableFeatures.find((candidate) => candidate.placeId === place.placeId);
        if (feature) {
          showFeature(feature);
        }
      });
      const credit = document.createElement("a");
      credit.className = "trending-photo-credit";
      credit.textContent = "Photo: Wikimedia Commons";
      credit.href = "https://commons.wikimedia.org/";
      credit.target = "_blank";
      credit.rel = "noopener";
      card.append(button, credit);
      trendingCards.append(card);
      void loadTrendingPhoto(place, photoFrame, credit);
    });
  }

  async function loadTrendingPhoto(place, photoFrame, credit) {
    if (!trendingPhotos.has(place.placeId)) {
      const request = (async () => {
        function plainText(value) {
          const template = document.createElement("template");
          template.innerHTML = value ?? "";
          return template.content.textContent.toLocaleLowerCase();
        }

        async function searchImage(search, keywords) {
          const params = new URLSearchParams({
            action: "query",
            generator: "search",
            gsrsearch: search,
            gsrnamespace: "6",
            gsrlimit: "5",
            prop: "imageinfo",
            iiprop: "url|extmetadata|mime",
            iiurlwidth: "480",
            format: "json",
            origin: "*",
          });
          const response = await fetch(`https://commons.wikimedia.org/w/api.php?${params}`);
          if (!response.ok) {
            throw new Error(`Wikimedia Commons image search failed (${response.status}).`);
          }
          const data = await response.json();
          return Object.values(data.query?.pages ?? {})
            .sort((left, right) => left.index - right.index)
            .map((page) => ({ page, image: page.imageinfo?.[0] }))
            .find(({ page, image }) => {
              const metadata = image?.extmetadata ?? {};
              const searchableText = [
                page.title,
                metadata.ObjectName?.value,
                metadata.ImageDescription?.value,
                metadata.Categories?.value,
              ].map(plainText).join(" ");
              const matchedKeywords = keywords.filter((keyword) =>
                searchableText.includes(keyword),
              );
              return image?.thumburl &&
                ["image/jpeg", "image/png", "image/webp"].includes(image.mime) &&
                !/\b(map|locator|sketch|engraving|painting|drawing|illustration)\b/i.test(searchableText) &&
                matchedKeywords.length >= Math.min(2, keywords.length);
            })?.image ?? null;
        }

        const nameKeywords = place.name
          .toLocaleLowerCase()
          .match(/[a-z]{4,}/g)
          ?.filter((word) => !photoStopWords.has(word)) ?? [];
        const image = await searchImage(
          `${place.name} ${place.region}`,
          [...new Set(nameKeywords)],
        );
        if (!image?.thumburl) {
          return null;
        }
        const metadata = image.extmetadata ?? {};
        const artistTemplate = document.createElement("template");
        artistTemplate.innerHTML = metadata.Artist?.value ?? "";
        const artist = artistTemplate.content.textContent.trim();
        const license = metadata.LicenseShortName?.value;
        return {
          url: image.thumburl,
          descriptionUrl: image.descriptionurl,
          credit: `Photo: ${artist || "Wikimedia Commons"}${license ? ` · ${license}` : ""}`,
        };
      })();
      trendingPhotos.set(place.placeId, request);
    }

    try {
      const photo = await trendingPhotos.get(place.placeId);
      if (!photo) {
        photoFrame.classList.add("has-no-photo");
        credit.textContent = "Photo unavailable";
        credit.removeAttribute("href");
        return;
      }
      const image = document.createElement("img");
      image.src = photo.url;
      image.alt = `Photo of ${place.name}`;
      image.loading = "lazy";
      image.addEventListener("error", () => {
        photoFrame.classList.add("has-no-photo");
        image.remove();
      }, { once: true });
      photoFrame.prepend(image);
      credit.textContent = photo.credit;
      credit.href = photo.descriptionUrl;
    } catch (error) {
      console.error(`Could not load a photo for "${place.name}".`, error);
      photoFrame.classList.add("has-no-photo");
      credit.textContent = "Photo unavailable";
      credit.removeAttribute("href");
    }
  }

  async function initializeTrending() {
    try {
      const { fs, db, auth } = await window.getArchaeologyFirebase();
      trendingFirebase = { fs, db, uid: auth.currentUser.uid };
      const today = new Date().toISOString().slice(0, 10);
      const since = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
      const query = fs.query(
        fs.collection(db, trendingCollection),
        fs.where("day", ">=", since),
        fs.where("day", "<=", today),
        fs.orderBy("day", "desc"),
        fs.limit(5000),
      );
      fs.onSnapshot(query, renderTrending, (error) => {
        console.error("Could not load trending activity.", error);
        trendingStatus.textContent =
          `Trending could not load: ${error.code || error.message}`;
      });
      trendingStatus.textContent = "Waiting for recent place activity...";
    } catch (error) {
      console.error("Could not connect to trending activity.", error);
      trendingStatus.textContent =
        `Trending could not connect: ${error.code || error.message}`;
      throw error;
    }
  }

  async function recordTrendingInteraction(feature, layer, category) {
    if (!trendableCategories.has(category)) {
      return;
    }
    try {
      await trendingReady;
      const properties = feature.properties ?? {};
      const placeId = createPlaceId(feature, layer, category);
      const day = new Date().toISOString().slice(0, 10);
      const dailyKey = `${trendingFirebase.uid}_${day}_${placeId}`;
      if (recordedInteractions.has(dailyKey)) {
        return;
      }

      const { fs, db, uid } = trendingFirebase;
      const activityRef = fs.doc(db, trendingCollection, dailyKey);
      await fs.runTransaction(db, async (transaction) => {
        const existing = await transaction.get(activityRef);
        if (existing.exists()) {
          return;
        }
        transaction.set(activityRef, {
          placeId,
          name: properties.name_en || properties.name || "Unnamed place",
          category,
          region: properties.region_unit_en || "",
          uid,
          day,
          createdAt: fs.serverTimestamp(),
        });
      });
      recordedInteractions.add(dailyKey);
    } catch (error) {
      console.error("Could not record trending activity.", error);
      trendingStatus.textContent =
        `Trending could not record this click: ${error.code || error.message}`;
    }
  }

  function createGeoJsonLayer(data, category) {
    const styles = {
      "Archaeological site boundaries (lines)": {
        color: "#f8fafc",
        weight: 2.5,
        dashArray: "8 5",
        fillOpacity: 0,
      },
      "Archaeological sites": {
        color: "#67e8f9",
        weight: 2,
        fillColor: "#0891b2",
        fillOpacity: 0.28,
      },
      "Historic places": {
        color: "#fde047",
        weight: 2,
        fillColor: "#eab308",
        fillOpacity: 0.26,
      },
      "Protection zones": {
        color: "#fb7185",
        weight: 2,
        fillColor: "#e11d48",
        fillOpacity: 0.16,
      },
    };

    const pointStyle = category === "Museums (points)"
      ? { fillColor: "#fde047", color: "#1f2937", borderClass: "museum" }
      : { fillColor: "#67e8f9", color: "#102a43", borderClass: "monument" };

    return L.geoJSON(data, {
      style: styles[category] ?? {
        color: "#67e8f9",
        weight: 2,
        fillColor: "#0891b2",
        fillOpacity: 0.25,
      },
      pointToLayer: (feature, latlng) => L.circleMarker(latlng, {
        radius: 6,
        color: pointStyle.color,
        weight: 2,
        fillColor: pointStyle.fillColor,
        fillOpacity: 1,
        className: pointStyle.borderClass,
      }),
      onEachFeature: (feature, featureLayer) => {
        const properties = feature.properties ?? {};
        const name = properties.name_en || properties.name || "";
        if (name) {
          const tooltip = document.createElement("span");
          tooltip.textContent = name;
          featureLayer.bindTooltip(tooltip, {
            direction: "top",
            offset: [0, -5],
            sticky: true,
          });
        }
        featureLayer.bindPopup(createPopup(feature), {
          className: "archaeology-popup",
          closeButton: true,
          maxWidth: 280,
        });
        if (trendableCategories.has(category)) {
          featureLayer.on("popupopen", () => {
            void recordTrendingInteraction(feature, featureLayer, category);
          });
        }
      },
    });
  }

  async function fetchGeoJson(url, category) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Unable to load ${category} data (${response.status} ${response.statusText}).`,
      );
    }
    return response.json();
  }

  async function loadExternalLayers() {
    const externalLayers = layers.filter((item) => item.dataFiles);
    if (externalLayers.length === 0) {
      mapLoadStatus.textContent = "";
      return;
    }

    searchInput.disabled = true;
    addressInput.disabled = true;
    addressButton.disabled = true;
    locationButton.disabled = true;
    let loadedCount = 0;
    const failures = [];
    mapLoadStatus.textContent =
      `Loading map data (0 of ${externalLayers.length} categories)...`;

    await Promise.all(
      externalLayers.map(async (item) => {
        try {
          const files = Object.entries(item.dataFiles).filter(([, url]) => url);
          const data = await Promise.all(
            files.map(([, url]) => fetchGeoJson(url, item.category)),
          );
          files.forEach(([kind], index) => {
            const geoJsonLayer = createGeoJsonLayer(data[index], item.category);
            if (kind === "points") {
              item.markerCluster.addLayer(geoJsonLayer);
            } else {
              item.layer.addLayer(geoJsonLayer);
            }
          });
          loadedCount += 1;
          mapLoadStatus.textContent =
            `Loading map data (${loadedCount} of ${externalLayers.length} categories)...`;
        } catch (error) {
          failures.push(item.category);
          console.error(`Failed to load map data for "${item.category}".`, error);
        }
      }),
    );

    searchInput.disabled = false;
    addressInput.disabled = false;
    addressButton.disabled = false;
    locationButton.disabled = false;
    if (failures.length > 0) {
      mapLoadStatus.textContent =
        `Loaded ${loadedCount} of ${externalLayers.length} categories. ` +
        `Could not load: ${failures.join(", ")}.`;
      return;
    }
    mapLoadStatus.textContent = "Map data loaded.";
  }

  function showFeature(feature) {
    const category = layers.find((item) => item.category === feature.category);
    if (category && !map.hasLayer(category.layer)) {
      category.layer.addTo(map);
      const checkbox = categoriesElement.querySelector(
        `[data-category-index="${layers.indexOf(category)}"] input`,
      );
      if (checkbox) {
        checkbox.checked = true;
      }
    }

    if (typeof feature.layer.getBounds === "function") {
      const bounds = feature.layer.getBounds();
      if (bounds.isValid()) {
        map.fitBounds(bounds.pad(0.15), { maxZoom: 14 });
      }
    } else if (typeof feature.layer.getLatLng === "function") {
      map.setView(feature.layer.getLatLng(), Math.max(map.getZoom(), 14));
    }

    const openPopup = () => feature.layer.openPopup?.();
    if (feature.markerCluster?.zoomToShowLayer) {
      feature.markerCluster.zoomToShowLayer(feature.layer, openPopup);
    } else {
      window.setTimeout(openPopup, 250);
    }
    closeSidebar();
  }

  function projectCoordinate(coordinate, origin) {
    const latitudeRadians = (origin.latitude * Math.PI) / 180;
    return {
      x:
        (coordinate[0] - origin.longitude) *
        111320 *
        Math.cos(latitudeRadians),
      y: (coordinate[1] - origin.latitude) * 110574,
    };
  }

  function distanceToSegment(point, start, end) {
    const segmentX = end.x - start.x;
    const segmentY = end.y - start.y;
    const segmentLengthSquared = segmentX * segmentX + segmentY * segmentY;
    if (segmentLengthSquared === 0) {
      return Math.hypot(point.x - start.x, point.y - start.y);
    }

    const projection = Math.max(
      0,
      Math.min(
        1,
        ((point.x - start.x) * segmentX + (point.y - start.y) * segmentY) /
          segmentLengthSquared,
      ),
    );
    return Math.hypot(
      point.x - (start.x + projection * segmentX),
      point.y - (start.y + projection * segmentY),
    );
  }

  function pointInRing(point, ring, origin) {
    let inside = false;
    for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
      const currentPoint = projectCoordinate(ring[index], origin);
      const previousPoint = projectCoordinate(ring[previous], origin);
      const crosses =
        currentPoint.y > point.y !== previousPoint.y > point.y &&
        point.x <
          ((previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)) /
            (previousPoint.y - currentPoint.y) +
            currentPoint.x;
      if (crosses) {
        inside = !inside;
      }
    }
    return inside;
  }

  function ringDistance(point, ring, origin) {
    let nearest = Infinity;
    for (let index = 1; index < ring.length; index += 1) {
      nearest = Math.min(
        nearest,
        distanceToSegment(
          point,
          projectCoordinate(ring[index - 1], origin),
          projectCoordinate(ring[index], origin),
        ),
      );
    }
    return nearest;
  }

  function geometryDistance(point, geometry, origin) {
    if (!geometry) {
      return Infinity;
    }

    const coordinates = geometry.coordinates;
    switch (geometry.type) {
      case "Point": {
        const projected = projectCoordinate(coordinates, origin);
        return Math.hypot(projected.x, projected.y);
      }
      case "MultiPoint":
        return Math.min(
          ...coordinates.map((coordinate) =>
            geometryDistance(point, { type: "Point", coordinates: coordinate }, origin),
          ),
        );
      case "LineString":
        return ringDistance(point, coordinates, origin);
      case "MultiLineString":
        return Math.min(
          ...coordinates.map((line) => ringDistance(point, line, origin)),
        );
      case "Polygon": {
        const [outerRing, ...holes] = coordinates;
        if (
          outerRing &&
          pointInRing(point, outerRing, origin) &&
          !holes.some((hole) => pointInRing(point, hole, origin))
        ) {
          return 0;
        }
        return Math.min(
          ...coordinates.map((ring) => ringDistance(point, ring, origin)),
        );
      }
      case "MultiPolygon":
        return Math.min(
          ...coordinates.map((polygon) =>
            geometryDistance(point, { type: "Polygon", coordinates: polygon }, origin),
          ),
        );
      case "GeometryCollection":
        return Math.min(
          ...geometry.geometries.map((child) =>
            geometryDistance(point, child, origin),
          ),
        );
      default:
        return Infinity;
    }
  }

  function formatDistance(meters) {
    return meters < 1000
      ? `${Math.round(meters)} m away`
      : `${(meters / 1000).toFixed(1)} km away`;
  }

  function clearSearchLocation() {
    if (userLocationMarker) {
      map.removeLayer(userLocationMarker);
      userLocationMarker = null;
    }
  }

  function showNearbyFeatures(location, locationLabel) {
    buildSearchIndex();
    const origin = {
      latitude: location.latitude,
      longitude: location.longitude,
    };
    const point = { x: 0, y: 0 };
    const closest = searchableFeatures
      .map((feature) => ({
        ...feature,
        distance: geometryDistance(point, feature.geometry, origin),
      }))
      .filter((feature) => Number.isFinite(feature.distance))
      .sort((left, right) => left.distance - right.distance)
      .slice(0, 5);

    nearbyResults.replaceChildren();
    if (closest.length === 0) {
      nearbyStatus.textContent = "No mappable features are available to compare.";
      return;
    }

    const locationPopup = document.createElement("span");
    locationPopup.textContent = `Search location: ${locationLabel}`;
    userLocationMarker = L.circleMarker(
      [location.latitude, location.longitude],
      {
        radius: 7,
        color: "#fff",
        weight: 2,
        fillColor: "#28614d",
        fillOpacity: 1,
      },
    )
      .bindPopup(locationPopup)
      .addTo(map);
    map.setView([location.latitude, location.longitude], 12);

    nearbyStatus.textContent = `Five closest features to ${locationLabel}:`;
    closest.forEach((feature) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "search-result";

      const name = document.createElement("span");
      name.className = "result-name";
      name.textContent = feature.name;

      const details = document.createElement("span");
      details.className = "result-details";
      details.textContent = [
        feature.category,
        formatDistance(feature.distance),
        feature.region,
      ]
        .filter(Boolean)
        .join(" · ");

      button.append(name, details);
      button.addEventListener("click", () => showFeature(feature));
      nearbyResults.append(button);
    });
  }

  async function searchAddress(address) {
    const query = address.trim();
    if (!query) {
      nearbyStatus.textContent = "Enter an address in Greece to search.";
      return;
    }

    addressButton.disabled = true;
    locationButton.disabled = true;
    clearSearchLocation();
    nearbyResults.replaceChildren();
    nearbyStatus.textContent = "Looking up address...";
    try {
      const params = new URLSearchParams({
        q: query,
        format: "jsonv2",
        limit: "1",
        countrycodes: "gr",
      });
      const response = await fetch(
        `https://nominatim.openstreetmap.org/search?${params.toString()}`,
        { headers: { Accept: "application/json" } },
      );
      if (!response.ok) {
        throw new Error(
          `Address search failed (${response.status} ${response.statusText}).`,
        );
      }
      const results = await response.json();
      if (results.length === 0) {
        nearbyStatus.textContent =
          "No address found in Greece. Check the spelling and try again.";
        return;
      }

      const result = results[0];
      const latitude = Number(result.lat);
      const longitude = Number(result.lon);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        throw new Error("Address search returned an invalid location.");
      }
      showNearbyFeatures(
        {
          latitude,
          longitude,
        },
        result.display_name,
      );
    } catch (error) {
      console.error("Address lookup failed.", error);
      nearbyStatus.textContent =
        error instanceof Error
          ? error.message
          : "Address lookup failed. Please try again.";
    } finally {
      addressButton.disabled = false;
      locationButton.disabled = false;
    }
  }

  function findNearbyByCurrentLocation() {
    if (!navigator.geolocation) {
      nearbyStatus.textContent =
        "Current location is not available in this browser.";
      return;
    }

    addressButton.disabled = true;
    locationButton.disabled = true;
    clearSearchLocation();
    nearbyResults.replaceChildren();
    nearbyStatus.textContent = "Getting your current location...";
    navigator.geolocation.getCurrentPosition(
      (position) => {
        showNearbyFeatures(
          {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
          },
          "your current location",
        );
        addressButton.disabled = false;
        locationButton.disabled = false;
      },
      (error) => {
        nearbyStatus.textContent =
          error.code === error.PERMISSION_DENIED
            ? "Location permission was denied. You can search an address instead."
            : "Unable to get your location. You can search an address instead.";
        addressButton.disabled = false;
        locationButton.disabled = false;
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 },
    );
  }

  function renderSearchResults(query) {
    searchResults.replaceChildren();

    if (query.length < 2) {
      searchStatus.textContent = "Type at least 2 characters to search.";
      return;
    }

    buildSearchIndex();
    const matches = searchableFeatures.filter((feature) =>
      feature.searchText.includes(query),
    );

    if (matches.length === 0) {
      searchStatus.textContent = "No places found. Try another name or region.";
      return;
    }

    const visibleMatches = matches.slice(0, 25);
    searchStatus.textContent =
      matches.length > visibleMatches.length
        ? `${countFormatter.format(matches.length)} matches. Showing the first ${visibleMatches.length}.`
        : `${countFormatter.format(matches.length)} ${matches.length === 1 ? "place" : "places"} found.`;

    visibleMatches.forEach((feature) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "search-result";

      const name = document.createElement("span");
      name.className = "result-name";
      name.textContent = feature.name;

      const details = document.createElement("span");
      details.className = "result-details";
      details.textContent = [feature.category, feature.region].filter(Boolean).join(" · ");

      button.append(name, details);
      button.addEventListener("click", () => showFeature(feature));
      searchResults.append(button);
    });
  }

  function setAllLayers(visible) {
    layers.forEach((item, index) => {
      const checkbox = categoriesElement.querySelector(
        `[data-category-index="${index}"] input`,
      );
      checkbox.checked = visible;
      if (visible) {
        item.layer.addTo(map);
      } else {
        map.removeLayer(item.layer);
      }
    });
  }

  function closeSidebar() {
    panel.classList.remove("is-open");
    document.body.classList.add("sidebar-hidden");
    backdrop.hidden = true;
    menuButton.setAttribute("aria-expanded", "false");
    menuButton.setAttribute("aria-label", "Show map search and filters");
  }

  function openSidebar() {
    document.body.classList.remove("sidebar-hidden");
    panel.classList.add("is-open");
    backdrop.hidden = false;
    menuButton.setAttribute("aria-expanded", "true");
    menuButton.setAttribute("aria-label", "Hide map search and filters");
    searchInput.focus();
  }

  function createLegend() {
    const legend = L.control({ position: "bottomright" });
    legend.onAdd = () => {
      const container = L.DomUtil.create("div", "map-legend");
      container.setAttribute("aria-label", "Map legend");
      const header = document.createElement("div");
      header.className = "map-legend-header";
      const title = document.createElement("div");
      title.className = "map-legend-title";
      title.textContent = "Map legend";
      const toggle = document.createElement("button");
      toggle.className = "panel-toggle legend-toggle";
      toggle.type = "button";
      toggle.textContent = "Hide";
      toggle.setAttribute("aria-label", "Hide map legend");
      toggle.setAttribute("aria-expanded", "true");
      const items = document.createElement("div");
      items.className = "map-legend-items";
      items.innerHTML = `
        <div class="map-legend-item">
          <span class="legend-symbol legend-boundary" aria-hidden="true"></span>
          <span>Archaeological boundaries</span>
        </div>
        <div class="map-legend-item">
          <span class="legend-symbol legend-polygon legend-sites" aria-hidden="true"></span>
          <span>Archaeological sites</span>
        </div>
        <div class="map-legend-item">
          <span class="legend-symbol legend-polygon legend-historic" aria-hidden="true"></span>
          <span>Historic places</span>
        </div>
        <div class="map-legend-item">
          <span class="legend-symbol legend-point legend-monument" aria-hidden="true"></span>
          <span>Monuments</span>
        </div>
        <div class="map-legend-item">
          <span class="legend-symbol legend-point legend-museum" aria-hidden="true"></span>
          <span>Museums</span>
        </div>
        <div class="map-legend-item">
          <span class="legend-symbol legend-polygon legend-protection" aria-hidden="true"></span>
          <span>Protection zones</span>
        </div>`;
      header.append(title, toggle);
      container.append(header, items);
      toggle.addEventListener("click", () => {
        const collapsed = container.classList.toggle("is-collapsed");
        toggle.textContent = collapsed ? "Show legend" : "Hide";
        toggle.setAttribute("aria-expanded", String(!collapsed));
        toggle.setAttribute(
          "aria-label",
          `${collapsed ? "Show" : "Hide"} map legend`,
        );
      });
      L.DomEvent.disableClickPropagation(container);
      return container;
    };
    legend.addTo(map);
  }

  createLayerControls();
  createLegend();
  document.querySelector("#show-all").addEventListener("click", () => setAllLayers(true));
  document.querySelector("#hide-all").addEventListener("click", () => setAllLayers(false));
  searchInput.addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    const query = searchInput.value.trim().toLocaleLowerCase();
    searchTimer = window.setTimeout(() => renderSearchResults(query), 180);
  });
  menuButton.addEventListener("click", openSidebar);
  closeButton.addEventListener("click", closeSidebar);
  backdrop.addEventListener("click", closeSidebar);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeSidebar();
    }
  });

  map.invalidateSize();
  trendingReady = initializeTrending();
  loadExternalLayers();
})();
