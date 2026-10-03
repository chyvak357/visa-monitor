'use strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toLocaleString('sv-SE')}]`, ...a);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const today = () => new Date().toLocaleDateString('sv-SE');
const addDays = (iso, n) => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
// '2026-10-05' → 'пн, 05.10'
const fmtDay = (iso) =>
  new Date(iso + 'T00:00:00Z').toLocaleDateString('ru-RU', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    timeZone: 'UTC',
  });

module.exports = { sleep, log, esc, isoDate, today, addDays, fmtDay };
