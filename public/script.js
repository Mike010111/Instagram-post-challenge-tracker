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
  stateInitial: document.getElementById("state-initial"),
  stateError: document.getElementById("state-error"),
  stateLoading: document.getElementById("state-loading"),
};

let lastFetchTimestamp = 0;
let isModalLocked = false;
let currentModalState = null;          // 'initial', 'error', 'loading'
let loadingTimer = null;              // для отложенного показа loading
const ringRadius = 64;
const ringLength = 2 * Math.PI * ringRadius;
nodes.ring.style.strokeDasharray = `${ringLength}`;
nodes.ring.style.strokeDashoffset = `${ringLength}`;

// ---------- Вспомогательные функции ----------
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

// --- Модальное окно (без мерцания) ---

// Возвращает видимый инпут (если есть), иначе null
function getVisibleInput() {
  // Ищем в активном блоке (initial или error)
  return document.querySelector(
    '#state-initial[style*="display: block"] .admin-secret-input, ' +
    '#state-error[style*="display: block"] .admin-secret-input'
  );
}

// Синхронно показывает нужный блок
function applyModalState(state) {
  // Скрываем все
  nodes.stateInitial.style.display = "none";
  nodes.stateError.style.display = "none";
  nodes.stateLoading.style.display = "none";

  // Показываем нужный
  if (state === "initial") {
    nodes.stateInitial.style.display = "block";
  } else if (state === "error") {
    nodes.stateError.style.display = "block";
  } else if (state === "loading") {
    nodes.stateLoading.style.display = "block";
  }

  // Управление крестиком
  if (state === "loading") {
    nodes.modalClose.classList.add("hidden");
    isModalLocked = true;
  } else {
    nodes.modalClose.classList.remove("hidden");
    isModalLocked = false;
  }

  currentModalState = state;
}

// Очищает поле ввода и ставит фокус (только если state = initial/error)
function clearVisibleInput() {
  if (currentModalState === "initial" || currentModalState === "error") {
    const input = getVisibleInput();
    if (input) {
      input.value = "";
      // Небольшая задержка, чтобы фокус точно установился после переключения
      setTimeout(() => input.focus(), 100);
    }
  }
}

// Главная функция смены состояния
function setModalState(state) {
  // Отменяем запланированный показ loading, если он был
  if (loadingTimer) {
    clearTimeout(loadingTimer);
    loadingTimer = null;
  }

  // Если состояние не меняется и не loading – просто очищаем ввод
  if (state === currentModalState && state !== "loading") {
    clearVisibleInput();
    return;
  }

  // Для loading – отложенный показ
  if (state === "loading") {
    loadingTimer = setTimeout(() => {
      applyModalState("loading");
      loadingTimer = null;
    }, 250);
    return;
  }

  // Мгновенное переключение для initial / error
  applyModalState(state);
  clearVisibleInput();
}

function openModal() {
  setModalState("initial");
  nodes.modal.classList.remove("hidden");
}

function closeModal() {
  if (isModalLocked) return;
  nodes.modal.classList.add("hidden");
  if (loadingTimer) {
    clearTimeout(loadingTimer);
    loadingTimer = null;
  }
}

// Закрытие по крестику и клику вне окна
nodes.modalClose.addEventListener("click", closeModal);
nodes.modal.addEventListener("click", (e) => {
  if (e.target === nodes.modal) closeModal();
});

// Обработка Enter
nodes.modal.addEventListener("keypress", async (e) => {
  if (e.key !== "Enter") return;

  // Проверяем, что событие пришло от видимого поля ввода
  const activeInput = getVisibleInput();
  if (!activeInput || e.target !== activeInput) return;

  const secret = activeInput.value.trim();
  if (!secret) return;

  // Запускаем отложенный loading и сразу выполняем запрос
  setModalState("loading");
  const startTime = Date.now();

  try {
    const url = `/api/instagram-stats?force=true&secret=${encodeURIComponent(secret)}`;
    const data = await fetchStats(url);
    updateUI(data);

    // Если loading успел показаться, держим его минимум 1 секунду
    if (currentModalState === "loading") {
      const elapsed = Date.now() - startTime;
      if (elapsed < 1000) {
        await new Promise(r => setTimeout(r, 1000 - elapsed));
      }
    }
    isModalLocked = false;
    closeModal();
  } catch (error) {
    setModalState("error");
    if (error.status === 429) {
      const errorBlock = document.getElementById("state-error"); // надёжно получаем блок ошибки
      const h3 = errorBlock.querySelector("h3");
      if (h3) h3.textContent = error.message;
    }
    // Для других ошибок заголовок остаётся "Доступ запрещен..."
  }
});

// Кнопка "Обновить сейчас"
nodes.refreshButton.addEventListener("click", () => {
  openModal();
});

// Первичная загрузка
loadData();