



const express = require("express");

const app = express();

app.use(express.json({ limit: "2kb" }));


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

/*
streams = {
  "streamer1": {
      roundId: 3,
      maxCards: 7,
      maxVotesPerUser: 2,
      votes: [0,0,0,0,0,0,0],
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
      userVotesByRound: Object.create(null),
    };
  }
  return streams[streamId];
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.max(min, Math.min(n, max));
}




// ====== Round control ======

app.post("/startRound", (req, res) => {
  const streamId = String(req.body.streamId || "").trim();
  const cardCount = Number(req.body.cardCount);
  const maxVotesPerUser = clampInt(req.body.maxVotesPerUser, 1, 1, 4);

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
  stream.userVotesByRound = Object.create(null);

  res.json({
    ok: true,
    streamId,
    roundId: stream.roundId,
    maxCards: stream.maxCards,
    maxVotesPerUser: stream.maxVotesPerUser
  });
});



app.post("/vote", (req, res) => {
  const streamId = String(req.body.streamId || "").trim();
  const cardId = Number(req.body.cardId);
  const userId = String(req.body.userId || "").trim();

  if (!streamId) {
    return res.status(400).json({ ok: false, error: "Missing streamId" });
  }

  if (!userId) {
    return res.status(400).json({ ok: false, error: "Missing userId" });
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
    votesUsed: userVotes.length + 1,
    maxVotesPerUser: stream.maxVotesPerUser
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
    votes: votesObj
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
  stream.userVotesByRound = Object.create(null);

  console.log("ROUND STARTED FOR:", streamId);

  res.json({
    ok: true,
    streamId,
    roundId: stream.roundId,
    maxCards: stream.maxCards,
    maxVotesPerUser: stream.maxVotesPerUser
  });
});


app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
