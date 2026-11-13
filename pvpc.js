// Lógica pura del PVPC: sin DOM ni red.
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

export function buildUrl(today, tomorrow) {
  return 'https://apidatos.ree.es/es/datos/mercados/precios-mercados-tiempo-real'
    + `?start_date=${today}T00:00&end_date=${tomorrow}T23:59&time_trunc=hour`;
}

export const toKwh = (eurMwh) => eurMwh / 1000;

// Respuesta de REE -> { today: [{hour, price, t}], tomorrow: [...] } (price en €/kWh, t en ms).
// Lanza error si no hay serie PVPC o no hay datos de hoy; mañana vacío es normal.
export function parse(json, today, tomorrow) {
  if (json.errors) throw new Error('La API devolvió un error');
  const serie = json.included?.find((x) => x.id === '1001');
  if (!serie) throw new Error('Sin serie PVPC');
  const out = { today: [], tomorrow: [] };
  for (const v of serie.attributes.values) {
    const d = v.datetime.slice(0, 10);
    const day = d === today ? out.today : d === tomorrow ? out.tomorrow : null;
    day?.push({ hour: v.datetime.slice(11, 13), price: toKwh(v.value), t: Date.parse(v.datetime) });
  }
  if (!out.today.length) throw new Error('Sin precios de hoy');
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
    cheapest: p.map((_, i) => i).sort((a, b) => p[a] - p[b] || a - b).slice(0, 3),
  };
}

// Tercil del rango del propio día: 'barato' | 'medio' | 'caro'.
export function level(price, { min, max }) {
  const step = (max - min) / 3;
  return price <= min + step ? 'barato' : price >= max - step ? 'caro' : 'medio';
}

export const fmtNum = (p) => p.toFixed(4).replace('.', ',');
export const fmt = (p) => `${fmtNum(p)} €/kWh`;
