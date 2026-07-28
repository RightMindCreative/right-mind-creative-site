const aboutReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const aboutReveals = document.querySelectorAll(".about-reveal");
const aboutObserver = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (!entry.isIntersecting) return;
    entry.target.classList.add("is-visible");
    aboutObserver.unobserve(entry.target);
  });
}, { threshold: 0.12 });

aboutReveals.forEach((element, index) => {
  element.style.transitionDelay = `${(index % 3) * 80}ms`;
  aboutObserver.observe(element);
});

const aboutChapters = document.querySelectorAll("[data-chapter]");
const aboutPills = document.querySelectorAll(".about-pill");
const chapterObserver = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (!entry.isIntersecting) return;
    aboutPills.forEach((pill) => {
      pill.classList.toggle("is-active", pill.getAttribute("href") === `#${entry.target.id}`);
    });
  });
}, { rootMargin: "-35% 0px -55%", threshold: 0 });
aboutChapters.forEach((chapter) => chapterObserver.observe(chapter));

if (!aboutReducedMotion) {
  const images = document.querySelectorAll(".about-image img");
  let ticking = false;
  const updateAboutMotion = () => {
    images.forEach((image) => {
      const frame = image.parentElement.getBoundingClientRect();
      const progress = Math.max(0, Math.min(1, (window.innerHeight - frame.top) / (window.innerHeight + frame.height)));
      image.style.setProperty("--image-y", `${(progress - 0.5) * 48}px`);
    });
    ticking = false;
  };
  window.addEventListener("scroll", () => {
    if (ticking) return;
    requestAnimationFrame(updateAboutMotion);
    ticking = true;
  }, { passive: true });
  updateAboutMotion();
}
