'use strict';
/**
 * Сайт записи consulat.gouv.fr (движок TROOV): браузер, флоу до календаря, опрос слотов.
 * Что и почему так устроено — SITE.md.
 */

const fs = require('fs');
const { spawn } = require('child_process');
const { chromium } = require('patchright');
const { log, sleep } = require('./util');
const { PATHS, config } = require('./config');

const API = 'https://api.consulat.gouv.fr/';
const SERVICE_MATCH = /раткосрочные визы/i; // первая «K» на сайте латинская — ищем по середине слова
const SERVICE_NAME_FR = 'Visa de court séjour (sans installation en France)'; // так услуга называется в API

const SESSION_MAX_AGE_MS = 3 * 60_000; // сервер убивает сессию через 2–6 мин после создания
const NESTED_SIZE = '1280,900'; // размер окна Xephyr и Chrome в нём
const TURNSTILE_AUTO_MS = 60_000; // сколько ждём, что Turnstile пройдёт сам
const TURNSTILE_HUMAN_MS = 10 * 60_000; // сколько ждём человека, если не прошёл

class SessionExpired extends Error {}
class RateLimited extends Error {}

/**
 * Поднимает Xephyr — вложенный X-сервер в отдельном окне. Chrome внутри него не может
 * отобрать фокус у остального рабочего стола, а капчу по-прежнему можно пройти руками.
 */
async function nestedDisplay(display) {
  const socket = `/tmp/.X11-unix/X${display.replace(/^:/, '')}`;
  if (fs.existsSync(socket)) return; // уже запущен (например, остался с прошлого раза)
  const x = spawn('Xephyr', [display, '-screen', NESTED_SIZE.replace(',', 'x'), '-resizeable', '-no-host-grab', '-title', 'visa-monitor'], {
    stdio: 'ignore',
  });
  x.on('error', (e) => log('Xephyr не запустился:', e.message));
  process.on('exit', () => x.kill());
  for (let i = 0; i < 50 && !fs.existsSync(socket); i++) await sleep(100);
  if (!fs.existsSync(socket)) throw new Error(`Xephyr не поднялся на ${display}`);
}

async function launch() {
  // Из-под Wayland Chrome поднимает Qt-шим на wayland и падает — на Linux принудительно X11.
  const linux = process.platform === 'linux';
  const display = linux && config().nestedDisplay.replace(/^:?(?=.)/, ':'); // «99» и «:99» — одно и то же
  if (display) await nestedDisplay(display);
  const ctx = await chromium.launchPersistentContext(PATHS.profile, {
    channel: 'chrome', // настоящий Google Chrome, не bundled Chromium — его Turnstile не пускает
    headless: false,
    chromiumSandbox: true, // иначе Playwright добавляет --no-sandbox и Chrome показывает плашку-предупреждение
    viewport: null,
    // Во Xephyr нет оконного менеджера — размер и позицию окна задаём сами.
    args: linux ? ['--ozone-platform=x11', ...(display ? [`--window-size=${NESTED_SIZE}`, '--window-position=0,0'] : [])] : [],
    env: linux
      ? { ...process.env, XDG_SESSION_TYPE: 'x11', QT_QPA_PLATFORM: 'xcb', ...(display && { DISPLAY: display }) }
      : undefined,
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  return { ctx, page };
}

const turnstileToken = (page) =>
  page.evaluate(() => document.querySelector('[name="cf-turnstile-response"]')?.value || '').catch(() => '');

/** Кнопка входа активна сразу, а токен Turnstile появляется через пару секунд — ждём именно токен. */
async function waitTurnstile(page, onStuck) {
  for (const until = Date.now() + TURNSTILE_AUTO_MS; Date.now() < until; await sleep(1000)) {
    if (await turnstileToken(page)) return;
  }
  log('Turnstile не прошёл сам — жду человека');
  await onStuck?.(`🤖 Капча не проходит сама. Пройдите её в окне робота — жду ${TURNSTILE_HUMAN_MS / 60_000} мин.`);
  for (const until = Date.now() + TURNSTILE_HUMAN_MS; Date.now() < until; await sleep(2000)) {
    if (await turnstileToken(page)) return;
  }
  throw new Error('Turnstile так и не пройден');
}

/**
 * Проходит флоу записи до календаря и возвращает всё, что нужно для опроса:
 * служебные заголовки, запрос exclude-days, URL-шаблон availability (с sessionId), окно бронирования.
 * onStuck(text) — позвать человека, если Turnstile не проходит сам.
 */
async function openSession(page, cfg, onStuck) {
  const sess = { createdAt: 0, id: null, headers: null, excludeReq: null, availabilityUrl: null, interval: null };

  const onRequest = (r) => {
    const u = r.url();
    if (!u.startsWith(API)) return;
    const h = r.headers();
    if (h['x-gouv-app-id']) {
      sess.headers = { Accept: 'application/json', 'x-gouv-web': h['x-gouv-web'], 'x-gouv-app-id': h['x-gouv-app-id'] };
    }
    if (u.includes('/reservations/availability')) sess.availabilityUrl ??= u;
    if (u.includes('/reservations/exclude-days')) sess.excludeReq = { url: u, body: r.postData() };
  };
  const onResponse = async (r) => {
    if (r.url().includes('/reservations/get-interval')) sess.interval = await r.json().catch(() => null);
  };
  page.on('request', onRequest);
  page.on('response', onResponse);

  try {
    await page.goto(cfg.bookingUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    // Иначе фронт пытается продолжить протухшую сессию и застревает на CAPTCHA_FAILED.
    await page.evaluate(() => localStorage.removeItem('resa-sid'));
    await waitTurnstile(page, onStuck);

    const created = page.waitForResponse(
      (r) => r.url().endsWith('/reservations-session') && r.request().method() === 'POST',
      { timeout: 30_000 }
    );
    await page.getByRole('button', { name: /Доступ к услугам|Accéder aux services/i }).click();
    const res = await created;
    if (res.status() !== 200) {
      throw new Error(`сайт не создал сессию: ${res.status()} ${(await res.text().catch(() => '')).slice(0, 150)}`);
    }
    sess.createdAt = Date.now();
    sess.id = (await res.json())._id;
    await page.getByRole('button', { name: /^(Нет|Non|No)$/ }).click({ timeout: 2000 }).catch(() => {});

    // Шаг 1 — услуга. Один человек на запись: с двумя сайт не пускает к календарю.
    const row = page.locator('.service-applicant').filter({ hasText: SERVICE_MATCH }).first();
    await row.waitFor({ state: 'visible', timeout: 30_000 });
    await row.getByRole('button', { name: /Больше|Plus|More/i }).click();
    await sleep(400);
    await page.getByRole('button', { name: /Подтвердить|Valider|Confirm/i }).click();

    // Шаг 2 — «Важная информация»: галочка + переход к слотам.
    const cb = page.locator('input[type="checkbox"]').first();
    await cb.waitFor({ state: 'attached', timeout: 30_000 });
    await sleep(400);
    await cb.check({ force: true }).catch(() => cb.click({ force: true }));
    await page.getByRole('button', { name: /Назначить встречу|Prendre rendez-vous/i }).click();

    // Календарь загружен, когда ушёл exclude-days. Availability сайт запрашивает только если
    // где-то есть места — иначе собираем URL сами по образцу.
    for (const until = Date.now() + 30_000; !(sess.excludeReq && sess.interval) && Date.now() < until; ) await sleep(300);
    if (!sess.excludeReq || !sess.headers || !sess.interval || !sess.id) {
      throw new Error('календарь не загрузился — возможно, поменялся флоу');
    }
    await sleep(1000);
    sess.availabilityUrl ??=
      sess.excludeReq.url.replace(/exclude-days.*$/, 'availability?') +
      new URLSearchParams({ name: SERVICE_NAME_FR, date: '', places: 1, matching: '', maxCapacity: 1, sessionId: sess.id });
    log(`сессия получена, окно бронирования ${sess.interval.start} … ${sess.interval.end}`);
    return sess;
  } finally {
    page.off('request', onRequest);
    page.off('response', onResponse);
  }
}

const sessionFresh = (sess) => sess && Date.now() - sess.createdAt < SESSION_MAX_AGE_MS;

/**
 * Один круг опроса из контекста страницы. exclude-days одним запросом отдаёт все дни окна без мест
 * (им сайт красит календарь), availability дёргаем только по остальным дням диапазона.
 */
async function scan(page, sess, cfg) {
  const from = cfg.dateFrom > sess.interval.start ? cfg.dateFrom : sess.interval.start;
  const to = cfg.dateTo < sess.interval.end ? cfg.dateTo : sess.interval.end;

  const t0 = Date.now();
  const res = await page.evaluate(
    async ({ availabilityUrl, excludeReq, headers, from, to, delay }) => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const fail = (status, body) => ({ error: { status, body: body.slice(0, 200) } });

      const ex = await fetch(excludeReq.url, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: excludeReq.body,
      });
      const exBody = await ex.text();
      if (ex.status !== 200) return fail(ex.status, exBody);
      const excluded = new Set(JSON.parse(exBody));

      const dates = [];
      for (let d = new Date(from + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
        const iso = d.toISOString().slice(0, 10);
        if (!excluded.has(iso)) dates.push(iso);
      }

      const out = [];
      let retries = 0;
      for (let i = 0; i < dates.length; ) {
        const date = dates[i];
        const u = new URL(availabilityUrl);
        u.searchParams.set('date', date);
        const r = await fetch(u, { headers });
        const body = await r.text();
        // Пропущенный из-за лимита день нельзя считать «мест нет» — повторяем его же, потом сдаёмся.
        if (r.status === 429) {
          if (++retries > 3) return fail(429, body);
          await wait(5000 * 2 ** (retries - 1));
          continue;
        }
        if (r.status !== 200) return fail(r.status, body);
        const slots = JSON.parse(body);
        if (slots.length) out.push({ date, times: slots.map((s) => s.time) });
        retries = 0;
        i++;
        await wait(delay);
      }
      return { out, checked: dates.length };
    },
    {
      availabilityUrl: sess.availabilityUrl,
      excludeReq: sess.excludeReq,
      headers: sess.headers,
      from,
      to,
      delay: cfg.requestDelayMs,
    }
  );

  if (res.error) {
    const { status, body } = res.error;
    if (status === 404 || status === 418 || /SESSION_|SessionError/.test(body)) throw new SessionExpired(body);
    if (status === 429) throw new RateLimited('сайт ограничил частоту запросов (429), круг пропущен');
    throw new Error(`API ответил ${status}: ${body}`);
  }
  log(`проверено дней с местами: ${res.checked} за ${((Date.now() - t0) / 1000).toFixed(1)} с`);
  return { found: res.out, from, to };
}

module.exports = { launch, openSession, waitTurnstile, sessionFresh, scan, SessionExpired, RateLimited };
