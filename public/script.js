const nodes = {
  followers: document.getElementById("followers"),
  followersGrowth: document.getElementById("followers-growth"),
  posts: document.getElementById("posts"),
  remaining: document.getElementById("remaining"),
  daysRemaining: document.getElementById("days-remaining"),
  avgCurrent: document.getElementById("avg-current"),
  avgRequired: document.getElementById("avg-required"),
  postedThisYear: document.getElementById("posted-this-year"),
  motivation: document.getElementById("motivation"),
  updatedAt: document.getElementById("updated-at"),
  refreshButton: document.getElementById("refresh-button"),
  ring: document.getElementById("ring-progress"),
};

const ringRadius = 64;
const ringLength = 2 * Math.PI * ringRadius;
nodes.ring.style.strokeDasharray = `${ringLength}`;
nodes.ring.style.strokeDashoffset = `${ringLength}`;

function formatInt(value) {
  return new Intl.NumberFormat("ru-RU").format(value);
}

function formatSignedInt(value) {
  if (value > 0) return `+${formatInt(value)}`;
  return formatInt(value);
}

function formatAvg(value) {
  return Number(value).toLocaleString("ru-RU", {
    minimumFractionDigits: value >= 1 ? 1 : 2,
    maximumFractionDigits: value >= 1 ? 2 : 3,
  });
}

function ringColor(progressPercent) {
  if (progressPercent < 35) return "#f05b49";
  if (progressPercent < 70) return "#f18d2e";
  return "#2ca17c";
}

function applyRing(progressPercent) {
  const clamped = Math.max(0, Math.min(100, progressPercent));
  const offset = ringLength * (1 - clamped / 100);
  nodes.ring.style.strokeDashoffset = String(offset);
  nodes.ring.style.stroke = ringColor(clamped);
}

function setError(message) {
  nodes.motivation.textContent = message;
  nodes.motivation.classList.add("error");
}

async function loadData() {
  nodes.motivation.classList.remove("error");
  nodes.motivation.textContent = "Обновляю данные...";
  try {
    const response = await fetch("/api/instagram-stats");
    const data = await response.json();

    if (!response.ok) {
      const message = [data.error, data.details].filter(Boolean).join(": ");
      throw new Error(message || "Ошибка сервера");
    }

    nodes.followers.textContent = formatInt(data.currentFollowers);
    nodes.followersGrowth.textContent = formatSignedInt(data.followersGrowth);
    nodes.posts.textContent = formatInt(data.currentPosts);
    nodes.remaining.textContent = formatInt(data.remainingPosts);
    nodes.daysRemaining.textContent = formatInt(data.daysRemainingInclusive);
    nodes.avgCurrent.textContent = `${formatAvg(data.currentAvgPostsPerDay)} / день`;
    nodes.avgRequired.textContent = `${formatAvg(data.requiredAvgPostsPerDay)} / день`;
    nodes.postedThisYear.textContent = formatInt(data.postedThisYear);
    nodes.motivation.textContent = data.motivation;
    nodes.updatedAt.textContent = `Обновлено: ${new Date(data.lastUpdatedAt).toLocaleString("ru-RU")}`;
    applyRing(data.progressPercent);
  } catch (error) {
    setError(`Не получилось обновить данные: ${error.message}`);
  }
}

nodes.refreshButton.addEventListener("click", loadData);
loadData();
