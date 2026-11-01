const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const crypto = require("node:crypto");

initializeApp();
const db = getFirestore();
const REGION = "asia-south1";

function requireAuth(request) {
  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "Sign in to continue.");
  return request.auth.uid;
}

function cleanText(value, maxLength) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function normalizedNickname(value) {
  return cleanText(value, 24).toLowerCase().replace(/\s+/g, " ");
}

function assertActiveProfile(profile) {
  if (!profile) throw new HttpsError("not-found", "Player profile was not found.");
  if (profile.isBanned === true || profile.accountStatus === "banned") {
    throw new HttpsError("permission-denied", "This account is restricted from player activities.");
  }
}

function assertVerifiedRealMoneyEligibility(profile) {
  // These two properties must be set by a separate trusted eligibility/guardian-verification process.
  // They are never writable by the player client.
  if (profile.realMoneyEligible !== true || profile.guardianAuthorizationVerified !== true) {
    throw new HttpsError(
      "failed-precondition",
      "This real-money feature requires verified eligibility and parent/guardian authorization. Contact support for details."
    );
  }
}

function hashValue(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

async function createUserNotification(uid, data) {
  const notification = {
    uid,
    type: data.type || "general",
    title: cleanText(data.title || "VER TOUR update", 90),
    body: cleanText(data.body || "You have a new update.", 500),
    read: false,
    createdAt: FieldValue.serverTimestamp()
  };
  await db.collection("notifications").add(notification);
  try {
    const tokenSnapshot = await db.collection("users").doc(uid).collection("fcmTokens").get();
    const tokens = [...new Set(tokenSnapshot.docs.map((doc) => doc.data().token).filter(Boolean))];
    for (let index = 0; index < tokens.length; index += 500) {
      const tokenBatch = tokens.slice(index, index + 500);
      if (!tokenBatch.length) continue;
      const response = await getMessaging().sendEachForMulticast({
        tokens: tokenBatch,
        notification: { title: notification.title, body: notification.body },
        data: { type: notification.type },
        webpush: { notification: { icon: "/assets/icon-192.png" } }
      });
      const invalidTokens = [];
      response.responses.forEach((result, tokenIndex) => {
        if (!result.success && [
          "messaging/registration-token-not-registered",
          "messaging/invalid-registration-token"
        ].includes(result.error?.code)) invalidTokens.push(tokenBatch[tokenIndex]);
      });
      if (invalidTokens.length) {
        const batch = db.batch();
        for (const invalid of invalidTokens) {
          const tokenDoc = tokenSnapshot.docs.find((doc) => doc.data().token === invalid);
          if (tokenDoc) batch.delete(tokenDoc.ref);
        }
        await batch.commit();
      }
    }
  } catch (error) {
    console.warn("FCM delivery failed:", error.message);
  }
}

async function broadcastToPlayers(data) {
  const players = await db.collection("users").where("isBanned", "!=", true).limit(1500).get();
  for (const player of players.docs) {
    await createUserNotification(player.id, data);
  }
}

exports.createPlayerProfile = onCall({ region: REGION, enforceAppCheck: false }, async (request) => {
  const uid = requireAuth(request);
  const ffUid = cleanText(request.data?.ffUid, 24);
  const nickname = cleanText(request.data?.nickname, 24).replace(/\s+/g, " ");
  const fullName = cleanText(request.data?.fullName, 60);
  const email = cleanText(request.auth.token.email, 160).toLowerCase();
  if (!/^\d{5,24}$/.test(ffUid)) throw new HttpsError("invalid-argument", "Enter a valid numeric Free Fire UID.");
  if (nickname.length < 3 || nickname.length > 24 || !/^[^/]{3,24}$/u.test(nickname)) {
    throw new HttpsError("invalid-argument", "Nickname must be 3–24 characters and must not contain a slash.");
  }
  if (fullName.length < 2) throw new HttpsError("invalid-argument", "Enter your full name.");
  if (!email) throw new HttpsError("failed-precondition", "The authenticated email address is unavailable.");

  const normalized = normalizedNickname(nickname);
  const userRef = db.collection("users").doc(uid);
  const walletRef = db.collection("wallets").doc(uid);
  const ffRegistryRef = db.collection("uidRegistry").doc(ffUid);
  const nicknameRegistryRef = db.collection("nicknameRegistry").doc(normalized);
  await db.runTransaction(async (transaction) => {
    const [userSnapshot, walletSnapshot, ffRegistrySnapshot, nicknameRegistrySnapshot] = await Promise.all([
      transaction.get(userRef),
      transaction.get(walletRef),
      transaction.get(ffRegistryRef),
      transaction.get(nicknameRegistryRef)
    ]);
    if (userSnapshot.exists) {
      const existing = userSnapshot.data();
      if (existing.ffUid === ffUid && existing.nickname === nickname && walletSnapshot.exists) return;
      throw new HttpsError("already-exists", "A player profile already exists for this account.");
    }
    if (walletSnapshot.exists) throw new HttpsError("already-exists", "A wallet record already exists for this account.");
    if (ffRegistrySnapshot.exists) throw new HttpsError("already-exists", "This Free Fire UID is already registered.");
    if (nicknameRegistrySnapshot.exists) throw new HttpsError("already-exists", "This nickname is already taken.");

    transaction.create(ffRegistryRef, { ownerUid: uid, ffUid, createdAt: FieldValue.serverTimestamp() });
    transaction.create(nicknameRegistryRef, { ownerUid: uid, nickname, createdAt: FieldValue.serverTimestamp() });
    transaction.create(userRef, {
      ffUid,
      nickname,
      fullName,
      email,
      createdAt: FieldValue.serverTimestamp(),
      accountStatus: "active",
      isBanned: false,
      rankName: "Unranked",
      achievementPoints: 0,
      vipLevel: "PLAYER",
      profileVersion: 1
    });
    transaction.create(walletRef, {
      availableBalance: 0,
      currency: "BDT",
      updatedAt: FieldValue.serverTimestamp()
    });
  });
  return { success: true };
});

exports.awardVerifiedAchievement = onCall({ region: REGION, enforceAppCheck: false }, async (request) => {
  const adminUid = requireAuth(request);
  if (request.auth.token.admin !== true) {
    throw new HttpsError("permission-denied", "Only trusted tournament administrators can award verified achievements.");
  }
  const uid = cleanText(request.data?.uid, 128);
  const pointsAdded = Number(request.data?.points);
  const reason = cleanText(request.data?.reason, 180);
  const tournamentId = cleanText(request.data?.tournamentId, 120);
  const allowedVip = ["PLAYER", "VIP 1", "VIP 2", "VIP 3", "VIP Elite"];
  const requestedVip = request.data?.vipLevel == null ? null : cleanText(request.data.vipLevel, 20);
  if (!uid || !Number.isInteger(pointsAdded) || pointsAdded < 1 || pointsAdded > 500) {
    throw new HttpsError("invalid-argument", "Provide a valid player UID and 1–500 verified achievement points.");
  }
  if (reason.length < 5) throw new HttpsError("invalid-argument", "A verified achievement reason is required.");
  if (requestedVip && !allowedVip.includes(requestedVip)) throw new HttpsError("invalid-argument", "Unknown VIP membership level.");

  const userRef = db.collection("users").doc(uid);
  const historyRef = db.collection("rankHistory").doc();
  let updated = null;
  await db.runTransaction(async (transaction) => {
    const userSnapshot = await transaction.get(userRef);
    if (!userSnapshot.exists) throw new HttpsError("not-found", "Player profile was not found.");
    const profile = userSnapshot.data();
    const totalPoints = Math.max(0, Number(profile.achievementPoints || 0)) + pointsAdded;
    const rankSteps = [
      [100, "Bronze"], [300, "Silver"], [600, "Gold"], [1000, "Platinum"],
      [1600, "Diamond"], [2400, "Heroic"], [3500, "Grandmaster"]
    ];
    let newRank = "Unranked";
    for (const [threshold, name] of rankSteps) if (totalPoints >= threshold) newRank = name;
    const oldRank = profile.rankName || "Unranked";
    const oldVip = profile.vipLevel || "PLAYER";
    const newVip = requestedVip || oldVip;
    const update = {
      achievementPoints: totalPoints,
      rankName: newRank,
      updatedAt: FieldValue.serverTimestamp()
    };
    if (requestedVip) update.vipLevel = requestedVip;
    transaction.update(userRef, update);
    transaction.create(historyRef, {
      uid,
      pointsAdded,
      totalPoints,
      oldRank,
      newRank,
      oldVipLevel: oldVip,
      newVipLevel: newVip,
      reason,
      tournamentId: tournamentId || null,
      awardedBy: adminUid,
      createdAt: FieldValue.serverTimestamp()
    });
    updated = { oldRank, newRank, oldVip, newVip, totalPoints };
  });
  return { success: true, ...updated };
});

exports.joinTournament = onCall({ region: REGION, enforceAppCheck: false }, async (request) => {
  const uid = requireAuth(request);
  const tournamentId = cleanText(request.data?.tournamentId, 120);
  if (!tournamentId) throw new HttpsError("invalid-argument", "Tournament ID is required.");

  const userRef = db.collection("users").doc(uid);
  const walletRef = db.collection("wallets").doc(uid);
  const tournamentRef = db.collection("tournaments").doc(tournamentId);
  const registrationRef = db.collection("registrations").doc(`${tournamentId}_${uid}`);
  const transactionRef = db.collection("transactions").doc();

  const result = await db.runTransaction(async (transaction) => {
    const [userSnapshot, tournamentSnapshot, registrationSnapshot] = await Promise.all([
      transaction.get(userRef),
      transaction.get(tournamentRef),
      transaction.get(registrationRef)
    ]);
    if (!userSnapshot.exists) throw new HttpsError("not-found", "Player profile was not found.");
    const profile = userSnapshot.data();
    assertActiveProfile(profile);
    if (!tournamentSnapshot.exists) throw new HttpsError("not-found", "Tournament was not found.");
    const tournament = tournamentSnapshot.data();
    if (tournament.status !== "published" || tournament.isActive === false) {
      throw new HttpsError("failed-precondition", "This tournament is not published.");
    }
    if (tournament.registrationOpen !== true) {
      throw new HttpsError("failed-precondition", "Registration is closed for this tournament.");
    }
    const startMillis = tournament.startAt?.toMillis ? tournament.startAt.toMillis() : 0;
    if (startMillis && startMillis <= Date.now()) {
      throw new HttpsError("failed-precondition", "This tournament has already started.");
    }
    if (registrationSnapshot.exists) {
      throw new HttpsError("already-exists", "You are already registered for this tournament.");
    }

    const slots = Number(tournament.availableSlots);
    if (!Number.isFinite(slots) || slots <= 0) {
      throw new HttpsError("resource-exhausted", "No tournament slots are available.");
    }
    const fee = Math.max(0, Number(tournament.entryFee || 0));
    let wallet = null;
    if (fee > 0) {
      assertVerifiedRealMoneyEligibility(profile);
      const walletSnapshot = await transaction.get(walletRef);
      if (!walletSnapshot.exists) throw new HttpsError("failed-precondition", "Wallet is not ready for this account.");
      wallet = walletSnapshot.data();
      if (Number(wallet.availableBalance || 0) < fee) {
        throw new HttpsError("failed-precondition", "Your available wallet balance is not enough.");
      }
      transaction.update(walletRef, {
        availableBalance: Number(wallet.availableBalance || 0) - fee,
        updatedAt: FieldValue.serverTimestamp()
      });
      transaction.set(transactionRef, {
        uid,
        type: "tournament_entry",
        title: `Entry fee — ${cleanText(tournament.name || "Tournament", 100)}`,
        amount: fee,
        direction: "debit",
        status: "approved",
        tournamentId,
        createdAt: FieldValue.serverTimestamp()
      });
    }

    transaction.update(tournamentRef, {
      availableSlots: slots - 1,
      registrationCount: Number(tournament.registrationCount || 0) + 1,
      updatedAt: FieldValue.serverTimestamp()
    });
    transaction.create(registrationRef, {
      uid,
      tournamentId,
      tournamentName: cleanText(tournament.name || "VER TOUR tournament", 100),
      gameMode: cleanText(tournament.gameMode || "", 40),
      mapName: cleanText(tournament.mapName || "", 40),
      fee,
      status: "confirmed",
      createdAt: FieldValue.serverTimestamp()
    });
    return { tournamentName: tournament.name || "Tournament" };
  });

  try {
    await createUserNotification(uid, {
      type: "tournament_registration",
      title: "Tournament registration confirmed",
      body: `Your registration for ${cleanText(result.tournamentName, 100)} is confirmed.`
    });
  } catch (error) { console.warn("Registration notification failed:", error.message); }
  return { success: true, message: `Your registration for ${result.tournamentName} is confirmed.` };
});

exports.submitPaymentRequest = onCall({ region: REGION, enforceAppCheck: false }, async (request) => {
  const uid = requireAuth(request);
  const method = cleanText(request.data?.method, 20).toLowerCase();
  const amount = Number(request.data?.amount);
  const transactionId = cleanText(request.data?.transactionId, 80);
  if (!["bkash", "nagad"].includes(method)) throw new HttpsError("invalid-argument", "Choose a supported payment method.");
  if (!Number.isFinite(amount) || amount < 1 || amount > 10000) throw new HttpsError("invalid-argument", "Amount must be between ৳1 and ৳10,000.");
  if (!/^[a-zA-Z0-9-]{5,80}$/.test(transactionId)) throw new HttpsError("invalid-argument", "Enter a valid payment transaction ID.");

  const userRef = db.collection("users").doc(uid);
  const configRef = db.collection("publicConfig").doc("paymentMethods");
  const requestRef = db.collection("transactions").doc();
  const registryRef = db.collection("paymentTxnRegistry").doc(hashValue(`${method}:${transactionId.toLowerCase()}`));

  await db.runTransaction(async (transaction) => {
    const [userSnapshot, configSnapshot, duplicateSnapshot] = await Promise.all([
      transaction.get(userRef), transaction.get(configRef), transaction.get(registryRef)
    ]);
    if (!userSnapshot.exists) throw new HttpsError("not-found", "Player profile was not found.");
    assertActiveProfile(userSnapshot.data());
    assertVerifiedRealMoneyEligibility(userSnapshot.data());
    const publishedMethod = configSnapshot.exists ? configSnapshot.data()?.[method] : null;
    if (publishedMethod?.enabled !== true || !cleanText(publishedMethod.number, 40)) {
      throw new HttpsError("failed-precondition", "This payment method is not currently available.");
    }
    if (duplicateSnapshot.exists) throw new HttpsError("already-exists", "This transaction ID has already been submitted.");

    transaction.create(registryRef, { uid, method, createdAt: FieldValue.serverTimestamp() });
    transaction.create(requestRef, {
      uid,
      type: "deposit_request",
      title: "Add money request",
      method,
      amount,
      transactionId,
      status: "pending",
      direction: "credit_request",
      createdAt: FieldValue.serverTimestamp()
    });
  });

  try {
    await createUserNotification(uid, {
      type: "payment_pending",
      title: "Payment request received",
      body: "Your payment request is pending independent verification. Your wallet has not been credited yet."
    });
  } catch (error) { console.warn("Payment request notification failed:", error.message); }
  return { success: true, message: "Payment request submitted and marked pending verification." };
});

exports.updatePlayerProfile = onCall({ region: REGION, enforceAppCheck: false }, async (request) => {
  const uid = requireAuth(request);
  const nickname = cleanText(request.data?.nickname, 24);
  const fullName = cleanText(request.data?.fullName, 60);
  if (nickname.length < 3 || !/^[^/]{3,24}$/u.test(nickname)) {
    throw new HttpsError("invalid-argument", "Nickname must be 3–24 characters and use letters, numbers, spaces, dot, underscore, or hyphen.");
  }
  if (fullName.length < 2) throw new HttpsError("invalid-argument", "Enter your full name.");
  const userRef = db.collection("users").doc(uid);
  const userSnapshot = await userRef.get();
  if (!userSnapshot.exists) throw new HttpsError("not-found", "Player profile was not found.");
  const current = userSnapshot.data();
  assertActiveProfile(current);
  const oldKey = normalizedNickname(current.nickname || "");
  const newKey = normalizedNickname(nickname);
  const newRegistryRef = db.collection("nicknameRegistry").doc(newKey);
  const oldRegistryRef = oldKey ? db.collection("nicknameRegistry").doc(oldKey) : null;

  await db.runTransaction(async (transaction) => {
    const [newRegistrySnapshot, oldRegistrySnapshot] = await Promise.all([
      transaction.get(newRegistryRef),
      oldRegistryRef ? transaction.get(oldRegistryRef) : Promise.resolve(null)
    ]);
    if (newKey !== oldKey && newRegistrySnapshot.exists) {
      throw new HttpsError("already-exists", "This nickname is already taken.");
    }
    if (newKey !== oldKey) {
      transaction.set(newRegistryRef, { ownerUid: uid, nickname, createdAt: FieldValue.serverTimestamp() });
      if (oldRegistryRef && oldRegistrySnapshot?.exists && oldRegistrySnapshot.data().ownerUid === uid) {
        transaction.delete(oldRegistryRef);
      }
    }
    transaction.update(userRef, {
      nickname,
      fullName,
      updatedAt: FieldValue.serverTimestamp()
    });
  });
  return { success: true };
});

exports.onTournamentPublished = onDocumentCreated({ document: "tournaments/{tournamentId}", region: REGION }, async (event) => {
  const tournament = event.data?.data();
  if (!tournament || tournament.status !== "published" || tournament.isActive === false) return;
  await broadcastToPlayers({
    type: "tournament_new",
    title: "New tournament published",
    body: `${cleanText(tournament.name || "A new tournament", 100)} is now available in VER TOUR.`
  });
});

exports.onTournamentUpdated = onDocumentUpdated({ document: "tournaments/{tournamentId}", region: REGION }, async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  const trackedFields = ["status", "name", "description", "registrationOpen", "startAt", "rules", "gameMode", "mapName"];
  const changed = trackedFields.some((field) => {
    const left = before[field]?.toMillis ? before[field].toMillis() : before[field];
    const right = after[field]?.toMillis ? after[field].toMillis() : after[field];
    return JSON.stringify(left) !== JSON.stringify(right);
  });
  if (!changed) return;
  let title = "Tournament updated";
  let type = "tournament_updated";
  if (after.status === "cancelled" && before.status !== "cancelled") {
    title = "Tournament cancelled";
    type = "tournament_cancelled";
  } else if (after.status === "published" && before.status !== "published") {
    title = "Tournament published";
    type = "tournament_new";
  }
  if (after.status === "published" && before.status !== "published") {
    await broadcastToPlayers({
      type: "tournament_new",
      title: "New tournament published",
      body: `${cleanText(after.name || "A new tournament", 100)} is now available in VER TOUR.`
    });
    return;
  }
  const tournamentId = event.params.tournamentId;
  const registrations = await db.collection("registrations").where("tournamentId", "==", tournamentId).get();
  for (const registration of registrations.docs) {
    await createUserNotification(registration.data().uid, {
      type,
      title,
      body: `${cleanText(after.name || "Your tournament", 100)} has a new update.`
    });
  }
});

exports.onNoticePublished = onDocumentCreated({ document: "notices/{noticeId}", region: REGION }, async (event) => {
  const notice = event.data?.data();
  if (!notice || notice.status !== "published" || notice.isActive === false) return;
  await broadcastToPlayers({
    type: "admin_notice",
    title: cleanText(notice.title || "New official notice", 90),
    body: cleanText(notice.description || notice.message || "A new notice has been published.", 300)
  });
});

exports.onNoticeUpdated = onDocumentUpdated({ document: "notices/{noticeId}", region: REGION }, async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  if (before.status === "published" || after.status !== "published" || after.isActive === false) return;
  await broadcastToPlayers({
    type: "admin_notice",
    title: cleanText(after.title || "New official notice", 90),
    body: cleanText(after.description || after.message || "A new notice has been published.", 300)
  });
});

exports.onTransactionStatusChanged = onDocumentUpdated({ document: "transactions/{transactionId}", region: REGION }, async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  if (before.status !== "pending" || !["approved", "rejected"].includes(after.status)) return;
  if (after.type !== "deposit_request") return;
  if (after.status === "approved") {
    const walletRef = db.collection("wallets").doc(after.uid);
    const transactionRef = event.data.after.ref;
    await db.runTransaction(async (transaction) => {
      const [currentRequest, walletSnapshot] = await Promise.all([
        transaction.get(transactionRef), transaction.get(walletRef)
      ]);
      if (!currentRequest.exists || currentRequest.data().walletCredited === true) return;
      if (!walletSnapshot.exists) throw new Error("Wallet missing for approved payment request.");
      const amount = Number(currentRequest.data().amount || 0);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("Invalid approved payment amount.");
      transaction.update(walletRef, {
        availableBalance: Number(walletSnapshot.data().availableBalance || 0) + amount,
        updatedAt: FieldValue.serverTimestamp()
      });
      transaction.update(transactionRef, {
        walletCredited: true,
        verifiedAt: FieldValue.serverTimestamp()
      });
    });
  }
  await createUserNotification(after.uid, {
    type: `payment_${after.status}`,
    title: after.status === "approved" ? "Payment request approved" : "Payment request rejected",
    body: after.status === "approved"
      ? "Your payment request has been verified. Your wallet balance has been updated."
      : "Your payment request was not approved. Check the transaction details or contact support."
  });
});

exports.onPlayerAchievementUpdated = onDocumentUpdated({ document: "users/{uid}", region: REGION }, async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  const uid = event.params.uid;
  if (before.rankName !== after.rankName && after.rankName) {
    await createUserNotification(uid, {
      type: "rank_up",
      title: "Rank upgraded",
      body: `Congratulations! Your verified rank is now ${cleanText(after.rankName, 40)}.`
    });
  }
  if (before.vipLevel !== after.vipLevel && after.vipLevel && after.vipLevel !== "PLAYER") {
    await createUserNotification(uid, {
      type: "vip_achievement",
      title: "VIP achievement unlocked",
      body: `Your membership status is now ${cleanText(after.vipLevel, 40)}.`
    });
  }
  if (before.isBanned !== after.isBanned && after.isBanned === true) {
    await createUserNotification(uid, {
      type: "account_restricted",
      title: "Account restriction notice",
      body: "Some player activities have been restricted. Open the app to review the notice and contact support."
    });
  }
});
