const express = require("express");
const cheerio = require("cheerio");
const path = require("path");
const http = require("http");
const https = require("https");
const dns = require("dns");
const { execFile } = require("child_process");
const { promisify } = require("util");

dns.setDefaultResultOrder("ipv4first");

const execFileAsync = promisify(execFile);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const INSTAGRAM_URL = "https://www.instagram.com/romejkomart/";
const INSTAGRAM_USERNAME = "romejkomart";
const YEAR = 2026;
const START_OF_YEAR_POSTS = 358;
const START_OF_YEAR_FOLLOWERS = 1775;
const YEAR_GOAL_POSTS = 300;

let cachedMetrics = null;
let lastFetchTime = 0;
const CACHE_TTL = 5 * 60 * 1000;
let apiBlockedUntil = 0;
const API_BLOCK_DURATION = 5 * 60 * 60 * 1000;

function normalizeNumber(value) {
  return Number(String(value || "").replace(/[^\d]/g, ""));
}

function stringifyExecStderr(stderr) {
  if (stderr == null) {
    return "";
  }
  if (typeof stderr === "string") {
    return stderr;
  }
  if (Buffer.isBuffer(stderr)) {
    return stderr.toString("utf8");
  }
  return String(stderr);
}

function flattenErrorText(error, depth = 0) {
  if (error == null || depth > 6) {
    return "";
  }
  if (typeof error === "string") {
    return error;
  }
  if (
    typeof AggregateError !== "undefined" &&
    error instanceof AggregateError &&
    Array.isArray(error.errors)
  ) {
    return error.errors.map((e) => flattenErrorText(e, depth + 1)).filter(Boolean).join(" ");
  }
  const parts = [
    error.code || "",
    error.message || "",
    stringifyExecStderr(error.stderr),
    flattenErrorText(error.cause, depth + 1),
  ];
  return parts.filter(Boolean).join(" ");
}

/** DNS / connectivity — not fixable by changing HTML parsers. */
function mapInstagramUpstreamFailure(error) {
  const msg = error?.message || String(error);
  const stderr = stringifyExecStderr(error?.stderr);
  const combined = flattenErrorText(error);
  if (
    error?.code === "ENOTFOUND" ||
    /\bENOTFOUND\b/i.test(combined) ||
    /\bENOTFOUND\b/i.test(`${msg} ${stderr}`) ||
    /Could not resolve host/i.test(combined) ||
    /nodename nor servname provided, or not known/i.test(combined)
  ) {
    return {
      status: 503,
      error:
        "Нет доступа к Instagram: адрес www.instagram.com не найден (ошибка DNS или нет интернета). Проверьте сеть, VPN, блокировки и DNS в настройках системы или Wi‑Fi.",
      details: msg.trim() || stderr.trim() || String(error),
    };
  }
  if (error?.code === "EAI_AGAIN" || /\bEAI_AGAIN\b/i.test(combined)) {
    return {
      status: 503,
      error:
        "Временная ошибка DNS при обращении к Instagram. Подождите и повторите или смените DNS-сервер.",
      details: msg.trim() || String(error),
    };
  }
  if (error?.code === "ETIMEDOUT" || /\brequest timeout\b/i.test(msg) || /Operation timed out/i.test(combined)) {
    return {
      status: 504,
      error: "Таймаут при подключении к Instagram.",
      details: msg.trim() || String(error),
    };
  }
  if (error?.code === "ECONNREFUSED" || error?.code === "ECONNRESET") {
    return {
      status: 503,
      error: "Соединение с Instagram разорвано или отклонено.",
      details: msg.trim() || String(error),
    };
  }
  return null;
}

function requestText(url, headers = {}, redirectsLeft = 4) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const client = target.protocol === "http:" ? http : https;

    const req = client.request(
      target,
      {
        method: "GET",
        headers,
        timeout: 15000,
      },
      (res) => {
        const statusCode = res.statusCode || 0;
        const location = res.headers.location;
        if ([301, 302, 303, 307, 308].includes(statusCode) && location && redirectsLeft > 0) {
          const redirected = new URL(location, url).toString();
          res.resume();
          requestText(redirected, headers, redirectsLeft - 1).then(resolve).catch(reject);
          return;
        }

        if (statusCode < 200 || statusCode >= 300) {
          res.resume();
          reject(new Error(`status ${statusCode}`));
          return;
        }

        const chunks = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      },
    );

    req.on("timeout", () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
    req.end();
  });
}

function getDaysRemainingInYearInclusive(now) {
  const yearEnd = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
  if (now > yearEnd) {
    return 0;
  }
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfYearDateOnly = new Date(yearEnd.getFullYear(), yearEnd.getMonth(), yearEnd.getDate());
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.floor((endOfYearDateOnly - startOfToday) / msPerDay) + 1;
}

function getDaysElapsedInYearInclusive(now) {
  const yearStart = new Date(now.getFullYear(), 0, 1);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.floor((startOfToday - yearStart) / msPerDay) + 1;
}

function getChallengeYearDayMetrics(now) {
  const challengeStart = new Date(YEAR, 0, 1);
  const challengeEnd = new Date(YEAR, 11, 31, 23, 59, 59, 999);
  const startDateOnly = new Date(YEAR, 0, 1);
  const endDateOnly = new Date(YEAR, 11, 31);
  const totalDays =
    Math.floor((endDateOnly - startDateOnly) / (24 * 60 * 60 * 1000)) + 1;

  if (now < challengeStart) {
    return {
      daysElapsedInclusive: 0,
      daysRemainingInclusive: totalDays,
      challengeYearFinished: false,
    };
  }

  if (now > challengeEnd) {
    return {
      daysElapsedInclusive: totalDays,
      daysRemainingInclusive: 0,
      challengeYearFinished: true,
    };
  }

  return {
    daysElapsedInclusive: getDaysElapsedInYearInclusive(now),
    daysRemainingInclusive: getDaysRemainingInYearInclusive(now),
    challengeYearFinished: false,
  };
}

function firstMatchNumber(html, patterns) {
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1] != null) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n >= 0) {
        return n;
      }
    }
  }
  return null;
}

function parseFromWindowPayload(html) {
  const posts = firstMatchNumber(html, [
    /"edge_owner_to_timeline_media"\s*:\s*\{\s*"count"\s*:\s*(\d+)/,
    /"edge_owner_to_timeline_media"\s*:\s*\{"count"\s*:\s*(\d+)/,
  ]);
  const followers = firstMatchNumber(html, [
    /"edge_followed_by"\s*:\s*\{\s*"count"\s*:\s*(\d+)/,
    /"edge_followed_by"\s*:\s*\{"count"\s*:\s*(\d+)/,
  ]);

  return { posts, followers };
}

function parseFromJsonSnippets(html) {
  const posts = firstMatchNumber(html, [/"media_count"\s*:\s*(\d+)/]);
  const followers = firstMatchNumber(html, [
    /"follower_count"\s*:\s*(\d+)/,
    /"followers_count"\s*:\s*(\d+)/,
  ]);
  return { posts, followers };
}

function parseFromMetaDescription(html) {
  const $ = cheerio.load(html);
  const description =
    $('meta[property="og:description"]').attr("content") ||
    $('meta[name="description"]').attr("content") ||
    "";

  if (!description) {
    return { posts: null, followers: null };
  }

  const followersMatch =
    description.match(/([\d.,\s\u00A0]+)\s+Followers/i) ||
    description.match(/([\d.,\s\u00A0]+)\s+подписчик/i);
  const postsMatch =
    description.match(/([\d.,\s\u00A0]+)\s+Posts/i) ||
    description.match(/([\d.,\s\u00A0]+)\s+публикац/i);

  return {
    posts: postsMatch ? normalizeNumber(postsMatch[1]) : null,
    followers: followersMatch ? normalizeNumber(followersMatch[1]) : null,
  };
}

function parseFromGenericCounterText(html) {
  const normalized = html.replace(/\s+/g, " ");
  const match = normalized.match(
    /([\d.,\s\u00A0]+)\s+Followers[\s,]+([\d.,\s\u00A0]+)\s+Following[\s,]+([\d.,\s\u00A0]+)\s+Posts/i,
  );

  if (!match) {
    return { posts: null, followers: null };
  }

  return {
    posts: normalizeNumber(match[3]),
    followers: normalizeNumber(match[1]),
  };
}

function mergePartialCounters(target, patch) {
  if (patch.posts != null) {
    target.posts = target.posts ?? patch.posts;
  }
  if (patch.followers != null) {
    target.followers = target.followers ?? patch.followers;
  }
}

function extractCountersFromHtml(html) {
  const result = { posts: null, followers: null };
  const parsers = [
    parseFromWindowPayload,
    parseFromJsonSnippets,
    parseFromMetaDescription,
    parseFromGenericCounterText,
  ];
  for (const parser of parsers) {
    mergePartialCounters(result, parser(html));
    if (result.posts != null && result.followers != null) {
      break;
    }
  }
  return result;
}

const INSTAGRAM_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
};

async function fetchInstagramProfileHtml(extraHeaders = {}) {
  return requestText(INSTAGRAM_URL, { ...INSTAGRAM_HEADERS, ...extraHeaders });
}

function envHasProxyVariables() {
  return !!(
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.ALL_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy ||
    process.env.all_proxy
  );
}

function getCurlCandidateBins() {
  const bins = [];
  if (process.env.CURL_BIN) {
    bins.push(process.env.CURL_BIN);
  }
  if (process.platform === "darwin") {
    bins.push("/usr/bin/curl", "/opt/homebrew/bin/curl");
  }
  bins.push("curl");
  return [...new Set(bins.filter(Boolean))];
}

/** Как `curl https://…` в терминале: без -A / -H / --compressed (Instagram часто кладёт счётчики в og:description только для «простого» клиента). */
function buildBareCurlArgs(url, followRedirects) {
  const args = ["-sS", "--max-time", "15"];
  if (followRedirects) {
    args.splice(1, 0, "-L");
  }
  if (envHasProxyVariables()) {
    args.push("--noproxy", "*");
  }
  args.push(url);
  return args;
}

async function curlExecuteWithBins(args) {
  const tried = getCurlCandidateBins();
  let lastError;
  for (const bin of tried) {
    try {
      const { stdout } = await execFileAsync(bin, args, {
        maxBuffer: 12 * 1024 * 1024,
        encoding: "utf8",
        env: buildCurlEnv(),
      });
      return stdout;
    } catch (err) {
      lastError = err;
    }
  }
  try {
    const cmd = `exec curl ${args.map((x) => JSON.stringify(String(x))).join(" ")}`;
    const { stdout } = await execFileAsync("/bin/bash", ["-lc", cmd], {
      maxBuffer: 12 * 1024 * 1024,
      encoding: "utf8",
      env: buildCurlEnv(),
    });
    return stdout;
  } catch (shellErr) {
    throw lastError || shellErr;
  }
}

function buildCurlArgs(url, headers = {}) {
  const args = ["-sS", "-L", "--compressed", "--max-time", "15"];
  // If a proxy is injected into the environment, curl may fail with
  // "CONNECT tunnel failed" even though direct curl in a login shell works.
  // Bypass proxies for Instagram fetches.
  if (envHasProxyVariables()) {
    args.push("--noproxy", "*");
  }
  const ua = headers["user-agent"];
  if (ua) {
    args.push("-A", ua);
  }
  for (const [key, val] of Object.entries(headers)) {
    if (key === "user-agent" || val == null || val === "") {
      continue;
    }
    args.push("-H", `${key}: ${val}`);
  }
  args.push(url);
  return args;
}

function buildCurlEnv() {
  // Inherit everything except proxy variables.
  const env = { ...process.env };
  delete env.HTTP_PROXY;
  delete env.HTTPS_PROXY;
  delete env.ALL_PROXY;
  delete env.http_proxy;
  delete env.https_proxy;
  delete env.all_proxy;
  return env;
}

async function curlGetExec(curlBin, url, headers = {}) {
  const args = buildCurlArgs(url, headers);
  const { stdout } = await execFileAsync(curlBin, args, {
    maxBuffer: 12 * 1024 * 1024,
    encoding: "utf8",
    env: buildCurlEnv(),
  });
  return stdout;
}

async function curlGetViaLoginShell(url, headers = {}) {
  const argv = buildCurlArgs(url, headers);
  const cmd = `exec curl ${argv.map((x) => JSON.stringify(String(x))).join(" ")}`;
  const { stdout } = await execFileAsync("/bin/bash", ["-lc", cmd], {
    maxBuffer: 12 * 1024 * 1024,
    encoding: "utf8",
    env: buildCurlEnv(),
  });
  return stdout;
}

async function curlGet(url, headers = {}) {
  const tried = getCurlCandidateBins();
  let lastError;
  for (const bin of tried) {
    try {
      return await curlGetExec(bin, url, headers);
    } catch (err) {
      lastError = err;
    }
  }

  try {
    return await curlGetViaLoginShell(url, headers);
  } catch (shellErr) {
    throw lastError || shellErr;
  }
}

async function fetchInstagramProfileHtmlViaCurl(extraHeaders = {}) {
  return curlGet(INSTAGRAM_URL, { ...INSTAGRAM_HEADERS, ...extraHeaders });
}

async function fetchFromProfileInfoApi(username) {
  const apiUrl = `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
  const responseText = await requestText(apiUrl, {
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "x-ig-app-id": "936619743392459",
    accept: "application/json",
  });
  console.log(responseText.substring(0, 500))
  const json = JSON.parse(responseText);
  const user = json?.data?.user;
  return {
    posts: user?.edge_owner_to_timeline_media?.count ?? null,
    followers: user?.edge_followed_by?.count ?? null,
  };
}

/**
 * Порядок: HTML через Node HTTPS → «голый» curl (как в CLI) → curl с заголовками браузера → JSON API.
 * Возвращает метку источника, когда оба счётчика известны.
 */
async function resolveInstagramProfileCounters(username) {
  const out = { posts: null, followers: null };

  const filled = () => out.posts != null && out.followers != null;

  if (!isApiBlocked()) {
    try {
      mergePartialCounters(out, await fetchFromProfileInfoApi(username));
    } catch (apiError) {
      const msg = flattenErrorText(apiError);
      if (msg.includes("401") || msg.includes("403")) {
        console.warn(`JSON API вернул ${msg}, блокирую на 5 часов`);
        setApiBlocked();
      }
    }
  }

  if (filled()) {
    return { ...out, source: "JSON API web_profile_info (HTTPS, Node.js)" };
  }

  try {
    const html = await fetchInstagramProfileHtmlViaCurl();
    mergePartialCounters(out, extractCountersFromHtml(html));
  } catch {
    /* ignore */
  }

  if (!filled()) {
    try {
      const html = await fetchInstagramProfileHtmlViaCurl({
        "accept-language": "en-US,en;q=0.9",
      });
      mergePartialCounters(out, extractCountersFromHtml(html));
    } catch {
      /* ignore */
    }
  }

  if (filled()) {
    return { ...out, source: "HTML страницы профиля (curl + User-Agent браузера)" };
  }

  for (const followRedirects of [false, true]) {
    try {
      const html = await curlExecuteWithBins(buildBareCurlArgs(INSTAGRAM_URL, followRedirects));
      mergePartialCounters(out, extractCountersFromHtml(html));
      if (filled()) {
        return {
          ...out,
          source: followRedirects
            ? "HTML страницы профиля (curl минимальный, с -L)"
            : "HTML страницы профиля (curl минимальный, без -L)",
        };
      }
    } catch {
      /* ignore */
    }
  }

  try {
    const html = await fetchInstagramProfileHtml();
    mergePartialCounters(out, extractCountersFromHtml(html));
  } catch {
    /* ignore */
  }

  if (!filled()) {
    try {
      const html = await fetchInstagramProfileHtml({
        "accept-language": "en-US,en;q=0.9",
      });
      mergePartialCounters(out, extractCountersFromHtml(html));
    } catch {
      /* ignore */
    }
  }

  if (filled()) {
    return { ...out, source: "HTML страницы профиля (HTTPS, Node.js)" };
  }

  return { ...out, source: null };
}

function motivationalComment({
  progressPercent,
  remainingPosts,
  requiredAvgPerDay,
  challengeYearFinished,
}) {
  if (remainingPosts <= 0) {
    return "Никто не сомневался в твоем успехе. Марта Стронг, отличная работа!";
  }
  if (challengeYearFinished) {
    return "Отличная проделанная работа. Дальше только больше!";
  }
  if (progressPercent >= 80) return "Финишная прямая: осталось совсем немного.";
  if (requiredAvgPerDay <= 1) return "Реалистичный темп — держи регулярность.";
  if (requiredAvgPerDay <= 2) return "Хороший вызов: стабильность важнее рывков.";
  return "Темп высокий — планируй контент заранее, чтобы не перегореть.";
}

function buildMetrics(currentPosts, currentFollowers) {
  const now = new Date();
  const postedThisYear = Math.max(0, currentPosts - START_OF_YEAR_POSTS);
  const followersGrowth = currentFollowers - START_OF_YEAR_FOLLOWERS;
  const remainingPosts = Math.max(0, YEAR_GOAL_POSTS - postedThisYear);
  const {
    daysElapsedInclusive: daysElapsed,
    daysRemainingInclusive: daysRemaining,
    challengeYearFinished,
  } = getChallengeYearDayMetrics(now);
  const currentAverageRaw = daysElapsed > 0 ? postedThisYear / daysElapsed : 0;
  const currentRequiredAverageRaw = daysRemaining > 0 ? remainingPosts / daysRemaining : 0;
  const currentAverageRounded = Number(currentAverageRaw.toFixed(currentAverageRaw >= 1 ? 2 : 3));
  const currentRequiredAverageRounded = Number(
    currentRequiredAverageRaw.toFixed(currentRequiredAverageRaw >= 1 ? 2 : 3),
  );
  const progressPercent = Math.min(100, (postedThisYear / YEAR_GOAL_POSTS) * 100);

  return {
    year: YEAR,
    currentPosts,
    currentFollowers,
    followersGrowth,
    startOfYearPosts: START_OF_YEAR_POSTS,
    startOfYearFollowers: START_OF_YEAR_FOLLOWERS,
    goalPosts: YEAR_GOAL_POSTS,
    postedThisYear,
    remainingPosts,
    daysElapsedInclusive: daysElapsed,
    daysRemainingInclusive: daysRemaining,
    currentAvgPostsPerDay: currentAverageRounded,
    requiredAvgPostsPerDay: currentRequiredAverageRounded,
    progressPercent: Number(progressPercent.toFixed(1)),
    challengeYearFinished,
    motivation: motivationalComment({
      progressPercent,
      remainingPosts,
      requiredAvgPerDay: currentRequiredAverageRounded,
      challengeYearFinished,
    }),
    lastUpdatedAt: now.toISOString(),
  };
}

function isApiBlocked() {
  return Date.now() < apiBlockedUntil;
}

function setApiBlocked() {
  apiBlockedUntil = Date.now() + API_BLOCK_DURATION;
  console.warn(`JSON API заблокирован до ${new Date(apiBlockedUntil).toISOString()}`);
}

app.get("/api/instagram-stats", async (_req, res) => {
  try {
    const now = Date.now();

    /*if (cachedMetrics && (now - lastFetchTime < CACHE_TTL)) {
      console.log("Instagram: отдача из кэша");
      return res.json(cachedMetrics);
    }*/

    const { posts, followers, source } = await resolveInstagramProfileCounters(INSTAGRAM_USERNAME);
    if (posts == null || followers == null) {
      throw new Error("Could not extract profile counters from page HTML");
    }

    console.log(`Instagram: данные профиля получены через — ${source}`);
    cachedMetrics = buildMetrics(posts, followers);
    lastFetchTime = now;
    res.json(cachedMetrics);
  } catch (error) {
    const flat = flattenErrorText(error);
    let upstream = mapInstagramUpstreamFailure(error);
    if (!upstream && /\bENOTFOUND\b/i.test(flat)) {
      upstream = {
        status: 503,
        error: "Не удалось найти адрес Instagram (ошибка DNS). Проверьте сеть; при расхождении с терминалом задайте CURL_BIN или другой PORT.",
        details: flat.trim() || error?.message || String(error),
      };
    }
    if (upstream) {
      res.status(upstream.status).json({ error: upstream.error, details: upstream.details });
      return;
    }
    res.status(502).json({
      error: "Не удалось получить данные Instagram. Возможно, страница вернула нестандартную разметку.",
      details: flat.trim() || error?.message || String(error),
    });
  }
});

app.use(
  express.static(path.join(__dirname, "public"), {
    setHeaders: (res) => {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    },
  }),
);

const server = http.createServer(app);

server.on("error", (err) => {
  console.error(
    "[fatal] Не удалось запустить сервер:",
    err.code || "",
    err.message,
  );
  if (err.code === "EADDRINUSE") {
    console.error(
      `Порт ${PORT} уже занят. Кто слушает: lsof -nP -iTCP:${PORT} -sTCP:LISTEN\n` +
        `Завершить процесс: kill -9 <PID>   или запуск с другим портом: PORT=3001 npm start`,
    );
  }
  process.exit(1);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Instagram planner running on http://localhost:${PORT}`);
});
