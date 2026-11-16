import assert from 'node:assert/strict';
import { VERSION, madridNow, addDays, isValidDate, fmtDate, fmtRange, period, TAX, chargeKw, chargeEnergy, chargeCost, chargePlan, cheapestPlan, cheapestStart, fmtDuration, slotsNeeded, chargeSlots, buildUrl, toKwh, weatherIcon, slotSolar, solarKwh, bestSolarStart, dailyKwhM2, sunHours, forecastUrl, geoUrl, parse, currentIndex, stats, level, fmt } from './pvpc.js';

const hours = (date, n, off, base = 100) =>
  Array.from({ length: n }, (_, h) => ({
    value: base + h, percentage: 0,
    datetime: `${date}T${String(h).padStart(2, '0')}:00:00.000${off}`,
  }));
const resp = (values) => ({ included: [
  { id: '1001', type: 'PVPC', attributes: { values } },
  { id: '600', type: 'Precio mercado spot', attributes: { values: [{ value: 1, datetime: '2026-11-13T00:00:00.000+01:00' }] } },
] });

// parseo hoy + mañana (ignora la serie 600)
let r = parse(resp([...hours('2026-11-13', 24, '+01:00'), ...hours('2026-11-14', 24, '+01:00', 200)]), '2026-11-13', '2026-11-14');
assert.equal(r.today.length, 24);
assert.equal(r.tomorrow.length, 24);
assert.equal(r.today[0].hour, '00');
assert.equal(r.tomorrow[23].price, 0.223);

// mañana ausente -> vacío; hoy ausente -> error
r = parse(resp(hours('2026-11-13', 24, '+01:00')), '2026-11-13', '2026-11-14');
assert.deepEqual(r.tomorrow, []);
assert.throws(() => parse(resp(hours('2026-11-14', 24, '+01:00')), '2026-11-13', '2026-11-14'));
assert.throws(() => parse({ included: [] }, '2026-11-13', '2026-11-14'));
assert.throws(() => parse({ errors: [{}] }, '2026-11-13', '2026-11-14'));

// día de 25 horas: no se deduplica la hora 02 y currentIndex distingue ambas
const v25 = [...hours('2026-10-25', 3, '+02:00'), ...hours('2026-10-25', 24, '+01:00').slice(2)]; // 00,01,02(+02),02..23(+01)
const d25 = parse(resp(v25), '2026-10-25', '2026-10-26').today;
assert.equal(d25.length, 25);
assert.equal(d25.filter((e) => e.hour === '02').length, 2);
assert.equal(currentIndex(d25, Date.parse('2026-10-25T02:30:00+02:00')), 2);
assert.equal(currentIndex(d25, Date.parse('2026-10-25T02:30:00+01:00')), 3);
assert.equal(currentIndex(d25, Date.parse('2026-10-26T12:00:00+01:00')), -1);

// €/MWh -> €/kWh y formato
assert.equal(toKwh(159.11), 0.15911);
assert.equal(fmt(toKwh(159.11)), '0,1591 €/kWh');

// terciles: mínimo barato, máximo caro, medio en medio
const day = [10, 20, 30, 40, 50, 60].map((v) => ({ price: v }));
const s = stats(day);
assert.equal(level(s.min, s), 'barato');
assert.equal(level(s.max, s), 'caro');
assert.equal(level(35, s), 'medio');
assert.equal(s.minI, 0);
assert.equal(s.maxI, 5);
assert.equal(s.avg, 35);
assert.equal(level(5, stats([{ price: 5 }])), 'barato'); // día plano

// fecha de Madrid cuando UTC va por detrás
assert.deepEqual(madridNow(new Date('2026-11-13T23:30:00Z')), { date: '2026-11-14', hour: 0 });
assert.deepEqual(madridNow(new Date('2026-07-13T21:59:00Z')), { date: '2026-07-13', hour: 23 }); // verano +02
assert.equal(addDays('2026-11-30', 1), '2026-12-01');
assert.equal(addDays('2026-12-31', 1), '2027-01-01');
assert.equal(buildUrl('2026-11-07', '2026-11-14'),
  'https://apidatos.ree.es/es/datos/mercados/precios-mercados-tiempo-real?start_date=2026-11-07T00:00&end_date=2026-11-14T23:59&time_trunc=hour');
assert.equal(addDays('2026-11-14', -7), '2026-11-07');

// estimador: spot de mañana + (PVPC - spot) de hace 7 días, con media horaria de cuartos
const quarters = (date, f) => Array.from({ length: 96 }, (_, i) => ({
  value: f(Math.floor(i / 4), i % 4),
  datetime: `${date}T${String(Math.floor(i / 4)).padStart(2, '0')}:${String(i % 4 * 15).padStart(2, '0')}:00.000+01:00`,
}));
const full = (pvpcToday, pvpcRef, spotRef, spotTom) => ({ included: [
  { id: '1001', attributes: { values: [...pvpcRef, ...pvpcToday] } },
  { id: '600', attributes: { values: [...spotRef, ...spotTom] } },
] });
const ref = hours('2026-11-07', 24, '+01:00', 150);                    // PVPC hace 7 días: 150 + h
const spotRef = quarters('2026-11-07', (h) => 100 + h);                 // spot hace 7 días: 100 + h  -> peaje 50
const spotTom = quarters('2026-11-14', (h, q) => 80 + h + q);           // media horaria = 80 + h + 1.5
const est = parse(full(hours('2026-11-13', 24, '+01:00'), ref, spotRef, spotTom), '2026-11-13', '2026-11-14');
assert.equal(est.today.length, 24);                                     // 'hoy' sigue agrupado con el rango ampliado
assert.equal(est.today[0].hour, '00');
assert.deepEqual(est.tomorrow, []);
assert.equal(est.estimate.length, 24);
assert.equal(est.estimate[5].hour, '05');
assert.ok(Math.abs(est.estimate[5].price - toKwh(80 + 5 + 1.5 + 50)) < 1e-12);
assert.equal(est.estimate[0].t, Date.parse('2026-11-14T00:00:00+01:00'));
// con mañana oficial no hay estimación
const off = parse(full([...hours('2026-11-13', 24, '+01:00'), ...hours('2026-11-14', 24, '+01:00')], ref, spotRef, spotTom), '2026-11-13', '2026-11-14');
assert.deepEqual(off.estimate, []);
assert.equal(off.tomorrow.length, 24);
// falta una hora de referencia (PVPC hace 7 días), spot de mañana incompleto o sin serie 600 -> sin estimación parcial
const hoy = hours('2026-11-13', 24, '+01:00');
assert.deepEqual(parse(full(hoy, ref.slice(1), spotRef, spotTom), '2026-11-13', '2026-11-14').estimate, []);
assert.deepEqual(parse(full(hoy, ref, spotRef.slice(4), spotTom), '2026-11-13', '2026-11-14').estimate, []);
assert.deepEqual(parse(full(hoy, ref, spotRef, spotTom.slice(0, 50)), '2026-11-13', '2026-11-14').estimate, []);
assert.deepEqual(parse({ included: [{ id: '1001', attributes: { values: [...ref, ...hoy] } }] }, '2026-11-13', '2026-11-14').estimate, []);

// fecha de simulación y versión
assert.ok(isValidDate('2026-11-11'));
for (const bad of ['2026-02-30', '2026-13-01', '2026-1-1', 'hoy', '', null]) assert.ok(!isValidDate(bad), String(bad));
assert.equal(fmtDate('2026-11-13'), 'vie 13 nov');
assert.equal(fmtDate('2026-12-01'), 'mar 1 dic');
assert.deepEqual(['00', '09', '13', '23'].map(fmtRange), ['00-01', '09-10', '13-14', '23-24']);
assert.match(VERSION, /^\d+\.\d+\.\d+$/);

// periodos 2.0TD: miércoles 2026-11-11 en cada frontera
const wed = { 7: 'valle', 8: 'llano', 9: 'llano', 10: 'punta', 13: 'punta', 14: 'llano', 17: 'llano', 18: 'punta', 21: 'punta', 22: 'llano', 23: 'llano' };
for (const [h, p] of Object.entries(wed)) assert.equal(period('2026-11-11', h), p, 'hora ' + h);
assert.equal(period('2026-11-11', '00'), 'valle');
assert.equal(period('2026-11-11', '08'), 'llano'); // hora como texto del datetime
for (const h of [0, 12, 19, 23]) {
  assert.equal(period('2026-11-14', h), 'valle'); // sábado
  assert.equal(period('2026-11-15', h), 'valle'); // domingo
  assert.equal(period('2026-12-08', h), 'valle'); // martes festivo (Inmaculada)
}
assert.equal(period('2026-04-03', 12), 'punta'); // Viernes Santo: laborable normal
assert.equal(period('2027-01-01', 12), 'valle'); // festivo fijo otro año
// el día de la semana no depende de la zona horaria del proceso
for (const tz of ['Pacific/Kiritimati', 'America/Los_Angeles']) {
  process.env.TZ = tz;
  assert.equal(period('2026-11-14', 12), 'valle');
  assert.equal(period('2026-11-13', 12), 'punta');
}
delete process.env.TZ;

// calculadora de carga
const r2 = (x) => Math.round(x * 100) / 100;
assert.equal(r2(chargeKw(1, 16, 22).line), 3.68);
assert.equal(r2(chargeKw(1, 16, 22).kw), 3.68);
assert.equal(r2(chargeKw(3, 16, 22).kw), 11.09);
assert.equal(chargeKw(3, 16, 11).kw, 11);                 // limitada por la potencia máxima
assert.equal(chargeKw(1, 32, 7).kw, 7);
assert.ok(Math.abs(chargeEnergy(60, 20, 80, 1) - 36) < 1e-9);
assert.ok(Math.abs(chargeEnergy(60, 20, 80) - 40) < 1e-9); // 36 kWh / 0,9
const pr = [0.30, 0.10, 0.10, 0.20, 0.10, 0.10, 0.40];
assert.ok(Math.abs(chargeCost(pr, 1, 2.5, 2) - (0.10 * 2 + 0.10 * 2 + 0.20 * 2 * 0.5)) < 1e-12); // hora parcial
assert.equal(chargeCost(pr, 5, 2.5, 2), null);            // no cabe
assert.ok(Math.abs(chargeCost(pr, 4, 3, 1) - 0.60) < 1e-12);
assert.deepEqual(cheapestStart(pr, 2, 1), { start: 1, cost: 0.2 }); // empate 1-2 y 4-5 -> el primero
assert.equal(cheapestStart(pr, 2.5, 1).start, 1);         // 0,25 frente a 0,40 (desde 4)
assert.equal(cheapestStart(pr, 8, 1), null);
assert.ok(Math.abs(TAX - 1.27186363) < 1e-8);
assert.equal(fmtDuration(3.9), '3 h 54 min');
assert.equal(fmtDuration(0.5), '30 min');
assert.equal(fmtDuration(1), '1 h 0 min');
// coma flotante: 69 kWh 35->80 % a 10 A monofásica = 15.000000000000002 h -> 15 tramos y cabe justo
const hF = chargeEnergy(69, 35, 80) / chargeKw(1, 10, 22).kw;
assert.ok(hF > 15 && hF < 15 + 1e-9);
assert.equal(slotsNeeded(hF), 15);
assert.notEqual(chargeCost(Array(15).fill(0.1), 0, hF, 2.3), null);
// cheapestStart considera el último inicio válido
assert.deepEqual(cheapestStart([0.5, 0.5, 0.5, 0.1, 0.1], 2, 1), { start: 3, cost: 0.2 });
assert.equal(cheapestStart([0.3, 0.2, 0.1], 1, 1).start, 2);
// hora en curso parcial ("ahora"): 1,5 h con 0,25 disponible del tramo 0 -> 0,25·p0 + 1·p1 + 0,25·p2
const q = [0.4, 0.2, 0.1, 0.3];
assert.equal(chargeSlots(1.5, 0.25), 3);
assert.equal(chargeSlots(hF, 1), 15);                     // sin regresión de coma flotante
assert.equal(chargeSlots(0.2, 0.25), 1);
assert.ok(Math.abs(chargeCost(q, 0, 1.5, 2, 0.25) - 2 * (0.4 * 0.25 + 0.2 + 0.1 * 0.25)) < 1e-12);
assert.ok(Math.abs(chargeCost(q, 1, 1.5, 2, 0.25) - 2 * (0.2 + 0.1 * 0.5)) < 1e-12); // la fracción solo afecta al tramo 0
assert.ok(Math.abs(chargeCost(q, 0, 0.2, 1, 0.25) - 0.4 * 0.2) < 1e-12);
assert.notEqual(chargeCost(q, 0, 3.25, 1, 0.25), null);   // 0,25 + 3 horas: cabe justo
assert.equal(chargeCost(q, 0, 3.3, 1, 0.25), null);
assert.equal(chargeCost(q, 0, 1, 1, 0), null);
for (const bad of [0, -0.5, NaN]) {  // fracción no válida -> null
  assert.equal(chargeCost(q, 0, 1, 1, bad), null);
  assert.equal(cheapestStart(q, 1, 1, bad), null);
}
const cA = cheapestStart([0.05, 0.1, 0.3, 0.3], 1, 1, 0.5); // "ahora": 0,025 + 0,05 = 0,075 frente a 0,1 desde el tramo 1
assert.equal(cA.start, 0);
assert.ok(Math.abs(cA.cost - 0.075) < 1e-12);
assert.equal(cheapestStart([0.5, 0.3, 0.1, 0.1], 1, 1, 0.5).start, 2);
// horas o potencia no válidas -> null
for (const [h, k] of [[0, 2], [-1, 2], [NaN, 2], [2, 0], [2, NaN], [Infinity, 2]]) {
  assert.equal(chargeCost(pr, 0, h, k), null);
  assert.equal(cheapestStart(pr, h, k), null);
}

// --- carga con kW por tramo (P1/P2) ---
{
  const eq = (a, b) => Math.abs(a - b) < 1e-9;
  const pp = [0.1, 0.2, 0.3, 0.4];
  // 10 kWh a [2, 5, 5, 5]: tramo 0 -> 2 kWh (1 h), tramo 1 -> 5 kWh (1 h), tramo 2 -> 3 kWh (0,6 h)
  const a = chargePlan(pp, 0, 10, [2, 5, 5, 5]);
  assert.ok(eq(a.cost, 0.1 * 2 + 0.2 * 5 + 0.3 * 3) && eq(a.hours, 2.6) && a.slots === 3);
  // igual en todos los tramos = escalar = chargeCost/chargeSlots de siempre
  const s = chargePlan(pp, 1, 7, 4), v = chargePlan(pp, 1, 7, [4, 4, 4, 4]);
  assert.deepEqual(s, v);
  assert.ok(eq(s.cost, chargeCost(pp, 1, 7 / 4, 4)) && eq(s.hours, 1.75) && s.slots === chargeSlots(1.75));
  // firstFraction (mitad del tramo 0): 1 kWh del tramo 0 a 2 kW, resto 5 kWh a 5 kW
  const f = chargePlan(pp, 0, 6, [2, 5, 5, 5], 0.5);
  assert.ok(eq(f.cost, 0.1 * 1 + 0.2 * 5) && eq(f.hours, 1.5) && f.slots === 2);
  // no cabe / inválidos
  assert.equal(chargePlan(pp, 3, 5, 4), null);
  assert.equal(chargePlan(pp, 0, 5, [4, 0, 4, 4]), null);
  assert.equal(chargePlan(pp, 0, 5, NaN), null);
  assert.equal(chargePlan(pp, 0, 0, 4), null);
  // más potencia en los tramos 2-3 (valle) y mismo precio en ellos: gana un inicio allí (kW mayor, menos horas)
  const c = cheapestPlan([0.1, 0.3, 0.1, 0.1], 4, [2, 2, 8, 8]);
  assert.ok(c.start === 2 && eq(c.cost, 0.4) && eq(c.hours, 0.5));
  assert.equal(cheapestPlan(pp, 5, 1), null);
}

// --- solar ---
assert.equal(VERSION, '1.8.0');
assert.deepEqual([0, 1, 2, 3, 45, 48, 51, 67, 71, 77, 80, 82, 85, 86, 95, 99].map(weatherIcon),
  ['sun', 'sun', 'psun', 'cloud', 'cloud', 'cloud', 'rain', 'rain', 'cloud', 'cloud', 'rain', 'rain', 'cloud', 'cloud', 'rain', 'rain']);
assert.ok(forecastUrl(40.48, -3.36).includes('latitude=40.48&longitude=-3.36') && geoUrl('Alcalá').includes('name=Alcal%C3%A1'));
const hr = { time: [], shortwave_radiation: [], weather_code: [], is_day: [] };
for (const d of ['2026-03-28', '2026-03-29', '2026-03-30']) for (let h = 0; h < 24; h++) {
  if (d === '2026-03-29' && h === 2) continue;  // cambio de hora: Open-Meteo no tiene marca 02:00
  hr.time.push(`${d}T${String(h).padStart(2, '0')}:00`);
  hr.shortwave_radiation.push(h * 10 + (d === '2026-03-29' ? 1000 : 0));  // marca h -> h*10 (+1000 el día 29)
  hr.weather_code.push(h === 12 ? 61 : 0);
  hr.is_day.push(h >= 7 && h < 20 ? 1 : 0);
}
assert.equal(slotSolar(hr, '2026-03-28', 12).w, 130);  // tramo 12-13 -> marca 13:00 (media de 12 a 13)
assert.equal(slotSolar(hr, '2026-03-28', 12).icon, 'rain');  // icono: marca 12:00
assert.equal(slotSolar(hr, '2026-03-28', 23).w, 1000);  // 23-24 -> marca 00:00 del día siguiente
assert.equal(slotSolar(hr, '2026-03-29', 23).w, 0);
assert.equal(slotSolar(hr, '2026-03-29', 3).w, 1040);  // 03:00 existe aunque falte 02:00
assert.equal(slotSolar(hr, '2026-03-29', 2), null);  // sin marca 02:00 -> sin dato, no un desplazamiento
assert.equal(slotSolar(hr, '2026-03-30', 23), null);  // sin marca 00:00 del día 31
assert.equal(slotSolar(hr, '2026-04-30', 10), null);
assert.equal(slotSolar(hr, '2026-03-28', 3).day, false);
assert.equal(slotSolar(hr, '2026-03-28', 10).day, true);
// kWh: 3 kWp, (500 + 500) W/m² -> 1 kWh/m² x 3 x 0,8 = 2,4
const ws = [0, 0, 500, 500, 1000, 100, 0];
assert.ok(Math.abs(solarKwh(ws, 2, 2, 3) - 2.4) < 1e-9);
assert.ok(Math.abs(solarKwh(ws, 4, 1.5, 1) - (1000 + 50) / 1000 * 0.8) < 1e-9);  // último tramo parcial en proporción
assert.ok(Math.abs(solarKwh([1000, 1000], 0, 1.5, 1, 0.5) - (500 + 1000) / 1000 * 0.8) < 1e-9);  // "ahora": solo la fracción
assert.equal(solarKwh(ws, 6, 2, 3), null);
assert.equal(solarKwh(ws, 2, 2, 3, 1, 1), 1);  // tope = energía necesaria
assert.deepEqual(bestSolarStart(ws, 2, 3), { start: 3, kwh: (500 + 1000) / 1000 * 3 * 0.8 });
assert.equal(bestSolarStart(ws, 2, 3, 1, 1).start, 1);  // con tope, empate -> el más temprano
assert.equal(bestSolarStart(ws, 9, 3), null);
assert.ok(Math.abs(dailyKwhM2(20.88) - 5.8) < 1e-9);
assert.deepEqual(sunHours('2026-11-15T07:52', '2026-11-15T17:48'), [8, 18]);

console.log('OK: todas las comprobaciones pasan');
