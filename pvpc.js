// Lógica pura del PVPC: sin DOM ni red.
export const VERSION = '1.9.1';
const TZ = 'Europe/Madrid';
const fmtMadrid = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
});

// Fecha (YYYY-MM-DD) y hora (0-23) actuales en Madrid para un instante dado.
export function madridNow(date = new Date()) {
  const p = Object.fromEntries(fmtMadrid.formatToParts(date).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

export function addDays(ymd, n) {
  return new Date(Date.parse(ymd + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
}

// AAAA-MM-DD real (rechaza 2026-02-30 o 2026-13-01).
export const isValidDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z')) && addDays(s, 0) === s;

export function buildUrl(start, end) {
  return 'https://apidatos.ree.es/es/datos/mercados/precios-mercados-tiempo-real'
    + `?start_date=${start}T00:00&end_date=${end}T23:59&time_trunc=hour`;
}

export const toKwh = (eurMwh) => eurMwh / 1000;

// Media horaria (€/kWh) del spot cuartohorario de un día: { 'HH': {price, t} }, o null si el día
// no tiene exactamente 96 cuartos (sin datos aún, hueco o día de cambio horario).
function hourlySpot(values, date) {
  const q = values.filter((v) => v.datetime.startsWith(date));
  if (q.length !== 96) return null;
  const h = {};
  for (const v of q) {
    const k = v.datetime.slice(11, 13);
    h[k] ??= { sum: 0, n: 0, t: Date.parse(v.datetime) };
    h[k].sum += v.value;
    h[k].n++;
  }
  return Object.fromEntries(Object.entries(h).map(([k, x]) => [k, { price: toKwh(x.sum / x.n), t: x.t }]));
}

// Respuesta de REE -> { today, tomorrow, estimate }: arrays de {hour, price, t} (price en €/kWh, t en ms).
// Lanza error si no hay serie PVPC o no hay datos de hoy; mañana vacío es normal.
// estimate (solo si mañana oficial está vacío) = spot de mañana + (PVPC - spot) de hace 7 días, hora a hora.
export function parse(json, today, tomorrow) {
  if (json.errors) throw new Error('La API devolvió un error');
  const serie = json.included?.find((x) => x.id === '1001');
  if (!serie) throw new Error('Sin serie PVPC');
  const out = { today: [], tomorrow: [], estimate: [] };
  for (const v of serie.attributes.values) {
    const d = v.datetime.slice(0, 10);
    const day = d === today ? out.today : d === tomorrow ? out.tomorrow : null;
    day?.push({ hour: v.datetime.slice(11, 13), price: toKwh(v.value), t: Date.parse(v.datetime) });
  }
  if (!out.today.length) throw new Error('Sin precios de hoy');
  // ponytail: sin estimación la semana posterior a un cambio horario ni con huecos; en festivos los peajes
  // cambian y puede errar. Todo o nada: nunca estimaciones parciales.
  if (!out.tomorrow.length) {
    const ref = addDays(tomorrow, -7);
    const spot = json.included.find((x) => x.id === '600')?.attributes.values ?? [];
    const sT = hourlySpot(spot, tomorrow);
    const sR = hourlySpot(spot, ref);
    const pR = Object.fromEntries(serie.attributes.values.filter((v) => v.datetime.startsWith(ref))
      .map((v) => [v.datetime.slice(11, 13), toKwh(v.value)]));
    const hours = Object.keys(sT ?? {}).sort();  // sort: las claves '10'..'23' saltarían delante de '00'..'09'
    if (sR && hours.every((h) => sR[h] && pR[h] !== undefined)) {
      out.estimate = hours.map((h) => ({ hour: h, price: sT[h].price + (pR[h] - sR[h].price), t: sT[h].t }));
    }
  }
  return out;
}

// Índice de la hora vigente en el instante nowMs (-1 si no está en el día).
// Por instante, no por hora: en el día de 25 horas la hora 02 aparece dos veces.
export const currentIndex = (day, nowMs) => day.findIndex((e) => nowMs >= e.t && nowMs < e.t + 36e5);

export function stats(day) {
  const p = day.map((e) => e.price);
  const min = Math.min(...p);
  const max = Math.max(...p);
  return {
    min, max,
    minI: p.indexOf(min), maxI: p.indexOf(max),
    avg: p.reduce((a, b) => a + b) / p.length,
  };
}

// Tercil del rango del propio día: 'barato' | 'medio' | 'caro'.
export function level(price, { min, max }) {
  const step = (max - min) / 3;
  return price <= min + step ? 'barato' : price >= max - step ? 'caro' : 'medio';
}

export const fmtNum = (p) => p.toFixed(4).replace('.', ',');
export const fmt = (p) => `${fmtNum(p)} €/kWh`;

// 'AAAA-MM-DD' -> 'vie 13 nov'
export const fmtDate = (ymd) => new Intl.DateTimeFormat('es-ES', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' })
  .format(Date.parse(ymd + 'T12:00:00Z')).replace(',', '');

// '13' -> '13-14', '23' -> '23-24'
export const fmtRange = (h) => `${h}-${String(Number(h) + 1).padStart(2, '0')}`;

// Periodo de peaje 2.0TD de una hora (hora local de Madrid) del día ymd: 'valle' | 'llano' | 'punta'.
// ponytail: solo festivos nacionales de fecha fija; ignora autonómicos y los trasladados a lunes (Semana Santa incluida);
// Ceuta y Melilla tienen otras franjas. Ampliar la lista FESTIVOS si hace falta.
const FESTIVOS = ['01-01', '01-06', '05-01', '08-15', '10-12', '11-01', '12-06', '12-08', '12-25'];
export function period(ymd, hour) {
  const dow = new Date(ymd + 'T00:00:00Z').getUTCDay();
  if (dow === 0 || dow === 6 || FESTIVOS.includes(ymd.slice(5))) return 'valle';
  const h = Number(hour);
  return h < 8 ? 'valle' : (h >= 10 && h < 14) || (h >= 18 && h < 22) ? 'punta' : 'llano';
}

// --- Calculadora de carga del coche ---
// ponytail: IEE 5,11269632 % y luego IVA 21 %; ignora el mínimo del IEE por MWh y el término de potencia.
// Los tipos cambian por ley: actualizar aquí.
export const TAX = 1.0511269632 * 1.21;

// Potencia de la línea (kW) y la que realmente se usa (limitada por el máximo del coche/cargador). phases: 1 | 3.
export function chargeKw(phases, amps, maxKw) {
  const line = (phases === 3 ? 400 * Math.sqrt(3) : 230) * amps / 1000;
  return { line, kw: Math.min(line, maxKw) };
}

// kWh tomados de la red para pasar de socPct a targetPct, con pérdidas de carga (eff).
export const chargeEnergy = (batKwh, socPct, targetPct, eff = 0.9) => batKwh * (targetPct - socPct) / 100 / eff;

// Tramos horarios que ocupa una carga de hours horas (tolera el error de coma flotante: 15.000000000000002 -> 15).
export const slotsNeeded = (hours) => Math.ceil(hours - 1e-9);

// Tramos que ocupa una carga que empieza en un tramo del que solo queda la fracción f (la hora en curso, "ahora").
export const chargeSlots = (hours, f = 1) => 1 + Math.max(0, slotsNeeded(hours - f));

// € (sin impuestos) consumiendo kw durante hours horas desde el tramo start; la última hora parcial cuenta en proporción.
// firstFraction: parte disponible del tramo 0 (0 < f <= 1; la hora en curso). null si se sale de los precios disponibles.
export function chargeCost(prices, start, hours, kw, firstFraction = 1) {
  const f = start === 0 ? firstFraction : 1;
  if (!(hours > 0 && kw > 0 && f > 0)) return null;
  const need = chargeSlots(hours, f);
  if (start + need > prices.length) return null;
  let cost = prices[start] * Math.min(f, hours);
  for (let i = 1, left = hours - f; i < need; i++, left--) cost += prices[start + i] * Math.min(1, left);
  return cost * kw;
}

// Inicio más barato que cabe: { start, cost } (empate -> el más temprano), o null.
export function cheapestStart(prices, hours, kw, firstFraction = 1) {
  if (!(firstFraction > 0)) return null;
  let best = null;
  for (let s = 0; s < prices.length; s++) {
    const cost = chargeCost(prices, s, hours, kw, firstFraction);
    if (cost !== null && (!best || cost < best.cost - 1e-12)) best = { start: s, cost };
  }
  return best;
}

// Plan de carga de kwh kWh desde el tramo start. kws: kW constantes (número) o kW de cada tramo (array indexado como prices;
// P1/P2 cambian según el periodo). Cada tramo aporta kW × tiempo disponible (el tramo 0 solo firstFraction); el último, en proporción.
// { cost (€ sin impuestos), hours (duración real), slots (tramos que ocupa) }, o null si no cabe o kW/kWh no válidos.
export function chargePlan(prices, start, kwh, kws, firstFraction = 1) {
  if (!(kwh > 0 && firstFraction > 0)) return null;
  let left = kwh, cost = 0, hours = 0, slots = 0;
  for (let i = start; left > 1e-9; i++) {
    const k = Array.isArray(kws) ? kws[i] : kws;
    if (i >= prices.length || !(k > 0)) return null;
    const take = Math.min(left, k * (i === 0 ? firstFraction : 1));
    cost += prices[i] * take; hours += take / k; left -= take; slots++;
  }
  return { cost, hours, slots };
}

// Inicio más barato con chargePlan: { start, cost, hours, slots } (empate -> el más temprano), o null.
// ok(start, plan): filtro opcional (p. ej. que la carga termine antes de una hora límite).
export function cheapestPlan(prices, kwh, kws, firstFraction = 1, ok = () => true) {
  let best = null;
  for (let s = 0; s < prices.length; s++) {
    const p = chargePlan(prices, s, kwh, kws, firstFraction);
    if (p && ok(s, p) && (!best || p.cost < best.cost - 1e-12)) best = { start: s, ...p };
  }
  return best;
}

// € (sin impuestos) que se pagan a la red con las placas (kwp, ws = W/m² de cada tramo): como chargePlan, pero en cada tramo
// la energía solar de ese tiempo (ws/1000 × kwp × PERF × horas) se resta de lo que consume el coche (sin bajar de 0). null si no cabe.
export function chargeGridCost(prices, start, kwh, kws, ws, kwp, firstFraction = 1) {
  if (!(kwh > 0 && firstFraction > 0)) return null;
  let left = kwh, cost = 0;
  for (let i = start; left > 1e-9; i++) {
    const k = Array.isArray(kws) ? kws[i] : kws;
    if (i >= prices.length || !(k > 0)) return null;
    const take = Math.min(left, k * (i === 0 ? firstFraction : 1));
    cost += prices[i] * Math.max(0, take - ws[i] / 1000 * kwp * PERF * take / k); left -= take;
  }
  return cost;
}

// 3.9 -> '3 h 54 min'; 0.5 -> '30 min'
export function fmtDuration(hours) {
  const m = Math.round(hours * 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}

// --- Previsión solar (Open-Meteo) ---
export const PERF = 0.8;  // rendimiento global de la instalación (pérdidas de inversor, temperatura, suciedad…)
export const geoUrl = (q) => 'https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(q) + '&count=5&language=es&countryCode=ES';
export const forecastUrl = (lat, lon) => `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
  + '&hourly=weather_code,shortwave_radiation,is_day&daily=weather_code,shortwave_radiation_sum,sunshine_duration,sunrise,sunset'
  + '&timezone=Europe%2FMadrid&forecast_days=3';

export const ICON_ES = { sun: 'Soleado', psun: 'Parcialmente nuboso', cloud: 'Nublado', rain: 'Lluvia' };
// Código WMO -> 'sun' | 'psun' | 'cloud' | 'rain' (nieve y desconocidos: 'cloud').
export function weatherIcon(code) {
  if (code === 0 || code === 1) return 'sun';
  if (code === 2) return 'psun';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82) || (code >= 95 && code <= 99)) return 'rain';
  return 'cloud';
}

// Sol del tramo local ymd + hour ('HH' o número) en la respuesta horaria de Open-Meteo, o null si falta.
// Se busca por texto 'AAAA-MM-DDTHH:00' (hora local de Madrid, a prueba de cambios horarios). shortwave_radiation es la
// media de la hora ANTERIOR a su marca: el tramo h-h+1 usa la marca h+1. Icono e is_day, la marca h.
export function slotSolar(hourly, ymd, hour) {
  const h = Number(hour);
  const stamp = (d, k) => `${d}T${String(k).padStart(2, '0')}:00`;
  const i = hourly.time.indexOf(stamp(ymd, h));
  const j = hourly.time.indexOf(h === 23 ? stamp(addDays(ymd, 1), 0) : stamp(ymd, h + 1));
  const w = hourly.shortwave_radiation[j];
  if (i < 0 || j < 0 || typeof w !== 'number') return null;
  return { w, icon: weatherIcon(hourly.weather_code[i]), day: hourly.is_day[i] === 1 || hourly.is_day[j] === 1 };
}

// kWh de las placas (kwp) en una carga de hours horas desde el tramo start; ws = W/m² de cada tramo.
// Mismos tramos y fracciones que chargeCost. Limitado a cap (la energía que necesita la carga). null si no cabe.
export function solarKwh(ws, start, hours, kwp, firstFraction = 1, cap = Infinity) {
  const f = start === 0 ? firstFraction : 1;
  if (!(hours > 0 && f > 0)) return null;
  const need = chargeSlots(hours, f);
  if (start + need > ws.length) return null;
  let wh = ws[start] * Math.min(f, hours);
  for (let i = 1, left = hours - f; i < need; i++, left--) wh += ws[start + i] * Math.min(1, left);
  return Math.min(cap, wh / 1000 * kwp * PERF);
}

// Inicio con más sol: { start, kwh } (empate -> el más temprano), o null.
// hours: número o función (inicio) -> horas de esa carga (null si no cabe).
export function bestSolarStart(ws, hours, kwp, firstFraction = 1, cap = Infinity) {
  let best = null;
  for (let s = 0; s < ws.length; s++) {
    const kwh = solarKwh(ws, s, typeof hours === 'function' ? hours(s) : hours, kwp, firstFraction, cap);
    if (kwh !== null && (!best || kwh > best.kwh + 1e-12)) best = { start: s, kwh };
  }
  return best;
}

export const dailyKwhM2 = (mj) => mj / 3.6;

// '2026-11-15T07:52', '2026-11-15T17:48' -> [8, 18] (horas redondeadas de salida y puesta de sol)
export const sunHours = (sunrise, sunset) => [sunrise, sunset].map((s) => Math.round(Number(s.slice(11, 13)) + Number(s.slice(14, 16)) / 60));
