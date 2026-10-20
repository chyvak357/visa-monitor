'use strict';

/**
 * Журнал наблюдений для будущей статистики — data/observations.jsonl, по строке JSON на событие:
 *   start / stop      — монитор запущен / остановлен (между ними и вне сканов мы не смотрели)
 *   scan              — успешный круг: окно, все дни окна без мест, время с capacity по дням из timed,
 *                       sessAge — возраст сессии, с; pollSec — интервал опроса перед этим кругом
 *   fail              — круг не удался (капча, 429, сессия) — пробел в наблюдениях; rateLimited — это 429
 *   expired           — сессия умерла раньше, чем мы её сами сменили; age — её возраст, с
 *   book / hold       — наши собственные действия, которые сами прячут слоты от сайта
 * Время ts — UTC.
 */
const fs = require('fs');
const path = require('path');
const { log } = require('./util');

const FILE = path.join(__dirname, '..', 'data', 'observations.jsonl');
let warned = false;

function record(ev, data = {}) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.appendFileSync(FILE, JSON.stringify({ ts: new Date().toISOString(), ev, ...data }) + '\n');
  } catch (e) {
    if (!warned) log('не удалось записать статистику:', e.message);
    warned = true;
  }
}

module.exports = { record };
