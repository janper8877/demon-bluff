



const express = require("express");
const crypto = require("crypto");

const app = express();
app.set("trust proxy", true);

app.use(express.json({ limit: "64kb" }));


const ALLOWED_ORIGINS = new Set([
  "https://supervisor.ext-twitch.tv",
  "https://www.twitch.tv",
  "https://twitch.tv",
]);

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  return /^https:\/\/[a-z0-9-]+\.ext-twitch\.tv$/i.test(origin);
}

app.use((req, res, next) => {
  console.log(new Date().toISOString(), req.method, req.url, "origin=", req.headers.origin || "-");
  next();
});

app.use((req, res, next) => {
  const origin = req.headers.origin;

  // CORS dla Twitch Extension iframe i lokalnych testow.
  if (isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else {
    // Fallback np. dla recznego sprawdzania JSON-a w przegladarce.
    res.setHeader("Access-Control-Allow-Origin", "*");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");

  // Pozwól Twitchowi embedować (gdyby jednak było użyte iframe)
  res.setHeader(
    "Content-Security-Policy",
    "frame-ancestors https://supervisor.ext-twitch.tv https://*.twitch.tv"
  );
  res.removeHeader("X-Frame-Options");

  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// streamId -> state
const streams = Object.create(null);
// sessionId -> Twitch connection status
const connectSessions = Object.create(null);

/*
streams = {
  "streamer1": {
      roundId: 3,
      maxCards: 7,
      maxVotesPerUser: 2,
      votes: [0,0,0,0,0,0,0],
      deadCards: [],
      userVotesByRound: {}
  }
}
*/


function getStream(streamId) {
  if (!streams[streamId]) {
    streams[streamId] = {
      roundId: 1,
      maxCards: 10,
      maxVotesPerUser: 1,
      votes: Array(10).fill(0),
      deadCards: [],
      evilCount: 1,
      cards: [],
      userVotesByRound: Object.create(null),
      players: Object.create(null),
      leaderboard: Object.create(null),
      scoredRounds: Object.create(null),
    };
  }
  return streams[streamId];
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.max(min, Math.min(n, max));
}

function cleanDisplayName(value, fallback) {
  const name = String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 24);

  return name || fallback;
}

function cleanText(value, maxLength) {
  return String(value || "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function cleanCards(value, maxCards) {
  if (!Array.isArray(value)) return [];

  return value
    .map((card) => ({
      id: clampInt(card && card.id, 0, 1, maxCards),
      name: cleanText(card && card.name, 48),
      description: cleanText(card && card.description, 700),
      alignment: cleanText(card && card.alignment, 16),
      type: cleanText(card && card.type, 16),
    }))
    .filter((card) => card.id >= 1 && card.id <= maxCards)
    .sort((a, b) => a.id - b.id);
}

function buildLeaderboard(stream) {
  return Object.entries(stream.leaderboard)
    .map(([userId, row]) => ({
      userId,
      displayName: stream.players[userId] || row.displayName || userId,
      score: row.score || 0,
      correctAnswers: row.correctAnswers || 0
    }))
    .sort((a, b) => b.score - a.score || a.displayName.localeCompare(b.displayName))
    .map((row, index) => ({
      rank: index + 1,
      ...row
    }));
}

function getPublicBaseUrl(req) {
  return String(process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`)
    .trim()
    .replace(/\/+$/, "");
}

function getTwitchRedirectUri(req) {
  return String(process.env.TWITCH_REDIRECT_URI || `${getPublicBaseUrl(req)}/connect/callback`).trim();
}

function pruneConnectSessions() {
  const now = Date.now();
  const maxAgeMs = 15 * 60 * 1000;

  for (const [sessionId, session] of Object.entries(connectSessions)) {
    if (!session || now - (session.createdAt || 0) > maxAgeMs) {
      delete connectSessions[sessionId];
    }
  }
}

function getTwitchOAuthConfig(req) {
  return {
    clientId: String(process.env.TWITCH_CLIENT_ID || "").trim(),
    clientSecret: String(process.env.TWITCH_CLIENT_SECRET || "").trim(),
    redirectUri: getTwitchRedirectUri(req)
  };
}

async function exchangeTwitchCode(req, code) {
  const { clientId, clientSecret, redirectUri } = getTwitchOAuthConfig(req);
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri
  });

  const tokenRes = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  const tokenData = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokenData.access_token) {
    throw new Error(`Twitch token exchange failed: ${tokenRes.status} ${JSON.stringify(tokenData)}`);
  }

  const userRes = await fetch("https://api.twitch.tv/helix/users", {
    headers: {
      "Authorization": `Bearer ${tokenData.access_token}`,
      "Client-Id": clientId
    }
  });

  const userData = await userRes.json().catch(() => ({}));
  if (!userRes.ok || !userData.data || !userData.data[0]) {
    throw new Error(`Twitch user lookup failed: ${userRes.status} ${JSON.stringify(userData)}`);
  }

  return userData.data[0];
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sendConnectHtml(res, title, message) {
  res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <style>
    body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#111;color:#fff;font:700 20px Arial,sans-serif;text-align:center}
    div{max-width:520px;padding:28px}
    small{display:block;margin-top:12px;color:#aaa;font-size:13px}
  </style>
</head>
<body><div>${escapeHtml(message)}<small>You can close this tab and return to Unity.</small></div></body>
</html>`);
}




// ====== Round control ======

app.get("/connect/start", (req, res) => {
  pruneConnectSessions();

  const sessionId = String(req.query.session || "").trim();
  const { clientId, clientSecret, redirectUri } = getTwitchOAuthConfig(req);

  if (!sessionId) {
    return res.status(400).json({ ok: false, error: "Missing session" });
  }

  if (!clientId || !clientSecret) {
    return res.status(500).json({
      ok: false,
      error: "Missing TWITCH_CLIENT_ID or TWITCH_CLIENT_SECRET on server"
    });
  }

  const state = crypto.randomBytes(16).toString("hex");
  connectSessions[sessionId] = {
    status: "pending",
    state,
    createdAt: Date.now()
  };

  const authorizeUrl = new URL("https://id.twitch.tv/oauth2/authorize");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", "");
  authorizeUrl.searchParams.set("state", `${sessionId}.${state}`);

  res.redirect(authorizeUrl.toString());
});

app.get("/connect/callback", async (req, res) => {
  pruneConnectSessions();

  const code = String(req.query.code || "").trim();
  const state = String(req.query.state || "").trim();
  const [sessionId, stateSecret] = state.split(".");
  const session = connectSessions[sessionId];

  if (!code || !sessionId || !stateSecret || !session || session.state !== stateSecret) {
    return sendConnectHtml(res, "Twitch connect failed", "Twitch connect failed. Please try again from Unity.");
  }

  try {
    const user = await exchangeTwitchCode(req, code);
    const streamId = String(user.id || "").trim();

    connectSessions[sessionId] = {
      ...session,
      status: "connected",
      streamId,
      login: user.login || "",
      displayName: user.display_name || user.login || streamId,
      connectedAt: Date.now()
    };

    getStream(streamId);

    return sendConnectHtml(
      res,
      "Twitch connected",
      `Connected Twitch channel: ${user.display_name || user.login || streamId}`
    );
  } catch (err) {
    console.error("Twitch connect callback failed:", err);
    connectSessions[sessionId] = {
      ...session,
      status: "error",
      error: "TWITCH_CONNECT_FAILED",
      errorAt: Date.now()
    };

    return sendConnectHtml(res, "Twitch connect failed", "Twitch connect failed. Please try again from Unity.");
  }
});

app.get("/connect/status", (req, res) => {
  pruneConnectSessions();

  const sessionId = String(req.query.session || "").trim();
  const session = connectSessions[sessionId];

  if (!sessionId) {
    return res.status(400).json({ ok: false, error: "Missing session" });
  }

  if (!session) {
    return res.json({ ok: true, connected: false, status: "missing" });
  }

  res.json({
    ok: true,
    connected: session.status === "connected",
    status: session.status,
    streamId: session.streamId || "",
    login: session.login || "",
    displayName: session.displayName || "",
    error: session.error || ""
  });
});

app.post("/startRound", (req, res) => {
  const streamId = String(req.body.streamId || "").trim();
  const cardCount = Number(req.body.cardCount);
  const maxVotesPerUser = clampInt(req.body.maxVotesPerUser, 1, 1, 4);
  const evilCount = clampInt(req.body.evilCount, maxVotesPerUser, 0, 10);

  if (!streamId) {
    return res.status(400).json({ ok: false, error: "Missing streamId" });
  }

  if (!Number.isInteger(cardCount) || cardCount < 1 || cardCount > 10) {
    return res.status(400).json({ ok: false, error: "Invalid cardCount (1-10)" });
  }

  const stream = getStream(streamId);

  stream.roundId++;
  stream.maxCards = cardCount;
  stream.maxVotesPerUser = maxVotesPerUser;
  stream.votes = Array(cardCount).fill(0);
  stream.deadCards = [];
  stream.evilCount = evilCount;
  stream.cards = cleanCards(req.body.cards, cardCount);
  stream.userVotesByRound = Object.create(null);

  res.json({
    ok: true,
    streamId,
    roundId: stream.roundId,
    maxCards: stream.maxCards,
    maxVotesPerUser: stream.maxVotesPerUser,
    evilCount: stream.evilCount,
    deadCards: stream.deadCards,
    cards: stream.cards
  });
});



app.post("/vote", (req, res) => {
  const streamId = String(req.body.streamId || "").trim();
  const cardId = Number(req.body.cardId);
  const userId = String(req.body.userId || "").trim();
  const displayName = cleanDisplayName(req.body.displayName, userId);

  if (!streamId) {
    return res.status(400).json({ ok: false, error: "Missing streamId" });
  }

  if (!userId) {
    return res.status(400).json({ ok: false, error: "Missing userId" });
  }

  const stream = getStream(streamId);
  stream.players[userId] = displayName;

  if (
    !Number.isInteger(cardId) ||
    cardId < 1 ||
    cardId > stream.maxCards
  ) {
    return res.status(400).json({
      ok: false,
      error: `Invalid cardId (1-${stream.maxCards})`
    });
  }

  if (stream.deadCards.includes(cardId)) {
    return res.status(409).json({
      ok: false,
      error: "CARD_DEAD",
      cardId,
      deadCards: stream.deadCards
    });
  }

  const roundKey = String(stream.roundId);
  if (!stream.userVotesByRound[roundKey]) {
    stream.userVotesByRound[roundKey] = Object.create(null);
  }

  const userVotes = stream.userVotesByRound[roundKey][userId] || [];

  if (userVotes.includes(cardId)) {
    return res.status(409).json({ ok: false, error: "ALREADY_VOTED_CARD" });
  }

  if (userVotes.length >= stream.maxVotesPerUser) {
    return res.status(409).json({
      ok: false,
      error: "VOTE_LIMIT_REACHED",
      maxVotesPerUser: stream.maxVotesPerUser
    });
  }

  stream.votes[cardId - 1]++;
  stream.userVotesByRound[roundKey][userId] = userVotes.concat(cardId);

  res.json({
    ok: true,
    streamId,
    roundId: stream.roundId,
    cardId,
    displayName,
    votesUsed: userVotes.length + 1,
    maxVotesPerUser: stream.maxVotesPerUser
  });
});

app.post("/voteBatch", (req, res) => {
  const streamId = String(req.body.streamId || "").trim();
  const userId = String(req.body.userId || "").trim();
  const displayName = cleanDisplayName(req.body.displayName, userId);
  const cardIds = Array.isArray(req.body.cardIds)
    ? req.body.cardIds.map(Number)
    : [];

  if (!streamId) {
    return res.status(400).json({ ok: false, error: "Missing streamId" });
  }

  if (!userId) {
    return res.status(400).json({ ok: false, error: "Missing userId" });
  }

  const stream = getStream(streamId);
  stream.players[userId] = displayName;

  const uniqueCardIds = [...new Set(cardIds)];

  if (uniqueCardIds.length !== cardIds.length) {
    return res.status(400).json({ ok: false, error: "DUPLICATE_CARD_IDS" });
  }

  if (uniqueCardIds.length < 1 || uniqueCardIds.length > stream.maxVotesPerUser) {
    return res.status(400).json({
      ok: false,
      error: "INVALID_VOTE_COUNT",
      maxVotesPerUser: stream.maxVotesPerUser
    });
  }

  for (const cardId of uniqueCardIds) {
    if (
      !Number.isInteger(cardId) ||
      cardId < 1 ||
      cardId > stream.maxCards
    ) {
      return res.status(400).json({
        ok: false,
        error: `Invalid cardId (1-${stream.maxCards})`
      });
    }

    if (stream.deadCards.includes(cardId)) {
      return res.status(409).json({
        ok: false,
        error: "CARD_DEAD",
        cardId,
        deadCards: stream.deadCards
      });
    }
  }

  const roundKey = String(stream.roundId);
  if (!stream.userVotesByRound[roundKey]) {
    stream.userVotesByRound[roundKey] = Object.create(null);
  }

  const userVotes = stream.userVotesByRound[roundKey][userId] || [];
  if (userVotes.length > 0) {
    return res.status(409).json({
      ok: false,
      error: "ALREADY_SUBMITTED",
      votesUsed: userVotes.length,
      maxVotesPerUser: stream.maxVotesPerUser
    });
  }

  for (const cardId of uniqueCardIds) {
    stream.votes[cardId - 1]++;
  }

  stream.userVotesByRound[roundKey][userId] = uniqueCardIds;

  res.json({
    ok: true,
    streamId,
    roundId: stream.roundId,
    cardIds: uniqueCardIds,
    displayName,
    votesUsed: uniqueCardIds.length,
    maxVotesPerUser: stream.maxVotesPerUser
  });
});

app.post("/scoreRound", (req, res) => {
  const streamId = String(req.body.streamId || "").trim();
  const correctCardId = Number(req.body.correctCardId);
  const points = clampInt(req.body.points, 1, 1, 1000);
  const force = req.body.force === true;

  if (!streamId) {
    return res.status(400).json({ ok: false, error: "Missing streamId" });
  }

  const stream = getStream(streamId);

  if (
    !Number.isInteger(correctCardId) ||
    correctCardId < 1 ||
    correctCardId > stream.maxCards
  ) {
    return res.status(400).json({
      ok: false,
      error: `Invalid correctCardId (1-${stream.maxCards})`
    });
  }

  const roundKey = String(stream.roundId);
  if (stream.scoredRounds[roundKey] && !force) {
    return res.status(409).json({
      ok: false,
      error: "ROUND_ALREADY_SCORED",
      roundId: stream.roundId,
      leaderboard: buildLeaderboard(stream)
    });
  }

  const roundVotes = stream.userVotesByRound[roundKey] || Object.create(null);
  const winners = [];

  for (const [userId, votedCards] of Object.entries(roundVotes)) {
    if (!Array.isArray(votedCards) || !votedCards.includes(correctCardId)) continue;

    if (!stream.leaderboard[userId]) {
      stream.leaderboard[userId] = {
        displayName: stream.players[userId] || userId,
        score: 0,
        correctAnswers: 0
      };
    }

    stream.leaderboard[userId].displayName = stream.players[userId] || stream.leaderboard[userId].displayName || userId;
    stream.leaderboard[userId].score += points;
    stream.leaderboard[userId].correctAnswers++;

    winners.push({
      userId,
      displayName: stream.players[userId] || userId
    });
  }

  stream.scoredRounds[roundKey] = {
    correctCardId,
    points,
    scoredAt: new Date().toISOString(),
    winners: winners.length
  };

  res.json({
    ok: true,
    streamId,
    roundId: stream.roundId,
    correctCardId,
    points,
    winners,
    leaderboard: buildLeaderboard(stream)
  });
});

app.post("/scoreRoundBatch", (req, res) => {
  const streamId = String(req.body.streamId || "").trim();
  const correctCardIds = Array.isArray(req.body.correctCardIds)
    ? req.body.correctCardIds.map(Number)
    : [];
  const points = clampInt(req.body.points, 1, 1, 1000);
  const force = req.body.force === true;

  if (!streamId) {
    return res.status(400).json({ ok: false, error: "Missing streamId" });
  }

  const stream = getStream(streamId);
  const uniqueCorrectCardIds = [...new Set(correctCardIds)].sort((a, b) => a - b);

  if (uniqueCorrectCardIds.length !== correctCardIds.length) {
    return res.status(400).json({ ok: false, error: "DUPLICATE_CORRECT_CARD_IDS" });
  }

  if (uniqueCorrectCardIds.length < 1 || uniqueCorrectCardIds.length > stream.maxVotesPerUser) {
    return res.status(400).json({
      ok: false,
      error: "INVALID_CORRECT_CARD_COUNT",
      maxVotesPerUser: stream.maxVotesPerUser
    });
  }

  for (const cardId of uniqueCorrectCardIds) {
    if (
      !Number.isInteger(cardId) ||
      cardId < 1 ||
      cardId > stream.maxCards
    ) {
      return res.status(400).json({
        ok: false,
        error: `Invalid correctCardId (1-${stream.maxCards})`
      });
    }
  }

  const roundKey = String(stream.roundId);
  if (stream.scoredRounds[roundKey] && !force) {
    return res.status(409).json({
      ok: false,
      error: "ROUND_ALREADY_SCORED",
      roundId: stream.roundId,
      leaderboard: buildLeaderboard(stream)
    });
  }

  const roundVotes = stream.userVotesByRound[roundKey] || Object.create(null);
  const winners = [];

  for (const [userId, votedCards] of Object.entries(roundVotes)) {
    if (!Array.isArray(votedCards)) continue;

    const sortedVotedCards = [...new Set(votedCards.map(Number))].sort((a, b) => a - b);
    const exactMatch =
      sortedVotedCards.length === uniqueCorrectCardIds.length &&
      sortedVotedCards.every((cardId, index) => cardId === uniqueCorrectCardIds[index]);

    if (!exactMatch) continue;

    if (!stream.leaderboard[userId]) {
      stream.leaderboard[userId] = {
        displayName: stream.players[userId] || userId,
        score: 0,
        correctAnswers: 0
      };
    }

    stream.leaderboard[userId].displayName = stream.players[userId] || stream.leaderboard[userId].displayName || userId;
    stream.leaderboard[userId].score += points;
    stream.leaderboard[userId].correctAnswers++;

    winners.push({
      userId,
      displayName: stream.players[userId] || userId,
      votedCards: sortedVotedCards
    });
  }

  stream.scoredRounds[roundKey] = {
    correctCardIds: uniqueCorrectCardIds,
    points,
    scoredAt: new Date().toISOString(),
    winners: winners.length
  };

  res.json({
    ok: true,
    streamId,
    roundId: stream.roundId,
    correctCardIds: uniqueCorrectCardIds,
    points,
    winners,
    leaderboard: buildLeaderboard(stream)
  });
});

app.get("/leaderboard", (req, res) => {
  const streamId = String(req.query.streamId || "").trim();

  if (!streamId) {
    return res.status(400).json({ ok: false, error: "Missing streamId" });
  }

  const stream = getStream(streamId);

  res.json({
    ok: true,
    streamId,
    roundId: stream.roundId,
    leaderboard: buildLeaderboard(stream)
  });
});

app.post("/resetLeaderboard", (req, res) => {
  const streamId = String(req.body.streamId || "").trim();
  const clearCurrentRoundVotes = req.body.clearCurrentRoundVotes !== false;

  if (!streamId) {
    return res.status(400).json({ ok: false, error: "Missing streamId" });
  }

  const stream = getStream(streamId);
  stream.leaderboard = Object.create(null);
  stream.scoredRounds = Object.create(null);

  if (clearCurrentRoundVotes) {
    stream.votes = Array(stream.maxCards).fill(0);
    stream.userVotesByRound[String(stream.roundId)] = Object.create(null);
  }

  res.json({
    ok: true,
    streamId,
    roundId: stream.roundId,
    clearedCurrentRoundVotes: clearCurrentRoundVotes,
    leaderboard: []
  });
});

app.post("/deadCard", (req, res) => {
  const streamId = String(req.body.streamId || "").trim();
  const cardId = Number(req.body.cardId);

  if (!streamId) {
    return res.status(400).json({ ok: false, error: "Missing streamId" });
  }

  const stream = getStream(streamId);

  if (
    !Number.isInteger(cardId) ||
    cardId < 1 ||
    cardId > stream.maxCards
  ) {
    return res.status(400).json({
      ok: false,
      error: `Invalid cardId (1-${stream.maxCards})`
    });
  }

  if (!stream.deadCards.includes(cardId)) {
    stream.deadCards.push(cardId);
    stream.deadCards.sort((a, b) => a - b);
  }

  res.json({
    ok: true,
    streamId,
    roundId: stream.roundId,
    cardId,
    deadCards: stream.deadCards
  });
});



// Unity będzie to odpytywać
app.get("/results", (req, res) => {

  const streamId = String(req.query.streamId || "").trim();

  if (!streamId) {
    return res.status(400).json({ ok:false, error:"Missing streamId" });
  }

  const stream = getStream(streamId);

  const votesObj = {};
  for (let i=1;i<=stream.maxCards;i++)
    votesObj[i] = stream.votes[i-1] || 0;

  res.json({
    ok:true,
    roundId: stream.roundId,
    maxCards: stream.maxCards,
    maxVotesPerUser: stream.maxVotesPerUser,
    evilCount: stream.evilCount,
    deadCards: stream.deadCards,
    votes: votesObj,
    cards: stream.cards
  });
});

app.get("/voteList", (req, res) => {
  const streamId = String(req.query.streamId || "").trim();

  if (!streamId) {
    return res.status(400).json({ ok: false, error: "Missing streamId" });
  }

  const stream = getStream(streamId);
  const roundKey = String(stream.roundId);
  const roundVotes = stream.userVotesByRound[roundKey] || Object.create(null);

  const votes = Object.entries(roundVotes)
    .filter(([, cardIds]) => Array.isArray(cardIds))
    .map(([userId, cardIds]) => ({
      displayName: stream.players[userId] || userId,
      cardIds: [...new Set(cardIds.map(Number))]
        .filter((cardId) => Number.isInteger(cardId))
        .sort((a, b) => a - b)
    }));

  res.json({
    ok: true,
    streamId,
    roundId: stream.roundId,
    votes
  });
});



app.get("/__whoami", (req, res) => {
  res.type("text").send("WHOAMI: https-server.cjs WITH RESULTS v1");
});


app.get("/startRound", (req, res) => {
  const streamId = String(req.query.streamId || "").trim();
  const cardCount = Number(req.query.cardCount);
  const maxVotesPerUser = clampInt(req.query.maxVotesPerUser, 1, 1, 4);

  if (!streamId) {
    return res.status(400).json({ ok: false, error: "Missing streamId" });
  }

  if (!Number.isInteger(cardCount) || cardCount < 1 || cardCount > 10) {
    return res.status(400).json({ ok: false, error: "Invalid cardCount (1-10)" });
  }

  const stream = getStream(streamId);

  stream.roundId++;
  stream.maxCards = cardCount;
  stream.maxVotesPerUser = maxVotesPerUser;
  stream.votes = Array(cardCount).fill(0);
  stream.deadCards = [];
  stream.evilCount = maxVotesPerUser;
  stream.cards = [];
  stream.userVotesByRound = Object.create(null);

  console.log("ROUND STARTED FOR:", streamId);

  res.json({
    ok: true,
    streamId,
    roundId: stream.roundId,
    maxCards: stream.maxCards,
    maxVotesPerUser: stream.maxVotesPerUser,
    evilCount: stream.evilCount,
    deadCards: stream.deadCards,
    cards: stream.cards
  });
});


app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
