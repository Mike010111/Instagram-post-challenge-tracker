const express = require("express");
const path = require("path");
const http = require("http");
const { ApifyClient } = require("apify-client");

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const INSTAGRAM_USERNAME = "romejkomart";
const YEAR = 2026;
const START_OF_YEAR_POSTS = 358;
const START_OF_YEAR_FOLLOWERS = 1775;
const YEAR_GOAL_POSTS = 300;

// Увеличиваем кэш до 1 часа, чтобы экономить бесплатные лимиты Apify
let cachedMetrics = null;
let lastFetchTime = 0;
const CACHE_TTL = 60 * 60 * 1000; 

// --- ФУНКЦИИ РАСЧЕТА ВРЕМЕНИ И ПРОГРЕССА ---
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
  const startDateOnly = new Date(YEAR, 0, 1);
  const endDateOnly = new Date(YEAR, 11, 31);
  const totalDays = Math.floor((endDateOnly - startDateOnly) / (24 * 60 * 60 * 1000)) + 1;

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
  const currentAverageRounded = Number(currentAverageRaw.toFixed(currentAverageRaw >= 1 ? 2 : 3));
  const currentRequiredAverageRounded = Number(currentRequiredAverageRaw.toFixed(currentRequiredAverageRaw >= 1 ? 2 : 3));
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

// --- ИНТЕГРАЦИЯ С APIFY ---
async function fetchInstagramStats() {
  const apifyToken = process.env.APIFY_API_TOKEN;
  if (!apifyToken) {
    throw new Error("Не задан APIFY_API_TOKEN в переменных окружения");
  }

  const client = new ApifyClient({ token: apifyToken });

  console.log("Запрашиваем данные из Apify...");
  // Вызываем готового актера для профилей
  const run = await client.actor("apify/instagram-profile-scraper").call({
    usernames: [INSTAGRAM_USERNAME],
  });

  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  
  if (!items || items.length === 0) {
    throw new Error("Apify вернул пустой результат");
  }

  const profile = items[0];
  return {
    posts: profile.postsCount,
    followers: profile.followersCount,
  };
}

// --- API ENDPOINT ---
app.get("/api/instagram-stats", async (_req, res) => {
  try {
    const now = Date.now();

    if (cachedMetrics && (now - lastFetchTime < CACHE_TTL)) {
      console.log("Instagram: отдача из кэша (экономим Apify лимиты)");
      return res.json(cachedMetrics);
    }

    const { posts, followers } = await fetchInstagramStats();

    if (posts == null || followers == null) {
      throw new Error("Не удалось получить счетчики (null) из ответа Apify");
    }

    console.log(`Instagram: данные профиля успешно получены через Apify`);
    cachedMetrics = buildMetrics(posts, followers);
    lastFetchTime = now;
    res.json(cachedMetrics);

  } catch (error) {
    console.error("Ошибка при работе с Apify:", error.message);
    res.status(502).json({
      error: "Не удалось получить данные Instagram через Apify.",
      details: error.message,
    });
  }
});

// Раздача статики
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  },
}));

const server = http.createServer(app);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Instagram planner running on http://localhost:${PORT}`);
});