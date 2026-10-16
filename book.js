#!/usr/bin/env node
/**
 * Запись из консоли — в первую очередь чтобы проверить people.json пробным прогоном:
 *
 *   npm run book -- --person 1 --date 2026-12-28 --time 09:30          # всё заполнить, НЕ подтверждать
 *   npm run book -- --person 1 --date 2026-12-28 --time 09:30 --real   # записать по-настоящему
 *
 * Монитор на это время должен быть остановлен (один профиль Chrome).
 */
'use strict';

const { log, sleep } = require('./src/util');
const { config } = require('./src/config');
const { launch } = require('./src/site');
const { loadPeople, book } = require('./src/booking');

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

(async () => {
  const people = loadPeople();
  const n = Number(arg('person'));
  const [date, time] = [arg('date'), arg('time')];
  if (!people[n - 1] || !/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !/^\d{2}:\d{2}$/.test(time || '')) {
    console.log('Использование: npm run book -- --person N --date ГГГГ-ММ-ДД --time ЧЧ:ММ [--real]');
    console.log('Люди из people.json:', people.map((p, i) => `${i + 1} — ${p.name}`).join(', ') || 'нет');
    process.exit(1);
  }
  const dryRun = !process.argv.includes('--real');
  const browser = await launch();
  try {
    const res = await book(browser, config(), people[n - 1], date, time, { dryRun });
    log(res.dry ? 'пробный прогон: всё заполнено, «Подтвердить» не нажата — посмотрите на окно' : 'запись отправлена');
    await sleep(dryRun ? 60_000 : 10_000);
  } catch (e) {
    log('не вышло:', e.message);
    await sleep(30_000);
  } finally {
    await browser.close();
  }
})();
