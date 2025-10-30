document.addEventListener("DOMContentLoaded", function() {
    // --- 1. SETUP ---
    let timer;
    let isPlaying = false;
    let selectedMetric = 'New Cases';
    let allData, nestedData, dateRange, filteredDateRange, geoData;
    let dataByProvinceByDate = new Map();

    // --- Kamus Penerjemah Nama Provinsi ---
    const geoJsonToCsvNameMap = {
        "Jakarta Raya": "DKI Jakarta",
        "Yogyakarta": "Daerah Istimewa Yogyakarta",
        "North Kalimantan": "Kalimantan Utara",
        "Bangka-Belitung": "Kepulauan Bangka Belitung"
    };

    function getCsvName(geoJsonName) {
        return geoJsonToCsvNameMap[geoJsonName] || geoJsonName;
    }
    
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
    // --- PERUBAHAN WARNA PETA ---
    // Menggunakan skala sekuensial yang dibalik: (1-t)
    // d3.interpolateRdYlGn(1) = Hijau (untuk 0)
    // d3.interpolateRdYlGn(0) = Merah (untuk max)
    const colorScale = d3.scaleSequential((t) => d3.interpolateRdYlGn(1 - t)).domain([0, 1000]); 
    // ----------------------------

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
        d3.json("indonesia-provinces.json") 
    ]).then(([covidData, indonesiaGeo]) => {
        allData = covidData;
        geoData = indonesiaGeo; 
        
        nestedData = d3.group(allData, d => d.Date);
        dateRange = Array.from(nestedData.keys()).sort(d3.ascending);
        filteredDateRange = dateRange;
        
        dataByProvinceByDate = new Map();
        for (let [date, values] of nestedData.entries()) {
            const provinceMap = new Map();
            for (let row of values) {
                provinceMap.set(row.Province, row);
            }
            dataByProvinceByDate.set(date, provinceMap);
        }
        
        dateSlider.attr("max", dateRange.length - 1);
        
        // Panggil DUA FUNGSI INI SETELAH allData dimuat
        updateColorScale(); // Set skala warna berdasarkan data penuh
        setupContextChart(); // Setup timeline (sekarang perlu allData)
        
        drawMap(); 
        update(0); 

        // --- 3. EVENT LISTENERS ---
        playPauseButton.on("click", togglePlay);
        dateSlider.on("input", () => update(+dateSlider.property("value")));
        metricSelect.on("change", () => {
            selectedMetric = metricSelect.property("value");
            updateContextChart(); // Update timeline bars
            updateColorScale(); // Update domain skala warna
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
            // --- PERUBAHAN WARNA DEFAULT ---
            .attr("fill", "#444") // Warna default 'no data' untuk dark mode
            // -----------------------------
            .on("mouseover", (event, d) => {
                tooltip.style("opacity", 1);
            })
            .on("mousemove", (event, d) => {
                const geoJsonName = d.properties.name; 
                const csvName = getCsvName(geoJsonName); 
                
                const currentDate = filteredDateRange[+dateSlider.property("value")];
                const provinceData = dataByProvinceByDate.get(currentDate)?.get(csvName); 
                
                let value = "N/A";
                if (provinceData) {
                    value = formatNumber(provinceData[selectedMetric]);
                }

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
    // --- DIROMBAK TOTAL UNTUK GRAFIK BATANG ---
    function setupContextChart() {
        // Agregasi data per minggu
        const weeklyTotals = d3.rollups(
            allData,
            v => d3.sum(v, d => d[selectedMetric]),
            d => d3.timeWeek.floor(d.Date) // Kelompokkan per minggu
        )
        .map(([date, value]) => ({ date, value }))
        .sort((a, b) => a.date - b.date);

        // Set domain X dan Y berdasarkan data mingguan
        contextXScale.domain(d3.extent(weeklyTotals, d => d.date));
        contextYScale.domain([0, d3.max(weeklyTotals, d => d.value)]);

        // Hitung lebar bar
        const weeks = d3.timeWeek.range(contextXScale.domain()[0], contextXScale.domain()[1]);
        const barWidth = (contextWidth / weeks.length);

        // Gambar Sumbu X
        contextSvg.append("g")
            .attr("class", "context-axis")
            .attr("transform", `translate(0,${contextHeight})`)
            .call(d3.axisBottom(contextXScale).ticks(d3.timeYear.every(1)));
        
        // Buat grup untuk bar
        contextSvg.append("g")
            .attr("class", "context-bars")
            .selectAll("rect")
            .data(weeklyTotals)
            .join("rect") // .join() modern untuk enter
            .attr("x", d => contextXScale(d.date))
            .attr("y", d => contextYScale(d.value))
            .attr("width", barWidth > 1 ? barWidth - 1 : barWidth) // Padding 1px jika muat
            .attr("height", d => contextHeight - contextYScale(d.value));

        // Anotasi (Tetap sama)
        const annotations = [{ date: "2021-07-15", label: "Puncak Delta" }, { date: "2022-02-15", label: "Puncak Omicron" }];
        annotations.forEach(ann => {
            const xPos = contextXScale(parseDate(ann.date.replace(/-/g, '/')));
            const g = contextSvg.append("g");
            g.append("line").attr("class", "annotation-line").attr("x1", xPos).attr("x2", xPos).attr("y1", 0).attr("y2", contextHeight);
            g.append("text").attr("class", "annotation-text").attr("x", xPos).attr("y", 10).text(ann.label);
        });

        // Brush (Tetap sama)
        const brush = d3.brushX().extent([[0, 0], [contextWidth, contextHeight]]).on("end", brushed);
        contextSvg.append("g")
            .attr("class", "brush")
            .call(brush);

        function brushed({ selection }) {
            if (selection) {
                const [x0, x1] = selection.map(contextXScale.invert);
                filteredDateRange = dateRange.filter(d => d >= x0 && d <= x1);
            } else {
                filteredDateRange = dateRange;
            }
            dateSlider.attr("max", filteredDateRange.length - 1);
            dateSlider.property("value", 0);
            updateColorScale(); // Perbarui skala warna berdasarkan rentang waktu baru
            update(0);
        }
    }
    
    // --- DIROMBAK TOTAL UNTUK UPDATE GRAFIK BATANG ---
    function updateContextChart() {
        // Agregasi data mingguan berdasarkan metrik yang DIPILIH
        const weeklyTotals = d3.rollups(
            allData,
            v => d3.sum(v, d => v[selectedMetric]), // Gunakan selectedMetric
            d => d3.timeWeek.floor(d.Date)
        )
        .map(([date, value]) => ({ date, value }))
        .sort((a, b) => a.date - b.date);
        
        // Update Y scale domain
        contextYScale.domain([0, d3.max(weeklyTotals, d => d.value)]);

        // Hitung lebar bar lagi
        const weeks = d3.timeWeek.range(contextXScale.domain()[0], contextXScale.domain()[1]);
        const barWidth = (contextWidth / weeks.length);
        
        // Data join untuk update bar
        const bars = contextSvg.select(".context-bars")
            .selectAll("rect")
            .data(weeklyTotals);
            
        bars.join( // Gunakan join untuk enter/update/exit
            enter => enter.append("rect") // Harusnya tidak terjadi, tapi untuk jaga-jaga
                .attr("x", d => contextXScale(d.date))
                .attr("width", barWidth > 1 ? barWidth - 1 : barWidth)
                .attr("y", contextHeight)
                .attr("height", 0)
                .call(enter => enter.transition().duration(500)
                    .attr("y", d => contextYScale(d.value))
                    .attr("height", d => contextHeight - contextYScale(d.value))),
            update => update // Transisi update
                .call(update => update.transition().duration(500)
                    .attr("y", d => contextYScale(d.value))
                    .attr("height", d => contextHeight - contextYScale(d.value))),
            exit => exit.call(exit => exit.transition().duration(500) // Harusnya tidak terjadi
                .attr("y", contextHeight)
                .attr("height", 0)
                .remove())
        );
    }
    
    function updateColorScale() {
        // Perbarui domain skala warna berdasarkan data yang difilter
        let maxVal = 0;
        let dataToScan = (filteredDateRange.length > 0) ? filteredDateRange : dateRange;

        for (const date of dataToScan) {
            const dailyData = nestedData.get(date);
            if (dailyData) {
                const dailyMax = d3.max(dailyData, d => d[selectedMetric]);
                if (dailyMax > maxVal) maxVal = dailyMax;
            }
        }
        // Set domain: 0 akan jadi Hijau, maxVal akan jadi Merah
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
                const geoJsonName = d.properties.name;
                const csvName = getCsvName(geoJsonName);
                const provinceData = currentDataByProvince.get(csvName); 
                
                if (provinceData) {
                    // Gunakan skala warna. 
                    // Jika 0, colorScale(0) akan mengembalikan Hijau.
                    return colorScale(provinceData[selectedMetric]);
                } else {
                    // --- PERUBAHAN WARNA DEFAULT ---
                    return "#444"; // Warna 'no data'
                    // -----------------------------
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
