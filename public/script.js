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

// Предзагрузка изображений модального окна в кэш браузера для мгновенного переключения
const preloadImages = ['/images/IMG_1.png', '/images/IMG_2.png', '/images/IMG_3.jpg'];
preloadImages.forEach(src => {
  const img = new Image();
  img.src = src;
});

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

// --- Модальное окно (State Machine) ---
const modalNodes = {
  overlay: document.getElementById("admin-modal"),
  closeBtn: document.getElementById("modal-close"),
  img: document.getElementById("modal-img"),
  title: document.getElementById("modal-title"),
  desc: document.getElementById("modal-desc"),
  input: document.getElementById("admin-input"),
};

let loadingVisualTimeout = null;

function setModalState(state, errorMessage = "") {
  // Если мы уже в состоянии ошибки и пытаемся снова вызвать ошибку
  // Если мы уже в состоянии ошибки и пытаемся снова вызвать ошибку
  if (state === "error" && currentModalState === "error") {
    modalNodes.input.value = ""; 
    
    // Перезапускаем анимацию тряски
    modalNodes.input.classList.remove("error-shake");
    void modalNodes.input.offsetWidth; 
    modalNodes.input.classList.add("error-shake");
    
    modalNodes.input.focus();
    return;
  }

  currentModalState = state;

  if (state === "initial") {
    modalNodes.img.src = "/images/IMG_1.png";
    modalNodes.title.textContent = "А вы кто?";
    modalNodes.desc.classList.add("hidden");
    modalNodes.input.classList.remove("hidden");
    modalNodes.closeBtn.classList.remove("hidden");
    modalNodes.input.value = "";
    setTimeout(() => modalNodes.input.focus(), 50);
    isModalLocked = false;
  } 
  else if (state === "error") {
    modalNodes.img.src = "/images/IMG_2.png";
    modalNodes.title.textContent = errorMessage || "Доступ запрещен. Попробуйте еще раз:";
    modalNodes.desc.classList.add("hidden");
    modalNodes.input.classList.remove("hidden");
    modalNodes.closeBtn.classList.remove("hidden");
    modalNodes.input.value = "";
    
    // Удаляем класс, триггерим reflow и добавляем класс заново для повторного воспроизведения анимации
    modalNodes.input.classList.remove("error-shake");
    void modalNodes.input.offsetWidth; 
    modalNodes.input.classList.add("error-shake");
    
    modalNodes.input.focus();
    isModalLocked = false;
  } 
  else if (state === "loading") {
    modalNodes.img.src = "/images/IMG_3.jpg";
    modalNodes.title.textContent = "Пушка! Погнали делать контент :)";
    modalNodes.desc.classList.remove("hidden");
    modalNodes.input.classList.add("hidden");
    modalNodes.closeBtn.classList.add("hidden");
    isModalLocked = true;
  }
}

function openModal() {
  setModalState("initial");
  modalNodes.overlay.classList.remove("hidden");
}

function closeModal() {
  if (isModalLocked) return;
  modalNodes.overlay.classList.add("hidden");
}

// Слушатели закрытия
modalNodes.closeBtn.addEventListener("click", closeModal);
modalNodes.overlay.addEventListener("click", (e) => {
  if (e.target === modalNodes.overlay) closeModal();
});

// Обработка Enter
modalNodes.input.addEventListener("keypress", async (e) => {
  if (e.key !== "Enter") return;

  const secret = modalNodes.input.value.trim();
  if (!secret) return;

  const startTime = Date.now();
  
  // Устанавливаем таймер: если через 250мс сервер не ответил (значит пароль верный и идет долгий Apify),
  // то показываем Содержимое 3. Если ответил быстро (ошибка) — отменяем таймер.
  loadingVisualTimeout = setTimeout(() => {
    setModalState("loading");
  }, 400);  

  try {
    const url = `/api/instagram-stats?force=true&secret=${encodeURIComponent(secret)}`;
    const data = await fetchStats(url);
    
    // Если запрос прошел успешно (200 OK)
    clearTimeout(loadingVisualTimeout); // На всякий случай
    setModalState("loading"); // Гарантируем, что успех показан
    updateUI(data);

    const elapsed = Date.now() - startTime;
    if (elapsed < 1000) {
      await new Promise(r => setTimeout(r, 1000 - elapsed));
    }
    
    isModalLocked = false;
    closeModal();
  } catch (error) {
    // Ошибка пришла быстро — отменяем показ Loading
    clearTimeout(loadingVisualTimeout);
    
    const errorMsg = (error.status === 403) ? "Доступ запрещен. Вы не админ!" : error.message;
    setModalState("error", errorMsg);
  }
});

modalNodes.input.addEventListener("input", () => {
  modalNodes.input.classList.remove("error-shake");
});

nodes.refreshButton.addEventListener("click", openModal);

// Первичная загрузка
loadData();