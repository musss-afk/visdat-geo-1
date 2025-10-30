document.addEventListener("DOMContentLoaded", function() {
    // --- 1. SETUP ---
    let timer;
    let isPlaying = false;
    let selectedMetric = 'New Cases';
    let allData, nestedData, dateRange, filteredDateRange, geoData;
    let dataByProvinceByDate = new Map();

    // --- BARU: Kamus Penerjemah Nama Provinsi ---
    // Ini menjembatani perbedaan antara file JSON dan CSV Anda
    const geoJsonToCsvNameMap = {
        "Jakarta Raya": "DKI Jakarta",
        "Yogyakarta": "Daerah Istimewa Yogyakarta",
        "North Kalimantan": "Kalimantan Utara",
        "Bangka-Belitung": "Kepulauan Bangka Belitung"
    };

    // Fungsi helper untuk mendapatkan nama CSV yang benar
    function getCsvName(geoJsonName) {
        // Jika nama ada di kamus, kembalikan nama dari CSV.
        // Jika tidak, berarti namanya sudah sama, jadi kembalikan nama aslinya.
        return geoJsonToCsvNameMap[geoJsonName] || geoJsonName;
    }
    // ---------------------------------------------

    // Formatters
    const parseDate = d3.timeParse("%m/%d/%Y");
    const formatDate = d3.timeFormat("%b %d, %Y");
    const formatNumber = d3.format(",.0f");

    // Dimensions
    const mapWidth = 960;
    const mapHeight = 500;
    const contextMargin = { top: 10, right: 30, bottom: 30, left: 30 };
    const contextWidth = 960 - contextMargin.left - contextMargin.right;
    const contextHeight = 100 - contextMargin.top - contextMargin.bottom;

    // Map SVG
    const svg = d3.select("#map-chart")
        .attr("viewBox", `0 0 ${mapWidth} ${mapHeight}`);
    const mapGroup = svg.append("g"); 

    // Context (Timeline) SVG
    const contextSvg = d3.select("#context-chart")
        .attr("width", contextWidth + contextMargin.left + contextMargin.right)
        .attr("height", contextHeight + contextMargin.top + contextMargin.bottom)
        .append("g")
        .attr("transform", `translate(${contextMargin.left},${contextMargin.top})`);

    // Tooltip
    const tooltip = d3.select("#tooltip");

    // Scales
    const colorScale = d3.scaleSequential(d3.interpolateReds).domain([0, 1000]); 
    const contextXScale = d3.scaleTime().range([0, contextWidth]);
    const contextYScale = d3.scaleLinear().range([contextHeight, 0]);

    // UI Elements
    const dateSlider = d3.select("#date-slider");
    const dateDisplay = d3.select("#date-display");
    const playPauseButton = d3.select("#play-pause-button");
    const metricSelect = d3.select("#metric-select");

    // Proyeksi Peta
    const projection = d3.geoMercator()
        .center([118, -2]) 
        .scale(1000) 
        .translate([mapWidth / 2, mapHeight / 2]);
    const path = d3.geoPath().projection(projection);

    // --- 2. DATA LOADING & PROCESSING ---
    Promise.all([
        d3.csv("covid_indonesia_province_cleaned.csv", d => {
            d.Date = parseDate(d.Date);
            d['New Cases'] = +d['New Cases'];
            d['New Deaths'] = +d['New Deaths'];
            d['Total Cases'] = +d['Total Cases'];
            d['Total Deaths'] = +d['Total Deaths'];
            d.Province = d.Province.trim();
            return d;
        }),
        d3.json("indonesia-provinces.json") // Memuat file JSON Anda
    ]).then(([covidData, indonesiaGeo]) => {
        allData = covidData;
        // DIUBAH: Gunakan format GeoJSON langsung (bukan TopoJSON)
        geoData = indonesiaGeo; 
        
        // Memproses data COVID untuk pencarian cepat
        nestedData = d3.group(allData, d => d.Date);
        dateRange = Array.from(nestedData.keys()).sort(d3.ascending);
        filteredDateRange = dateRange;
        
        // Membuat lookup map: Map[Date -> Map[Province(CSV) -> Data]]
        dataByProvinceByDate = new Map();
        for (let [date, values] of nestedData.entries()) {
            const provinceMap = new Map();
            for (let row of values) {
                // Kunci di sini adalah nama dari CSV (misal 'DKI Jakarta')
                provinceMap.set(row.Province, row);
            }
            dataByProvinceByDate.set(date, provinceMap);
        }
        
        dateSlider.attr("max", dateRange.length - 1);
        
        setupContextChart(); 
        drawMap(); 
        update(0); 

        // --- 3. EVENT LISTENERS ---
        playPauseButton.on("click", togglePlay);
        dateSlider.on("input", () => update(+dateSlider.property("value")));
        metricSelect.on("change", () => {
            selectedMetric = metricSelect.property("value");
            updateContextChart(); 
            updateColorScale(); 
            update(+dateSlider.property("value"));
        });

    }).catch(error => {
        console.error("Error loading data:", error);
    });

    // --- 4. MAP DRAWING & ZOOM ---
    function drawMap() {
        mapGroup.selectAll("path.province")
            .data(geoData.features)
            .enter()
            .append("path")
            .attr("class", "province")
            .attr("d", path)
            .attr("fill", "#ccc") 
            .on("mouseover", (event, d) => {
                tooltip.style("opacity", 1);
            })
            .on("mousemove", (event, d) => {
                // DIUBAH: Gunakan kunci 'name' dan terjemahkan
                const geoJsonName = d.properties.name; 
                const csvName = getCsvName(geoJsonName); // Terjemahkan ke nama CSV
                
                const currentDate = filteredDateRange[+dateSlider.property("value")];
                // Cari data menggunakan nama CSV
                const provinceData = dataByProvinceByDate.get(currentDate)?.get(csvName); 
                
                let value = "N/A";
                if (provinceData) {
                    value = formatNumber(provinceData[selectedMetric]);
                }

                // Tampilkan nama dari JSON (lebih rapi, misal 'Yogyakarta')
                tooltip.html(`<strong>${geoJsonName}</strong><br>${selectedMetric}: ${value}`)
                       .style("left", (event.pageX + 15) + "px")
                       .style("top", (event.pageY - 28) + "px");
            })
            .on("mouseout", () => {
                tooltip.style("opacity", 0);
            });
            
        const zoom = d3.zoom()
            .scaleExtent([1, 8]) 
            .on("zoom", (event) => {
                mapGroup.attr("transform", event.transform);
            });
        svg.call(zoom);
    }
    
    // --- 5. CONTEXT CHART (TIMELINE & BRUSH) ---
    // (Fungsi ini tidak berubah)
    function setupContextChart() {
        const nationalTotals = Array.from(nestedData, ([date, values]) => {
            return { date: date, value: d3.sum(values, v => v[selectedMetric]) };
        });
        
        contextXScale.domain(d3.extent(dateRange));
        contextYScale.domain([0, d3.max(nationalTotals, d => d.value)]);

        const contextArea = d3.area()
            .x(d => contextXScale(d.date))
            .y0(contextHeight)
            .y1(d => contextYScale(d.value));
        
        contextSvg.append("path").datum(nationalTotals).attr("class", "context-area").attr("d", contextArea);
        contextSvg.append("g").attr("class", "context-axis").attr("transform", `translate(0,${contextHeight})`).call(d3.axisBottom(contextXScale).ticks(d3.timeYear.every(1)));

        const annotations = [{ date: "2021-07-15", label: "Puncak Delta" }, { date: "2022-02-15", label: "Puncak Omicron" }];
        annotations.forEach(ann => {
            const xPos = contextXScale(parseDate(ann.date.replace(/-/g, '/')));
            const g = contextSvg.append("g");
            g.append("line").attr("class", "annotation-line").attr("x1", xPos).attr("x2", xPos).attr("y1", 0).attr("y2", contextHeight);
            g.append("text").attr("class", "annotation-text").attr("x", xPos).attr("y", 10).text(ann.label);
        });

        const brush = d3.brushX().extent([[0, 0], [contextWidth, contextHeight]]).on("end", brushed);
        contextSvg.append("g").attr("class", "brush").call(brush);

        function brushed({ selection }) {
            if (selection) {
                const [x0, x1] = selection.map(contextXScale.invert);
                filteredDateRange = dateRange.filter(d => d >= x0 && d <= x1);
            } else {
                filteredDateRange = dateRange;
            }
            dateSlider.attr("max", filteredDateRange.length - 1);
            dateSlider.property("value", 0);
            updateColorScale(); 
            update(0);
        }
    }
    
    function updateContextChart() {
        const nationalTotals = Array.from(nestedData, ([date, values]) => {
            return { date: date, value: d3.sum(values, v => v[selectedMetric]) };
        });
        contextYScale.domain([0, d3.max(nationalTotals, d => d.value)]);
        const contextArea = d3.area().x(d => contextXScale(d.date)).y0(contextHeight).y1(d => contextYScale(d.value));
        contextSvg.select(".context-area").datum(nationalTotals).transition().duration(500).attr("d", contextArea);
    }
    
    function updateColorScale() {
        let maxVal = 0;
        for (const date of filteredDateRange) {
            const dailyMax = d3.max(nestedData.get(date) || [], d => d[selectedMetric]);
            if (dailyMax > maxVal) maxVal = dailyMax;
        }
        colorScale.domain([0, maxVal > 0 ? maxVal : 1]);
    }

    // --- 6. UPDATE FUNCTION (Main Logic) ---
    function update(dateIndex) {
        if (!filteredDateRange || filteredDateRange.length === 0) return;
        
        const currentDate = filteredDateRange[dateIndex];
        dateDisplay.text(formatDate(currentDate));
        dateSlider.property("value", dateIndex);

        const currentDataByProvince = dataByProvinceByDate.get(currentDate);
        
        if (!currentDataByProvince) return; 

        // Update Peta
        mapGroup.selectAll("path.province")
            .transition()
            .duration(isPlaying ? 150 : 0) 
            .attr("fill", d => {
                // DIUBAH: Gunakan kunci 'name' dan terjemahkan
                const geoJsonName = d.properties.name;
                const csvName = getCsvName(geoJsonName); // Terjemahkan
                
                // Cari data menggunakan nama CSV
                const provinceData = currentDataByProvince.get(csvName); 
                
                if (provinceData && provinceData[selectedMetric] > 0) {
                    return colorScale(provinceData[selectedMetric]);
                } else {
                    return "#ccc"; // Warna default
                }
            });
    }

    // --- 7. ANIMATION CONTROLS ---
    // (Fungsi ini tidak berubah)
    function togglePlay() {
        if (isPlaying) {
            clearInterval(timer);
            playPauseButton.text("Play");
        } else {
            playPauseButton.text("Pause");
            timer = setInterval(() => {
                let currentValue = +dateSlider.property("value");
                let maxValue = +dateSlider.attr("max");
                if (currentValue < maxValue) {
                    currentValue++;
                    update(currentValue);
                } else {
                    clearInterval(timer);
                    isPlaying = false;
                    playPauseButton.text("Play");
                }
            }, 150); 
        }
        isPlaying = !isPlaying;
    }
});