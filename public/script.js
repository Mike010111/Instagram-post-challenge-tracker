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
  modal: document.getElementById("admin-modal"),
  modalClose: document.getElementById("modal-close"),
  modalImage: document.getElementById("modal-image"),
  modalTitle: document.getElementById("modal-title"),
  modalSubtitle: document.getElementById("modal-subtitle"),
  modalInput: document.getElementById("admin-secret-input"),
};

let lastFetchTimestamp = 0;
let isModalLocked = false;
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

function updateUI(data) {
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
  
  lastFetchTimestamp = new Date(data.lastUpdatedAt).getTime();
  applyRing(data.progressPercent);
}

async function fetchStats(url = "/api/instagram-stats") {
  const response = await fetch(url);
  const data = await response.json();

  if (!response.ok) {
    const message = [data.error, data.details].filter(Boolean).join(": ");
    throw { status: response.status, message: message || "Ошибка сервера" };
  }
  return data;
}

// Обычная загрузка данных (старт страницы)
async function loadData() {
  nodes.motivation.classList.remove("error");
  nodes.motivation.textContent = "Обновляю данные...";
  try {
    const data = await fetchStats();
    updateUI(data);
  } catch (error) {
    setError(`Не получилось обновить данные: ${error.message}`);
  }
}

// --- ЛОГИКА МОДАЛЬНОГО ОКНА ---

function setModalState(state) {
  nodes.modalInput.classList.remove("hidden");
  nodes.modalClose.classList.remove("hidden");
  nodes.modalSubtitle.classList.add("hidden");
  isModalLocked = false;

  if (state === "initial") {
    nodes.modalImage.src = "/images/IMG_1.png";
    nodes.modalTitle.textContent = "А вы кто?";
    nodes.modalInput.value = "";
  } else if (state === "error") {
    nodes.modalImage.src = "/images/IMG_2.png";
    nodes.modalTitle.textContent = "Доступ запрещен. Ожидайте обновление данных админом...";
    nodes.modalInput.value = "";
  } else if (state === "loading") {
    nodes.modalImage.src = "/images/IMG_3.jpg";
    nodes.modalTitle.textContent = "Пушка! Погнали делать контент :)";
    nodes.modalSubtitle.classList.remove("hidden");
    nodes.modalInput.classList.add("hidden");
    nodes.modalClose.classList.add("hidden");
    isModalLocked = true; // Запрещаем закрытие кликом мимо окна
  }
}

function openModal() {
  setModalState("initial");
  nodes.modal.classList.remove("hidden");
  setTimeout(() => nodes.modalInput.focus(), 100);
}

function closeModal() {
  if (isModalLocked) return;
  nodes.modal.classList.add("hidden");
}

// Закрытие по крестику и клику вне окна
nodes.modalClose.addEventListener("click", closeModal);
nodes.modal.addEventListener("click", (e) => {
  if (e.target === nodes.modal) closeModal();
});

// Обработка кнопки обновления
nodes.refreshButton.addEventListener("click", () => {
  const now = Date.now();
  // Если прошел час (3600000 мс) или данных вообще нет - грузим обычно
  if (!lastFetchTimestamp || now - lastFetchTimestamp >= 3600000) {
    loadData();
  } else {
    // Иначе запрашиваем пароль
    openModal();
  }
});

// Обработка ввода секретного имени
nodes.modalInput.addEventListener("keypress", async (e) => {
  if (e.key === "Enter") {
    const secret = nodes.modalInput.value.trim();
    if (!secret) return;

    setModalState("loading");
    const startTime = Date.now();

    try {
      const url = `/api/instagram-stats?force=true&secret=${encodeURIComponent(secret)}`;
      const data = await fetchStats(url);
      
      updateUI(data);

      // Гарантируем, что успешное окно видно минимум 1 секунду
      const elapsed = Date.now() - startTime;
      if (elapsed < 1000) {
        await new Promise(r => setTimeout(r, 1000 - elapsed));
      }
      
      isModalLocked = false;
      closeModal();
      
    } catch (error) {
      // Ошибка (403 Неверный пароль или 429 Лимит исчерпан)
      setModalState("error");
      if(error.status === 429) {
          nodes.modalTitle.textContent = error.message;
      }
    }
  }
});

loadData();