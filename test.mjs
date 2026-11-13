import assert from 'node:assert/strict';
import { madridNow, addDays, buildUrl, toKwh, parse, currentIndex, stats, level, fmt } from './pvpc.js';

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
assert.equal(buildUrl('2026-11-13', '2026-11-14'),
  'https://apidatos.ree.es/es/datos/mercados/precios-mercados-tiempo-real?start_date=2026-11-13T00:00&end_date=2026-11-14T23:59&time_trunc=hour');

console.log('OK: todas las comprobaciones pasan');
