const form = document.querySelector("[data-artist-intake]");
const success = document.querySelector("[data-intake-success]");
const errorMessage = document.querySelector("[data-intake-error]");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorMessage.textContent = "";
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  button.innerHTML = "saving your profile…";
  try {
    const response = await fetch("/api/artists/intake", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(Object.fromEntries(new FormData(form))),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Your profile could not be saved.");
    form.hidden = true;
    success.hidden = false;
    success.scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (error) {
    errorMessage.textContent = error.message;
    button.disabled = false;
    button.innerHTML = "save my profile <b>↗︎</b>";
  }
});
