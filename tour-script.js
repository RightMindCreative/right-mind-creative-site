const tourReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const tourReveals = document.querySelectorAll(".tour-reveal");
const tourObserver = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) {
      entry.target.classList.add("is-visible");
      tourObserver.unobserve(entry.target);
    }
  });
}, { threshold: 0.12 });
tourReveals.forEach((element, index) => {
  element.style.transitionDelay = `${(index % 3) * 80}ms`;
  tourObserver.observe(element);
});

const chapters = [...document.querySelectorAll("[data-chapter]")];
const glassLinks = [...document.querySelectorAll(".glass-bubble")];
const chapterObserver = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (!entry.isIntersecting) return;
    glassLinks.forEach((link) => link.classList.toggle("is-active", link.getAttribute("href") === `#${entry.target.id}`));
  });
}, { rootMargin: "-35% 0px -55%", threshold: 0 });
chapters.forEach((chapter) => chapterObserver.observe(chapter));

document.querySelectorAll("button").forEach((button) => button.addEventListener("click", (event) => event.preventDefault()));

if (!tourReducedMotion) {
  const hero = document.querySelector(".tour-hero-media");
  const images = [...document.querySelectorAll(".image-frame img")];
  let ticking = false;
  const updateTourMotion = () => {
    hero.style.transform = `scale(1.07) translateY(${Math.min(window.scrollY * 0.12, 105)}px)`;
    images.forEach((image) => {
      const frame = image.parentElement.getBoundingClientRect();
      const progress = Math.max(0, Math.min(1, (window.innerHeight - frame.top) / (window.innerHeight + frame.height)));
      image.style.setProperty("--image-y", `${(progress - 0.5) * 55}px`);
    });
    ticking = false;
  };
  window.addEventListener("scroll", () => {
    if (!ticking) {
      requestAnimationFrame(updateTourMotion);
      ticking = true;
    }
  }, { passive: true });
  updateTourMotion();
}
