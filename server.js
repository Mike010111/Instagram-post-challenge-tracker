const express = require("express");
const cheerio = require("cheerio");
const path = require("path");
const https = require("https");
const http = require("http");

const app = express();
const PORT = process.env.PORT || 3000;

const INSTAGRAM_URL = "https://www.instagram.com/romejkomart/";
const YEAR = 2026;
const START_OF_YEAR_POSTS = 358;
const START_OF_YEAR_FOLLOWERS = 1775;
const YEAR_GOAL_POSTS = 300;

function normalizeNumber(value) {
  return Number(String(value || "").replace(/[^\d]/g, ""));
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

async function fetchHtmlWithBestEffortParsing() {
  let html = await fetchInstagramProfileHtml();
  console.log('HTML snippet:', html.substring(0, 500));
  let extracted = extractCountersFromHtml(html);

  if (extracted.posts == null || extracted.followers == null) {
    try {
      const htmlEn = await fetchInstagramProfileHtml({
        "accept-language": "en-US,en;q=0.9",
      });
      mergePartialCounters(extracted, extractCountersFromHtml(htmlEn));
    } catch (_e) {
      // keep first HTML parse result
    }
  }

  return { extracted };
}

async function fetchFromProfileInfoApi(username) {
  const apiUrl = `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
  const responseText = await requestText(apiUrl, {
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "x-ig-app-id": "936619743392459",
    accept: "application/json",
  });
  console.log('API raw:', responseText.substring(0, 300));
  const json = JSON.parse(responseText);
  const user = json?.data?.user;
  return {
    posts: user?.edge_owner_to_timeline_media?.count ?? null,
    followers: user?.edge_followed_by?.count ?? null,
  };
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

app.get("/api/instagram-stats", async (_req, res) => {
  try {
    const { extracted } = await fetchHtmlWithBestEffortParsing();
    let currentPosts = extracted.posts;
    let currentFollowers = extracted.followers;

    if (currentPosts == null || currentFollowers == null) {
      try {
        const fromProfileApi = await fetchFromProfileInfoApi("romejkomart");
        if (currentPosts == null) {
          currentPosts = fromProfileApi.posts;
        }
        if (currentFollowers == null) {
          currentFollowers = fromProfileApi.followers;
        }
      } catch (_apiError) {
        // HTML already failed partially; API is last resort.
      }
    }

    if (currentPosts == null || currentFollowers == null) {
      throw new Error("Could not extract profile counters from page HTML");
    }

    res.json(buildMetrics(currentPosts, currentFollowers));
  } catch (error) {
    res.status(502).json({
      error: "Не удалось получить данные Instagram. Возможно, страница вернула нестандартную разметку.",
      details: error?.message || String(error),
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

app.listen(PORT, () => {
  console.log(`Instagram planner running on http://localhost:${PORT}`);
});
