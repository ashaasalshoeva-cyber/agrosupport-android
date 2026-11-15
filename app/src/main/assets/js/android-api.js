/* AgroSupport Android: in-app replacement for server.py (read-only demo mode).
 *
 * Every /api/... request made by the site is answered here, inside the app. The logic is a direct
 * port of the Python modules agro_calc.py, agro_lab.py, agro_ai.py (template mode), science.py,
 * agro_nasa.py and the data routes of server.py.
 *
 * Data policy (same as the website): only real NASA / NOAA / USDA responses are used. Bundled
 * files in data_snapshots/ are dated saved responses and are always labelled delivery="snapshot".
 * Live requests (NASA POWER, NOAA forecast) go through the app's native proxy (/__ext/...),
 * and when they fail the saved snapshot is used, or the source is reported as unavailable.
 * Nothing is invented. Uploads and the admin panel are disabled, as in the website's cloud-demo mode.
 */
(function () {
  'use strict';
  var root = typeof window !== 'undefined' ? window : globalThis;
  if (root.__agroApiInstalled) return;
  root.__agroApiInstalled = true;

  var VERSION = '0.2.1';
  var YEAR = 2025; // year of the bundled data_snapshots (science.py used "current year - 1")
  var CROP_IDS = ['wheat', 'cotton', 'corn', 'barley', 'tomato', 'potato', 'rice', 'alfalfa', 'sunflower',
    'soybean', 'apple', 'apricot', 'grape', 'chickpea'];
  var SITE = {
    id: 'USA-NE-SCAL', name: 'South Central Agricultural Laboratory (UNL)', region: 'USA-NE-SC',
    state: 'Nebraska', country: 'USA', lat: 40.575256, lon: -98.137824, area_ha: null,
    location_kind: 'verified-research-site-reference-point',
    precision_note: 'Officially published coordinates identify the research laboratory, not an individual field or parcel boundary.',
    verified_source: 'https://scal.unl.edu/location/', about_source: 'https://scal.unl.edu/',
    documented_crops: ['corn', 'soybean'],
    documented_practices: ['center-pivot irrigation', 'lateral-move irrigation', 'subsurface drip irrigation'],
    public: true
  };
  var SITES = {
    'USA-NE-SCAL': { lat: 40.575256, lon: -98.137824, name: 'UNL SCAL · Nebraska', kind: 'research_reference' },
    'TJK-SUG-001': { lat: 40.275, lon: 69.635, name: 'Sughd · Тоҷикистон', kind: 'regional_reference' },
    'TJK-KHT-002': { lat: 37.833, lon: 68.782, name: 'Khatlon · Тоҷикистон', kind: 'regional_reference' },
    'TJK-DRS-003': { lat: 38.526, lon: 68.563, name: 'RRP · Тоҷикистон', kind: 'regional_reference' },
    'TJK-GBA-004': { lat: 37.49, lon: 71.55, name: 'GBAO · Тоҷикистон', kind: 'regional_reference' }
  };

  // ------------------------------------------------------------------ helpers
  function ValueErr(msg) { this.message = msg; this.name = 'ValueErr'; }
  ValueErr.prototype = Object.create(Error.prototype);

  // Python-compatible round(): rounds the exact binary value; an exact decimal tie goes to the even digit.
  function pyRound(x, n) {
    if (x === null || x === undefined || !isFinite(x)) return x;
    n = n || 0;
    var neg = x < 0, ax = Math.abs(x);
    var exact = ax.toFixed(Math.min(100, n + 60)), dot = exact.indexOf('.');
    var tail = exact.slice(dot + 1 + n), res;
    if (/^50*$/.test(tail)) { // exact tie
      var digits = BigInt(exact.slice(0, dot) + exact.slice(dot + 1, dot + 1 + n));
      if (digits % 2n === 1n) digits += 1n;
      var str = digits.toString().padStart(n + 1, '0');
      res = Number(n ? str.slice(0, str.length - n) + '.' + str.slice(str.length - n) : str);
    } else res = Number(ax.toFixed(n));
    return neg ? -res : res;
  }
  function finite(x) { return typeof x === 'number' && isFinite(x) && x > -990; }
  function isValid(v) { // agro_calc.is_valid
    if (v === null || v === undefined || typeof v === 'boolean') return false;
    var f = Number(v);
    return isFinite(f) && f > -900 && f < 100000;
  }
  function sum(a) { // Neumaier compensated sum, same algorithm as CPython 3.12+ sum() of floats
    var f = 0, c = 0;
    for (var i = 0; i < a.length; i++) {
      var x = a[i], t = f + x;
      if (Math.abs(f) >= Math.abs(x)) c += (f - t) + x; else c += (x - t) + f;
      f = t;
    }
    return f + c;
  }
  function mean(a) { // statistics.mean(): exact sum, one correct rounding
    var dv = new DataView(new ArrayBuffer(8)), parts = [], minE = 0, seen = false;
    for (var i = 0; i < a.length; i++) {
      dv.setFloat64(0, a[i]);
      var hi = dv.getUint32(0), lo = dv.getUint32(4), sign = hi >>> 31, e = (hi >>> 20) & 0x7ff;
      var m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
      if (e === 0) e = 1; else m |= (1n << 52n);
      e -= 1075; if (sign) m = -m;
      parts.push([m, e]); if (m !== 0n && (!seen || e < minE)) { minE = e; seen = true; }
    }
    if (!seen) return 0;
    var S = 0n; parts.forEach(function (q) { if (q[0] !== 0n) S += q[0] << BigInt(q[1] - minE); });
    var q = (S << 64n) / BigInt(a.length);
    return Number(q) * Math.pow(2, minE - 64);
  }
  function stdev(a) { var m = mean(a), s = 0; for (var i = 0; i < a.length; i++) s += (a[i] - m) * (a[i] - m); return Math.sqrt(s / (a.length - 1)); }
  function nowIso() { return new Date().toISOString().replace(/\.\d+Z$/, '+00:00'); }
  var DAY = 86400000;
  function utc(y, m, d) { return Date.UTC(y, m - 1, d); }
  function ymd(ms) { var d = new Date(ms); return d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0'); }
  function iso(ms) { var s = ymd(ms); return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6); }
  function daysInYear(y) { return Math.round((utc(y + 1, 1, 1) - utc(y, 1, 1)) / DAY); }
  function monthDays(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
  function isoWeek(ms) { // ISO-8601 week number
    var d = new Date(ms); var day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    var y0 = Date.UTC(d.getUTCFullYear(), 0, 1);
    return Math.ceil(((d - y0) / DAY + 1) / 7);
  }
  function dget(o, k) { return o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined; }

  // ------------------------------------------------------------------ agro_calc (A methods)
  function gdd(tmin, tmax, base, cap) {
    base = base === undefined ? 10 : base; cap = cap === undefined ? 30 : cap;
    if (!finite(tmin) || !finite(tmax) || tmin > tmax) return null;
    return Math.max(0, (Math.min(tmax, cap) + Math.max(tmin, base)) / 2 - base);
  }
  function frostWindow(daily, year) {
    var start = utc(year, 1, 1), end = utc(year, 12, 31), dates = [];
    for (var t = start; t <= end; t += DAY) dates.push(t);
    for (var i = 0; i < dates.length; i++) if (!finite(dget(daily, ymd(dates[i])))) return { days: null, last_spring: null, first_autumn: null, complete: false };
    var spring = [], autumn = [];
    dates.forEach(function (t) { if (daily[ymd(t)] <= 0) { (new Date(t).getUTCMonth() + 1 < 7 ? spring : autumn).push(t); } });
    var a = spring.length ? Math.max.apply(null, spring) : start - DAY;
    var b = autumn.length ? Math.min.apply(null, autumn) : end + DAY;
    return { days: Math.max(0, Math.round((b - a) / DAY) - 1), last_spring: spring.length ? iso(a) : null,
      first_autumn: autumn.length ? iso(b) : null, complete: true, censored: !spring.length || !autumn.length };
  }
  function precipitationAnomaly(total, baseline) {
    var values = baseline.filter(finite);
    if (!finite(total) || values.length < 2) return { mm: null, percent: null, z: null, normal: null };
    var m = mean(values), sd = stdev(values);
    return { mm: total - m, percent: m ? 100 * (total - m) / m : null, z: sd ? (total - m) / sd : null, normal: m };
  }
  function climateSimilarity(a, b, scales) {
    var weights = a.map(function () { return 1; });
    if (!(a.length === b.length && b.length === scales.length) || !a.length) throw new ValueErr('Dimensions differ');
    if (a.concat(b).some(function (v) { return !finite(v); }) || scales.some(function (s) { return s <= 0; })) throw new ValueErr('Invalid feature vector');
    var terms = a.map(function (x, i) { return weights[i] * Math.pow((x - b[i]) / scales[i], 2); });
    var distance = Math.sqrt(sum(terms) / sum(weights));
    return { similarity: 100 * Math.exp(-distance), distance: distance, contributions: terms, scales: scales, weights: weights };
  }

  // ------------------------------------------------------------------ agro_calc (B methods)
  function gddDay(tmax, tmin, base, ceiling) {
    base = base === undefined ? 10 : base; ceiling = ceiling === undefined ? 30 : ceiling;
    if (!(isValid(tmax) && isValid(tmin))) return null;
    var hi = Math.min(ceiling, Math.max(base, Number(tmax))), lo = Math.min(ceiling, Math.max(base, Number(tmin)));
    return Math.max(0, (hi + lo) / 2 - base);
  }
  function summarizeDaily(parameters, year) {
    var names = ['T2M_MAX', 'T2M_MIN', 'PRECTOTCORR', 'T2M'];
    names.forEach(function (k) { if (!parameters[k] || typeof parameters[k] !== 'object') throw new ValueErr('Missing required POWER daily parameters'); });
    var records = [], keys = Object.keys(parameters.T2M_MAX).sort();
    keys.forEach(function (ds) {
      if (!(/^\d{8}$/.test(ds) && ds.indexOf(String(year)) === 0)) return;
      var mo = +ds.slice(4, 6), dy = +ds.slice(6, 8);
      var ms = utc(+ds.slice(0, 4), mo, dy);
      if (new Date(ms).getUTCMonth() + 1 !== mo || new Date(ms).getUTCDate() !== dy) return;
      var mx = parameters.T2M_MAX[ds], mn = parameters.T2M_MIN[ds], rain = parameters.PRECTOTCORR[ds], avg = parameters.T2M[ds];
      var doy = Math.round((ms - utc(+ds.slice(0, 4), 1, 1)) / DAY) + 1;
      var rec = { date: iso(ms), doy: doy, tmax: isValid(mx) ? Number(mx) : null, tmin: isValid(mn) ? Number(mn) : null,
        temp: isValid(avg) ? Number(avg) : null, rain: (isValid(rain) && Number(rain) >= 0) ? Number(rain) : null };
      rec.gdd = gddDay(rec.tmax, rec.tmin);
      records.push(rec);
    });
    if (!records.length) throw new ValueErr('No valid daily records in response');
    var growing = records.filter(function (r) { var m = +r.date.slice(5, 7); return m >= 4 && m <= 9; });
    var gd = growing.filter(function (r) { return r.gdd !== null; }).map(function (r) { return r.gdd; });
    var p = growing.filter(function (r) { return r.rain !== null; }).map(function (r) { return r.rain; });
    var heat = growing.filter(function (r) { return r.tmax !== null; });
    var sp = records.filter(function (r) { return r.doy <= 182 && r.tmin !== null && r.tmin <= 0; }).map(function (r) { return r.date; });
    var fa = records.filter(function (r) { return r.doy > 182 && r.tmin !== null && r.tmin <= 0; }).map(function (r) { return r.date; });
    var means = growing.filter(function (r) { return r.temp !== null; }).map(function (r) { return r.temp; });
    var leap = (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0));
    return {
      year: year, growing_months: 'April–September',
      gdd_corn_c: gd.length ? pyRound(sum(gd), 1) : null, gdd_days: gd.length,
      rain_mm: p.length ? pyRound(sum(p), 1) : null, rain_days: p.length,
      tmean_c: means.length ? pyRound(sum(means) / means.length, 2) : null, temp_days: means.length,
      days_over_30c: heat.length ? heat.filter(function (r) { return r.tmax > 30; }).length : null,
      heat_valid_days: heat.length,
      last_spring_frost: sp.length ? sp.reduce(function (a, b) { return a > b ? a : b; }) : null,
      first_autumn_frost: fa.length ? fa.reduce(function (a, b) { return a < b ? a : b; }) : null,
      frost_note: 'Missing event does not prove absence of frost; check valid day coverage.',
      valid_days: records.length, coverage_fraction: pyRound(records.length / (leap ? 366 : 365), 3),
      method: 'Corn GDD: daily clamped max/min 10–30°C; frost: daily minimum ≤0°C; seasonal April–September; >30°C heat days.',
      record_type: 'calculation-from-NASA-POWER-reanalysis'
    };
  }
  function climateTwinB(a, b) {
    var fs = [['tmean_c', 15.0], ['rain_mm', 400.0], ['gdd_corn_c', 1200.0], ['days_over_30c', 60.0]];
    if (fs.some(function (f) { return !(isValid(a[f[0]]) && isValid(b[f[0]])); })) return { status: 'insufficient-data', score: null };
    var parts = fs.map(function (f) { return { metric: f[0], a: a[f[0]], b: b[f[0]], scale: f[1], normalized_delta: pyRound((a[f[0]] - b[f[0]]) / f[1], 4) }; });
    var distance = Math.sqrt(sum(parts.map(function (x) { return x.normalized_delta * x.normalized_delta; })));
    return { status: 'computed', score: pyRound(100 / (1 + distance), 1), distance: pyRound(distance, 3), features: parts,
      method: 'Uncalibrated 100/(1+Euclidean distance); arbitrary display similarity, not agricultural transferability.',
      limits: 'NASA gridded estimates; weather alone cannot establish agronomic equivalence.' };
  }

  // ------------------------------------------------------------------ data loading
  var memo = {};
  function load(path) {
    if (memo[path]) return memo[path];
    var hook = root.__agroLoad;
    var p = hook ? Promise.resolve().then(function () { return hook(path); }) :
      nativeFetch('/' + path, { cache: 'force-cache' }).then(function (r) { if (!r.ok) throw new Error('missing ' + path); return r.json(); });
    memo[path] = p.catch(function (e) { delete memo[path]; throw e; });
    return memo[path];
  }
  function snapshot(key) { return load('data_snapshots/' + key + '.json').then(function (x) { x = JSON.parse(JSON.stringify(x)); x.delivery = 'snapshot'; return x; }); }
  function getPower(site) {
    if (!SITES[site]) return Promise.reject(new ValueErr('Unknown site'));
    return snapshot('power_' + site + '_' + YEAR);
  }
  function getModis(site) { return snapshot('modis_' + site + '_' + YEAR); }
  function getThresholds() { return load('data/crop_thresholds.json'); }

  // ------------------------------------------------------------------ science.py
  function yearMetrics(params, year, crop) {
    var n = daysInYear(year), keys = [];
    for (var i = 0; i < n; i++) keys.push(ymd(utc(year, 1, 1) + i * DAY));
    function vals(p) { return keys.map(function (k) { return dget(params[p], k); }); }
    function complete(p) { return vals(p).every(finite); }
    var rain = complete('PRECTOTCORR') ? sum(vals('PRECTOTCORR')) : null;
    var tmin = vals('T2M_MIN'), tmax = vals('T2M_MAX');
    var gs = tmin.map(function (a, i) { return gdd(a, tmax[i]); });
    var win = frostWindow(params.T2M_MIN || {}, year);
    function mn(p) { return complete(p) ? mean(vals(p)) : null; }
    var m = mn('T2M'), rad = mn('ALLSKY_SFC_SW_DWN'), rw = mn('GWETROOT');
    return { year: year, rain_mm: rain !== null ? pyRound(rain, 2) : null,
      gdd: (crop === 'corn' && gs.every(function (v) { return v !== null; })) ? pyRound(sum(gs), 2) : null,
      frost_free_days: win.days, frost: win,
      mean_c: m !== null ? pyRound(m, 2) : null, radiation: rad !== null ? pyRound(rad, 3) : null,
      root_wetness: rw !== null ? pyRound(rw, 3) : null,
      hot_days_30c: complete('T2M_MAX') ? vals('T2M_MAX').filter(function (v) { return v > 30; }).length : null,
      valid_days: vals('T2M').filter(finite).length, expected_days: n };
  }
  function monthlyClimatology(params) {
    var fields = ['PRECTOTCORR', 'T2M', 'ALLSKY_SFC_SW_DWN', 'WS2M', 'GWETROOT'];
    function rec(year, month) {
      var dates = [], nd = monthDays(year, month);
      for (var d = 1; d <= nd; d++) dates.push(String(year).padStart(4, '0') + String(month).padStart(2, '0') + String(d).padStart(2, '0'));
      var r = { month: month, year: year };
      fields.forEach(function (f) {
        var v = dates.map(function (k) { return dget(params[f], k); });
        r[f] = v.some(function (x) { return !finite(x); }) ? null : pyRound(f === 'PRECTOTCORR' ? sum(v) : sum(v) / v.length, 3);
      });
      return r;
    }
    var last = [], baseline = [];
    for (var m = 1; m <= 12; m++) last.push(rec(YEAR, m));
    for (var mo = 1; mo <= 12; mo++) {
      var samples = []; for (var y = YEAR - 10; y < YEAR; y++) samples.push(rec(y, mo));
      var r = { month: mo, period: [YEAR - 10, YEAR - 1] };
      fields.forEach(function (f) {
        var v = samples.map(function (s) { return s[f]; });
        r[f] = v.every(function (x) { return x !== null; }) ? pyRound(sum(v) / 10, 3) : null;
      });
      baseline.push(r);
    }
    return { last_complete_year: last, baseline_10_years: baseline, units: {
      PRECTOTCORR: 'mm/month', T2M: '°C', ALLSKY_SFC_SW_DWN: 'kWh/m²/day', WS2M: 'm/s', GWETROOT: '0–1 (modelled root-zone wetness)' },
      baseline_years: [YEAR - 10, YEAR - 1] };
  }
  function bundle(site, crop) {
    var base = { site_id: site, site: SITES[site], crop: crop, metrics: {}, sources: [], status: 'unavailable' };
    return getPower(site).then(function (p) {
      return getThresholds().then(function (thr) {
        var params = {};
        Object.keys(p.raw.properties.parameter).forEach(function (k) { params[k] = Object.assign({}, p.raw.properties.parameter[k]); });
        var unit = ((p.raw.parameters || {}).ALLSKY_SFC_SW_DWN || {}).units || '';
        if (unit.indexOf('MJ') === 0) {
          var s = params.ALLSKY_SFC_SW_DWN; Object.keys(s).forEach(function (k) { s[k] = finite(s[k]) ? s[k] / 3.6 : s[k]; });
        }
        var years = []; for (var y = YEAR - 10; y <= YEAR; y++) years.push(yearMetrics(params, y, crop));
        var metrics = years[years.length - 1];
        var anom = precipitationAnomaly(metrics.rain_mm, years.slice(0, -1).map(function (y) { return y.rain_mm; }));
        metrics.rain_anomaly = {}; Object.keys(anom).forEach(function (k) { metrics.rain_anomaly[k] = anom[k] !== null ? pyRound(anom[k], 2) : null; });
        var weeks = [], minKeys = Object.keys(params.T2M_MIN);
        for (var w = 1; w <= 53; w++) {
          var rows = [];
          minKeys.forEach(function (k) {
            var v = params.T2M_MIN[k]; if (!finite(v)) return;
            var ms = utc(+k.slice(0, 4), +k.slice(4, 6), +k.slice(6));
            if (+k.slice(0, 4) < YEAR && isoWeek(ms) === w) rows.push(v);
          });
          weeks.push({ week: w, frost_probability: rows.length ? pyRound(rows.filter(function (v) { return v <= 0; }).length / rows.length, 3) : null, n: rows.length });
        }
        var prov = {}; ['source', 'type', 'resolution', 'retrieved_at', 'period', 'delivery'].forEach(function (k) { prov[k] = p[k]; });
        return Object.assign(base, { status: 'available', metrics: metrics, years: years, weeks: weeks, monthly: monthlyClimatology(params),
          sources: [p.source_url], provenance: prov, units: p.raw.parameters || {}, baseline: [YEAR - 10, YEAR - 1],
          thresholds: thr[crop] === undefined ? null : thr[crop], calculated_at: nowIso() });
      });
    }).catch(function () { return base; });
  }
  var FEATURES = ['rain_mm', 'mean_c', 'hot_days_30c', 'frost_free_days', 'gdd', 'radiation'];
  var SCALES = [300, 10, 30, 60, 1000, 2];
  function twin(site) {
    return Promise.all([bundle(site, 'corn'), bundle('USA-NE-SCAL', 'corn')]).then(function (r) {
      var a = r[0], b = r[1];
      function vector(item) {
        var years = (item.years || []).slice(0, -1);
        return FEATURES.map(function (k) {
          return (years.length === 10 && years.every(function (y) { return y[k] !== null; })) ? mean(years.map(function (y) { return y[k]; })) : null;
        });
      }
      var va = vector(a), vb = vector(b);
      if (va.concat(vb).some(function (v) { return v === null; })) return { status: 'unavailable', features: FEATURES };
      var res = climateSimilarity(va, vb, SCALES);
      return Object.assign(res, { status: 'available', features: FEATURES, selected: va, reference: vb, reference_id: 'USA-NE-SCAL',
        baseline: [YEAR - 10, YEAR - 1], provenance: [a.provenance, b.provenance], period: 'calendar_year',
        limitation: 'Exploratory annual climate comparison, not crop suitability. One reference only.' });
    });
  }

  // ------------------------------------------------------------------ agro_lab.py (nutrient balance)
  var ELEMENTS = ['N', 'P2O5', 'K2O'];
  var DEMO_GRAIN = { N: 22.0, P2O5: 9.0, K2O: 6.0 }, DEMO_STRAW = { N: 5.0, P2O5: 2.0, K2O: 15.0 };
  function finiteNumber(value, name, lower, upper) {
    lower = lower === undefined ? 0 : lower; upper = upper === undefined ? 1000000 : upper;
    if (typeof value !== 'number' || !isFinite(value)) throw new ValueErr(name + ': ожидается число');
    if (!(lower <= value && value <= upper)) throw new ValueErr(name + ': допустимый диапазон ' + pyNum(lower) + '–' + pyNum(upper));
    return value;
  }
  function pyNum(x) { return Number.isInteger(x) ? String(x) : String(x); }
  function nutrients(value, label, upper) {
    upper = upper === undefined ? 1500 : upper;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValueErr(label + ': ожидается объект с N, P2O5, K2O');
    var o = {}; ELEMENTS.forEach(function (e) { o[e] = finiteNumber(value[e], label + '.' + e, 0, upper); }); return o;
  }
  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function calculateBalance(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ValueErr('Ожидается объект параметров');
    var area = finiteNumber(data.area_ha, 'area_ha', 0.01, 100000);
    var yieldT = finiteNumber(data.yield_t_ha, 'yield_t_ha', 0.1, 25);
    var strawRatio = finiteNumber(has(data, 'straw_ratio') ? data.straw_ratio : 1.1, 'straw_ratio', 0, 4);
    var strawExported = has(data, 'straw_exported') ? data.straw_exported : false;
    if (typeof strawExported !== 'boolean') throw new ValueErr('straw_exported: ожидается true или false');
    var grain = nutrients(has(data, 'grain_offtake_kg_t') ? data.grain_offtake_kg_t : DEMO_GRAIN, 'grain_offtake_kg_t', 100);
    var straw = nutrients(has(data, 'straw_offtake_kg_t') ? data.straw_offtake_kg_t : DEMO_STRAW, 'straw_offtake_kg_t', 100);
    var mineral = nutrients(data.mineral_kg_ha, 'mineral_kg_ha'), organic = nutrients(data.organic_kg_ha, 'organic_kg_ha');
    var losses = nutrients(data.estimated_loss_kg_ha, 'estimated_loss_kg_ha');
    var rows = {};
    ELEMENTS.forEach(function (e) {
      var rg = yieldT * grain[e], rs = strawExported ? (yieldT * strawRatio * straw[e]) : 0;
      var inputs = mineral[e] + organic[e], outputs = rg + rs + losses[e], bal = inputs - outputs;
      rows[e] = { inputs_kg_ha: pyRound(inputs, 2), grain_offtake_kg_ha: pyRound(rg, 2), straw_export_kg_ha: pyRound(rs, 2),
        losses_kg_ha: pyRound(losses[e], 2), balance_kg_ha: pyRound(bal, 2), balance_total_kg: pyRound(bal * area, 2),
        replacement_gap_kg_ha: pyRound(Math.max(0, -bal), 2) };
    });
    return { crop: 'wheat', area_ha: area, yield_t_ha: yieldT, straw_exported: strawExported, straw_ratio: strawRatio, elements: rows,
      method: 'declared nutrient inputs minus grain/straw exports and estimated losses',
      data_origin: 'editable illustrative parameters + farmer entries; NOT NASA soil NPK',
      limitations: [
        'Нулевой или положительный баланс не доказывает восстановления плодородия почвы.',
        'Содержание доступных элементов, pH, засоление и органическое вещество требуют лабораторных анализов.',
        'Поступление органических удобрений учитывается по их ПОЛНОМУ составу; доступность по сезонам здесь не моделируется.',
        'Потери из-за вымывания, газовых выделений и эрозии необходимо оценивать отдельно; ноль означает неизвестно/не задано.',
        'Коэффициенты выноса зерном и соломой демонстрационные; агроном должен заменить их региональными значениями.'] };
  }
  function f1(v) { return pyRound(v, 1).toFixed(1); }
  function basicAdvice(balance, weather) {
    var el = balance.elements, parts = [];
    var neg = ELEMENTS.filter(function (e) { return el[e].replacement_gap_kg_ha > 0; }).map(function (e) { return [e, el[e].replacement_gap_kg_ha]; });
    var pos = ELEMENTS.filter(function (e) { return el[e].balance_kg_ha > 0; }).map(function (e) { return [e, el[e].balance_kg_ha]; });
    if (neg.length) parts.push('Расчётный дефицит баланса: ' + neg.map(function (x) { return x[0] + ' ' + f1(x[1]) + ' кг/га'; }).join(', ') + '. Это оценка для планирования, не готовая доза удобрений.');
    else parts.push('По введённым данным отрицательного NPK-баланса нет; это не свидетельствует о восстановлении плодородия.');
    if (pos.length) parts.push('Положительный баланс: ' + pos.map(function (x) { return x[0] + ' ' + f1(x[1]) + ' кг/га'; }).join(', ') + '. Избыток поступления также требует проверки экологических рисков.');
    if (balance.straw_exported) parts.push('Вывоз соломы увеличивает вынос особенно калия. Рассмотрите возврат растительных остатков, если это совместимо с условиями поля.');
    else parts.push('Солома оставлена на поле и не вычитается как экспорт; доступность веществ при разложении не мгновенна.');
    if (weather) {
      var rain = (weather.totals || {}).rain_mm;
      if (rain !== null && rain !== undefined) parts.push('NASA POWER: осадки за выбранный ИСТОРИЧЕСКИЙ период ≈ ' + f1(rain) + ' мм. Это климатические данные, не измерение почвенного NPK и не прогноз.');
    } else parts.push('Метеоданные NASA не загружены: климатический контекст не учтён.');
    parts.push('Следующий шаг: отбор проб почвы N/P/K, органического вещества, pH и электропроводности; согласование плана с местным агрономом.');
    return parts.join(' ');
  }
  function explainTemplate(balance) { // agro_ai.explain without an API key (the app never holds secret keys)
    return { mode: 'template', ai_used: false, summary: basicAdvice(balance, null),
      note: 'Ключ OPENAI_API_KEY не настроен: показан расчётный шаблон, а не ответ ИИ.' };
  }

  // ------------------------------------------------------------------ assistant_template.py
  var TEXT = {
    en: { title: 'Verified-data summary', none: 'No verified climatic indicators are currently loaded.', source: 'Data source: NASA POWER daily gridded estimates.',
      limits: 'These are regional grid estimates, not measurements on the field.', review: 'Check actual soil moisture and the crop stage on the plot before acting.',
      no_npk: 'This service does not calculate fertilizer or pesticide prescriptions.' },
    ru: { title: 'Сводка проверяемых данных', none: 'Проверенные климатические показатели пока не загружены.', source: 'Источник: суточные сеточные оценки NASA POWER.',
      limits: 'Это региональные сеточные оценки, а не измерения на самом поле.', review: 'Перед действиями проверьте фактическую влажность почвы и фазу развития культуры.',
      no_npk: 'Сервис не назначает нормы удобрений и пестицидов.' },
    tg: { title: 'Хулосаи маълумоти санҷишшаванда', none: 'Нишондиҳандаҳои иқлимии санҷидашуда ҳанӯз бор нашудаанд.', source: 'Манбаъ: баҳодиҳии шабакавии ҳаррӯзаи NASA POWER.',
      limits: 'Инҳо баҳодиҳии минтақавӣ мебошанд, на ченкунии худи майдон.', review: 'Пеш аз амал намии воқеии хок ва марҳилаи рушди зироатро тафтиш кунед.',
      no_npk: 'Хизматрасонӣ меъёри нуриҳо ва пестисидҳоро таъин намекунад.' } };
  function templateSummary(bundleObj, lang) {
    lang = TEXT[lang] ? lang : 'en'; var txt = TEXT[lang], data = bundleObj.season || {}, items = [];
    if (data.valid_days) { items.push(txt.source); items.push(txt.limits); } else items.push(txt.none);
    items.push(txt.review); items.push(txt.no_npk);
    return { mode: 'template', summary: items.join(' '), key_points: items.slice(0, 2), caveats: items.slice(-2),
      sources: data.valid_days ? ['NASA POWER'] : [], evidence_bundle: bundleObj };
  }

  // ------------------------------------------------------------------ agro_nasa.py (live POWER point series)
  var AG_PARAMS = ['T2M', 'T2M_MAX', 'T2M_MIN', 'RH2M', 'PRECTOTCORR', 'WS2M', 'ALLSKY_SFC_SW_DWN'];
  var POWER_SRC = 'https://power.larc.nasa.gov/api/temporal/daily/point';
  function parsePowerRequest(q) {
    function one(k) { var x = q[k]; if (Array.isArray(x)) x = x.length === 1 ? x[0] : null; return x; }
    var lat = parseFloat(one('lat')), lon = parseFloat(one('lon'));
    var latS = one('lat'), lonS = one('lon');
    if (latS === null || latS === undefined || latS === '' || lonS === null || lonS === undefined || lonS === '' || isNaN(lat) || isNaN(lon) || isNaN(Number(latS)) || isNaN(Number(lonS)))
      throw new ValueErr('Укажите корректные координаты lat / lon');
    if (!isFinite(lat) || !isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) throw new ValueErr('Координаты находятся вне диапазона');
    var s = one('start'), e = one('end');
    function pd(x) { if (typeof x !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(x)) return null; var ms = utc(+x.slice(0, 4), +x.slice(5, 7), +x.slice(8)); var d = new Date(ms); if (d.getUTCMonth() + 1 !== +x.slice(5, 7) || d.getUTCDate() !== +x.slice(8)) return null; return ms; }
    var sm = pd(s), em = pd(e);
    if (sm === null || em === null) throw new ValueErr('Используйте даты ГГГГ-ММ-ДД');
    var today = Date.now() - (Date.now() % DAY);
    if (sm < utc(1981, 1, 1) || em > today - 7 * DAY || sm > em || (em - sm) / DAY > 365)
      throw new ValueErr('Выберите завершённый исторический период до 366 дней (с 1981 года; без последних 7 дней)');
    return [pyRound(lat, 4), pyRound(lon, 4), s, e];
  }
  function powerRequestUrl(lat, lon, start, end) {
    var q = { parameters: AG_PARAMS.join(','), community: 'AG', latitude: lat, longitude: lon, start: start.replace(/-/g, ''), end: end.replace(/-/g, ''), format: 'JSON', 'time-standard': 'LST' };
    return POWER_SRC + '?' + Object.keys(q).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(q[k]); }).join('&');
  }
  function cleanNumber(x) { return (typeof x === 'number' && isFinite(x) && x > -990 && x >= -1e6 && x <= 1e6) ? x : null; }
  function transformWeather(raw, lat, lon, start, end, url) {
    var p = (raw && raw.properties && raw.properties.parameter) || {};
    AG_PARAMS.forEach(function (k) { if (!p[k] || typeof p[k] !== 'object') throw new ValueErr('NASA POWER returned incomplete fields; unavailable values were not filled'); });
    var units = String(((raw.parameters || {}).ALLSKY_SFC_SW_DWN || {}).units || 'MJ/m^2/day').toLowerCase(), factor;
    if (units.indexOf('mj') >= 0) factor = 1 / 3.6; else if (units.indexOf('kw-hr') >= 0 || units.indexOf('kwh') >= 0) factor = 1;
    else throw new ValueErr('Unknown NASA solar radiation unit: ' + units);
    var first = utc(+start.slice(0, 4), +start.slice(5, 7), +start.slice(8)), last = utc(+end.slice(0, 4), +end.slice(5, 7), +end.slice(8));
    var daily = [], months = {}, monthOrder = [], n = 0, valid = {}; AG_PARAMS.forEach(function (k) { valid[k] = 0; });
    for (var d = first; d <= last; d += DAY) {
      var key = ymd(d), row = { date: iso(d) };
      AG_PARAMS.forEach(function (k) {
        var val = cleanNumber(p[k][key]);
        if (k === 'PRECTOTCORR' && val !== null && val < 0) val = null;
        if (k === 'RH2M' && val !== null && !(val >= 0 && val <= 100)) val = null;
        if (k === 'ALLSKY_SFC_SW_DWN' && val !== null) val *= factor;
        row[k] = val !== null ? pyRound(val, 3) : null;
        if (val !== null) valid[k]++;
      });
      daily.push(row); n++;
      var mk = iso(d).slice(0, 7);
      if (!months[mk]) { months[mk] = { month: mk, days: 0, valid_days: {}, sum: {} }; AG_PARAMS.forEach(function (k) { months[mk].valid_days[k] = 0; months[mk].sum[k] = 0; }); monthOrder.push(mk); }
      var m = months[mk]; m.days++;
      AG_PARAMS.forEach(function (k) { if (row[k] !== null) { m.sum[k] += row[k]; m.valid_days[k]++; } });
    }
    if (!n || !valid.T2M || !valid.PRECTOTCORR) throw new ValueErr('No usable temperature or precipitation records returned by NASA');
    var monthly = monthOrder.map(function (mk) {
      var m = months[mk], o = { month: m.month, expected_days: m.days };
      AG_PARAMS.forEach(function (k) { var c = m.valid_days[k]; o[k] = c ? pyRound(k === 'PRECTOTCORR' ? m.sum[k] : m.sum[k] / c, 2) : null; o[k + '_valid_days'] = c; });
      return o;
    });
    var rainOk = valid.PRECTOTCORR === n;
    var totalRain = rainOk ? pyRound(sum(daily.filter(function (r) { return r.PRECTOTCORR !== null; }).map(function (r) { return r.PRECTOTCORR; })), 2) : null;
    var meanTemp = pyRound(sum(daily.filter(function (r) { return r.T2M !== null; }).map(function (r) { return r.T2M; })) / valid.T2M, 2);
    return { source: 'NASA POWER', source_url: url, retrieved_at: nowIso(), data_status: 'live-real-api', snapshot: false,
      coordinates: { lat: lat, lon: lon }, period: { start: start, end: end }, time_standard: 'LST',
      units: { T2M: '°C', T2M_MAX: '°C', T2M_MIN: '°C', RH2M: '%', PRECTOTCORR: 'mm/day', WS2M: 'm/s', ALLSKY_SFC_SW_DWN: 'kWh/m²/day' },
      daily: daily, monthly: monthly, valid_days: valid, expected_days: n, totals: { rain_mm: totalRain, temperature_mean_c: meanTemp },
      limits: 'Gridded near-surface weather estimates, not field sensors. Missing rainfall prevents a complete-period precipitation total. No NPK assay or irrigation prescription.' };
  }

  // ------------------------------------------------------------------ live access through the app's native proxy
  function extGet(url, timeoutMs) {
    var hook = root.__agroExt;
    if (hook) return Promise.resolve().then(function () { return hook(url); });
    var u = new URL(url), ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, timeoutMs || 20000) : null;
    return nativeFetch('/__ext/' + u.host + u.pathname + u.search, ctl ? { signal: ctl.signal, cache: 'no-store' } : { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .finally(function () { if (timer) clearTimeout(timer); });
  }
  var liveMem = {};
  function liveCached(key, ttlMs, fn) {
    var row = liveMem[key]; if (row && Date.now() - row[0] < ttlMs) return Promise.resolve(row[1]);
    return fn().then(function (v) { liveMem[key] = [Date.now(), v]; return v; });
  }

  // ------------------------------------------------------------------ /api/data/* routes
  function livePowerSummary() {
    var q = { latitude: SITE.lat, longitude: SITE.lon, start: YEAR + '0101', end: YEAR + '1231', community: 'AG',
      parameters: ['T2M', 'PRECTOTCORR', 'ALLSKY_SFC_SW_DWN', 'WS2M'].join(','), format: 'JSON', 'time-standard': 'LST' };
    var url = 'https://power.larc.nasa.gov/api/temporal/daily/point?' + Object.keys(q).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(q[k]); }).join('&');
    return extGet(url).then(function (raw) { return powerSummaryFromRaw(raw); });
  }
  function powerSummaryFromRaw(raw) {
    var PP = ['T2M', 'PRECTOTCORR', 'ALLSKY_SFC_SW_DWN', 'WS2M'];
    var records = {}, par = (raw.properties || {}).parameter || {};
    Object.keys(par).forEach(function (k) { records[k] = Object.assign({}, par[k]); });
    PP.forEach(function (p) { if (!records[p]) throw new ValueErr('Incomplete NASA POWER response'); });
    var su = String((((raw.parameters || {}).ALLSKY_SFC_SW_DWN) || {}).units || 'MJ/m²/day').toLowerCase();
    function vv(v) { return typeof v === 'number' && v > -990 && v < 1e12; }
    if (su.indexOf('mj') >= 0) { var s = records.ALLSKY_SFC_SW_DWN; Object.keys(s).forEach(function (k) { s[k] = vv(s[k]) ? s[k] / 3.6 : s[k]; }); }
    else if (su.indexOf('kwh') < 0) throw new ValueErr('Unknown solar radiation units');
    var months = [];
    for (var month = 1; month <= 12; month++) {
      var prefix = String(YEAR) + String(month).padStart(2, '0'), row = { month: month, year: YEAR };
      PP.forEach(function (p) {
        var values = Object.keys(records[p]).filter(function (d) { return d.indexOf(prefix) === 0 && vv(records[p][d]); }).map(function (d) { return records[p][d]; });
        row[p] = values.length ? pyRound(p === 'PRECTOTCORR' ? sum(values) : sum(values) / values.length, 2) : null;
        row[p + '_days'] = values.length;
      });
      months.push(row);
    }
    return { source: 'NASA POWER', source_url: 'https://power.larc.nasa.gov/', service: 'Daily Point API', reference_year: YEAR,
      coordinates: { lat: SITE.lat, lon: SITE.lon },
      units: { T2M: '°C (daily means → monthly mean)', PRECTOTCORR: 'mm (daily totals → monthly sum)', ALLSKY_SFC_SW_DWN: 'kWh/m²/day (daily values → monthly mean)', WS2M: 'm/s (daily values → monthly mean)' },
      resolution_note: 'Grid/model estimate for the location, not a measurement at the research plot.', retrieved_at: nowIso(), months: months };
  }
  function historicPower() { // same fallback as server.py: real bundled Nebraska source
    return bundle('USA-NE-SCAL', 'corn').then(function (h) {
      if (h.status !== 'available') return null;
      var months = h.monthly.last_complete_year.map(function (x) { return Object.assign({}, x, { T2M_days: null, PRECTOTCORR_days: null, ALLSKY_SFC_SW_DWN_days: null, WS2M_days: null }); });
      var prov = h.provenance;
      return { source: 'NASA POWER', source_url: h.sources[0], reference_year: h.metrics.year, retrieved_at: prov.retrieved_at, delivery: prov.delivery,
        snapshot: prov.delivery === 'snapshot', months: months, resolution_note: prov.resolution + '; grid estimate, not field measurement',
        units: { T2M: '°C', PRECTOTCORR: 'mm/month', ALLSKY_SFC_SW_DWN: 'kWh/m²/day', WS2M: 'm/s' } };
    });
  }
  function savedFlag(x) { return Object.assign({}, x, { snapshot: true, data_status: 'offline-real-snapshot', snapshot_retrieved_at: x.retrieved_at, snapshot_source: x.source_url }); }

  function dataPower() {
    return liveCached('power', 24 * 3600e3, livePowerSummary).catch(function () {
      return historicPower().then(function (h) { if (h) return h; return snapshot('legacy_power').then(savedFlag); });
    });
  }
  function dataForecast() {
    return liveCached('forecast', 20 * 60e3, function () {
      return extGet('https://api.weather.gov/points/' + SITE.lat + ',' + SITE.lon).then(function (p) {
        var fu = ((p.properties || {}).forecast);
        if (typeof fu !== 'string' || fu.indexOf('https://api.weather.gov/gridpoints/') !== 0) throw new ValueErr('Unexpected NOAA forecast URL');
        return extGet(fu);
      }).then(function (data) {
        var props = data.properties || {}, periods = [];
        (props.periods || []).slice(0, 10).forEach(function (pe) {
          var o = {}; ['name', 'startTime', 'endTime', 'isDaytime', 'temperature', 'temperatureUnit', 'probabilityOfPrecipitation', 'windSpeed', 'windDirection', 'shortForecast', 'detailedForecast'].forEach(function (k) { if (k in pe) o[k] = pe[k]; });
          periods.push(o);
        });
        if (!periods.length) throw new ValueErr('Forecast has no periods');
        return { source: 'NOAA National Weather Service', source_url: 'https://www.weather.gov/', issued_at: props.updateTime || props.generatedAt, retrieved_at: nowIso(),
          coordinates: { lat: SITE.lat, lon: SITE.lon }, resolution_note: 'Forecast grid, not an on-farm weather station measurement.', periods: periods };
      });
    }).catch(function () { return snapshot('legacy_forecast').then(savedFlag); });
  }
  function dataSoil() { return snapshot('legacy_soil').then(savedFlag); }
  function seasonFromSnapshot() {
    return getPower('USA-NE-SCAL').then(function (p) {
      var ind = summarizeDaily(p.raw.properties.parameter, YEAR);
      return { source: 'NASA POWER', source_url: 'https://power.larc.nasa.gov/', retrieved_at: p.retrieved_at, year: YEAR, indicators: ind, site_id: SITE.id,
        coordinates: { lat: SITE.lat, lon: SITE.lon }, spatial_resolution: 'NASA POWER daily gridded estimate (~0.5-degree meteorological grid; varies by parameter)',
        provenance_type: 'NASA reanalysis/model derived; AAIAP deterministic calculation',
        limits: 'No ground validation performed. Corn GDD only; thresholds for other crops are not established.',
        snapshot: true, delivery: 'snapshot', data_status: 'offline-real-snapshot', snapshot_retrieved_at: p.retrieved_at, snapshot_source: p.source_url };
    });
  }
  function dataModis() {
    return getModis('USA-NE-SCAL').then(function (m) {
      var rows = [];
      m.rows.forEach(function (r) { if (r.ndvi !== null && r.ndvi !== undefined) rows.push({ modis_date: r.date, ndvi: r.ndvi, pixels: r.valid_pixels }); });
      if (!rows.length) throw new ValueErr('No valid MODIS NDVI pixels in the saved response');
      return { source: 'NASA ORNL DAAC TESViS · MOD13Q1 NDVI', source_url: 'https://modis.ornl.gov/data/modis_webservice.html', retrieved_at: m.retrieved_at,
        year: YEAR, rows: rows, resolution_note: 'MOD13Q1 ~250m pixels; only pixel-reliability 0 values are averaged (saved real response). Exploratory only; NOT measured NDVI of a field.',
        status: 'saved-real-response', snapshot: true, delivery: 'snapshot', data_status: 'offline-real-snapshot', snapshot_retrieved_at: m.retrieved_at, snapshot_source: m.source_url };
    });
  }
  function dataTwin() {
    var regions = [{ id: 'TJK-DRS-003', name: 'RRP (Tajikistan) regional reference point (not a field)', site: 'TJK-DRS-003' },
      { id: 'USA-NE-SCAL', name: SITE.name, site: 'USA-NE-SCAL' }];
    return Promise.all(regions.map(function (r) { return getPower(r.site); })).then(function (powers) {
      var start = YEAR - 4, out = [];
      regions.forEach(function (r, i) {
        var params = powers[i].raw.properties.parameter, years = [];
        for (var y = start; y <= YEAR; y++) years.push(summarizeDaily(params, y));
        var cols = ['tmean_c', 'rain_mm', 'gdd_corn_c', 'days_over_30c'], feats = {};
        cols.forEach(function (k) { var v = years.filter(function (x) { return x[k] !== null; }).map(function (x) { return x[k]; }); feats[k] = v.length ? pyRound(sum(v) / v.length, 2) : null; });
        out.push({ id: r.id, name: r.name, lat: SITES[r.site].lat, lon: SITES[r.site].lon, features: feats, period: start + '–' + YEAR,
          seasons_with_records: years.filter(function (x) { return x.coverage_fraction > 0.95; }).length });
      });
      return { source: 'NASA POWER', source_url: 'https://power.larc.nasa.gov/', retrieved_at: powers[0].retrieved_at, regions: out, similarity: climateTwinB(out[0].features, out[1].features),
        type: 'derived-reanalysis-heuristic', warning: 'Regional reference points; no claim of field or farm equivalence. The score is NOT crop suitability.',
        snapshot: true, delivery: 'snapshot', data_status: 'offline-real-snapshot' };
    });
  }

  // ------------------------------------------------------------------ router
  function R(status, body) { return { status: status, body: body }; }
  function parseQuery(search) {
    var q = {}, sp = new URLSearchParams(search || '');
    sp.forEach(function (v, k) { (q[k] = q[k] || []).push(v); });
    return q;
  }
  function q1(q, k, d) { return q[k] && q[k].length ? q[k][0] : d; }
  var READ_ONLY = { error_code: 'CLOUD_READ_ONLY', error: 'Uploads and admin disabled in cloud demo' };

  function route(method, path, search, bodyText) {
    method = (method || 'GET').toUpperCase();
    var q = parseQuery(search);
    var UNAVAILABLE = R(503, { error: 'Data source is temporarily unavailable' });
    function unavailable(source) { return R(503, { error: 'Data source is temporarily unavailable', source: source, detail: '' }); }
    if (method === 'GET') {
      if (path === '/api/health') return Promise.resolve(R(200, { ok: true, version: VERSION, mode: 'cloud-demo', platform: 'android-app', cache_entries: Object.keys(liveMem).length,
        snapshot_available: ['power', 'forecast', 'soil', 'season', 'modis'] }));
      if (path === '/api/sites') return Promise.resolve(R(200, { sites: [SITE] }));
      if (path === '/api/photos') return Promise.resolve(R(200, { photos: {}, backgrounds: {} }));
      if (path === '/api/admin/status') return Promise.resolve(R(200, { configured: false, authenticated: false, disabled: true }));
      if (path === '/api/community/photos') return Promise.resolve(R(200, { crop: '', photos: [], read_only: true }));
      if (path.indexOf('/api/science/') === 0) {
        var site = q1(q, 'site', 'USA-NE-SCAL'), crop = q1(q, 'crop', 'corn');
        if (path === '/api/science/sites') return Promise.resolve(R(200, SITES));
        if (!SITES[site] || CROP_IDS.indexOf(crop) < 0) return Promise.resolve(R(400, { error: 'invalid_selection' }));
        var job;
        if (path === '/api/science/evidence') job = bundle(site, crop);
        else if (path === '/api/science/twin') job = twin(site);
        else if (path === '/api/science/modis') job = getModis(site).then(function (m) { delete m.raw; return m; });
        else return Promise.resolve(R(404, { error: 'not_found' }));
        return job.then(function (x) { return R(200, x); }, function () { return R(503, { status: 'unavailable', error: 'source_unavailable' }); });
      }
      if (path === '/api/agro/weather') {
        var args; try { args = parsePowerRequest(q); } catch (e) { return Promise.resolve(R(400, { error: String(e.message).slice(0, 220) })); }
        var url = powerRequestUrl(args[0], args[1], args[2], args[3]);
        return liveCached('w|' + args.join('|'), 24 * 3600e3, function () { return extGet(url, 30000).then(function (raw) { return transformWeather(raw, args[0], args[1], args[2], args[3], url); }); })
          .then(function (x) { return R(200, x); }, function (e) {
            if (e instanceof ValueErr) return R(400, { error: String(e.message).slice(0, 220) });
            return R(503, { status: 'unavailable', error: 'NASA POWER unavailable' });
          });
      }
      var routes = { '/api/data/power': dataPower, '/api/data/forecast': dataForecast, '/api/data/soil': dataSoil, '/api/data/season': seasonFromSnapshot, '/api/data/modis': dataModis, '/api/data/twin': dataTwin };
      if (routes[path]) return routes[path]().then(function (x) { return R(200, x); }, function () { return unavailable(path.split('/').pop()); });
      return Promise.resolve(R(404, { error: 'Not found' }));
    }
    if (method === 'POST') {
      if (path.indexOf('/api/admin/') === 0 || path.indexOf('/api/community/') === 0) return Promise.resolve(R(403, READ_ONLY));
      var data; try { data = JSON.parse(bodyText || 'null'); } catch (e) { return Promise.resolve(R(400, { error: 'Invalid JSON' })); }
      if (path === '/api/agro/balance' || path === '/api/agro/advice') {
        try {
          var balance = calculateBalance(data && data.balance);
          if (path === '/api/agro/balance') return Promise.resolve(R(200, balance));
          return Promise.resolve(R(200, Object.assign({ balance: balance, weather_used: false }, explainTemplate(balance))));
        } catch (e) { return Promise.resolve(R(400, { error: String(e.message).slice(0, 220) })); }
      }
      if (path === '/api/assistant/summary') {
        if (!data || data.site_id !== SITE.id || CROP_IDS.indexOf(data.crop) < 0) return Promise.resolve(R(400, { error_code: 'INVALID_SITE_OR_CROP' }));
        return seasonFromSnapshot().then(function (c) { return { season: c.indicators, source_status: 'offline-snapshot', source_url: c.source_url }; }, function () { return { season: null, source_status: 'not-loaded' }; })
          .then(function (extra) {
            var evidence = Object.assign({ site_id: SITE.id, crop: data.crop }, extra);
            var res = templateSummary(evidence, data.lang || 'en'); res.ai_used = false; return R(200, res);
          });
      }
      return Promise.resolve(R(404, { error: 'Not found' }));
    }
    return Promise.resolve(R(404, { error: 'Not found' }));
  }

  // ------------------------------------------------------------------ fetch interception
  var nativeFetch = typeof root.fetch === 'function' ? root.fetch.bind(root) : null;
  var EXT_HOSTS = { 'power.larc.nasa.gov': 1, 'api.weather.gov': 1, 'modis.ornl.gov': 1 };
  if (nativeFetch && typeof Response !== 'undefined' && root.location) {
    root.fetch = function (input, init) {
      try {
        var isReq = typeof Request !== 'undefined' && input instanceof Request;
        var u = new URL(isReq ? input.url : String(input), root.location.href);
        if (u.origin === root.location.origin && u.pathname.indexOf('/api/') === 0) {
          var method = (init && init.method) || (isReq && input.method) || 'GET';
          var bodyP = (init && init.body !== undefined && init.body !== null) ? Promise.resolve(typeof init.body === 'string' ? init.body : '') :
            (isReq && method !== 'GET' ? input.clone().text() : Promise.resolve(''));
          return bodyP.then(function (b) { return route(method, u.pathname, u.search, b); }).then(function (res) {
            return new Response(JSON.stringify(res.body), { status: res.status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
          });
        }
        if (EXT_HOSTS[u.host] && u.protocol === 'https:') {
          return nativeFetch('/__ext/' + u.host + u.pathname + u.search, init && init.signal ? { signal: init.signal } : undefined);
        }
      } catch (e) { /* fall through to the native fetch */ }
      return nativeFetch(input, init);
    };
  }

  var api = { route: route, bundle: bundle, twin: twin, summarizeDaily: summarizeDaily, calculateBalance: calculateBalance, basicAdvice: basicAdvice,
    transformWeather: transformWeather, parsePowerRequest: parsePowerRequest, powerSummaryFromRaw: powerSummaryFromRaw, climateTwinB: climateTwinB, pyRound: pyRound, YEAR: YEAR };
  root.__agroApi = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
