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

// Предзагрузка изображений
const preloadImages = ['/images/IMG_1.png', '/images/IMG_2.png', '/images/IMG_3.jpg'];
preloadImages.forEach(src => {
  const img = new Image();
  img.src = src;
});

let lastFetchTimestamp = 0;
let isModalLocked = false;
let currentModalState = null;

const ringRadius = 64;
const ringLength = 2 * Math.PI * ringRadius;
nodes.ring.style.strokeDasharray = `${ringLength}`;
nodes.ring.style.strokeDashoffset = `${ringLength}`;

// ---------- Вспомогательные функции (без изменений) ----------
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

async function fetchStats(url) {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) {
    const message = [data.error, data.details].filter(Boolean).join(": ");
    throw { status: response.status, message: message || "Ошибка сервера" };
  }
  return data;
}

async function loadData() {
  nodes.motivation.classList.remove("error");
  nodes.motivation.textContent = "Обновляю данные...";
  try {
    const data = await fetchStats("/api/instagram-stats");
    updateUI(data);
  } catch (error) {
    setError(`Не получилось обновить данные: ${error.message}`);
  }
}

// ---------- Модальное окно ----------
const modalNodes = {
  overlay: document.getElementById("admin-modal"),
  closeBtn: document.getElementById("modal-close"),
  img: document.getElementById("modal-img"),
  title: document.getElementById("modal-title"),
  desc: document.getElementById("modal-desc"),
  input: document.getElementById("admin-input"),
  content: document.querySelector(".modal-content"),
};

function setSpinner(show) {
  modalNodes.content.classList.toggle("locked", show);
}

function setCloseButtonDisabled(disabled) {
  modalNodes.closeBtn.classList.toggle("disabled", disabled);
}

function setModalLock(lock) {
  isModalLocked = lock;
  setCloseButtonDisabled(lock);
  modalNodes.input.disabled = lock;
}

function setModalState(state, errorMessage = "") {
  // Повторная ошибка – только анимация
  if (currentModalState === "error" && state === "error") {
    modalNodes.title.textContent = errorMessage || "Доступ запрещен. Попробуйте еще раз:";
    modalNodes.input.value = "";
    modalNodes.input.classList.remove("error-shake");
    void modalNodes.input.offsetWidth;
    modalNodes.input.classList.add("error-shake");
    modalNodes.input.focus();
    // Снимаем возможную блокировку
    setModalLock(false);
    setSpinner(false);
    return;
  }

  currentModalState = state;

  // Спиннер снимаем во всех состояниях, кроме явного ожидания
  setSpinner(false);

  // Блокировка закрытия
  const closeLocked = (state === "loading");
  setModalLock(closeLocked);

  if (state === "initial") {
    modalNodes.img.src = "/images/IMG_1.png";
    modalNodes.title.textContent = "А вы кто?";
    modalNodes.desc.classList.add("hidden");
    modalNodes.input.classList.remove("hidden", "error-shake");
    modalNodes.input.value = "";
    setTimeout(() => modalNodes.input.focus(), 50);
  } 
  else if (state === "error") {
    modalNodes.img.src = "/images/IMG_2.png";
    modalNodes.title.textContent = errorMessage || "Доступ запрещен. Попробуйте еще раз:";
    modalNodes.desc.classList.add("hidden");
    modalNodes.input.classList.remove("hidden");
    modalNodes.input.value = "";
    modalNodes.input.classList.remove("error-shake");
    void modalNodes.input.offsetWidth;
    modalNodes.input.classList.add("error-shake");
    modalNodes.input.focus();
  } 
  else if (state === "loading") {
    modalNodes.img.src = "/images/IMG_3.jpg";
    modalNodes.title.textContent = "Пушка! Погнали делать контент :)";
    modalNodes.desc.classList.remove("hidden");
    modalNodes.input.classList.add("hidden");
  }
}

function openModal() {
  setModalState("initial");
  modalNodes.overlay.classList.remove("hidden");
}

function closeModal() {
  if (isModalLocked) return;
  modalNodes.overlay.classList.add("hidden");
  // Сброс блокировок при закрытии
  setModalLock(false);
  setSpinner(false);
}

modalNodes.closeBtn.addEventListener("click", closeModal);
modalNodes.overlay.addEventListener("click", (e) => {
  if (e.target === modalNodes.overlay) closeModal();
});

// Основной обработчик Enter
modalNodes.input.addEventListener("keypress", async (e) => {
  if (e.key !== "Enter") return;

  const secret = modalNodes.input.value.trim();
  if (!secret) return;

  // --- Фаза 1: проверка секрета (со спиннером) ---
  setSpinner(true);
  setModalLock(true);
  modalNodes.input.disabled = true;

  try {
    // Быстрый запрос проверки секрета
    const checkRes = await fetch(`/api/check-secret?secret=${encodeURIComponent(secret)}`);
    if (!checkRes.ok) {
      // Секрет неверный – переходим в ошибку
      throw { status: checkRes.status, message: "Доступ запрещен. Вы не админ!" };
    }

    // Секрет верен – сразу показываем "Пушка!" без спиннера
    setModalState("loading");  // здесь спиннер уже снят, крестик заблокирован

    // --- Фаза 2: запуск обновления данных (без спиннера) ---
    const dataUrl = `/api/instagram-stats?force=true&secret=${encodeURIComponent(secret)}`;
    const data = await fetchStats(dataUrl);
    updateUI(data);

    // После обновления закрываем окно (без задержки)
    setModalLock(false);
    closeModal();

  } catch (error) {
    // Ошибка на любом этапе (кроме успеха): убираем спиннер и показываем ошибку
    setSpinner(false);
    const errorMsg = error.message || "Ошибка обновления";
    if (currentModalState === "initial") {
      setModalState("error", errorMsg);
    } else {
      // Уже в ошибке – просто обновляем текст и анимацию
      setModalState("error", errorMsg);
    }
  }
});

// Сброс красной обводки при вводе
modalNodes.input.addEventListener("input", () => {
  modalNodes.input.classList.remove("error-shake");
});

nodes.refreshButton.addEventListener("click", openModal);

// Первичная загрузка
loadData();