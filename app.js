import { firebaseConfig, firebaseVapidKey } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth, onAuthStateChanged, createUserWithEmailAndPassword,
  signInWithEmailAndPassword, signOut, deleteUser
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, addDoc, deleteDoc,
  collection, query, where, orderBy, limit, onSnapshot,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js";
import { getMessaging, getToken, onMessage, isSupported } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-messaging.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = {
  auth: null, db: null, functions: null, user: null, profile: null, wallet: null,
  tournaments: [], notices: [], banners: [], notifications: [], transactions: [],
  registrations: [], rankHistory: [], messages: [], support: [], paymentMethods: null,
  unsubscribers: [], chatUnsubscribe: null, currentPage: "home", notificationFilter: "all",
  blockedUsers: new Set(JSON.parse(localStorage.getItem("vt_blocked_users") || "[]")),
  messaging: null, firebaseReady: false, photoUrl: null, supportUnsubscribe: null,
  creatingAccount: false, activeUid: null, lastRankName: null, lastVipLevel: null
};

const rankLevels = [
  { name: "Bronze", points: 100, icon: "♜" },
  { name: "Silver", points: 300, icon: "♖" },
  { name: "Gold", points: 600, icon: "♛" },
  { name: "Platinum", points: 1000, icon: "✥" },
  { name: "Diamond", points: 1600, icon: "◆" },
  { name: "Heroic", points: 2400, icon: "✦" },
  { name: "Grandmaster", points: 3500, icon: "♕" }
];

function firebaseConfigured() {
  return Boolean(firebaseConfig.apiKey && !firebaseConfig.apiKey.startsWith("YOUR_") &&
    firebaseConfig.projectId && !firebaseConfig.projectId.startsWith("YOUR_"));
}

function toast(message, type = "info") {
  const region = $("#toast-region");
  const item = document.createElement("div");
  item.className = `toast ${type}`;
  item.textContent = message;
  region.append(item);
  window.setTimeout(() => item.remove(), 4200);
}

function friendlyError(error) {
  const code = error?.code || "";
  const map = {
    "auth/invalid-email": "Enter a valid email address.",
    "auth/user-not-found": "No account exists with this email.",
    "auth/wrong-password": "The password is incorrect.",
    "auth/invalid-credential": "Email or password is incorrect.",
    "auth/email-already-in-use": "This email is already registered.",
    "auth/weak-password": "Use a stronger password with at least 8 characters.",
    "auth/too-many-requests": "Too many attempts. Please try again later.",
    "auth/network-request-failed": "Network error. Check your connection.",
    "permission-denied": "This action is not permitted for your account.",
    "functions/failed-precondition": error.message || "This action is not available for your account.",
    "functions/resource-exhausted": "The available limit has been reached.",
    "functions/already-exists": error.message || "This item has already been registered."
  };
  return map[code] || error?.message || "Something went wrong. Please try again.";
}

function setBusy(button, busy, busyText = "PLEASE WAIT…") {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.disabled = true;
    button.textContent = busyText;
  } else {
    button.disabled = false;
    if (button.dataset.originalText) button.textContent = button.dataset.originalText;
  }
}

function initials(value = "VT") {
  return String(value).trim().split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase() || "VT";
}

function formatMoney(value) {
  const amount = Number(value || 0);
  return `৳${amount.toLocaleString("en-BD", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(value, includeTime = false) {
  if (!value) return "Date unavailable";
  const date = value?.toDate ? value.toDate() : new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  const options = includeTime
    ? { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }
    : { day: "numeric", month: "short", year: "numeric" };
  return new Intl.DateTimeFormat("en-BD", options).format(date);
}

function timestampValue(value) {
  if (!value) return 0;
  if (value.toMillis) return value.toMillis();
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function esc(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

function initialsColor(uid = "") {
  const palette = ["#355d8b", "#6452a4", "#287b83", "#8a4b74", "#80632e"];
  let hash = 0;
  for (const char of String(uid)) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return palette[Math.abs(hash) % palette.length];
}

function updateAvatars() {
  const nickname = state.profile?.nickname || state.user?.email?.split("@")[0] || "Player";
  const avatarText = initials(nickname);
  $$('[data-avatar]').forEach((node) => {
    node.innerHTML = "";
    node.style.background = `linear-gradient(135deg,${initialsColor(state.user?.uid)},#28294f)`;
    if (state.photoUrl) {
      const image = document.createElement("img");
      image.src = state.photoUrl;
      image.alt = "Player profile";
      node.append(image);
    } else {
      node.textContent = avatarText;
    }
  });
}

function showAuth(mode = "login") {
  $("#auth-screen").classList.remove("hidden");
  $("#app-shell").classList.add("hidden");
  $("#ban-screen").classList.add("hidden");
  const signup = mode === "signup";
  $("#login-form").classList.toggle("hidden", signup);
  $("#signup-form").classList.toggle("hidden", !signup);
  $("#auth-title").textContent = signup ? "Create your player ID" : "Welcome back";
  $("#auth-subtitle").textContent = signup ? "Register once, then enter the arena." : "Sign in to continue to your player account.";
}

function showApp() {
  $("#auth-screen").classList.add("hidden");
  $("#app-shell").classList.remove("hidden");
  $("#ban-screen").classList.add("hidden");
  showPage(state.currentPage || "home");
}

function showPage(page) {
  const target = $(`[data-page="${page}"]`);
  if (!target) return;
  state.currentPage = page;
  $$(".page").forEach((node) => node.classList.toggle("active", node.dataset.page === page));
  $$('[data-page-target]').forEach((node) => node.classList.toggle("active", node.dataset.pageTarget === page));
  $("#page-heading").textContent = page.toUpperCase();
  if (page === "chat") startChatFeed();
  if (page === "wallet") loadWalletActivity();
  if (page === "support") loadSupportHistory();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function openModal(html) {
  $("#modal-content").innerHTML = html;
  $("#modal-root").classList.remove("hidden");
  $("#modal-root").setAttribute("aria-hidden", "false");
  const first = $("input,select,textarea,button", $("#modal-content"));
  first?.focus({ preventScroll: true });
}

function closeModal() {
  $("#modal-root").classList.add("hidden");
  $("#modal-root").setAttribute("aria-hidden", "true");
  $("#modal-content").innerHTML = "";
}

function cleanupSubscriptions() {
  state.unsubscribers.forEach((unsubscribe) => {
    try { unsubscribe(); } catch (error) { console.warn("Subscription cleanup:", error); }
  });
  state.unsubscribers = [];
  if (state.chatUnsubscribe) state.chatUnsubscribe();
  state.chatUnsubscribe = null;
  if (state.supportUnsubscribe) state.supportUnsubscribe();
  state.supportUnsubscribe = null;
}

function startAuthListeners(user) {
  cleanupSubscriptions();
  const uid = user.uid;
  const addSubscription = (unsubscribe) => state.unsubscribers.push(unsubscribe);

  addSubscription(onSnapshot(doc(state.db, "users", uid), (snapshot) => {
    if (!snapshot.exists()) return;
    state.profile = snapshot.data();
    renderProfile();
    if (state.profile.isBanned === true || state.profile.accountStatus === "banned") showBanScreen(state.profile);
    else if (!$("#app-shell").classList.contains("hidden")) $("#ban-screen").classList.add("hidden");
  }, (error) => toast(friendlyError(error), "error")));

  addSubscription(onSnapshot(doc(state.db, "wallets", uid), (snapshot) => {
    state.wallet = snapshot.exists() ? snapshot.data() : { availableBalance: 0 };
    renderWallet();
  }, (error) => console.warn("Wallet listener:", error)));

  addSubscription(onSnapshot(query(collection(state.db, "tournaments"), where("status", "==", "published"), limit(50)), (snapshot) => {
    state.tournaments = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
      .filter((item) => item.isActive !== false)
      .sort((a, b) => timestampValue(a.startAt) - timestampValue(b.startAt));
    renderTournaments();
    renderFeaturedTournament();
  }, (error) => {
    console.warn("Tournament listener:", error);
    $("#tournament-list").innerHTML = '<div class="empty-inline">Unable to load tournaments. Check your connection and try again.</div>';
  }));

  addSubscription(onSnapshot(query(collection(state.db, "notices"), where("status", "==", "published"), limit(30)), (snapshot) => {
    state.notices = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
      .filter((item) => item.isActive !== false)
      .sort((a, b) => timestampValue(b.publishedAt || b.createdAt) - timestampValue(a.publishedAt || a.createdAt));
    renderNotices();
  }, (error) => console.warn("Notice listener:", error)));

  addSubscription(onSnapshot(query(collection(state.db, "banners"), where("status", "==", "published"), limit(10)), (snapshot) => {
    state.banners = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
      .filter((item) => item.isActive !== false)
      .sort((a, b) => timestampValue(b.publishedAt) - timestampValue(a.publishedAt));
    renderBanners();
  }, (error) => console.warn("Banner listener:", error)));

  addSubscription(onSnapshot(query(collection(state.db, "notifications"), where("uid", "==", uid), limit(60)), (snapshot) => {
    state.notifications = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
      .sort((a, b) => timestampValue(b.createdAt) - timestampValue(a.createdAt));
    renderNotifications();
  }, (error) => console.warn("Notification listener:", error)));

  addSubscription(onSnapshot(query(collection(state.db, "transactions"), where("uid", "==", uid), limit(80)), (snapshot) => {
    state.transactions = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
      .sort((a, b) => timestampValue(b.createdAt) - timestampValue(a.createdAt));
    renderTransactions();
  }, (error) => console.warn("Transaction listener:", error)));

  addSubscription(onSnapshot(query(collection(state.db, "registrations"), where("uid", "==", uid), limit(100)), (snapshot) => {
    state.registrations = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
      .sort((a, b) => timestampValue(b.createdAt) - timestampValue(a.createdAt));
    $("#home-joined").textContent = state.registrations.filter((item) => item.status !== "cancelled").length;
    renderTournamentHistory();
  }, (error) => console.warn("Registration listener:", error)));

  addSubscription(onSnapshot(query(collection(state.db, "rankHistory"), where("uid", "==", uid), limit(50)), (snapshot) => {
    state.rankHistory = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
      .sort((a, b) => timestampValue(b.createdAt) - timestampValue(a.createdAt));
    renderRankHistory();
  }, (error) => console.warn("Rank history listener:", error)));

  addSubscription(onSnapshot(doc(state.db, "publicConfig", "paymentMethods"), (snapshot) => {
    state.paymentMethods = snapshot.exists() ? snapshot.data() : null;
    renderPaymentMethods();
  }, (error) => console.warn("Payment configuration:", error)));

  loadLocalPhoto().then((value) => { state.photoUrl = value; updateAvatars(); });
  registerPushNotifications(false);
}

function renderProfile() {
  const profile = state.profile || {};
  const nickname = profile.nickname || state.user?.email?.split("@")[0] || "Player";
  $$('[data-user-nickname]').forEach((node) => node.textContent = nickname);
  $("#profile-fullname").textContent = profile.fullName || "Full name unavailable";
  $("#profile-ffuid").textContent = profile.ffUid || "—";
  $("#profile-firebase-uid").textContent = state.user?.uid || "—";
  $("#profile-email").textContent = state.user?.email || profile.email || "—";
  $("#profile-created").textContent = formatDate(state.user?.metadata?.creationTime || profile.createdAt);
  const points = Math.max(0, Number(profile.achievementPoints || 0));
  const rank = profile.rankName || "Unranked";
  const vip = profile.vipLevel || "PLAYER";
  if (state.lastRankName && state.lastRankName !== rank) {
    [$("#profile-rank"), $("#home-rank"), $("#profile-rank-icon")].forEach((node) => node.classList.add("rank-up-effect"));
    toast(`Rank upgraded: ${rank}`, "success");
    window.setTimeout(() => $$(".rank-up-effect").forEach((node) => node.classList.remove("rank-up-effect")), 1500);
  }
  if (state.lastVipLevel && state.lastVipLevel !== vip) {
    $("#profile-vip").classList.add("vip-unlock-effect");
    toast(`Membership updated: ${vip}`, "success");
    window.setTimeout(() => $("#profile-vip").classList.remove("vip-unlock-effect"), 1500);
  }
  state.lastRankName = rank;
  state.lastVipLevel = vip;
  const rankIndex = rankLevels.findIndex((item) => item.name.toLowerCase() === rank.toLowerCase());
  const next = rankLevels[rankIndex + 1] || rankLevels[0];
  const currentThreshold = rankIndex >= 0 ? rankLevels[rankIndex].points : 0;
  const nextThreshold = rankIndex >= 0 ? (rankLevels[rankIndex + 1]?.points || rankLevels[rankIndex].points) : rankLevels[0].points;
  const progress = Math.max(0, Math.min(100, nextThreshold === currentThreshold ? 100 : ((points - currentThreshold) / (nextThreshold - currentThreshold)) * 100));
  const rankIcon = rankIndex >= 0 ? rankLevels[rankIndex].icon : "♜";
  $("#profile-rank").textContent = rank;
  $("#profile-points").textContent = points.toLocaleString("en-BD");
  $("#profile-rank-icon").textContent = rankIcon;
  $("#profile-rank-progress").style.width = `${progress}%`;
  $("#profile-rank-next").textContent = rankIndex === rankLevels.length - 1 ? "Top rank achieved." : `${Math.max(0, nextThreshold - points)} points to ${next.name}.`;
  $("#home-rank").textContent = rank;
  $("#home-points").textContent = `${points.toLocaleString("en-BD")} achievement points`;
  $("#mini-rank-icon").textContent = rankIcon;
  $("#mini-rank-name").textContent = rank;
  $("#mini-rank-next").textContent = rankIndex === rankLevels.length - 1 ? "Top rank" : `Next: ${next.name}`;
  $("#mini-rank-points").textContent = rankIndex === -1 ? `${points} / ${rankLevels[0].points} points` : `${points} / ${nextThreshold} points`;
  $("#mini-rank-progress").style.width = `${progress}%`;
  $("#profile-vip").textContent = vip === "PLAYER" ? "Standard Player" : vip;
  $("#profile-vip-badge").textContent = vip;
  $("#home-vip").textContent = vip;
  $("#home-vip-sub").textContent = vip === "PLAYER" ? "Standard membership" : "Verified membership";
  $("#profile-vip-description").textContent = profile.vipDescription || "VIP 1 → VIP 2 → VIP 3 → VIP Elite. Membership is awarded through legitimate achievements and approved rewards, not excessive spending.";
  const vipProgress = Math.max(0, Math.min(100, Number(profile.vipProgress || 0)));
  $("#profile-vip-progress").style.width = `${vipProgress}%`;
  $("#profile-vip-progress-label").textContent = profile.nextVipLevel ? `${vipProgress}% progress to ${profile.nextVipLevel}` : "Membership progress is managed by verified achievements.";
  $("#welcome-date").innerHTML = `PLAYER STATUS <b>${profile.accountStatus === "active" ? "ACTIVE" : "PLAYER"}</b>`;
  updateAvatars();
}

function renderWallet() {
  const balance = Number(state.wallet?.availableBalance || 0);
  $("#home-balance").textContent = formatMoney(balance);
  $("#wallet-balance").textContent = formatMoney(balance);
  $("#profile-balance").textContent = formatMoney(balance);
}

function renderFeaturedTournament() {
  const slot = $("#featured-tournament");
  const event = state.tournaments.find((item) => item.registrationOpen === true && Number(item.availableSlots ?? item.totalSlots ?? 0) > 0) || state.tournaments[0];
  if (!event) {
    slot.innerHTML = '<div class="empty-inline">No tournaments available right now. Check back when a new event is published.</div>';
    return;
  }
  const banner = event.bannerUrl ? `<img src="${esc(event.bannerUrl)}" alt="${esc(event.name || "Tournament banner")}" loading="lazy">` : "VT";
  slot.innerHTML = `<article class="featured-card"><div class="featured-img">${banner}</div><div class="featured-info"><span class="eyebrow">${event.registrationOpen ? "REGISTRATION OPEN" : "PUBLISHED EVENT"}</span><h3>${esc(event.name || "Tournament")}</h3><p>${esc(event.description || "Official VER TOUR event")}</p><div class="event-meta"><span>${esc(event.gameMode || "Game mode TBA")}</span><span>${esc(event.mapName || "Map TBA")}</span><span>${formatDate(event.startAt, true)}</span></div></div><div class="featured-side"><strong>${Number(event.entryFee || 0) === 0 ? "FREE" : formatMoney(event.entryFee)}</strong><button class="btn btn-primary" data-join-event="${esc(event.id)}">VIEW EVENT ↗</button></div></article>`;
}

function tournamentStatus(event) {
  const slots = Number(event.availableSlots ?? event.totalSlots ?? 0);
  const startAt = timestampValue(event.startAt);
  if (event.registrationOpen === false) return "Closed";
  if (slots <= 0) return "Full";
  if (startAt && startAt < Date.now()) return "Started";
  return "Open";
}

function renderTournaments() {
  const queryText = $("#tournament-search").value.trim().toLowerCase();
  const filter = $("#tournament-status-filter").value;
  const events = state.tournaments.filter((event) => {
    const text = `${event.name || ""} ${event.gameMode || ""} ${event.mapName || ""}`.toLowerCase();
    const status = tournamentStatus(event).toLowerCase();
    const matchFilter = filter === "all" || (filter === "open" && status === "open") || (filter === "upcoming" && status !== "started") || (filter === "full" && status === "full");
    return text.includes(queryText) && matchFilter;
  });
  if (!events.length) {
    $("#tournament-list").innerHTML = '<div class="empty-inline">No tournaments available right now.<br>Only official events published by the organizer are shown.</div>';
    return;
  }
  $("#tournament-list").innerHTML = events.map((event) => {
    const slots = Math.max(0, Number(event.availableSlots ?? event.totalSlots ?? 0));
    const status = tournamentStatus(event);
    const banner = event.bannerUrl ? `<img src="${esc(event.bannerUrl)}" alt="${esc(event.name || "Tournament banner")}" loading="lazy">` : `<span>VER TOUR</span>`;
    const disabled = status !== "Open";
    return `<article class="tournament-card"><div class="tournament-image">${banner}<span class="event-status">${esc(status.toUpperCase())}</span></div><div class="tournament-body"><h3>${esc(event.name || "Untitled event")}</h3><p>${esc(event.description || "Official tournament information will be shown here.")}</p><div class="tournament-data"><div><span>GAME MODE</span><b>${esc(event.gameMode || "—")}</b></div><div><span>MAP</span><b>${esc(event.mapName || "—")}</b></div><div><span>DATE & TIME</span><b>${formatDate(event.startAt, true)}</b></div><div><span>ENTRY FEE</span><b>${Number(event.entryFee || 0) ? formatMoney(event.entryFee) : "FREE"}</b></div><div><span>AVAILABLE SLOTS</span><b>${slots}</b></div><div><span>RULES</span><b>${esc(event.rulesShort || "View details")}</b></div></div><div class="tournament-card-foot"><small>${esc(event.region || "VER TOUR official event")}</small><button class="btn ${disabled ? "btn-outline" : "btn-primary"}" data-join-event="${esc(event.id)}" ${disabled ? "disabled" : ""}>${disabled ? esc(status.toUpperCase()) : "VIEW & JOIN ↗"}</button></div></div></article>`;
  }).join("");
}

function renderNotices() {
  const latest = state.notices.slice(0, 3);
  const markup = (notice) => `<article class="notice-item">${notice.imageUrl ? `<img class="notice-image" src="${esc(notice.imageUrl)}" alt="${esc(notice.title || "Notice image")}" loading="lazy">` : '<div class="notice-icon">✦</div>'}<div><b>${esc(notice.title || "Official notice")}</b><p>${esc(notice.description || notice.message || "")}</p><small>${formatDate(notice.publishedAt || notice.createdAt)}</small></div></article>`;
  $("#home-notices").innerHTML = latest.length ? latest.map(markup).join("") : '<div class="empty-inline">No published notices right now.</div>';
  const all = $("#all-notices");
  if (all) all.innerHTML = state.notices.length ? state.notices.map(markup).join("") : '<div class="empty-inline">No official notices have been published.</div>';
}

function renderBanners() {
  const active = state.banners.filter((item) => !item.expiresAt || timestampValue(item.expiresAt) > Date.now());
  const container = $("#promo-banners");
  if (!container) return;
  if (!active.length) { container.innerHTML = ""; return; }
  container.innerHTML = active.slice(0, 3).map((banner) => `<a class="promo-banner" href="${banner.linkUrl && /^https:\/\//i.test(banner.linkUrl) ? esc(banner.linkUrl) : "#"}" ${banner.linkUrl && /^https:\/\//i.test(banner.linkUrl) ? 'target="_blank" rel="noopener noreferrer"' : ""}>${banner.imageUrl ? `<img src="${esc(banner.imageUrl)}" loading="lazy" alt="${esc(banner.title || "Promotion")}">` : ""}<span><b>${esc(banner.title || "VER TOUR EVENT")}</b><small>${esc(banner.description || "")}</small></span></a>`).join("");
}

function renderNotifications() {
  const unread = state.notifications.filter((item) => item.read !== true).length;
  ["#top-notice-count", "#mobile-notice-count", "#rail-notice-count"].forEach((selector) => {
    const node = $(selector);
    node.textContent = unread;
    node.classList.toggle("hidden", unread === 0);
  });
  const list = state.notifications.filter((item) => state.notificationFilter !== "unread" || item.read !== true);
  $("#notification-list").innerHTML = list.length ? list.map((item) => `<article class="notification-item ${item.read ? "" : "unread"}"><div class="notice-icon">${iconForNotification(item.type)}</div><div class="notification-copy"><b>${esc(item.title || "VER TOUR update")}</b><p>${esc(item.body || item.message || "You have a new update.")}</p><small>${formatDate(item.createdAt, true)}</small></div>${item.read ? "" : `<button data-mark-read="${esc(item.id)}">MARK READ</button>`}</article>`).join("") : '<div class="empty-inline">You are all caught up. New updates will appear here.</div>';
}

function iconForNotification(type = "") {
  if (type.includes("payment")) return "৳";
  if (type.includes("rank")) return "♛";
  if (type.includes("tournament")) return "▣";
  if (type.includes("ban")) return "!";
  return "✦";
}

function statusClass(status = "pending") {
  return `status-${String(status).toLowerCase()}`;
}

function renderTransactions() {
  const list = state.transactions;
  $("#transaction-list").innerHTML = list.length ? list.map((item) => `<article class="transaction-item"><div><b>${esc(item.title || transactionTitle(item.type))}</b><small>${formatDate(item.createdAt, true)} · ${esc(item.method || item.reference || item.type || "Wallet activity")}</small></div><div style="text-align:right"><b>${formatMoney(item.amount)}</b><span class="transaction-status ${statusClass(item.status)}">${esc((item.status || "pending").toUpperCase())}</span></div></article>`).join("") : '<div class="empty-inline">No transactions yet. Verified wallet activity will appear here.</div>';
}

function transactionTitle(type = "") {
  const titles = { deposit_request: "Add money request", tournament_entry: "Tournament entry", admin_adjustment: "Wallet adjustment" };
  return titles[type] || "Wallet transaction";
}

function renderPaymentMethods() {
  const methods = state.paymentMethods || {};
  const bkash = methods.bkash?.enabled === true;
  const nagad = methods.nagad?.enabled === true;
  $("#payment-method-status").innerHTML = `<span class="method-pill ${bkash ? "" : "off"}">bKash ${bkash ? "AVAILABLE" : "UNAVAILABLE"}</span><span class="method-pill ${nagad ? "" : "off"}">Nagad ${nagad ? "AVAILABLE" : "UNAVAILABLE"}</span>`;
}

function renderTournamentHistory() {
  if (!state.registrations.length) {
    $("#profile-history").innerHTML = '<div class="empty-inline">No tournament history yet. Join an official event to see your registration here.</div>';
    return;
  }
  $("#profile-history").innerHTML = state.registrations.map((item) => `<article class="history-item"><div><b>${esc(item.tournamentName || "VER TOUR event")}</b><small>${formatDate(item.createdAt, true)} · ${esc(item.gameMode || "Tournament")}</small></div><span class="history-status">${esc((item.status || "confirmed").toUpperCase())}</span></article>`).join("");
}

function renderRankHistory() {
  const list = $("#rank-history-list");
  if (!list) return;
  list.innerHTML = state.rankHistory.length ? state.rankHistory.map((item) => `<article class="history-item"><div><b>${esc(item.newRank || item.newVipLevel || "Achievement updated")}</b><small>${formatDate(item.createdAt, true)} · ${esc(item.reason || "Verified achievement")}</small></div><span class="history-status">${item.pointsAdded ? `+${Number(item.pointsAdded).toLocaleString("en-BD")} PTS` : "VIP UPDATE"}</span></article>`).join("") : '<div class="empty-inline">Verified rank changes will appear here.</div>';
}

function renderChat() {
  const visible = state.messages.filter((message) => !state.blockedUsers.has(message.uid));
  const box = $("#chat-messages");
  if (!visible.length) {
    box.innerHTML = '<div class="empty-inline">No messages yet. Start a friendly conversation with the community.</div>';
    return;
  }
  box.innerHTML = visible.map((message) => {
    const own = message.uid === state.user?.uid;
    const name = message.nickname || "Player";
    const badge = message.vipLevel && message.vipLevel !== "PLAYER" ? `<span class="vip-badge">${esc(message.vipLevel)}</span>` : "";
    const adminNotice = message.isAnnouncement === true;
    return `<article class="chat-message ${own ? "own" : ""} ${adminNotice ? "announcement" : ""}"><div class="avatar" style="background:linear-gradient(135deg,${initialsColor(message.uid)},#28294f)">${adminNotice ? "VT" : esc(initials(name))}</div><div class="chat-bubble-wrap"><div class="chat-meta"><b>${adminNotice ? "VER TOUR ADMIN" : esc(name)}</b>${badge}<small>${adminNotice ? "OFFICIAL" : esc(message.rankName || "Player")}</small><small>${formatDate(message.createdAt, true)}</small></div><div class="chat-bubble">${esc(message.text || "")}</div>${own ? `<button data-chat-action="delete" data-message-id="${esc(message.id)}" data-message-uid="${esc(message.uid)}">DELETE MESSAGE</button>` : (adminNotice ? "" : `<button data-chat-action="report" data-message-id="${esc(message.id)}" data-message-uid="${esc(message.uid)}">REPORT MESSAGE</button><button data-chat-action="block" data-message-id="${esc(message.id)}" data-message-uid="${esc(message.uid)}">BLOCK USER</button>`)}</div></article>`;
  }).join("");
  box.scrollTop = box.scrollHeight;
}

function renderSupport() {
  const list = state.support;
  $("#support-history").innerHTML = list.length ? list.map((item) => `<article class="support-item"><b>${esc(item.subject || "Support request")}</b><small>${esc(item.category || "other").toUpperCase()} · ${formatDate(item.createdAt, true)} · ${esc(item.status || "open")}</small><p>${esc(item.message || "")}</p>${item.adminReply ? `<div class="support-reply"><b>VER TOUR SUPPORT</b><br>${esc(item.adminReply)}</div>` : ""}</article>`).join("") : '<div class="empty-inline">No support requests yet.</div>';
}

function showBanScreen(profile) {
  $("#ban-reason").textContent = profile.banReason || "Not provided";
  $("#ban-date").textContent = formatDate(profile.banDate || profile.updatedAt, true);
  $("#ban-expiry").textContent = profile.banExpiresAt ? formatDate(profile.banExpiresAt, true) : "Until further notice";
  $("#ban-screen").classList.remove("hidden");
  $("#app-shell").classList.add("hidden");
}

function showJoinModal(eventId) {
  const event = state.tournaments.find((item) => item.id === eventId);
  if (!event) return toast("This tournament is no longer available.", "error");
  const fee = Number(event.entryFee || 0);
  const slots = Number(event.availableSlots ?? event.totalSlots ?? 0);
  const moneyEligible = state.profile?.realMoneyEligible === true && state.profile?.guardianAuthorizationVerified === true;
  const paidBlocked = fee > 0 && !moneyEligible;
  openModal(`<span class="modal-eyebrow">OFFICIAL TOURNAMENT</span><h2 id="modal-title">${esc(event.name || "Join tournament")}</h2><p>${esc(event.description || "Review the event information before continuing.")}</p><div class="modal-tournament-preview"><div><span>GAME MODE</span><b>${esc(event.gameMode || "—")}</b></div><div><span>MAP</span><b>${esc(event.mapName || "—")}</b></div><div><span>DATE</span><b>${formatDate(event.startAt, true)}</b></div><div><span>AVAILABLE SLOTS</span><b>${slots}</b></div><div><span>ENTRY FEE</span><b>${fee ? formatMoney(fee) : "FREE"}</b></div></div>${event.rules ? `<p><b>Rules:</b> ${esc(event.rules)}</p>` : ""}<p class="modal-note">${fee > 0 ? (paidBlocked ? "Paid entry is unavailable until age eligibility and parent/guardian authorization are verified by the trusted support process. Free tournaments remain available." : "Paid entry will be checked and processed by the trusted server. No betting or cash wagering is supported.") : "Registration is subject to account status, available slots, and server confirmation."}</p><div class="modal-form">${paidBlocked ? '<button class="btn btn-outline btn-full" data-open-support>CONTACT SUPPORT</button>' : `<button class="btn btn-primary btn-full" id="confirm-join" data-event-id="${esc(event.id)}">${fee ? "CONFIRM ENTRY" : "CONFIRM FREE REGISTRATION"} ↗</button>`}<button class="btn btn-outline btn-full" data-close-modal>CANCEL</button></div>`);
}

function showAddMoneyModal() {
  const moneyEligible = state.profile?.realMoneyEligible === true && state.profile?.guardianAuthorizationVerified === true;
  if (!moneyEligible) {
    openModal(`<span class="modal-eyebrow">PLAYER SAFETY</span><h2 id="modal-title">Wallet payments unavailable</h2><p>Real-money payment requests require verified age eligibility and parent/guardian authorization. These checks must be completed by the trusted VER TOUR support process. No payment number or payment request is shown until verification is complete.</p><div class="modal-form"><button class="btn btn-primary btn-full" data-open-support>CONTACT SUPPORT</button><button class="btn btn-outline btn-full" data-close-modal>CLOSE</button></div>`);
    return;
  }
  const methods = state.paymentMethods || {};
  const enabled = ["bkash", "nagad"].filter((key) => methods[key]?.enabled === true && String(methods[key]?.number || "").trim());
  const optionHtml = enabled.map((key) => `<option value="${key}">${key === "bkash" ? "bKash" : "Nagad"}</option>`).join("");
  if (!enabled.length) return toast("No payment methods are currently published. Please check again later.", "error");
  const initial = methods[enabled[0]] || {};
  openModal(`<span class="modal-eyebrow">WALLET REQUEST</span><h2 id="modal-title">Add money</h2><p>Payment instructions are loaded from the organizer's published Firebase settings. Never send your PIN or OTP.</p><form id="payment-request-form" class="modal-form"><label>Payment method<select id="payment-method">${optionHtml}</select></label><div class="modal-tournament-preview" id="payment-instructions"><div><span>PAYMENT NUMBER</span><b>${esc(initial.number || "Not published")}</b></div><p>${esc(initial.instructions || "Follow the current instructions provided by the organizer.")}</p></div><label>Amount (৳)<input id="payment-amount" type="number" min="1" max="10000" step="1" required placeholder="Enter amount"></label><label>Transaction ID<input id="payment-txn-id" maxlength="80" required placeholder="Enter the payment transaction ID"></label><p class="modal-note">Your request remains pending. Wallet balance is updated only after trusted verification. Real-money requests require eligibility and verified parent/guardian authorization.</p><button class="btn btn-primary btn-full" type="submit">SUBMIT FOR VERIFICATION ↗</button></form>`);
}

function showEditProfileModal() {
  const profile = state.profile || {};
  openModal(`<span class="modal-eyebrow">PLAYER SETTINGS</span><h2 id="modal-title">Edit profile</h2><form id="edit-profile-form" class="modal-form"><label>Nickname<input id="edit-nickname" maxlength="24" value="${esc(profile.nickname || "")}" required></label><label>Full name<input id="edit-fullname" maxlength="60" value="${esc(profile.fullName || "")}" required></label><p class="modal-note">Nickname changes are checked by a trusted Firebase function so duplicate names cannot be claimed.</p><button class="btn btn-primary btn-full" type="submit">SAVE PROFILE</button></form>`);
}

function showSupportShortcut() {
  if (!$("#ban-screen").classList.contains("hidden")) {
    openModal(`<span class="modal-eyebrow">ACCOUNT SUPPORT</span><h2 id="modal-title">Contact VER TOUR</h2><p>Your account is restricted, but you can still send an account-related support request.</p><form id="ban-support-form" class="modal-form"><label>Subject<input id="ban-support-subject" maxlength="100" required placeholder="Account access issue"></label><label>Message<textarea id="ban-support-message" rows="4" maxlength="2000" required placeholder="Describe the problem. Do not include passwords or OTPs."></textarea></label><button class="btn btn-primary btn-full" type="submit">SEND SUPPORT REQUEST</button></form>`);
    return;
  }
  closeModal();
  showPage("support");
}

function startChatFeed() {
  if (state.chatUnsubscribe || !state.user) return;
  const chatQuery = query(collection(state.db, "globalChat"), orderBy("createdAt", "desc"), limit(60));
  state.chatUnsubscribe = onSnapshot(chatQuery, (snapshot) => {
    state.messages = snapshot.docs.map((item) => ({ id: item.id, ...item.data() })).reverse();
    renderChat();
  }, (error) => {
    console.warn("Chat feed:", error);
    $("#chat-messages").innerHTML = '<div class="empty-inline">Global chat is unavailable right now.</div>';
  });
}

function loadSupportHistory() {
  const supportQuery = query(collection(state.db, "supportMessages"), where("uid", "==", state.user.uid), limit(50));
  if (state.supportUnsubscribe) return;
  const unsubscribe = onSnapshot(supportQuery, (snapshot) => {
    state.support = snapshot.docs.map((item) => ({ id: item.id, ...item.data() })).sort((a, b) => timestampValue(b.createdAt) - timestampValue(a.createdAt));
    renderSupport();
  }, (error) => console.warn("Support history:", error));
  state.supportUnsubscribe = unsubscribe;
  state.unsubscribers.push(unsubscribe);
}

function loadWalletActivity() {
  renderTransactions();
}

async function registerPushNotifications(askUser = true) {
  if (!state.user || !firebaseVapidKey || firebaseVapidKey.startsWith("YOUR_")) return;
  try {
    if (!(await isSupported())) return;
    let permission = Notification.permission;
    if (permission === "default" && askUser) permission = await Notification.requestPermission();
    if (permission !== "granted") return;
    const registration = await navigator.serviceWorker.register("./firebase-messaging-sw.js");
    const messaging = getMessaging(state.auth.app);
    state.messaging = messaging;
    const token = await getToken(messaging, { vapidKey: firebaseVapidKey, serviceWorkerRegistration: registration });
    if (token) {
      const tokenId = await shortHash(token);
      await setDoc(doc(state.db, "users", state.user.uid, "fcmTokens", tokenId), {
        token, platform: "webview", updatedAt: serverTimestamp()
      }, { merge: true });
    }
    onMessage(messaging, (payload) => {
      toast(payload.notification?.title ? `${payload.notification.title}: ${payload.notification.body || "New update"}` : "You have a new VER TOUR update.");
    });
  } catch (error) {
    console.warn("Push notifications:", error);
    if (askUser) toast("Push notification setup failed. You can still read updates in the app.", "error");
  }
}

async function shortHash(value) {
  const data = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].slice(0, 16).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function saveLocalPhoto(file) {
  if (!file || !file.type.startsWith("image/")) throw new Error("Choose a valid image file.");
  if (file.size > 8 * 1024 * 1024) throw new Error("Choose an image smaller than 8 MB.");
  const image = await createImageBitmap(file);
  const scale = Math.min(1, 500 / Math.max(image.width, image.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.78));
  if (!blob) throw new Error("Unable to process this image.");
  await idbPut("profile-photo", blob);
  state.photoUrl = URL.createObjectURL(blob);
  updateAvatars();
}

function openPhotoDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("ver-tour-local", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("assets");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbPut(key, value) {
  const db = await openPhotoDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("assets", "readwrite");
    transaction.objectStore("assets").put(value, key);
    transaction.oncomplete = () => { db.close(); resolve(); };
    transaction.onerror = () => { db.close(); reject(transaction.error); };
  });
}

async function loadLocalPhoto() {
  try {
    const db = await openPhotoDatabase();
    return await new Promise((resolve, reject) => {
      const request = db.transaction("assets", "readonly").objectStore("assets").get("profile-photo");
      request.onsuccess = () => { const blob = request.result; db.close(); resolve(blob ? URL.createObjectURL(blob) : null); };
      request.onerror = () => { db.close(); reject(request.error); };
    });
  } catch { return null; }
}

function checkBannedForAction() {
  if (state.profile?.isBanned === true || state.profile?.accountStatus === "banned") {
    showBanScreen(state.profile);
    toast("This account is restricted from player activities.", "error");
    return true;
  }
  return false;
}

async function handleSignup(event) {
  event.preventDefault();
  if (!state.firebaseReady) return toast("Add your Firebase configuration in js/firebase-config.js first.", "error");
  const button = $("button[type=submit]", event.currentTarget);
  const ffUid = $("#signup-ffuid").value.trim();
  const nickname = $("#signup-nickname").value.trim().replace(/\s+/g, " ");
  const fullName = $("#signup-fullname").value.trim();
  const email = $("#signup-email").value.trim().toLowerCase();
  const password = $("#signup-password").value;
  const confirm = $("#signup-confirm").value;
  if (!/^\d{5,24}$/.test(ffUid)) return toast("Enter a valid numeric Free Fire UID.", "error");
  if (nickname.length < 3 || nickname.length > 24 || !/^[\p{L}\p{N} _.-]+$/u.test(nickname)) return toast("Nickname must be 3–24 characters and use letters, numbers, spaces, dot, underscore, or hyphen.", "error");
  if (password.length < 8) return toast("Password must contain at least 8 characters.", "error");
  if (password !== confirm) return toast("Passwords do not match.", "error");
  setBusy(button, true, "CREATING ACCOUNT…");
  let credential = null;
  state.creatingAccount = true;
  try {
    credential = await createUserWithEmailAndPassword(state.auth, email, password);
    const createPlayerProfile = httpsCallable(state.functions, "createPlayerProfile");
    try {
      await createPlayerProfile({ ffUid, nickname, fullName });
    } catch (profileError) {
      // A callable response can be lost after the server commits. Check for the exact profile
      // before deleting the newly created Authentication account.
      const profileSnapshot = await getDoc(doc(state.db, "users", credential.user.uid));
      if (!profileSnapshot.exists() || profileSnapshot.data().ffUid !== ffUid) throw profileError;
    }
    state.creatingAccount = false;
    await activateAuthenticatedUser(credential.user);
    toast("Player account created successfully.", "success");
  } catch (error) {
    state.creatingAccount = false;
    if (credential?.user) {
      try { await deleteUser(credential.user); } catch (cleanupError) { console.warn("Account cleanup:", cleanupError); }
    }
    toast(friendlyError(error), "error");
  } finally {
    setBusy(button, false);
  }
}

async function handleLogin(event) {
  event.preventDefault();
  if (!state.firebaseReady) return toast("Add your Firebase configuration in js/firebase-config.js first.", "error");
  const button = $("button[type=submit]", event.currentTarget);
  setBusy(button, true, "SIGNING IN…");
  try {
    await signInWithEmailAndPassword(state.auth, $("#login-email").value.trim(), $("#login-password").value);
  } catch (error) {
    toast(friendlyError(error), "error");
  } finally {
    setBusy(button, false);
  }
}

async function handleJoin(eventId, button) {
  if (checkBannedForAction()) return;
  const event = state.tournaments.find((item) => item.id === eventId);
  if (!event || tournamentStatus(event) !== "Open") return toast("Registration is not available for this event.", "error");
  setBusy(button, true, "VERIFYING…");
  try {
    const joinTournament = httpsCallable(state.functions, "joinTournament");
    const result = await joinTournament({ tournamentId: eventId });
    closeModal();
    toast(result.data?.message || "Your registration has been confirmed.", "success");
  } catch (error) {
    toast(friendlyError(error), "error");
  } finally {
    setBusy(button, false);
  }
}

async function handlePaymentRequest(event) {
  event.preventDefault();
  if (checkBannedForAction()) return;
  const button = $("button[type=submit]", event.currentTarget);
  const method = $("#payment-method").value;
  const amount = Number($("#payment-amount").value);
  const transactionId = $("#payment-txn-id").value.trim();
  if (!Number.isFinite(amount) || amount < 1 || amount > 10000) return toast("Enter an amount between ৳1 and ৳10,000.", "error");
  if (transactionId.length < 5) return toast("Enter a valid transaction ID.", "error");
  setBusy(button, true, "SUBMITTING…");
  try {
    const submitPaymentRequest = httpsCallable(state.functions, "submitPaymentRequest");
    await submitPaymentRequest({ method, amount, transactionId });
    closeModal();
    toast("Payment request submitted. It will remain pending until verified.", "success");
  } catch (error) {
    toast(friendlyError(error), "error");
  } finally {
    setBusy(button, false);
  }
}

async function handleProfileUpdate(event) {
  event.preventDefault();
  const button = $("button[type=submit]", event.currentTarget);
  const nickname = $("#edit-nickname").value.trim();
  const fullName = $("#edit-fullname").value.trim();
  if (nickname.length < 3 || !fullName) return toast("Enter a valid nickname and full name.", "error");
  setBusy(button, true, "SAVING…");
  try {
    const updatePlayerProfile = httpsCallable(state.functions, "updatePlayerProfile");
    await updatePlayerProfile({ nickname, fullName });
    closeModal();
    toast("Profile updated successfully.", "success");
  } catch (error) {
    toast(friendlyError(error), "error");
  } finally {
    setBusy(button, false);
  }
}

async function handleChatSubmit(event) {
  event.preventDefault();
  if (checkBannedForAction()) return;
  const input = $("#chat-input");
  const text = input.value.trim();
  if (!text) return;
  if (text.length > 500) return toast("Messages can contain up to 500 characters.", "error");
  const button = $("button[type=submit]", event.currentTarget);
  setBusy(button, true, "SENDING…");
  try {
    await addDoc(collection(state.db, "globalChat"), {
      uid: state.user.uid,
      nickname: state.profile?.nickname || "Player",
      rankName: state.profile?.rankName || "Unranked",
      vipLevel: state.profile?.vipLevel || "PLAYER",
      text,
      createdAt: serverTimestamp()
    });
    input.value = "";
  } catch (error) {
    toast(friendlyError(error), "error");
  } finally {
    setBusy(button, false);
  }
}

async function handleSupportSubmit(event) {
  event.preventDefault();
  const button = $("button[type=submit]", event.currentTarget);
  const subject = $("#support-subject").value.trim();
  const message = $("#support-message").value.trim();
  if (!subject || message.length < 8) return toast("Please add a subject and a little more detail.", "error");
  setBusy(button, true, "SENDING…");
  try {
    await addDoc(collection(state.db, "supportMessages"), {
      uid: state.user.uid,
      category: $("#support-category").value,
      subject, message,
      status: "open",
      createdAt: serverTimestamp()
    });
    event.currentTarget.reset();
    toast("Support request sent. Replies will appear here.", "success");
  } catch (error) {
    toast(friendlyError(error), "error");
  } finally {
    setBusy(button, false);
  }
}

async function markNotificationRead(notificationId) {
  try {
    await updateDoc(doc(state.db, "notifications", notificationId), { read: true, readAt: serverTimestamp() });
  } catch (error) { toast(friendlyError(error), "error"); }
}

async function markAllNotificationsRead() {
  const unread = state.notifications.filter((item) => !item.read);
  if (!unread.length) return toast("All notifications are already read.");
  const button = $("#mark-all-read");
  setBusy(button, true, "UPDATING…");
  try {
    await Promise.all(unread.map((item) => updateDoc(doc(state.db, "notifications", item.id), { read: true, readAt: serverTimestamp() })));
    toast("All notifications marked as read.", "success");
  } catch (error) { toast(friendlyError(error), "error"); }
  finally { setBusy(button, false); }
}

async function handleChatAction(action, messageId, messageUid) {
  if (action === "delete" && messageUid === state.user.uid) {
    try { await deleteDoc(doc(state.db, "globalChat", messageId)); toast("Message deleted.", "success"); }
    catch (error) { toast(friendlyError(error), "error"); }
    return;
  }
  if (action === "block") {
    if (!messageUid || messageUid === state.user.uid) return;
    state.blockedUsers.add(messageUid);
    localStorage.setItem("vt_blocked_users", JSON.stringify([...state.blockedUsers]));
    renderChat();
    toast("Messages from this player are now hidden on this device.", "success");
    return;
  }
  if (action === "report") {
    openModal(`<span class="modal-eyebrow">COMMUNITY SAFETY</span><h2 id="modal-title">Report message</h2><p>Tell the moderation team why this message should be reviewed.</p><form id="report-form" class="modal-form"><label>Reason<select id="report-reason"><option value="spam">Spam or promotion</option><option value="harassment">Harassment</option><option value="scam">Scam or suspicious request</option><option value="personal_info">Personal information</option><option value="other">Other</option></select></label><label>Details<textarea id="report-details" maxlength="500" rows="3" placeholder="Optional details"></textarea></label><button class="btn btn-primary btn-full" type="submit">SUBMIT REPORT</button></form>`);
    $("#report-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await addDoc(collection(state.db, "chatReports"), {
          reporterUid: state.user.uid, messageId, reportedUid: messageUid,
          reason: $("#report-reason").value, details: $("#report-details").value.trim(),
          status: "open", createdAt: serverTimestamp()
        });
        closeModal(); toast("Report submitted to moderators.", "success");
      } catch (error) { toast(friendlyError(error), "error"); }
    });
  }
}

async function handleLogout() {
  try { cleanupSubscriptions(); await signOut(state.auth); }
  catch (error) { toast(friendlyError(error), "error"); }
}

function bindEvents() {
  document.addEventListener("click", (event) => {
    const pageButton = event.target.closest("[data-page-target]");
    if (pageButton) {
      const page = pageButton.dataset.pageTarget;
      if (page) showPage(page);
    }
    const authButton = event.target.closest("[data-auth-mode]");
    if (authButton) showAuth(authButton.dataset.authMode);
    const close = event.target.closest("[data-close-modal]");
    if (close) closeModal();
    const joinButton = event.target.closest("[data-join-event]");
    if (joinButton) showJoinModal(joinButton.dataset.joinEvent);
    const supportButton = event.target.closest("[data-open-support]");
    if (supportButton) showSupportShortcut();
    const toggle = event.target.closest("[data-toggle-password]");
    if (toggle) {
      const input = document.getElementById(toggle.dataset.togglePassword);
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      toggle.textContent = show ? "HIDE" : "SHOW";
    }
    const readButton = event.target.closest("[data-mark-read]");
    if (readButton) markNotificationRead(readButton.dataset.markRead);
    const chatAction = event.target.closest("[data-chat-action]");
    if (chatAction) handleChatAction(chatAction.dataset.chatAction, chatAction.dataset.messageId, chatAction.dataset.messageUid);
    const filterButton = event.target.closest("[data-notification-filter]");
    if (filterButton) {
      state.notificationFilter = filterButton.dataset.notificationFilter;
      $$('[data-notification-filter]').forEach((button) => button.classList.toggle("active", button === filterButton));
      renderNotifications();
    }
  });

  $("#login-form").addEventListener("submit", handleLogin);
  $("#signup-form").addEventListener("submit", handleSignup);
  $("#chat-form").addEventListener("submit", handleChatSubmit);
  $("#support-form").addEventListener("submit", handleSupportSubmit);
  $("#mark-all-read").addEventListener("click", markAllNotificationsRead);
  $("#tournament-search").addEventListener("input", renderTournaments);
  $("#tournament-status-filter").addEventListener("change", renderTournaments);
  $("#logout-btn").addEventListener("click", handleLogout);
  $("#rail-logout").addEventListener("click", handleLogout);
  $("#ban-logout").addEventListener("click", handleLogout);
  $("#edit-profile-btn").addEventListener("click", showEditProfileModal);
  $("#edit-profile-shortcut").addEventListener("click", showEditProfileModal);
  $("#add-money-btn").addEventListener("click", showAddMoneyModal);
  $("#change-photo-btn").addEventListener("click", () => $("#profile-photo-input").click());
  $("#profile-photo-input").addEventListener("change", async (event) => {
    try { await saveLocalPhoto(event.target.files?.[0]); toast("Profile photo saved on this device.", "success"); }
    catch (error) { toast(error.message || "Unable to save photo.", "error"); }
    event.target.value = "";
  });
  $("#enable-notifications").addEventListener("click", () => registerPushNotifications(true));
  $("#connection-status").addEventListener("click", () => toast(navigator.onLine ? "Your device is online." : "You appear to be offline.", navigator.onLine ? "success" : "error"));
  $("#modal-content").addEventListener("submit", (event) => {
    if (event.target.id === "payment-request-form") handlePaymentRequest(event);
    if (event.target.id === "edit-profile-form") handleProfileUpdate(event);
    if (event.target.id === "ban-support-form") {
      event.preventDefault();
      const subject = $("#ban-support-subject").value.trim();
      const message = $("#ban-support-message").value.trim();
      if (!subject || message.length < 8) return toast("Please provide more detail.", "error");
      const button = $("button[type=submit]", event.target);
      setBusy(button, true, "SENDING…");
      addDoc(collection(state.db, "supportMessages"), {
        uid: state.user.uid, category: "account", subject, message,
        status: "open", createdAt: serverTimestamp()
      }).then(() => { closeModal(); toast("Account support request sent.", "success"); })
        .catch((error) => toast(friendlyError(error), "error"))
        .finally(() => setBusy(button, false));
    }
  });
  $("#modal-content").addEventListener("click", (event) => {
    const button = event.target.closest("#confirm-join");
    if (button) handleJoin(button.dataset.eventId, button);
  });
  $("#modal-content").addEventListener("change", (event) => {
    if (event.target.id === "payment-method") {
      const method = state.paymentMethods?.[event.target.value] || {};
      $("#payment-instructions").innerHTML = `<div><span>PAYMENT NUMBER</span><b>${esc(method.number || "Not published")}</b></div><p>${esc(method.instructions || "Follow the current instructions provided by the organizer.")}</p>`;
    }
  });
  window.addEventListener("online", () => { $("#connection-status").innerHTML = '<span class="connection-dot"></span><span>ONLINE</span>'; });
  window.addEventListener("offline", () => { $("#connection-status").innerHTML = '<span class="connection-dot" style="background:var(--red)"></span><span>OFFLINE</span>'; });
}

async function activateAuthenticatedUser(user) {
  if (state.activeUid === user.uid) return;
  state.activeUid = user.uid;
  state.user = user;
  try {
    const profileSnapshot = await getDoc(doc(state.db, "users", user.uid));
    if (!profileSnapshot.exists()) {
      state.activeUid = null;
      toast("Your player profile could not be found. Contact support.", "error");
      await signOut(state.auth);
      return;
    }
    state.profile = profileSnapshot.data();
    showApp();
    startAuthListeners(user);
    renderProfile();
    renderWallet();
  } catch (error) {
    state.activeUid = null;
    showAuth("login");
    toast(friendlyError(error), "error");
  } finally {
    $("#app-loader").classList.add("hidden");
  }
}

async function init() {
  bindEvents();
  $("#welcome-date").innerHTML = `PLAYER STATUS <b>CONNECTING</b>`;
  if (!firebaseConfigured()) {
    $("#app-loader").classList.add("hidden");
    showAuth("login");
    toast("Setup required: add Firebase values in js/firebase-config.js.", "error");
    return;
  }
  try {
    const app = initializeApp(firebaseConfig);
    state.auth = getAuth(app);
    state.db = getFirestore(app);
    state.functions = getFunctions(app, "asia-south1");
    state.firebaseReady = true;
    onAuthStateChanged(state.auth, async (user) => {
      state.user = user;
      if (!user) {
        state.activeUid = null;
        cleanupSubscriptions();
        state.profile = null;
        state.wallet = null;
        $("#app-loader").classList.add("hidden");
        showAuth("login");
        return;
      }
      if (state.creatingAccount) return;
      await activateAuthenticatedUser(user);
    });
  } catch (error) {
    console.error("Firebase startup:", error);
    $("#app-loader").classList.add("hidden");
    showAuth("login");
    toast("Firebase could not start. Check your project configuration.", "error");
  }
}

init();
