// Lógica pura del PVPC: sin DOM ni red.
export const VERSION = '1.3.0';
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
