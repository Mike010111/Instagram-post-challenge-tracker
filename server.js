require("dotenv").config();
const express = require("express");
const path = require("path");
const { ApifyClient } = require("apify-client");
const { Redis } = require("@upstash/redis");

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// --- Обязательные переменные окружения ---
// Секрет для доступа к принудительному обновлению данных.
// Дефолтного значения намеренно нет: без него сервер не должен подниматься.
const ADMIN_SECRET = process.env.ADMIN_SECRET_NAME;
if (!ADMIN_SECRET) {
  throw new Error("Не задана переменная окружения ADMIN_SECRET_NAME");
}

const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN;
if (!APIFY_API_TOKEN) {
  throw new Error("Не задана переменная окружения APIFY_API_TOKEN");
}

if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
  throw new Error("Не заданы переменные окружения UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN");
}

// Redis (REST-клиент для Upstash) — используется как персистентный кэш,
// который переживает "засыпание" бесплатного инстанса Render
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// --- Конфигурация конкретного челленджа ---
// Вынесена в .env, чтобы не хранить чужие персональные данные в коде
const INSTAGRAM_USERNAME = process.env.INSTAGRAM_USERNAME;
const YEAR = Number(process.env.CHALLENGE_YEAR) || new Date().getUTCFullYear();
const START_OF_YEAR_POSTS = Number(process.env.START_OF_YEAR_POSTS) || 0;
const START_OF_YEAR_FOLLOWERS = Number(process.env.START_OF_YEAR_FOLLOWERS) || 0;
const YEAR_GOAL_POSTS = Number(process.env.YEAR_GOAL_POSTS) || 300;
const OWNER_NAME = process.env.OWNER_NAME || "Чемпион";

if (!INSTAGRAM_USERNAME) {
  throw new Error("Не задана переменная окружения INSTAGRAM_USERNAME");
}

const CACHE_KEY = "instagram_metrics_cache";
const CACHE_TTL_SECONDS = 60 * 60 * 24; // TTL в Redis — 24 часа
const LOCAL_CACHE_TTL_MS = 60 * 60 * 1000; // 1 час — актуальность локального кэша в памяти
const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 часа — периодичность похода в Apify
const MAX_FORCED_UPDATES = Number(process.env.MAX_FORCED_UPDATES) || 15;

function getCurrentBelgradeDate() {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Belgrade",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(new Date());
  const year = +parts.find((p) => p.type === "year").value;
  const month = +parts.find((p) => p.type === "month").value;
  const day = +parts.find((p) => p.type === "day").value;
  return { year, month, day };
}

// Локальный кэш в памяти процесса — самый быстрый уровень выдачи данных
let cachedMetrics = null;
let cacheTimestamp = 0;

function getDaysRemainingInYearInclusive(now) {
  const yearEnd = new Date(Date.UTC(YEAR, 11, 31, 23, 59, 59, 999));
  if (now > yearEnd) return 0;
  const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const endOfYearDateOnly = new Date(Date.UTC(YEAR, 11, 31));
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.floor((endOfYearDateOnly - startOfToday) / msPerDay) + 1;
}

function getDaysElapsedInYearInclusive(now) {
  const yearStart = new Date(Date.UTC(YEAR, 0, 1));
  const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.floor((startOfToday - yearStart) / msPerDay) + 1;
}

function getChallengeYearDayMetrics(now) {
  const challengeStart = new Date(Date.UTC(YEAR, 0, 1));
  const challengeEnd = new Date(Date.UTC(YEAR, 11, 31, 23, 59, 59, 999));
  const totalDays = 365;

  if (now < challengeStart) {
    return { daysElapsedInclusive: 0, daysRemainingInclusive: totalDays, challengeYearFinished: false };
  }
  if (now > challengeEnd) {
    return { daysElapsedInclusive: totalDays, daysRemainingInclusive: 0, challengeYearFinished: true };
  }

  return {
    daysElapsedInclusive: getDaysElapsedInYearInclusive(now),
    daysRemainingInclusive: getDaysRemainingInYearInclusive(now),
    challengeYearFinished: false,
  };
}

function motivationalComment({ progressPercent, remainingPosts, requiredAvgPerDay, challengeYearFinished }) {
  if (remainingPosts <= 0) return `Никто не сомневался в твоём успехе. ${OWNER_NAME}, отличная работа!`;
  if (challengeYearFinished) return "Отличная проделанная работа. Дальше только больше!";
  if (progressPercent >= 80) return "Финишная прямая: осталось совсем немного.";
  if (requiredAvgPerDay <= 1) return "Реалистичный темп — держи регулярность.";
  if (requiredAvgPerDay <= 2) return "Хороший вызов: стабильность важнее рывков.";
  return "Темп высокий — планируй контент заранее, чтобы не перегореть.";
}

function buildMetrics(currentPosts, currentFollowers) {
  const nowReal = new Date(); // реальное время обновления, UTC
  const belgrade = getCurrentBelgradeDate();
  const nowDateBelgrade = new Date(Date.UTC(belgrade.year, belgrade.month - 1, belgrade.day));

  const postedThisYear = Math.max(0, currentPosts - START_OF_YEAR_POSTS);
  const followersGrowth = currentFollowers - START_OF_YEAR_FOLLOWERS;
  const remainingPosts = Math.max(0, YEAR_GOAL_POSTS - postedThisYear);
  const { daysElapsedInclusive, daysRemainingInclusive, challengeYearFinished } =
    getChallengeYearDayMetrics(nowDateBelgrade);

  const currentAverageRaw = daysElapsedInclusive > 0 ? postedThisYear / daysElapsedInclusive : 0;
  const currentRequiredAverageRaw = daysRemainingInclusive > 0 ? remainingPosts / daysRemainingInclusive : 0;
  const progressPercent = Math.min(100, (postedThisYear / YEAR_GOAL_POSTS) * 100);

  return {
    year: YEAR,
    currentPosts,
    currentFollowers,
    followersGrowth,
    postedThisYear,
    remainingPosts,
    daysElapsedInclusive,
    daysRemainingInclusive,
    currentAvgPostsPerDay: Number(currentAverageRaw.toFixed(2)),
    requiredAvgPostsPerDay: Number(currentRequiredAverageRaw.toFixed(2)),
    progressPercent: Number(progressPercent.toFixed(1)),
    challengeYearFinished,
    motivation: motivationalComment({
      progressPercent,
      remainingPosts,
      requiredAvgPerDay: currentRequiredAverageRaw,
      challengeYearFinished,
    }),
    lastUpdatedAt: nowReal.toISOString(),
  };
}

async function fetchInstagramStats() {
  const client = new ApifyClient({ token: APIFY_API_TOKEN });
  const run = await client.actor("apify/instagram-profile-scraper").call({
    usernames: [INSTAGRAM_USERNAME],
  });

  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  if (!items || items.length === 0) {
    throw new Error("Apify вернул пустой результат");
  }

  return {
    posts: items[0].postsCount,
    followers: items[0].followersCount,
  };
}

// --- Работа с Redis: только чтение/запись кэша, без критичной бизнес-логики ---
async function loadCacheFromRedis() {
  try {
    const data = await redis.get(CACHE_KEY);
    return data || null;
  } catch (err) {
    console.error("Redis get error:", err.message);
    return null;
  }
}

async function saveCacheToRedis(metrics) {
  if (!metrics) {
    console.error("Redis set error: попытка сохранить пустые данные");
    return;
  }

  try {
    await redis.set(CACHE_KEY, metrics, { ex: CACHE_TTL_SECONDS });
    console.log("Redis: кэш сохранён");
  } catch (err) {
    console.error("Redis set error:", err.message);
  }
}

// Защита от одновременных запросов к Apify: если обновление уже идёт,
// все параллельные запросы ждут один и тот же промис вместо того,
// чтобы плодить лишние обращения к скрейперу
let activeUpdatePromise = null;

function triggerUpdateAndWait() {
  if (activeUpdatePromise) return activeUpdatePromise;

  console.log("Запуск обновления Apify...");
  activeUpdatePromise = (async () => {
    try {
      const { posts, followers } = await fetchInstagramStats();
      const metrics = buildMetrics(posts, followers);

      cachedMetrics = metrics;
      cacheTimestamp = Date.now();
      await saveCacheToRedis(metrics);
      console.log("Обновление успешно завершено.");

      return cachedMetrics;
    } catch (err) {
      console.error("Ошибка при обновлении:", err.message);
      throw err;
    } finally {
      activeUpdatePromise = null;
    }
  })();

  return activeUpdatePromise;
}

// Быстрая проверка секрета без запуска обновления через Apify
app.get("/api/check-secret", (req, res) => {
  const secret = req.query.secret;
  if (secret !== ADMIN_SECRET) {
    return res.status(403).json({ error: "Неверное секретное слово" });
  }
  return res.json({ valid: true });
});

app.get("/api/instagram-stats", async (req, res) => {
  try {
    const force = req.query.force === "true";
    const secret = req.query.secret;

    // ========== Принудительное обновление (админ-доступ) ==========
    if (force) {
      if (secret !== ADMIN_SECRET) {
        return res.status(403).json({ error: "Неверное секретное слово" });
      }

      const forcedKey = `forced_updates_${new Date().toISOString().split("T")[0]}`;
      let withinLimit = true;
      try {
        const count = await redis.incr(forcedKey);
        await redis.expire(forcedKey, 86400);
        withinLimit = count <= MAX_FORCED_UPDATES;
      } catch (err) {
        console.error("Redis limit error:", err.message);
        // Если Redis недоступен для проверки лимита, не блокируем администратора
      }

      if (!withinLimit) {
        return res.status(429).json({ error: `Лимит обновлений (${MAX_FORCED_UPDATES} раз в день) исчерпан.` });
      }

      console.log("Принудительное обновление: запрос к Apify...");
      const { posts, followers } = await fetchInstagramStats();
      const metrics = buildMetrics(posts, followers);

      cachedMetrics = metrics;
      cacheTimestamp = Date.now();
      await saveCacheToRedis(metrics);

      return res.json(metrics);
    }

    // ========== Обычный запрос ==========
    let metricsToReturn = null;

    if (cachedMetrics && Date.now() - cacheTimestamp < LOCAL_CACHE_TTL_MS) {
      metricsToReturn = cachedMetrics;
      console.log("Отдача из локального кэша");
    } else {
      console.log("Локальный кэш пуст/устарел, пробую Redis...");
      const redisData = await loadCacheFromRedis();
      if (redisData) {
        cachedMetrics = redisData;
        cacheTimestamp = Date.now();
        metricsToReturn = redisData;
        console.log("Данные загружены из Redis в локальный кэш");
      }
    }

    if (metricsToReturn && !metricsToReturn.stale) {
      const ageMs = Date.now() - new Date(metricsToReturn.lastUpdatedAt).getTime();

      if (ageMs > UPDATE_INTERVAL_MS) {
        console.log("Данные устарели, жду новых...");
        try {
          metricsToReturn = await triggerUpdateAndWait();
        } catch (err) {
          console.log("Не удалось обновить, отдаю старые данные");
        }
      }

      return res.json(metricsToReturn);
    }

    // Кэша нет ни в памяти, ни в Redis (например, первый запуск сервера)
    console.log("Кэш отсутствует, ожидаю первую загрузку данных...");
    try {
      const freshMetrics = await triggerUpdateAndWait();
      return res.json(freshMetrics);
    } catch (err) {
      return res.status(502).json({
        error: "Не удалось получить первичные данные Instagram.",
        details: err.message,
      });
    }
  } catch (error) {
    console.error("Ошибка API:", error.message);
    res.status(502).json({
      error: "Не удалось получить данные Instagram.",
      details: error.message,
    });
  }
});

app.use(express.static(path.join(__dirname, "public")));

app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, "public", "404.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
