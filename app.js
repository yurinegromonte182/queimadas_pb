
'use strict';

// =====================================================
// DASHBOARD DE QUEIMADAS - PARAÍBA 2026
// =====================================================

const TZ = 'America/Fortaleza';
const START = Date.UTC(2026, 0, 1, 3);
const END = Date.UTC(2027, 0, 1, 3);
const DAY = 86400000;

const files = [
    'queimadas_pb_2026.geojson',
    'municipios_pb.geojson',
    'limite_pb.geojson'
];

const fmt = new Intl.DateTimeFormat('pt-BR', {
    timeZone: TZ,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
});

const short = new Intl.DateTimeFormat('pt-BR', {
    timeZone: TZ,
    day: '2-digit',
    month: '2-digit'
});

const month = new Intl.DateTimeFormat('pt-BR', {
    timeZone: TZ,
    month: 'long',
    year: 'numeric'
});

const nf = new Intl.NumberFormat('pt-BR', {
    maximumFractionDigits: 2
});

// =====================================================
// FUNÇÕES AUXILIARES
// =====================================================

const clean = v =>
    v == null ||
    String(v).trim() === '' ||
    ['-999', 'NULL', 'NONE', 'NAN'].includes(
        String(v).trim().toUpperCase()
    ) ||
    Number(v) === -999 ? null : v;

const number = v =>
    clean(v) === null || !Number.isFinite(Number(v))
        ? null : Number(v);

const key = v => String(clean(v) ?? '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ');

const name = v => String(clean(v) ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ');

const esc = v => String(v ?? 'Sem dado').replace(
    /[&<>"']/g,
    c => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[c])
);

const count = (a, fn) => {
    const m = new Map();

    for (const f of a) {
        const k = fn(f);
        m.set(k, (m.get(k) || 0) + 1);
    }

    return m;
};

const rank = m => [...m].sort(
    (a, b) => b[1] - a[1] ||
    String(a[0]).localeCompare(String(b[0]), 'pt-BR')
);

const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

// =====================================================
// CORES E CLASSIFICAÇÕES
// =====================================================

const clusterColors = [
    '#e5a43a',
    '#e07827',
    '#d34b25',
    '#9b262c'
];

const frpColors = [
    '#f4c64d',
    '#f59b35',
    '#e45e28',
    '#b62c33'
];

const muniColors = [
    '#f3f2e8',
    '#fed98e',
    '#fe9929',
    '#d95f0e',
    '#852514'
];

const clusterClass = n =>
    n < 10 ? 0 :
    n < 50 ? 1 :
    n < 100 ? 2 : 3;

const frpClass = n =>
    n < 10 ? 0 :
    n < 30 ? 1 :
    n < 100 ? 2 : 3;

const muniClass = n =>
    n === 0 ? 0 :
    n <= 20 ? 1 :
    n <= 50 ? 2 :
    n <= 100 ? 3 : 4;

let map;
let td;
let ts;
let base;
let stateLayer;
let muniLines;
let visual;
let highlight;

let charts = {};
let timer = null;
let raw = [];
let municipalData;
let stateData;
let home;
let syncing = false;
let generation = 0;

// =====================================================
// CONTROLE TEMPORAL
// =====================================================

function makeTimes(step) {

    const a = [];

    for (let t = START; t < END;) {

        a.push(t);

        if (step === 'mes') {

            const d = new Date(t);

            t = Date.UTC(
                d.getUTCFullYear(),
                d.getUTCMonth() + 1,
                1,
                3
            );

        } else {

            t += DAY * (step === 'semana' ? 7 : 1);

        }
    }

    return a;
}

function slot(times, t) {

    let lo = 0;
    let hi = times.length - 1;

    while (lo < hi) {

        const mid = Math.ceil((lo + hi) / 2);

        if (times[mid] <= t) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }

    return lo;
}

// =====================================================
// POPUP DOS FOCOS
// =====================================================

function popup(f) {

    return `
        <div style="min-width:205px">

            <div class="muted">
                Foco de queimadas
            </div>

            <strong>
                ${esc(f.municipio || 'Município não informado')}
            </strong>

            <div class="popup-frp">
                ${f.frp === null
                    ? 'Sem dado'
                    : nf.format(f.frp) + ' MW'}
            </div>

            <div class="muted">
                Potência radiativa do fogo (FRP)
            </div>

            <div class="popup-grid">

                <div>
                    <b>Data e hora</b><br>
                    ${esc(fmt.format(f.t))}
                </div>

                <div>
                    <b>Bioma</b><br>
                    ${esc(f.bioma || null)}
                </div>

                <div>
                    <b>Risco de fogo</b><br>
                    ${esc(f.risco === null
                        ? null
                        : nf.format(f.risco))}
                </div>

                <div>
                    <b>Dias sem chuva</b><br>
                    ${esc(f.dias === null
                        ? null
                        : nf.format(f.dias))}
                </div>

                <div>
                    <b>Precipitação</b><br>
                    ${esc(f.prec === null
                        ? null
                        : nf.format(f.prec) + ' mm')}
                </div>

                <div>
                    <b>Satélite</b><br>
                    ${esc(f.sat)}
                </div>

            </div>

        </div>
    `;
}

// =====================================================
// CENTRALIZAÇÃO NA PARAÍBA
// =====================================================

const PB_BOUNDS = [
    [-8.32, -38.85],
    [-5.98, -34.75]
];

function fitPB() {

    const fallback = L.latLngBounds(PB_BOUNDS);

    const b =
        home?.isValid() &&
        fallback.contains(home) &&
        home.getEast() - home.getWest() > 2 &&
        home.getNorth() - home.getSouth() > 1
            ? home
            : fallback;

    map.invalidateSize({
        pan: true,
        animate: false
    });

    map.fitBounds(b, {
        padding: [24, 24],
        animate: false
    });
}

// =====================================================
// ZOOM AUTOMÁTICO NO MUNICÍPIO SELECIONADO
// =====================================================

function fitMunicipio(v, animate = true) {

    // Sem município selecionado: volta para a Paraíba.
    if (!v) {
        fitPB();
        return;
    }

    const b = L.latLngBounds([]);

    // Obtém os limites do território municipal.
    if (muniLines) {

        muniLines.eachLayer(l => {

            if (
                muniKey(l.feature) === v &&
                l.getBounds
            ) {
                b.extend(l.getBounds());
            }

        });
    }

    // Caso não encontre o polígono, usa os focos.
    if (!b.isValid()) {

        for (const f of raw) {

            if (f.mkey === v) {
                b.extend([f.lat, f.lng]);
            }
        }
    }

    map.invalidateSize({
        pan: false,
        animate: false
    });

    if (b.isValid()) {

        map.fitBounds(b, {
            padding: [30, 30],
            maxZoom: 14,
            animate: animate
        });
    }
}

// =====================================================
// INICIALIZAÇÃO DO MAPA LEAFLET
// =====================================================

function initMap(vm) {

    map = L.map('map', {
        zoomControl: false,
        preferCanvas: true,
        zoomSnap: 0.5,
        zoomDelta: 0.5
    }).setView([-7.15, -36.8], 7);

    fitPB();

    requestAnimationFrame(() => fitPB());

    map.createPane('municipalPane').style.zIndex = 410;
    map.createPane('statePane').style.zIndex = 450;

    map.getPane('statePane').style.pointerEvents = 'none';

    map.createPane('highlightPane').style.zIndex = 650;

    // Controle personalizado de zoom e botão Home.
    const Zoom = L.Control.extend({

        options: {
            position: 'topleft'
        },

        onAdd() {

            const div = L.DomUtil.create(
                'div',
                'leaflet-bar'
            );

            const botoes = [
                ['+', 'Aproximar', () => map.zoomIn()],
                ['⌂', 'Voltar ao estado inteiro', () => vm.goHome()],
                ['−', 'Afastar', () => map.zoomOut()]
            ];

            for (const [symbol, title, action] of botoes) {

                const a = L.DomUtil.create(
                    'a',
                    symbol === '⌂' ? 'home-btn' : '',
                    div
                );

                a.href = '#';
                a.textContent = symbol;
                a.title = title;

                a.setAttribute('aria-label', title);
                a.setAttribute('role', 'button');

                L.DomEvent.on(a, 'click', e => {
                    L.DomEvent.stop(e);
                    action();
                });

                L.DomEvent.on(a, 'keydown', e => {

                    if (e.key === ' ') {
                        L.DomEvent.stop(e);
                        action();
                    }

                });
            }

            L.DomEvent.disableClickPropagation(div);

            return div;
        }

    });

    map.addControl(new Zoom());

    // Mapa base OpenStreetMap.
    base = L.tileLayer(
        'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        {
            maxZoom: 19,
            attribution:
                '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        }
    ).addTo(map);

    let errors = 0;
    let success = 0;

    base.on('loading', () => {
        errors = 0;
        success = 0;
    });

    base.on('tileerror', () => {
        errors++;
        vm.baseError = true;
    });

    base.on('tileload', () => success++);

    base.on('load', () => {
        vm.baseError = errors > 0 || success === 0;
    });

    // Leaflet TimeDimension.
    td = new L.TimeDimension({
        times: makeTimes('mes'),
        currentTime: Date.UTC(2026, 9, 1, 3)
    });

    map.timeDimension = td;

    td.on('timeload', e => {

        if (syncing) return;

        vm.index = slot(vm.times, e.time);

        vm.refresh();
    });

    map.on('zoomend', () => {

        updateLines();

        if (vm.view === 'municipios' && visual?.setStyle) {

            visual.setStyle({
                weight: map.getZoom() >= 9 ? 0.8 : 0
            });
        }
    });

    // Corrige dimensões do mapa no modo normal
    // e durante a alternância para tela cheia.

    let resizeFrame = 0;

    const ajustarMapa = () => {

        cancelAnimationFrame(resizeFrame);

        resizeFrame = requestAnimationFrame(() => {

            const el = map.getContainer();

            if (el.clientWidth && el.clientHeight) {

                if (vm.municipio) {

                    fitMunicipio(vm.municipio, false);

                } else {

                    fitPB();

                }
            }

        });
    };

    if (typeof ResizeObserver !== 'undefined') {

        const observer = new ResizeObserver(ajustarMapa);

        observer.observe(map.getContainer());

    } else {

        window.addEventListener('resize', ajustarMapa);

    }

    document.addEventListener(
        'fullscreenchange',
        ajustarMapa
    );

    vm.$nextTick(ajustarMapa);

    window.addEventListener(
        'load',
        ajustarMapa,
        { once: true }
    );
}

// =====================================================
// LIMITES MUNICIPAIS E ESTADUAL
// =====================================================

function updateLines() {

    if (!muniLines) return;

    const show = map.getZoom() >= 9;

    if (show && !map.hasLayer(muniLines)) {

        muniLines.addTo(map);

    } else if (!show && map.hasLayer(muniLines)) {

        map.removeLayer(muniLines);

    }
}

function resetBoundaries(vm) {

    for (const l of [stateLayer, muniLines]) {

        if (l && map.hasLayer(l)) {
            map.removeLayer(l);
        }
    }

    stateLayer = L.geoJSON(stateData, {

        pane: 'statePane',
        interactive: false,

        style: {
            color: '#263b35',
            weight: 2.4,
            fill: false,
            opacity: 1
        }

    }).addTo(map);

    muniLines = L.geoJSON(municipalData, {

        pane: 'municipalPane',
        interactive: false,

        style: {
            color: '#687b71',
            weight: 1,
            fill: false,
            opacity: 0.75
        }

    });

    home = stateLayer.getBounds();

    vm.goHome();

    requestAnimationFrame(() => vm.goHome());

    updateLines();
}

const muniName = f => name(
    f.properties?.municipio || f.properties?.nome
);

const muniKey = f => key(muniName(f));

// =====================================================
// RENDERIZAÇÃO DAS VISUALIZAÇÕES
// =====================================================

function renderMap(vm, selected) {

    if (visual) {
        map.removeLayer(visual);
    }

    if (highlight) {

        map.removeLayer(highlight);

        highlight = null;
    }

    map.closePopup();

    // -------------------------------------------------
    // AGRUPAMENTO DE FOCOS
    // -------------------------------------------------

    if (vm.view === 'agrupados') {

        visual = L.markerClusterGroup({

            showCoverageOnHover: false,
            maxClusterRadius: 50,

            iconCreateFunction(c) {

                const n = c.getChildCount();
                const i = clusterClass(n);
                const s = 34 + i * 7;

                return L.divIcon({

                    html: `
                        <div class="cluster-dot"
                            style="
                                background:${clusterColors[i]};
                                width:${s}px;
                                height:${s}px
                            ">
                            ${n}
                        </div>
                    `,

                    className: '',
                    iconSize: [s, s]

                });
            }

        });

        for (const f of selected) {

            const m = L.marker(
                [f.lat, f.lng],
                {
                    title: f.municipio || 'Foco',

                    icon: L.divIcon({

                        className: '',

                        html: `
                            <div style="
                                width:13px;
                                height:13px;
                                border-radius:50%;
                                background:#d34b25;
                                border:2px solid white;
                                box-shadow:0 1px 4px #0008
                            "></div>
                        `,

                        iconSize: [13, 13]
                    })
                }
            );

            m.bindPopup(popup(f));

            visual.addLayer(m);
        }

    // -------------------------------------------------
    // MAPA DE CALOR
    // -------------------------------------------------

    } else if (vm.view === 'densidade') {

        visual = L.heatLayer(

            selected.map(f => [f.lat, f.lng, 1]),

            {
                radius: 25,
                blur: 19,
                maxZoom: 12,

                gradient: {
                    0.2: '#3b82f6',
                    0.45: '#36b37e',
                    0.65: '#f4d03f',
                    0.85: '#ed7929',
                    1: '#b91c1c'
                }
            }
        );

    // -------------------------------------------------
    // INTENSIDADE POR FRP
    // -------------------------------------------------

    } else if (vm.view === 'intensidade') {

        visual = L.layerGroup(

            selected.map(f =>

                L.circleMarker(
                    [f.lat, f.lng],
                    {
                        radius: f.frp === null
                            ? 4
                            : Math.min(
                                18,
                                4 + Math.sqrt(Math.max(0, f.frp))
                            ),

                        color: '#633b27',
                        weight: 1,

                        fillColor: f.frp === null
                            ? '#929a96'
                            : frpColors[frpClass(f.frp)],

                        fillOpacity: 0.8
                    }

                ).bindPopup(popup(f))
            )
        );

    // -------------------------------------------------
    // MAPA COROPLÉTICO MUNICIPAL
    // -------------------------------------------------

    } else {

        const totals = count(selected, f => f.mkey);

        visual = L.geoJSON(municipalData, {

            pane: 'municipalPane',

            style: f => ({

                weight: map.getZoom() >= 9 ? 0.8 : 0,

                color: '#687b71',

                fillColor: muniColors[
                    muniClass(totals.get(muniKey(f)) || 0)
                ],

                fillOpacity: 0.8

            }),

            onEachFeature(f, l) {

                const n = totals.get(muniKey(f)) || 0;

                l.bindPopup(`
                    <b>${esc(muniName(f))}</b><br>
                    ${nf.format(n)} focos no período
                `);

                // Duplo clique seleciona e aproxima.
                l.on('dblclick', () => {
                    vm.setMunicipio(muniKey(f));
                });
            }
        });
    }

    visual.addTo(map);

    if (stateLayer) {
        stateLayer.bringToFront();
    }

    updateLines();
}

// =====================================================
// CONFIGURAÇÃO DOS GRÁFICOS
// =====================================================

function chart(id, opts) {

    if (charts[id]) {
        charts[id].destroy();
    }

    charts[id] = Highcharts.chart(

        id,

        Highcharts.merge({

            chart: {
                backgroundColor: 'transparent',

                style: {
                    fontFamily: 'system-ui,sans-serif'
                }
            },

            title: {
                text: null
            },

            credits: {
                enabled: false
            },

            legend: {
                enabled: false
            },

            lang: {
                noData: 'Sem dados'
            },

            accessibility: {
                enabled: true
            },

            yAxis: {
                title: {
                    text: 'Focos'
                },
                allowDecimals: false,
                min: 0
            },

            tooltip: {
                valueSuffix: ' focos'
            },

            plotOptions: {
                series: {
                    animation: false
                }
            },

            colors: ['#28755a']

        }, opts)
    );
}

function renderCharts(vm, filtered, selected) {

    // -------------------------------------------------
    // GRÁFICO TEMPORAL
    // -------------------------------------------------

    const tcounts = Array(vm.times.length).fill(0);

    for (const f of filtered) {
        tcounts[slot(vm.times, f.t)]++;
    }

    const labels = vm.times.map(t =>
        vm.step === 'mes'
            ? month.format(t).split(' ')[0]
            : short.format(t)
    );

    chart('chart-time', {

        chart: {
            type: 'column'
        },

        xAxis: {

            categories: labels,

            labels: {
                step: Math.max(
                    1,
                    Math.ceil(labels.length / 15)
                )
            },

            plotBands: [{
                from: vm.index - 0.5,
                to: vm.index + 0.5,
                color: '#d4e9dc'
            }]
        },

        plotOptions: {

            series: {

                cursor: 'pointer',

                point: {

                    events: {

                        click() {
                            vm.seek(this.index);
                        }
                    }
                }
            }
        },

        series: [{

            name: 'Focos',

            data: tcounts.map((n, i) => ({

                y: n,

                color: i === vm.index
                    ? '#d86a27'
                    : vm.accumulated && i <= vm.index
                        ? '#28755a'
                        : '#a7bcb1'
            }))
        }]

    });

    // -------------------------------------------------
    // TOP 15 MUNICÍPIOS
    // -------------------------------------------------

    const municipalities = rank(
        count(selected, f => f.mkey)
    ).filter(x => x[0]).slice(0, 15);

    chart('chart-municipios', {

        chart: {
            type: 'bar'
        },

        xAxis: {

            categories: municipalities.map(
                x => vm.names[x[0]] || x[0]
            )
        },

        plotOptions: {

            series: {

                cursor: 'pointer',

                point: {

                    events: {

                        click() {

                            // Filtra e enquadra município.
                            vm.setMunicipio(
                                this.options.mkey
                            );
                        }
                    }
                }
            }
        },

        series: [{

            name: 'Focos',

            data: municipalities.map(
                ([k, y]) => ({
                    y,
                    mkey: k
                })
            )
        }]
    });

    // -------------------------------------------------
    // GRÁFICO DE BIOMAS
    // -------------------------------------------------

    chart('chart-bioma', {

        chart: {
            type: 'pie'
        },

        legend: {
            enabled: true
        },

        colors: [
            '#28755a',
            '#e6a33b',
            '#b96d37',
            '#698c9b',
            '#a1ada7'
        ],

        plotOptions: {

            pie: {

                showInLegend: true,

                dataLabels: {

                    enabled: true,

                    format: '{point.name}: {point.y}'
                },

                point: {

                    events: {

                        click() {

                            if (this.options.filter) {

                                vm.setBioma(
                                    this.options.filter
                                );
                            }
                        }
                    }
                }
            }
        },

        series: [{

            name: 'Focos',

            data: rank(

                count(
                    selected,
                    f => f.bioma || 'Sem dado'
                )

            ).map(([n, y]) => ({

                name: n,

                y,

                filter: n === 'Sem dado' ? '' : n
            }))
        }]

    });

    // -------------------------------------------------
    // HORÁRIOS DE DETECÇÃO
    // -------------------------------------------------

    const hrs = Array(24).fill(0);

    for (const f of selected) {

        const hora = new Date(
            f.t - 3 * 3600000
        ).getUTCHours();

        hrs[hora]++;
    }

    chart('chart-hora', {

        chart: {
            type: 'column'
        },

        xAxis: {

            categories: hrs.map(
                (_, i) => String(i).padStart(2, '0') + 'h'
            ),

            labels: {
                step: 2
            }
        },

        series: [{
            name: 'Focos',
            data: hrs,
            color: '#be682e'
        }]
    });

}

// =====================================================
// APLICAÇÃO VUE
// =====================================================

Vue.createApp({

    data() {

        return {

            ready: false,

            status: Object.fromEntries(
                files.map(f => [
                    f,
                    {
                        state: 'pendente',
                        message: 'Aguardando'
                    }
                ])
            ),

            municipio: '',
            bioma: '',
            biomas: [],
            names: {},

            view: 'agrupados',
            step: 'mes',
            accumulated: false,

            times: makeTimes('mes'),

            // Outubro de 2026.
            index: 9,

            playing: false,
            baseError: false,

            source: '—',
            satellites: '—',

            excluded: 0,
            kpis: [],
            topFrp: [],

            views: [

                {
                    id: 'agrupados',
                    label: 'Agrupados'
                },

                {
                    id: 'densidade',
                    label: 'Densidade'
                },

                {
                    id: 'intensidade',
                    label: 'Intensidade (FRP)'
                },

                {
                    id: 'municipios',
                    label: 'Municípios'
                }
            ],

            steps: [

                {
                    id: 'dia',
                    label: 'Dia'
                },

                {
                    id: 'semana',
                    label: 'Semana'
                },

                {
                    id: 'mes',
                    label: 'Mês'
                }
            ]
        };
    },

    // =================================================
    // PROPRIEDADES COMPUTADAS
    // =================================================

    computed: {

        periodLabel() {

            const t = this.times[this.index] || START;

            const end = Math.min(
                this.times[this.index + 1] || END,
                END
            );

            let s = this.step === 'mes'

                ? cap(month.format(t))

                : this.step === 'dia'

                    ? fmt.format(t).split(',')[0].split(' ')[0]

                    : `${short.format(t)} a ${
                        short.format(end - 1)
                    } de 2026`;

            if (this.accumulated) {

                s = `1º jan. a ${
                    short.format(end - 1)
                } de 2026`;
            }

            return `${s} · ${
                this.accumulated
                    ? 'acumulado'
                    : this.step === 'mes'
                        ? 'só este mês'
                        : this.step === 'dia'
                            ? 'só este dia'
                            : 'só esta semana'
            }`;
        },

        legend() {

            if (this.view === 'agrupados') {

                return [
                    '1–9 focos',
                    '10–49',
                    '50–99',
                    '100 ou mais'

                ].map((label, i) => ({
                    label,
                    color: clusterColors[i]
                }));
            }

            if (this.view === 'densidade') {

                return [
                    'Baixa',
                    'Moderada',
                    'Alta',
                    'Muito alta'

                ].map((label, i) => ({

                    label,

                    color: [
                        '#3b82f6',
                        '#36b37e',
                        '#f4d03f',
                        '#b91c1c'
                    ][i]
                }));
            }

            if (this.view === 'intensidade') {

                return [

                    ...[
                        '< 10 MW',
                        '10–< 30 MW',
                        '30–< 100 MW',
                        '≥ 100 MW'

                    ].map((label, i) => ({
                        label,
                        color: frpColors[i]
                    })),

                    {
                        label: 'Sem FRP',
                        color: '#929a96'
                    }
                ];
            }

            return [

                '0 focos',
                '1–20',
                '21–50',
                '51–100',
                '> 100'

            ].map((label, i) => ({
                label,
                color: muniColors[i]
            }));
        }
    },

    // =================================================
    // MÉTODOS
    // =================================================

    methods: {

        num(v) {
            return v === null ? 'Sem dado' : nf.format(v);
        },

        formatDate(t) {
            return fmt.format(t);
        },

        goHome() {
            fitPB();
        },

        fullscreen() {

            const el = document.getElementById('map-shell');

            if (document.fullscreenElement) {

                document.exitFullscreen().catch(() => {});

            } else if (el.requestFullscreen) {

                el.requestFullscreen().catch(() => {

                    alert(
                        'Tela cheia indisponível neste navegador.'
                    );
                });

            } else {

                alert(
                    'Tela cheia indisponível neste navegador.'
                );
            }
        },

        // =============================================
        // CARREGAMENTO DOS ARQUIVOS GEOJSON
        // =============================================

        async load() {

            this.stop();

            const g = ++generation;

            this.ready = false;

            const results = await Promise.all(

                files.map(async f => {

                    this.status[f] = {
                        state: 'carregando',
                        message: 'Carregando…'
                    };

                    try {

                        // Compatibilidade com os nomes
                        // dos arquivos exportados pelo QGIS.

                        const alternativas = {

                            'queimadas_pb_2026.geojson': [
                                'queimadas_2026.geojson'
                            ],

                            'municipios_pb.geojson': [
                                'municipios.geojson'
                            ]
                        };

                        let r;

                        const tentativas = [
                            f,
                            ...(alternativas[f] || [])
                        ];

                        for (const nome of tentativas) {

                            r = await fetch(
                                'dados/' + nome,
                                {
                                    cache: 'no-cache'
                                }
                            );

                            if (r.ok || r.status !== 404) {
                                break;
                            }
                        }

                        if (!r.ok) {

                            throw Error(
                                `HTTP ${r.status} ${
                                    r.statusText
                                } — verifique dados/ (${
                                    tentativas.join(' ou ')
                                })`
                            );
                        }

                        const j = await r.json();

                        if (
                            j.type !== 'FeatureCollection' ||
                            !Array.isArray(j.features)
                        ) {

                            throw Error(
                                'GeoJSON não é uma FeatureCollection válida'
                            );
                        }

                        if (
                            f !== files[0] &&
                            !j.features.some(x =>
                                ['Polygon', 'MultiPolygon']
                                    .includes(x.geometry?.type)
                            )
                        ) {

                            throw Error(
                                'Nenhum polígono encontrado'
                            );
                        }

                        if (g === generation) {

                            this.status[f] = {

                                state: 'ok',

                                message: `${
                                    j.features.length
                                } feições carregadas`
                            };
                        }

                        return j;

                    } catch (e) {

                        if (g === generation) {

                            this.status[f] = {

                                state: 'erro',

                                message: `${e.message}${
                                    location.protocol === 'file:'
                                        ? ' — abra por um servidor HTTP local.'
                                        : ''
                                }`
                            };
                        }

                        return null;
                    }
                })
            );

            if (
                g !== generation ||
                results.some(x => !x)
            ) {
                return;
            }

            const [f, m, s] = results;

            municipalData = m;
            stateData = s;

            raw = [];

            this.excluded = 0;

            const names = {};

            // Nomes dos municípios.
            for (const x of m.features) {

                if (muniKey(x)) {

                    names[muniKey(x)] = muniName(x);
                }
            }

            // Processamento dos focos.
            for (const [id, x] of f.features.entries()) {

                const p = x.properties || {};
                const c = x.geometry?.coordinates;

                const dt = clean(
                    p.data_hora ?? p.datahora
                );

                const t =
                    typeof dt === 'string' &&
                    /(Z|[+-]\d\d:\d\d)$/i.test(dt)
                        ? Date.parse(dt)
                        : NaN;

                if (

                    !Number.isFinite(t) ||

                    t < START ||

                    t >= END ||

                    x.geometry?.type !== 'Point' ||

                    !Array.isArray(c) ||

                    !Number.isFinite(c[0]) ||

                    !Number.isFinite(c[1]) ||

                    Math.abs(c[0]) > 180 ||

                    Math.abs(c[1]) > 90

                ) {

                    this.excluded++;

                    continue;
                }

                const mk = key(p.municipio);

                if (mk && !names[mk]) {

                    names[mk] = name(p.municipio);
                }

                raw.push({

                    id,

                    t,

                    lng: c[0],

                    lat: c[1],

                    mkey: mk,

                    municipio: names[mk] || '',

                    bioma: name(p.bioma),

                    frp: number(p.frp),

                    risco: number(
                        p.risco_fogo ?? p.riscofogo
                    ),

                    dias: number(
                        p.dias_sem_chuva ?? p.diasemchuva
                    ),

                    prec: number(p.precipitacao),

                    sat: clean(p.satelite)
                });
            }

            this.names = names;

            this.biomas = [

                ...new Set(

                    raw.map(f => f.bioma).filter(Boolean)

                )

            ].sort();

            // Metadados.
            const meta = f.metadados || {};

            this.source = meta.fonte || 'GeoJSON fornecido';

            const sat =

                meta.satelite ??

                meta['satélite'] ??

                meta.satelites ??

                [...new Set(
                    raw.map(f => f.sat).filter(Boolean)
                )];

            this.satellites = Array.isArray(sat)

                ? sat.join(', ') || 'Não informado'

                : String(sat || 'Não informado');

            const totals = count(raw, f => f.mkey);

            if (ts) {
                ts.destroy();
            }

            // =========================================
            // TOM SELECT - FILTRO MUNICIPAL
            // =========================================

            ts = new TomSelect('#municipio', {

                options: Object.entries(names)

                    .sort(
                        (a, b) => a[1].localeCompare(
                            b[1],
                            'pt-BR'
                        )
                    )

                    .map(([value, n]) => ({

                        value,

                        text: `${n} (${
                            nf.format(totals.get(value) || 0)
                        })`,

                        alias: key(n)

                    })),

                items: [],

                valueField: 'value',

                labelField: 'text',

                searchField: ['text', 'alias'],

                diacritics: true,

                allowEmptyOption: false,

                placeholder: 'Todos os municípios — buscar',

                plugins: ['clear_button'],

                // Selecionar município ativa o zoom.
                onChange: v => this.setMunicipio(v)

            });

            this.municipio = '';
            this.bioma = '';

            resetBoundaries(this);

            this.ready = true;

            this.step = 'mes';
            this.accumulated = false;

            this.times = makeTimes('mes');
            this.index = 9;

            syncing = true;

            td.setAvailableTimes(
                this.times,
                'replace'
            );

            td.setCurrentTime(this.times[9]);

            syncing = false;

            this.refresh();
        },

        // =============================================
        // FILTRO MUNICIPAL COM ZOOM AUTOMÁTICO
        // =============================================

        setMunicipio(v) {

            this.municipio = v;

            if (ts && ts.getValue() !== v) {

                ts.setValue(v, true);
            }

            // Atualiza mapa, indicadores e gráficos.
            this.refresh();

            // Enquadra os limites do município.
            fitMunicipio(v);

        },

        setBioma(v) {

            this.bioma = v;

            this.refresh();
        },

        clearFilters() {

            this.municipio = '';

            this.bioma = '';

            if (ts) {
                ts.clear(true);
            }

            this.refresh();

            // Retorna para o estado inteiro.
            fitPB();
        },

        changeView(v) {

            this.view = v;

            if (this.ready) {
                this.refresh();
            }
        },

        changeMode(v) {

            this.accumulated = v;

            this.refresh();
        },

        // =============================================
        // NAVEGAÇÃO TEMPORAL
        // =============================================

        changeStep(s) {

            if (s === this.step) return;

            this.stop();

            const old = this.times[this.index];

            this.step = s;

            this.times = makeTimes(s);

            this.index = slot(this.times, old);

            syncing = true;

            td.setAvailableTimes(
                this.times,
                'replace'
            );

            td.setCurrentTime(
                this.times[this.index]
            );

            syncing = false;

            this.refresh();
        },

        seek(i) {

            if (!this.ready) return;

            const next = Math.max(

                0,

                Math.min(
                    this.times.length - 1,
                    i
                )
            );

            if (next === this.index) {

                this.refresh();

                return;
            }

            td.setCurrentTime(
                this.times[next]
            );
        },

        move(n) {

            this.seek(this.index + n);
        },

        stop() {

            if (timer) {
                clearInterval(timer);
            }

            timer = null;

            this.playing = false;
        },

        togglePlay() {

            if (this.playing) {

                this.stop();

                return;
            }

            if (this.index === this.times.length - 1) {

                this.seek(0);
            }

            this.playing = true;

            timer = setInterval(() => {

                if (
                    this.index >= this.times.length - 1
                ) {

                    this.stop();

                } else {

                    this.move(1);
                }

            }, 1000);
        },

        // =============================================
        // ATUALIZAÇÃO DO DASHBOARD
        // =============================================

        refresh() {

            if (!this.ready) return;

            const filtered = raw.filter(f =>

                (
                    !this.municipio ||
                    f.mkey === this.municipio
                )

                &&

                (
                    !this.bioma ||
                    f.bioma === this.bioma
                )
            );

            const start = this.accumulated

                ? START

                : this.times[this.index];

            const end =

                this.times[this.index + 1] || END;

            const selected = filtered.filter(

                f => f.t >= start && f.t < end
            );

            const total = selected.length;

            const detail = total

                ? `${nf.format(total)} de ${
                    nf.format(filtered.length)
                } focos selecionados`

                : 'Sem focos na seleção';

            const days = rank(

                count(
                    selected,
                    f => fmt.format(f.t).slice(0, 10)
                )
            );

            const municipalities = new Set(

                selected.map(
                    f => f.mkey
                ).filter(Boolean)
            );

            // Ranking dos maiores valores de FRP.
            this.topFrp = selected

                .filter(f => f.frp !== null)

                .sort((a, b) => b.frp - a.frp)

                .slice(0, 10);

            const caa = selected.filter(

                f => key(f.bioma) === 'CAATINGA'

            ).length;

            // Indicadores.
            this.kpis = [

                {
                    label: 'Focos',
                    value: nf.format(total),
                    detail
                },

                {
                    label: 'Municípios atingidos',

                    value: nf.format(
                        municipalities.size
                    ),

                    detail
                },

                {
                    label: 'Dia com mais focos',

                    value: days[0]?.[0] || '—',

                    detail: days.length

                        ? `${days[0][1]} focos · ${detail}`

                        : detail
                },

                {
                    label: 'Maior FRP',

                    value: this.topFrp.length

                        ? nf.format(
                            this.topFrp[0].frp
                        ) + ' MW'

                        : '—',

                    detail: this.topFrp.length

                        ? detail

                        : total

                            ? 'Sem FRP válida nesta seleção'

                            : detail
                },

                {
                    label: 'Na Caatinga',

                    value: total

                        ? nf.format(
                            caa / total * 100
                        ) + '%'

                        : '—',

                    detail: total

                        ? `${caa} de ${total} focos no período`

                        : detail
                }
            ];

            // Não modifica o zoom ao atualizar o período
            // ou ao alterar o filtro de bioma.

            renderMap(this, selected);

            renderCharts(
                this,
                filtered,
                selected
            );
        },

        // =============================================
        // LOCALIZAR FOCO DA TABELA NO MAPA
        // =============================================

        locate(f) {

            this.stop();

            if (highlight) {
                map.removeLayer(highlight);
            }

            map.setView(

                [f.lat, f.lng],

                Math.max(map.getZoom(), 13)
            );

            highlight = L.circleMarker(

                [f.lat, f.lng],

                {
                    pane: 'highlightPane',
                    radius: 11,
                    color: '#152f24',
                    weight: 3,
                    fillColor: '#fbbf24',
                    fillOpacity: 1
                }

            ).addTo(map)

                .bindPopup(popup(f))

                .openPopup();

            document.getElementById(
                'map-shell'
            ).scrollIntoView({

                behavior: 'smooth',

                block: 'start'
            });
        }
    },

    // =================================================
    // INICIALIZAÇÃO DA APLICAÇÃO
    // =================================================

    mounted() {

        initMap(this);

        this.load();
    }

}).mount('#app');
