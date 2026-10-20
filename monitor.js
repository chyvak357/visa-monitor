#!/usr/bin/env node
/**
 * Монитор слотов на визу — Посольство Франции в Тбилиси (consulat.gouv.fr, движок TROOV).
 *
 * Держит настоящий Google Chrome (через Patchright) с отдельным профилем .browser-profile/,
 * сам проходит флоу записи до календаря (Turnstile в таком браузере проходит сам),
 * опрашивает слоты по датам из .env и шлёт новые в Telegram — владельцу и одобренным подписчикам.
 * Если заполнен people.json, в алертах есть кнопки «записать такого-то на этот слот».
 *
 *   npm run setup           # первый запуск: подключить бота, выбрать даты
 *   npm start               # мониторинг
 *   npm start -- --once     # один проход: результат в консоль, без Telegram
 *
 * Настройки — .env (перечитывается на каждом круге, перезапуск не нужен), см. .env.example.
 */
'use strict';

const { log, esc, fmtDay } = require('./src/util');
const { config } = require('./src/config');
const { Bot } = require('./src/telegram');
const { launch, openSession, sessionFresh, scan, SessionExpired, RateLimited } = require('./src/site');
const { loadPeople, book, fillAndConfirm, SlotGone } = require('./src/booking');
const { record } = require('./src/stats');

const FAILS_BEFORE_ALERT = 3; // ошибок подряд до уведомления владельцу
const REALERT_MS = 30 * 60_000; // не напоминать про тот же слот чаще
const MAX_SLOT_BUTTONS = 24; // кнопок «записать» в одном алерте
const POLL_SPEEDUP = 0.85; // после удачного круга интервал опроса × столько, пока не дойдёт до POLL_MIN_SECONDS
const POLL_FLOOR_AFTER_429 = 1.5; // упёрлись в 429 — ниже «интервал × столько» до перезапуска не опускаемся
const CODE_WAIT_MS = 10 * 60_000; // сколько ждать код из письма

const ONCE = process.argv.includes('--once');

const daysLines = (found) => found.map((f) => `${fmtDay(f.date)}: ${f.times.join(', ')}`);
const hhmm = (t) => new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
// В callback_data двоеточие — разделитель, поэтому время кодируем без него: '10:50' ↔ '1050'.
const packTime = (t) => t.replace(':', '');
const unpackTime = (s) => `${s.slice(0, 2)}:${s.slice(2)}`;

function slotsMessage(fresh, found, from, to, cfg) {
  const byDay = new Map();
  for (const key of fresh) {
    const [date, time] = key.split(' ');
    byDay.set(date, [...(byDay.get(date) || []), time]);
  }
  const freshFound = [...byDay].sort().map(([date, times]) => ({ date, times }));
  const total = found.reduce((n, f) => n + f.times.length, 0);

  let msg = `🇫🇷 <b>Новые слоты на визу — Тбилиси</b>\n\n${daysLines(freshFound).join('\n')}`;
  if (total > fresh.length) {
    msg += `\n\n<b>Всего открыто ${fmtDay(from)} – ${fmtDay(to)}:</b>\n${daysLines(found).join('\n')}`;
  }
  msg += `\n\n<a href="${cfg.bookingUrl}">Записаться</a>`;
  if (cfg.holdMin > 0) msg += `\n🪟 Окно робота держит календарь ${cfg.holdMin} мин — можно бронировать прямо в нём.`;
  return msg;
}

/** По кнопке на каждый новый слот, по три в ряд. */
function slotButtons(fresh) {
  const keys = [...fresh].sort().slice(0, MAX_SLOT_BUTTONS);
  const rows = [];
  for (let i = 0; i < keys.length; i += 3) {
    rows.push(
      keys.slice(i, i + 3).map((k) => {
        const [date, time] = k.split(' ');
        return [`${date.slice(8)}.${date.slice(5, 7)} ${time}`, `slot:${date}:${packTime(time)}`];
      })
    );
  }
  return rows;
}

async function main() {
  let cfg = config();
  const bot = new Bot(ONCE ? '' : cfg.tgToken, cfg.tgChatId);
  if (!ONCE && !bot.enabled) log('Telegram не настроен — алерты будут только в консоли. Запустите: npm run setup');

  // Что показывать по /status.
  const status = { startedAt: Date.now(), lastCheck: 0, found: [], fails: 0, lastError: '', holdUntil: 0 };
  const booked = new Map(); // имя → слот, записанный в этом запуске (защита от двойной записи)

  // Адаптивный интервал опроса: от POLL_SECONDS спускается к POLL_MIN_SECONDS, на 429 откатывается назад.
  const pace = { sec: cfg.pollSec, floor: 0 };
  const clampPace = (sec) => Math.min(cfg.pollSec, Math.max(cfg.pollMinSec, pace.floor, sec));

  bot.statusText = () => {
    const lines = [`Диапазон: ${fmtDay(cfg.dateFrom)} – ${fmtDay(cfg.dateTo)}, опрос ~${Math.round(pace.sec)} с`];
    if (status.holdUntil > Date.now()) lines.push(`🪟 Окно держится для брони до ${hhmm(status.holdUntil)}`);
    if (!status.lastCheck) lines.push('Ещё ни одной проверки');
    else {
      lines.push(`Последняя проверка: ${hhmm(status.lastCheck)}`);
      lines.push(status.found.length ? `Открыто:\n${daysLines(status.found).join('\n')}` : 'Слотов в диапазоне нет');
    }
    if (status.fails) lines.push(`⚠️ Ошибок подряд: ${status.fails} — ${esc(status.lastError)}`);
    const people = loadPeople();
    lines.push(
      people.length
        ? `Автозапись: ${people.map((p) => esc(p.name)).join(', ')}${cfg.bookingDryRun ? ' (пробный режим)' : ''}`
        : 'Автозапись выключена — нет people.json'
    );
    for (const [name, slot] of booked) lines.push(`✅ ${esc(name)} записан: ${slot}`);
    return `${status.fails ? '🟡' : '🟢'} <b>Мониторинг работает</b> с ${hhmm(status.startedAt)}\n${lines.join('\n')}`;
  };

  const browser = await launch();
  let stopping = false;
  browser.onClosed = () => {
    if (stopping) return;
    log('окно браузера закрыто — выхожу');
    record('stop', { reason: 'browser closed' });
    process.exit(1);
  };
  process.on('SIGINT', async () => {
    log('остановка');
    record('stop', { reason: 'SIGINT' });
    stopping = true;
    await browser.close();
    process.exit(0);
  });

  const callHuman = (text) => bot.screenToOwner(browser.page, text);
  let sess = null;

  // ─── Запись по кнопкам из Telegram ────────────────────────────────────────
  // Запросы встают в очередь; главный цикл берёт их первыми и просыпается ради них раньше срока.

  const jobs = [];
  let wake = () => {};
  const nap = (ms) =>
    new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(t);
        resolve();
      };
    });
  const enqueue = (job) => {
    jobs.push(job);
    wake();
  };

  bot.callback('slot', async (q, [date, hm]) => {
    await bot.answer(q.id);
    const people = loadPeople();
    if (!people.length) return bot.send(q.message.chat.id, 'Автозапись выключена: заполните people.json.');
    const rows = people.map((p, i) => [[p.name, `book:${date}:${hm}:${i}`]]);
    if (people.length > 1) rows.push([['👥 Всех по порядку', `book:${date}:${hm}:all`]]);
    await bot.send(q.message.chat.id, `Кого записать на <b>${fmtDay(date)} ${unpackTime(hm)}</b>?`, { buttons: rows });
  });

  bot.callback('book', async (q, [date, hm, who]) => {
    const people = loadPeople();
    const persons = who === 'all' ? people : [people[Number(who)]].filter(Boolean);
    if (!persons.length) return bot.answer(q.id, 'Не нашёл человека в people.json');
    await bot.answer(q.id, 'Принято');
    const names = persons.map((p) => esc(p.name)).join(', ');
    await bot.edit(q.message.chat.id, q.message.message_id, `⏳ Записываю ${names} на ${fmtDay(date)} ${unpackTime(hm)}…`);
    enqueue({ type: 'book', chatId: String(q.message.chat.id), date, time: unpackTime(hm), persons, all: who === 'all' });
  });

  bot.callback('fill', async (q, [idx, date, hm]) => {
    const person = loadPeople()[Number(idx)];
    if (!person) return bot.answer(q.id, 'Не нашёл человека в people.json');
    await bot.answer(q.id, 'Принято');
    await bot.edit(q.message.chat.id, q.message.message_id, `⏳ Дозаполняю форму за ${esc(person.name)}…`);
    const slot = date && hm ? { date, time: unpackTime(hm) } : null;
    enqueue({ type: 'fill', chatId: String(q.message.chat.id), persons: [person], slot });
  });

  // Код из письма: ждём следующее сообщение из того чата, откуда пришла запись.
  let codeWaiter = null;
  bot.onText = async (m) => {
    if (!codeWaiter || String(m.chat.id) !== codeWaiter.chatId) return false;
    codeWaiter.resolve(m.text.trim());
    return true;
  };
  const askCode = (chatId) => async () => {
    await bot.send(chatId, `📧 Сайт просит код подтверждения из письма — пришлите его сюда (жду ${CODE_WAIT_MS / 60_000} мин).`);
    return new Promise((resolve) => {
      const t = setTimeout(() => codeWaiter?.resolve(null), CODE_WAIT_MS);
      codeWaiter = {
        chatId,
        resolve: (code) => {
          clearTimeout(t);
          codeWaiter = null;
          resolve(code);
        },
      };
    });
  };

  async function runJob(job) {
    cfg = config();
    const notify = async (text) => {
      const png = await browser.page.screenshot().catch(() => null);
      for (const id of new Set([job.chatId, bot.ownerId])) await bot.sendPhoto(id, png, text);
    };
    const opts = { dryRun: cfg.bookingDryRun, onStuck: callHuman, askCode: askCode(job.chatId) };
    // Окно уже стоит на календаре, где нашлись слоты, — первого человека записываем прямо в нём.
    let calendar = sess;

    // «Всех по порядку»: выбранный слот и следующие за ним из последней проверки.
    const chosen = `${job.date} ${job.time}`;
    const queue = [chosen];
    if (job.all) {
      for (const f of status.found) for (const t of f.times) if (`${f.date} ${t}` > chosen) queue.push(`${f.date} ${t}`);
    }

    for (const person of job.persons) {
      if (booked.has(person.name)) {
        await bot.send(job.chatId, `ℹ️ ${esc(person.name)} уже записан в этом запуске: ${booked.get(person.name)}`);
        continue;
      }
      try {
        let slot = job.slot ? `${fmtDay(job.slot.date)} ${job.slot.time}` : 'слот, выбранный в окне';
        let res;
        if (job.type === 'fill') {
          record('book', { ...job.slot, dry: cfg.bookingDryRun });
          res = await fillAndConfirm(browser, cfg, person, job.slot, opts);
        }
        else {
          for (;;) {
            const key = queue.shift();
            if (!key) throw new SlotGone('свободных слотов не осталось');
            const [date, time] = key.split(' ');
            const sess = calendar;
            calendar = null; // дальше окно уйдёт с календаря
            try {
              record('book', { date, time, dry: cfg.bookingDryRun });
              res = await book(browser, cfg, person, date, time, { ...opts, sess });
              slot = `${fmtDay(date)} ${time}`;
              break;
            } catch (e) {
              if (!(e instanceof SlotGone) || !job.all) throw e;
              log(`${e.message} — пробую следующий`);
            }
          }
        }
        if (res.dry) {
          await notify(`🧪 Пробный прогон: ${person.name} → ${slot}. Форма заполнена, «Подтвердить» не нажата (BOOKING_DRY_RUN=1).`);
        } else {
          booked.set(person.name, slot);
          await notify(`✅ ${person.name}: запись на ${slot} отправлена. Проверьте почту ${person.email}.`);
        }
      } catch (e) {
        log(`запись ${person.name} не удалась:`, e.message);
        await notify(`❌ Не удалось записать ${person.name}: ${e.message}`);
      }
    }
    sess = null; // страница ушла с календаря — для опроса нужна новая сессия
  }

  /** Держим окно на календаре; если человек сам выбрал время — предлагаем дозаполнить форму. */
  async function holdWindow() {
    sess = await openSession(browser, cfg, callHuman).catch((e) => log('не удалось открыть календарь для брони:', e.message));
    const page = browser.page;
    await page.bringToFront().catch(() => {});
    status.holdUntil = Date.now() + cfg.holdMin * 60_000;
    log(`держу окно ${cfg.holdMin} мин`);
    record('hold', { min: cfg.holdMin });

    const people = loadPeople();
    const onRequest = (r) => {
      if (!people.length || !r.url().includes('/update-step-value')) return;
      let body;
      try {
        body = JSON.parse(r.postData() || '');
      } catch {
        return;
      }
      const [date, slots] = Object.entries(body.value?.slots || {})[0] || [];
      if (body.key !== 'slotsStep' || !slots?.length) return;
      bot.toOwner(`🖱 В окне выбран слот <b>${fmtDay(date)} ${slots[0].time}</b>. За кого заполнить форму?`, {
        buttons: [people.map((p, i) => [p.name, `fill:${i}:${date}:${packTime(slots[0].time)}`])],
      });
    };
    page.on('request', onRequest);
    try {
      while (Date.now() < status.holdUntil && !jobs.length) await nap(status.holdUntil - Date.now());
    } finally {
      page.off('request', onRequest);
      status.holdUntil = 0;
      // Пришла запись — она продолжит в этом же календаре; иначе для опроса нужна новая сессия.
      if (!jobs.length) sess = null;
    }
  }

  // ─── Главный цикл ─────────────────────────────────────────────────────────

  bot.start();
  log(`старт: ${cfg.dateFrom} … ${cfg.dateTo}, опрос ${cfg.pollMinSec < cfg.pollSec ? `${cfg.pollSec} → ${cfg.pollMinSec}` : `~${cfg.pollSec}`} с`);
  record('start', { range: [cfg.dateFrom, cfg.dateTo], pollSec: cfg.pollSec, pollMinSec: cfg.pollMinSec });
  if (!ONCE) {
    const people = loadPeople();
    await bot.toOwner(
      `🟢 Мониторинг слотов запущен\nДиапазон: ${fmtDay(cfg.dateFrom)} – ${fmtDay(cfg.dateTo)}\n` +
        `Подписчиков: ${bot.subs.approved.length}. Автозапись: ${people.length ? people.map((p) => esc(p.name)).join(', ') : 'выключена'}` +
        `${people.length && cfg.bookingDryRun ? ' (пробный режим)' : ''}\n/status — что происходит`
    );
  }

  let failAlerted = false;
  let prev = null; // ключи «дата время» с прошлого круга; null — кругов ещё не было
  const alertedAt = new Map(); // ключ слота → когда о нём последний раз писали

  for (;;) {
    while (jobs.length) await runJob(jobs.shift());

    try {
      cfg = config();
      if (!sessionFresh(sess)) sess = await openSession(browser, cfg, callHuman);

      let result;
      try {
        result = await scan(browser.page, sess, cfg);
      } catch (e) {
        if (!(e instanceof SessionExpired)) throw e;
        const age = Math.round((Date.now() - sess.createdAt) / 1000);
        log(`сессия умерла раньше срока (${age} с) — пересоздаю`);
        record('expired', { age });
        sess = await openSession(browser, cfg, callHuman);
        result = await scan(browser.page, sess, cfg);
      }
      const { found, from, to } = result;
      const sessAge = Math.round((Date.now() - sess.createdAt) / 1000);
      record('scan', { ...result.obs, sessAge, pollSec: Math.round(pace.sec) });
      pace.sec = clampPace(pace.sec * POLL_SPEEDUP);

      if (failAlerted) await bot.toOwner('✅ Мониторинг снова работает');
      Object.assign(status, { lastCheck: Date.now(), found, fails: 0, lastError: '' });
      failAlerted = false;

      log(found.length ? `открыто:\n  ${daysLines(found).join('\n  ')}` : `в ${from} … ${to} слотов нет`);

      const current = new Set(found.flatMap((f) => f.times.map((t) => `${f.date} ${t}`)));
      const now = Date.now();
      const fresh = [...current].filter(
        (k) => (prev === null || !prev.has(k)) && now - (alertedAt.get(k) || 0) > REALERT_MS
      );
      prev = current;

      if (fresh.length && !ONCE) {
        fresh.forEach((k) => alertedAt.set(k, now));
        const buttons = loadPeople().length ? slotButtons(fresh) : undefined;
        await bot.broadcast(slotsMessage(fresh, found, from, to, cfg), { buttons });
        if (cfg.holdMin > 0 && !jobs.length) await holdWindow();
      }
    } catch (e) {
      if (stopping) break;
      const rateLimited = e instanceof RateLimited;
      if (!rateLimited) sess = null; // при 429 новая сессия — только лишние запросы
      const msg = e.message.split('\n')[0];
      Object.assign(status, { fails: status.fails + 1, lastError: msg });
      log(`ошибка (${status.fails} подряд): ${msg}`);
      record('fail', { error: msg, ...(rateLimited && { rateLimited, pollSec: Math.round(pace.sec) }) });
      if (rateLimited) {
        log(`429 на интервале ~${Math.round(pace.sec)} с — откат к ${cfg.pollSec} с`);
        pace.floor = Math.min(cfg.pollSec, pace.sec * POLL_FLOOR_AFTER_429);
        pace.sec = cfg.pollSec;
      }
      if (status.fails >= FAILS_BEFORE_ALERT && !failAlerted && !ONCE) {
        failAlerted = true;
        await callHuman(`⚠️ ${status.fails} раз подряд не получается проверить слоты:\n${msg}`);
      }
    }

    if (ONCE) break;
    pace.sec = clampPace(pace.sec); // .env могли поменять на ходу
    if (!jobs.length) await nap(pace.sec * 1000 * (0.8 + Math.random() * 0.4));
  }

  stopping = true;
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
