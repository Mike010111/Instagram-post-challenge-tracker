require("dotenv").config();
const express = require("express");
const path = require("path");
const { ApifyClient } = require("apify-client");
const { Redis } = require("@upstash/redis");

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Инициализация Redis (REST-клиент для Upstash)
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const INSTAGRAM_USERNAME = "romejkomart";
const YEAR = 2026;
const START_OF_YEAR_POSTS = 358;
const START_OF_YEAR_FOLLOWERS = 1775;
const YEAR_GOAL_POSTS = 300;

const CACHE_KEY = "instagram_metrics_cache";
const CACHE_TTL_SECONDS = 60 * 60 * 24; // TTL в Redis – 24 часа

const ADMIN_SECRET = process.env.ADMIN_SECRET_NAME || "admin";
const MAX_FORCED_UPDATES = 10;

// === Локальный кэш (память процесса) ===
let cachedMetrics = null;       // сами данные
let cacheTimestamp = 0;         // время последнего обновления (необязательно, но для информации)

// --- Функции расчёта (без изменений) ---
function getDaysRemainingInYearInclusive(now) {
  const yearEnd = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
  if (now > yearEnd) return 0;
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
  const totalDays = 365;

  if (now < challengeStart) return { daysElapsedInclusive: 0, daysRemainingInclusive: totalDays, challengeYearFinished: false };
  if (now > challengeEnd) return { daysElapsedInclusive: totalDays, daysRemainingInclusive: 0, challengeYearFinished: true };
  
  return {
    daysElapsedInclusive: getDaysElapsedInYearInclusive(now),
    daysRemainingInclusive: getDaysRemainingInYearInclusive(now),
    challengeYearFinished: false,
  };
}

function motivationalComment({ progressPercent, remainingPosts, requiredAvgPerDay, challengeYearFinished }) {
  if (remainingPosts <= 0) return "Никто не сомневался в твоем успехе. Марта Стронг, отличная работа!";
  if (challengeYearFinished) return "Отличная проделанная работа. Дальше только больше!";
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
  const { daysElapsedInclusive: daysElapsed, daysRemainingInclusive: daysRemaining, challengeYearFinished } = getChallengeYearDayMetrics(now);
  
  const currentAverageRaw = daysElapsed > 0 ? postedThisYear / daysElapsed : 0;
  const currentRequiredAverageRaw = daysRemaining > 0 ? remainingPosts / daysRemaining : 0;
  
  const progressPercent = Math.min(100, (postedThisYear / YEAR_GOAL_POSTS) * 100);

  return {
    year: YEAR,
    currentPosts,
    currentFollowers,
    followersGrowth,
    postedThisYear,
    remainingPosts,
    daysElapsedInclusive: daysElapsed,
    daysRemainingInclusive: daysRemaining,
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
    lastUpdatedAt: now.toISOString(),
  };
}

async function fetchInstagramStats() {
  const apifyToken = process.env.APIFY_API_TOKEN;
  if (!apifyToken) throw new Error("Не задан APIFY_API_TOKEN");

  const client = new ApifyClient({ token: apifyToken });
  const run = await client.actor("apify/instagram-profile-scraper").call({
    usernames: [INSTAGRAM_USERNAME],
  });

  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  if (!items || items.length === 0) throw new Error("Apify вернул пустой результат");

  return {
    posts: items[0].postsCount,
    followers: items[0].followersCount,
  };
}

// --- Безопасная работа с Redis (только для восстановления и сохранения) ---
async function loadCacheFromRedis() {
  try {
    const data = await redis.get(CACHE_KEY);
    return data ? data : null;
  } catch (err) {
    console.error("Redis get error:", err.message);
    return null;
  }
}

async function saveCacheToRedis(metrics) {
  if (!metrics) {
    console.error("Redis set error: Попытка сохранить пустые данные. Аргумент metrics =", metrics);
    return;
  }

  try {
    await redis.set(CACHE_KEY, metrics, { ex: CACHE_TTL_SECONDS });
    console.log("Redis: кэш сохранён");
  } catch (err) {
    console.error("Redis set error:", err.message);
  }
}

// --- API ENDPOINT ---
app.get("/api/instagram-stats", async (req, res) => {
  try {
    const force = req.query.force === "true";
    const secret = req.query.secret;

    // ========== ПРИНУДИТЕЛЬНОЕ ОБНОВЛЕНИЕ (force) ==========
    if (force) {
      if (secret !== ADMIN_SECRET) {
        return res.status(403).json({ error: "Неверное секретное имя" });
      }

      // Проверка суточного лимита (счётчик в Redis)
      const forcedKey = `forced_updates_${new Date().toISOString().split('T')[0]}`;
      let withinLimit = true;
      try {
        const count = await redis.incr(forcedKey);
        await redis.expire(forcedKey, 86400);
        withinLimit = count <= MAX_FORCED_UPDATES;
      } catch (err) {
        console.error("Redis limit error:", err.message);
        // Если Redis недоступен, разрешаем обновление (или можно запретить, по желанию)
      }

      if (!withinLimit) {
        return res.status(429).json({ error: "Лимит обновлений (10 раз в день) исчерпан." });
      }

      console.log("Принудительное обновление: запрос к Apify...");
      const { posts, followers } = await fetchInstagramStats();
      const metrics = buildMetrics(posts, followers);

      // проверяем, что метрики успешно сформировались
      if (!metrics) {
        throw new Error("Функция buildMetrics вернула пустой результат (null/undefined)");
      }

      // Обновляем локальный кэш
      cachedMetrics = metrics;
      cacheTimestamp = Date.now();

      // Сохраняем в Redis (чтобы пережить сон)
      await saveCacheToRedis(metrics);

      return res.json(metrics);
    }

    // ========== ОБЫЧНЫЙ ЗАПРОС ==========
    // 1. Если есть локальный кэш – отдаём его (Redis не трогаем)
    if (cachedMetrics) {
      console.log("Отдача из локального кэша (память)");
      return res.json(cachedMetrics);
    }

    // 2. Локального кэша нет (сервер только запустился) – пробуем восстановить из Redis
    console.log("Локальный кэш пуст, пробую Redis...");
    const redisData = await loadCacheFromRedis();

    if (redisData) {
      // Заполняем локальный кэш
      cachedMetrics = redisData;
      cacheTimestamp = Date.now();
      console.log("Данные загружены из Redis в локальный кэш");
      return res.json(redisData);
    }

    // 3. Кэша нет нигде – возвращаем заглушку (без Apify)
    console.log("Кэш отсутствует, отдаю заглушку (без Apify)");
    return res.json({
      year: YEAR,
      currentPosts: 0,
      currentFollowers: 0,
      followersGrowth: 0,
      postedThisYear: 0,
      remainingPosts: YEAR_GOAL_POSTS,
      daysElapsedInclusive: 0,
      daysRemainingInclusive: 0,
      currentAvgPostsPerDay: 0,
      requiredAvgPostsPerDay: 0,
      progressPercent: 0,
      challengeYearFinished: false,
      motivation: "Данные ещё не загружены. Нажмите «Обновить» для получения актуальной информации.",
      lastUpdatedAt: new Date(0).toISOString(),
      stale: true,
    });

  } catch (error) {
    console.error("Ошибка API:", error.message);
    res.status(502).json({
      error: "Не удалось получить данные Instagram.",
      details: error.message,
    });
  }
});

// Раздача статики
app.use(express.static(path.join(__dirname, "public")));

// Тестовый маршрут для 404
app.get("/test-404", (req, res) => {
  res.status(404).sendFile(path.join(__dirname, "public", "404.html"));
});

// Финальный 404
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, "public", "404.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});