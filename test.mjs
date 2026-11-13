import assert from 'node:assert/strict';
import { VERSION, madridNow, addDays, isValidDate, buildUrl, toKwh, parse, currentIndex, stats, level, fmt } from './pvpc.js';

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
assert.deepEqual(s.cheapest, [0, 1, 2]);
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
assert.match(VERSION, /^\d+\.\d+\.\d+$/);

console.log('OK: todas las comprobaciones pasan');
