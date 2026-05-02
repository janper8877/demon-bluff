window.addEventListener("DOMContentLoaded", () => {
  const stage = document.getElementById("stage");
  const stageWrap = document.getElementById("stageWrap");
  const uiScale = document.getElementById("uiScale");

  if (!stage || !stageWrap) {
    console.error("Missing #stage or #stageWrap.");
    return;
  }

  const isLocalTest =
    location.protocol === "file:" ||
    location.hostname === "localhost" ||
    location.hostname === "127.0.0.1" ||
    location.hostname === "";

  if (isLocalTest) {
    installFakeTwitch();
  }

  let cardCount = 9;
  let currentRoundId = null;
  let pollingStarted = false;
  let streamId = null;
  let userId = null;
  let firstContextReceived = false;

  let ui = { x: 0, y: 0, scale: 1 };
  let design = { w: 1920, h: 1080 };
  let lastContext = null;

  function installFakeTwitch() {
    console.log("LOCAL TWITCH TEST MODE");

    window.Twitch = {
      ext: {
        onAuthorized: (cb) => {
          setTimeout(() => {
            cb({
              channelId: "local_channel",
              userId: "local_user",
            });
          }, 100);
        },
        onContext: (cb) => {
          setTimeout(() => {
            cb({
              videoResolution: "1920x1080",
              displayResolution: "1920x1080",
              isFullScreen: false,
              isTheatreMode: false,
            }, []);
          }, 200);
        },
      },
    };
  }

  function setDesign(w, h) {
    if (!w || !h || !Number.isFinite(w) || !Number.isFinite(h)) return;

    design = { w, h };
    document.documentElement.style.setProperty("--design-w", `${w}px`);
    document.documentElement.style.setProperty("--design-h", `${h}px`);
  }

  function parseResolution(str) {
    const match = /^(\d{2,5})x(\d{2,5})$/.exec(str || "");
    return match ? { w: Number(match[1]), h: Number(match[2]) } : null;
  }

  function getVideoRect() {
    const vw = window.innerWidth || 1;
    const vh = window.innerHeight || 1;
    const videoAR = design.w / design.h;
    const winAR = vw / vh;

    let x;
    let y;
    let w;
    let h;

    if (winAR > videoAR) {
      h = vh;
      w = h * videoAR;
      x = (vw - w) / 2;
      y = 0;
    } else {
      w = vw;
      h = w / videoAR;
      x = 0;
      y = (vh - h) / 2;
    }

    return { x, y, w, h, fitScale: w / design.w };
  }

  function applyUI(reason = "applyUI") {
    const rect = getVideoRect();
    const fit = rect.fitScale;

    if (!Number.isFinite(fit) || fit <= 0) return;

    const cx = design.w / 2;
    const cy = design.h / 2;
    const tx = ui.x * design.w;
    const ty = ui.y * design.h;

    stage.style.transform =
      `translate(${rect.x}px, ${rect.y}px) ` +
      `scale(${fit}) ` +
      `translate(${cx}px, ${cy}px) ` +
      `scale(${ui.scale}) ` +
      `translate(${-cx}px, ${-cy}px) ` +
      `translate(${tx}px, ${ty}px)`;

    console.log("APPLY UI:", reason, stage.style.transform);
  }

  let rafPending = false;
  function scheduleApplyUI(reason) {
    if (rafPending) return;

    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      applyUI(reason);
    });
  }

  if (uiScale) {
    uiScale.addEventListener("input", () => {
      ui.scale = Number(uiScale.value);
      applyUI("slider");
    });
  }

  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startUiX = 0;
  let startUiY = 0;

  stageWrap.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".card")) return;

    dragging = true;
    stageWrap.classList.add("dragging");
    stageWrap.setPointerCapture(e.pointerId);

    startX = e.clientX;
    startY = e.clientY;
    startUiX = ui.x;
    startUiY = ui.y;
  });

  stageWrap.addEventListener("pointermove", (e) => {
    if (!dragging) return;

    const rect = getVideoRect();
    const totalScale = rect.fitScale * ui.scale;

    if (!Number.isFinite(totalScale) || totalScale <= 0) return;

    const dxDesign = (e.clientX - startX) / totalScale;
    const dyDesign = (e.clientY - startY) / totalScale;

    ui.x = startUiX + dxDesign / design.w;
    ui.y = startUiY + dyDesign / design.h;

    applyUI("drag");
  });

  function endDrag() {
    dragging = false;
    stageWrap.classList.remove("dragging");
  }

  stageWrap.addEventListener("pointerup", endDrag);
  stageWrap.addEventListener("pointercancel", endDrag);

  function computeSlots(count) {
    const cx = design.w / 2;
    const cy = design.h / 2;
    const radius = Math.min(design.w, design.h) * 0.36;

    const anglesByCount = {
      5: [-90, -18, 54, 126, 198],
      6: [-90, -30, 30, 90, 150, 210],
      7: [-90, -38.57, 12.86, 64.29, 115.71, 167.14, 218.57],
      8: [-90, -45, 0, 45, 90, 135, 180, 225],
      9: [-90, -50, -10, 30, 70, 110, 150, 190, 230],
    };

    const angles = anglesByCount[count] || anglesByCount[9];

    return angles.map((angle) => {
      const rad = (angle * Math.PI) / 180;
      return {
        x: cx + Math.cos(rad) * radius,
        y: cy + Math.sin(rad) * radius,
      };
    });
  }

  function addCard(label, x, y, cardId) {
    const el = document.createElement("button");

    el.className = "card";
    el.type = "button";
    el.textContent = label;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;

    el.addEventListener("click", () => {
      console.log("CARD CLICKED", cardId);
      sendVote(cardId);
    });

    stage.appendChild(el);
  }

  function showCards() {
    stage.innerHTML = "";

    const safeCount = Math.max(1, Math.min(cardCount, 9));
    const slots = computeSlots(safeCount);

    for (let i = 0; i < safeCount; i++) {
      const slotIndex = (i + 1) % slots.length;
      const slot = slots[slotIndex];

      addCard(`#${i + 1}`, slot.x, slot.y, i + 1);
    }

    applyUI("showCards");
  }

  async function fetchGameState() {
    if (!streamId || location.protocol === "file:") return;

    let res;
    try {
      res = await fetch(`/results?streamId=${encodeURIComponent(streamId)}`, {
        cache: "no-store",
      });
    } catch (e) {
      console.warn("Results request failed:", e);
      return;
    }

    if (!res.ok) return;

    const data = await res.json();
    console.log("RESULTS:", data);

    if (currentRoundId !== data.roundId) {
      currentRoundId = data.roundId;

      if (Number.isInteger(data.maxCards)) {
        cardCount = Math.max(1, Math.min(data.maxCards, 9));
      }

      showCards();
    }
  }

  function startPolling() {
    if (pollingStarted || !streamId || location.protocol === "file:") return;

    pollingStarted = true;
    fetchGameState();
    setInterval(fetchGameState, 1000);
  }

  function waitForTwitch() {
    if (!window.Twitch || !window.Twitch.ext) {
      setTimeout(waitForTwitch, 50);
      return;
    }

    console.log("TWITCH READY");

    window.Twitch.ext.onContext((context, changed) => {
      console.log("CONTEXT RECEIVED", context, changed);
      lastContext = context;

      const vr = parseResolution(context && context.videoResolution);
      if (vr && (vr.w !== design.w || vr.h !== design.h)) {
        setDesign(vr.w, vr.h);
      }

      if (!firstContextReceived) {
        firstContextReceived = true;
        showCards();
      }

      scheduleApplyUI("onContext");
    });

    window.Twitch.ext.onAuthorized((auth) => {
      streamId = String((auth && auth.channelId) || "").trim();
      userId = String((auth && auth.userId) || "").trim();

      console.log("AUTHORIZED");
      console.log("STREAM ID =", streamId);
      console.log("USER ID =", userId);

      startPolling();
    });
  }

  function setStatus(msg) {
    const el = document.getElementById("status");
    if (!el) return;
    el.textContent = msg;
  }

  function getUserId() {
    if (userId) return userId;

    let id = localStorage.getItem("demo_uid");
    if (!id) {
      id = `demo_${Math.random().toString(36).slice(2)}`;
      localStorage.setItem("demo_uid", id);
    }

    return id;
  }

  async function sendVote(cardId) {
    if (!streamId) {
      setStatus("No streamId.");
      return;
    }

    if (location.protocol === "file:") {
      setStatus("Run through local server to vote.");
      return;
    }

    let res;
    try {
      res = await fetch("/vote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          streamId,
          cardId,
          userId: getUserId(),
        }),
      });
    } catch (e) {
      console.error("Vote request failed:", e);
      setStatus("Vote failed (network error).");
      return;
    }

    if (res.ok) {
      setStatus("Voted!");
      return;
    }

    if (res.status === 409) {
      setStatus("You already voted this round.");
      return;
    }

    let data = null;
    try {
      data = await res.json();
    } catch {}

    console.error("Vote error:", res.status, data);
    setStatus("Vote failed.");
  }

  window.addEventListener("resize", () => scheduleApplyUI("resize"));
  document.addEventListener("fullscreenchange", () => scheduleApplyUI("fullscreenchange"));

  setDesign(design.w, design.h);
  applyUI("startup");
  waitForTwitch();

  setTimeout(() => {
    if (!firstContextReceived && stage.children.length === 0) {
      console.warn("No Twitch context received; showing fallback cards.");
      showCards();
    }
  }, 1000);

  window.__viewerDebug = {
    get state() {
      return { cardCount, currentRoundId, streamId, userId, firstContextReceived, ui, design, lastContext };
    },
    showCards,
    applyUI,
  };
});
