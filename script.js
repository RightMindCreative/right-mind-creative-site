const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const heroVideo = document.querySelector(".hero-media");
if (heroVideo) heroVideo.playbackRate = 0.5;
const selectedWorkVideo = document.querySelector(".listen-visual video");
if (selectedWorkVideo) selectedWorkVideo.playbackRate = 0.5;

document.querySelectorAll("button:not([data-audio])").forEach((button) => {
  button.addEventListener("click", (event) => event.preventDefault());
});

const player = new Audio();
let activeAudioButton = null;
const expandedBackdrop = document.querySelector("[data-player-backdrop]");
const expandedPlayButton = document.querySelector(".player-main-play");
const expandedSeek = document.querySelector(".player-seek");
const expandedCurrent = document.querySelector(".player-current");
const expandedTotal = document.querySelector(".player-total");
const expandedCover = document.querySelector(".expanded-cover");
const expandedTitle = document.querySelector("#expanded-player-title");
const expandedArtist = document.querySelector(".player-artist");
let expandedTrack = null;

const formatTime = (seconds) => {
  if (!Number.isFinite(seconds)) return "--:--";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
};

const syncPlayState = () => {
  const isPlaying = !player.paused;
  if (activeAudioButton) activeAudioButton.textContent = isPlaying ? "Ⅱ" : "▶︎";
  if (expandedPlayButton) {
    expandedPlayButton.textContent = isPlaying ? "Ⅱ" : "▶︎";
    const title = expandedTitle?.textContent || "track";
    expandedPlayButton.setAttribute("aria-label", `${isPlaying ? "Pause" : "Play"} ${title}`);
  }
};

document.querySelectorAll("[data-audio]").forEach((button) => {
  button.addEventListener("click", () => {
    if (activeAudioButton === button && !player.paused) {
      player.pause();
      syncPlayState();
      return;
    }
    if (activeAudioButton) activeAudioButton.textContent = "▶︎";
    player.src = button.dataset.audio;
    activeAudioButton = button;
    player.play();
    syncPlayState();
  });
});
player.addEventListener("loadedmetadata", () => {
  const duration = formatTime(Math.round(player.duration));
  const activeTrack = activeAudioButton?.closest(".track");
  activeTrack?.querySelector(".track-duration")?.replaceChildren(duration);
  if (expandedTotal) expandedTotal.textContent = duration;
});
player.addEventListener("timeupdate", () => {
  if (expandedCurrent) expandedCurrent.textContent = formatTime(player.currentTime);
  if (expandedSeek && Number.isFinite(player.duration)) {
    expandedSeek.value = String((player.currentTime / player.duration) * 100);
  }
});
player.addEventListener("play", syncPlayState);
player.addEventListener("pause", syncPlayState);
player.addEventListener("ended", () => {
  syncPlayState();
  activeAudioButton = null;
});

const openExpandedPlayer = (track) => {
  if (!track) return;
  expandedTrack = track;
  const trackButton = track.querySelector("[data-audio]");
  const trackTitle = track.querySelector("h3")?.textContent.trim() || "Selected work";
  const trackArtist = track.querySelector("p")?.textContent.trim() || "Right Mind Creative";
  const trackArtwork = track.querySelector("img");
  expandedTitle.textContent = trackTitle;
  expandedArtist.textContent = trackArtist;
  expandedCover.src = trackArtwork.src;
  expandedCover.alt = trackArtwork.alt;
  expandedPlayButton.setAttribute("aria-label", `Play ${trackTitle}`);
  expandedBackdrop.hidden = false;
  document.body.style.overflow = "hidden";
  document.querySelector(".player-close")?.focus();
  if (!player.src.endsWith(trackButton.dataset.audio)) {
    if (activeAudioButton) activeAudioButton.textContent = "▶︎";
    player.src = trackButton.dataset.audio;
    activeAudioButton = trackButton;
    expandedCurrent.textContent = "0:00";
    expandedSeek.value = "0";
    expandedTotal.textContent = track.querySelector(".track-duration")?.textContent || "--:--";
  }
  syncPlayState();
};

document.querySelectorAll(".track:has(.artwork-open)").forEach((track) => {
  track.querySelector(".artwork-open")?.addEventListener("click", () => openExpandedPlayer(track));
  track.addEventListener("click", (event) => {
    if (event.target.closest("[data-audio]")) return;
    openExpandedPlayer(track);
  });
});

const closeExpandedPlayer = () => {
  expandedBackdrop.hidden = true;
  document.body.style.overflow = "";
  expandedTrack?.querySelector(".artwork-open")?.focus();
};
document.querySelector(".player-close")?.addEventListener("click", closeExpandedPlayer);
expandedBackdrop?.addEventListener("click", (event) => {
  if (event.target === expandedBackdrop) closeExpandedPlayer();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && expandedBackdrop && !expandedBackdrop.hidden) closeExpandedPlayer();
});
expandedPlayButton?.addEventListener("click", () => {
  const trackButton = expandedTrack?.querySelector("[data-audio]");
  if (trackButton && !player.src.endsWith(trackButton.dataset.audio)) {
    player.src = trackButton.dataset.audio;
    activeAudioButton = trackButton;
  }
  if (player.paused) player.play();
  else player.pause();
});
expandedSeek?.addEventListener("input", () => {
  if (Number.isFinite(player.duration)) player.currentTime = (Number(expandedSeek.value) / 100) * player.duration;
});
document.querySelectorAll("[data-skip]").forEach((button) => {
  button.addEventListener("click", () => {
    player.currentTime = Math.max(0, Math.min(player.duration || 0, player.currentTime + Number(button.dataset.skip)));
  });
});
document.querySelector(".player-volume")?.addEventListener("input", (event) => {
  player.volume = Number(event.target.value);
});

const observer = new IntersectionObserver(
  (entries) => entries.forEach((entry) => {
    if (entry.isIntersecting) {
      entry.target.classList.add("is-visible");
      observer.unobserve(entry.target);
    }
  }),
  { threshold: 0.12 }
);

document.querySelectorAll(".reveal").forEach((element, index) => {
  element.style.transitionDelay = `${(index % 3) * 70}ms`;
  observer.observe(element);
});

if (!reducedMotion) {
  const heroMedia = document.querySelector(".hero-media");
  const parallaxImage = document.querySelector(".parallax-image");
  const statementTitle = document.querySelector(".statement .display");
  const aboutTop = document.querySelector(".about-top");
  const aboutVisual = document.querySelector(".about-visual");
  const serviceRows = [...document.querySelectorAll(".service")];
  const listenVisual = document.querySelector(".listen-visual");
  const listenTitle = document.querySelector(".listen-title");
  const finalEyebrow = document.querySelector(".final-cta .eyebrow");
  const finalTitle = document.querySelector(".final-cta .split-title");
  const finalButton = document.querySelector(".final-cta .round-link");
  let ticking = false;

  const sectionProgress = (element) => {
    if (!element) return 0.5;
    const rect = element.getBoundingClientRect();
    return Math.max(0, Math.min(1, (window.innerHeight - rect.top) / (window.innerHeight + rect.height)));
  };

  const setMotion = (element, property, value) => {
    if (element) element.style.setProperty(property, `${value.toFixed(2)}px`);
  };

  const updateMotion = () => {
    const y = window.scrollY;
    heroMedia.style.transform = `scale(1.08) translateY(${Math.min(y * 0.13, 100)}px)`;
    if (parallaxImage) {
      const rect = parallaxImage.parentElement.getBoundingClientRect();
      const progress = (window.innerHeight - rect.top) / (window.innerHeight + rect.height);
      parallaxImage.style.transform = `translateY(${(progress - 0.5) * 110}px)`;
    }
    const statementOffset = sectionProgress(statementTitle) - 0.5;
    setMotion(statementTitle, "--motion-x", statementOffset * -70);

    const aboutOffset = sectionProgress(document.querySelector(".about")) - 0.5;
    setMotion(aboutTop, "--motion-x", aboutOffset * 55);
    setMotion(aboutVisual, "--motion-y", aboutOffset * -90);

    const servicesOffset = sectionProgress(document.querySelector(".services")) - 0.5;
    serviceRows.forEach((row, index) => {
      const direction = index % 2 === 0 ? -1 : 1;
      setMotion(row, "--motion-x", servicesOffset * direction * (18 + index * 4));
    });

    const listenOffset = sectionProgress(document.querySelector(".listen")) - 0.5;
    setMotion(listenVisual, "--motion-y", listenOffset * -85);
    setMotion(listenTitle, "--motion-x", listenOffset * 50);

    const finalOffset = sectionProgress(document.querySelector(".final-cta")) - 0.5;
    setMotion(finalEyebrow, "--motion-y", finalOffset * -45);
    setMotion(finalTitle, "--motion-x", finalOffset * -65);
    setMotion(finalButton, "--motion-y", finalOffset * 90);
    ticking = false;
  };

  window.addEventListener("scroll", () => {
    if (!ticking) {
      requestAnimationFrame(updateMotion);
      ticking = true;
    }
  }, { passive: true });
  updateMotion();
}
