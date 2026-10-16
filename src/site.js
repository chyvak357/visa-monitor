'use strict';
/**
 * Сайт записи consulat.gouv.fr (движок TROOV): браузер, флоу до календаря, опрос слотов.
 * Что и почему так устроено — SITE.md.
 */

const fs = require('fs');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const { chromium } = require('patchright');
const { log, sleep } = require('./util');
const { PATHS, config } = require('./config');

const API = 'https://api.consulat.gouv.fr/';
const SERVICE_MATCH = /раткосрочные визы/i; // первая «K» на сайте латинская — ищем по середине слова
const SERVICE_NAME_FR = 'Visa de court séjour (sans installation en France)'; // так услуга называется в API

const SESSION_MAX_AGE_MS = 3 * 60_000; // сервер убивает сессию через 2–6 мин после создания
const NESTED_SIZE = '1280,900'; // размер окна Xephyr и Chrome в нём
const TURNSTILE_AUTO_MS = 60_000; // сколько ждём, что Turnstile пройдёт сам
const TURNSTILE_RESET_MS = 20_000; // пока ждём сами — так часто перезапускаем зависший виджет
const TURNSTILE_HUMAN_MS = 2 * 60_000; // сколько ждём человека, потом перезапускаем браузер
const TURNSTILE_RESTARTS = 3; // перезапусков браузера подряд, если капча так и не проходит
const CLICK_FIRST_MS = 4_000; // автоклик: сначала даём Turnstile шанс пройти без клика
const CLICK_RETRY_MS = 15_000; // автоклик: столько ждём токен после клика, прежде чем кликнуть снова

class SessionExpired extends Error {}
class RateLimited extends Error {}
class CaptchaStuck extends Error {}

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

/** «99» и «:99» — одно и то же; пусто — Chrome на основном рабочем столе. */
const nestedDisplayName = () => process.platform === 'linux' && config().nestedDisplay.replace(/^:?(?=.)/, ':');

async function launchChrome() {
  // Из-под Wayland Chrome поднимает Qt-шим на wayland и падает — на Linux принудительно X11.
  const linux = process.platform === 'linux';
  const display = nestedDisplayName();
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

/**
 * Окно робота. Его можно перезапустить (застрявшая капча после перезапуска часто проходит сама),
 * поэтому ctx и page берём из этого объекта каждый раз заново, а не запоминаем.
 */
class Browser {
  onClosed = null; // окно закрыли не мы

  async start() {
    const { ctx, page } = await launchChrome();
    Object.assign(this, { ctx, page });
    ctx.on('close', () => this.ctx === ctx && this.onClosed?.());
    return this;
  }

  async restart() {
    await this.close();
    await this.start();
  }

  async close() {
    const ctx = this.ctx;
    this.ctx = null;
    await ctx?.close().catch(() => {});
  }
}

const launch = () => new Browser().start();

/** fn() с перезапуском браузера, если в нём застряла капча. onRestart() — перед каждым перезапуском. */
async function retryCaptcha(browser, fn, onRestart) {
  for (let restarts = 0; ; restarts++) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof CaptchaStuck)) throw e;
      if (restarts >= TURNSTILE_RESTARTS) throw new Error(`капча не пройдена и после ${restarts} перезапусков браузера`);
      log('капча не пройдена — перезапускаю браузер');
      onRestart?.();
      await browser.restart();
    }
  }
}

const turnstileToken = (page) =>
  page.evaluate(() => document.querySelector('[name="cf-turnstile-response"]')?.value || '').catch(() => '');

/**
 * Новая попытка капчи без перезагрузки страницы — заполненная форма и выбранный слот остаются.
 * window.turnstile есть только в мире страницы, а Patchright по умолчанию выполняет код в изолированном.
 */
const resetTurnstile = (page) =>
  page
    .evaluate(
      () => {
        const box = document.querySelector('[name="cf-turnstile-response"]')?.parentElement;
        try {
          window.turnstile?.reset(box);
        } catch {
          window.turnstile?.reset();
        }
      },
      undefined,
      undefined,
      false
    )
    .catch((e) => log('не смог перезапустить капчу:', e.message));

/**
 * Где на странице галочка Turnstile — точка во вьюпорте (CSS-пиксели), null — виджета не видно.
 * Сама галочка лежит в закрытом shadow DOM внутри iframe и появляется через несколько секунд после
 * виджета. guess — галочку так и не нашли: бьём в левую часть виджета, там она у стандартного Turnstile 300×65.
 */
async function turnstileCheckbox(page, guess) {
  // На сайте виджет стоит у нижнего края и в окно Xephyr не помещается — клик ушёл бы за экран.
  const box = await page
    .evaluate(() => {
      const el = document.querySelector('[name="cf-turnstile-response"]')?.parentElement;
      if (!el) return null;
      let r = el.getBoundingClientRect();
      if (r.top < 0 || r.bottom > innerHeight) {
        el.scrollIntoView({ block: 'center' });
        r = el.getBoundingClientRect();
      }
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })
    .catch(() => null);
  const frame = page.frames().find((f) => f.url().includes('challenges.cloudflare.com'));
  const cb = await frame?.locator('input[type="checkbox"]').first().boundingBox({ timeout: 500 }).catch(() => null);
  // Невидимый input растянут на всю подпись — человек же жмёт в квадратик слева.
  if (cb) return { x: cb.x + Math.min(cb.width, 24) / 2, y: cb.y + cb.height / 2 };
  if (!guess || !box || box.width < 100 || box.height < 30) return null;
  return { x: box.x + Math.min(30, box.width / 10), y: box.y + box.height / 2 };
}

const run = promisify(execFile);
let noXdotool = false;

/**
 * Настоящий клик мышью в X-сервере Xephyr: плавно ведём его курсор к точке и жмём.
 * Реальный курсор на рабочем столе не трогается — у Xephyr свой.
 */
async function xClick(page, display, p) {
  const env = { ...process.env, DISPLAY: display };
  // Во Xephyr нет оконного менеджера и рамок: вьюпорт сдвинут от угла экрана только на панели Chrome.
  const win = await page.evaluate(() => ({
    x: screenX + (outerWidth - innerWidth) / 2,
    y: screenY + outerHeight - innerHeight,
    k: devicePixelRatio,
  }));
  const to = { x: Math.round((win.x + p.x) * win.k), y: Math.round((win.y + p.y) * win.k) };
  const { stdout } = await run('xdotool', ['getmouselocation', '--shell'], { env });
  const from = { x: Number(/X=(\d+)/.exec(stdout)?.[1] ?? 0), y: Number(/Y=(\d+)/.exec(stdout)?.[1] ?? 0) };

  const args = [];
  const steps = 15 + Math.floor(Math.random() * 10);
  const bend = (Math.random() - 0.5) * 80; // путь дугой, а не по линейке
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const e = t * t * (3 - 2 * t); // разгон и торможение
    const arc = Math.sin(Math.PI * t) * bend;
    const x = from.x + (to.x - from.x) * e + arc * 0.3;
    const y = from.y + (to.y - from.y) * e + arc;
    args.push('mousemove', String(Math.round(x)), String(Math.round(y)), 'sleep', (0.01 + Math.random() * 0.02).toFixed(3));
  }
  args.push('mousemove', String(to.x), String(to.y), 'sleep', (0.1 + Math.random() * 0.2).toFixed(3), 'click', '1');
  await run('xdotool', args, { env });
}

/** Кликает по галочке Turnstile. false — галочки пока не видно, кликать некуда. */
async function clickTurnstile(page, guess) {
  const p = await turnstileCheckbox(page, guess);
  if (!p) return false;
  p.x += (Math.random() - 0.5) * 6;
  p.y += (Math.random() - 0.5) * 6;
  const display = nestedDisplayName();
  try {
    if (display && !noXdotool) {
      log('автоклик по капче');
      await xClick(page, display, p);
      return true;
    }
  } catch (e) {
    if (e.code !== 'ENOENT') {
      log('автоклик не удался:', e.message);
      return true;
    }
    noXdotool = true;
    log('xdotool не установлен (sudo apt install xdotool) — кликаю через DevTools, это хуже');
  }
  // Без Xephyr системный клик пришёлся бы в то окно, что сверху на рабочем столе, — только DevTools-клик.
  log('автоклик по капче (DevTools)');
  await page.mouse.move(p.x, p.y, { steps: 15 + Math.floor(Math.random() * 10) });
  await sleep(100 + Math.random() * 200);
  await page.mouse.click(p.x, p.y).catch((e) => log('автоклик не удался:', e.message));
  return true;
}

/**
 * Кнопка входа активна сразу, а токен Turnstile появляется через пару секунд — ждём именно токен.
 * С CAPTCHA_AUTOCLICK=1 сами кликаем по галочке, пока не позвали человека.
 */
async function waitTurnstile(page, onStuck) {
  const autoclick = config().captchaAutoclick;
  const until = Date.now() + TURNSTILE_AUTO_MS;
  let resetAt = Date.now() + TURNSTILE_RESET_MS;
  let clickAt = Date.now() + CLICK_FIRST_MS;
  let missed = 0; // попыток подряд, когда галочку не нашли
  for (; Date.now() < until; await sleep(1000)) {
    if (await turnstileToken(page)) return;
    if (Date.now() >= resetAt) {
      resetAt = Date.now() + TURNSTILE_RESET_MS;
      log('Turnstile завис — перезапускаю виджет');
      await resetTurnstile(page);
      clickAt = Date.now() + CLICK_FIRST_MS;
    }
    if (autoclick && Date.now() >= clickAt) {
      clickAt = Infinity; // до следующего перезапуска виджета
      if (await clickTurnstile(page, missed >= 5)) {
        resetAt = Date.now() + CLICK_RETRY_MS;
        missed = 0;
      } else {
        if (++missed === 5) log('автоклик: не вижу галочку капчи — дальше бью наугад в левую часть виджета');
        clickAt = Date.now() + 2000;
      }
    }
  }
  log('Turnstile не прошёл сам — жду человека');
  // Не ждём отправку: пока Telegram тупит, капчу могут пройти, и это надо заметить.
  Promise.resolve(
    onStuck?.(
      `🤖 Капча не проходит сама${autoclick ? ' (автоклик не помог)' : ''}. ` +
        `Пройдите её в окне робота — жду ${TURNSTILE_HUMAN_MS / 60_000} мин, потом перезапущу браузер.`
    )
  ).catch((e) => log('не смог позвать человека:', e.message));
  for (const until = Date.now() + TURNSTILE_HUMAN_MS; Date.now() < until; await sleep(2000)) {
    if (await turnstileToken(page)) return log('Turnstile пройден');
  }
  throw new CaptchaStuck('Turnstile не пройден');
}

/**
 * Проходит флоу записи до календаря и возвращает всё, что нужно для опроса:
 * служебные заголовки, запрос exclude-days, URL-шаблон availability (с sessionId), окно бронирования.
 * onStuck(text) — позвать человека, если Turnstile не проходит сам. Не прошёл и с ним — перезапускаем браузер.
 */
async function openSession(browser, cfg, onStuck) {
  // Новую сессию начинаем в только что запущенном Chrome — так капча реже просит человека.
  if (cfg.freshBrowser && browser.page.url() !== 'about:blank') await browser.restart();
  return retryCaptcha(browser, () => enterCalendar(browser.page, cfg, onStuck));
}

async function enterCalendar(page, cfg, onStuck) {
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

/** Свободное время на один день (тот же availability, что и в scan). */
async function dayTimes(page, sess, date) {
  const res = await page.evaluate(
    async ({ url, headers, date }) => {
      const u = new URL(url);
      u.searchParams.set('date', date);
      const r = await fetch(u, { headers });
      return { status: r.status, body: await r.text() };
    },
    { url: sess.availabilityUrl, headers: sess.headers, date }
  );
  if (res.status !== 200) throw new Error(`availability ответил ${res.status}: ${res.body.slice(0, 150)}`);
  return JSON.parse(res.body).map((s) => s.time);
}

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

module.exports = {
  launch,
  openSession,
  retryCaptcha,
  waitTurnstile,
  sessionFresh,
  dayTimes,
  scan,
  SessionExpired,
  RateLimited,
  CaptchaStuck,
};
