// Copy buttons and the terminal recording's playback. The page works without
// this script: the recording then shows its final frame.

const status = document.querySelector("[data-copy-status]");

for (const button of document.querySelectorAll(".copy")) {
  const label = button.querySelector(".copy__label");
  let reset;
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      label.textContent = "Copied";
      button.dataset.state = "copied";
      status.textContent = "Copied to clipboard";
    } catch {
      label.textContent = "Failed";
      status.textContent = "Copy failed. Select the text and copy it manually.";
    }
    clearTimeout(reset);
    reset = setTimeout(() => {
      label.textContent = "Copy";
      delete button.dataset.state;
      status.textContent = "";
    }, 2000);
  });
}

const video = document.querySelector(".terminal__video");
const toggle = document.querySelector(".terminal__toggle");

if (video && toggle) {
  // The <source> media queries pick the narrow recording on phones. Browsers only
  // apply them on load, so reload the video (and match its poster) when the
  // viewport crosses the breakpoint, for example when a phone is rotated.
  const narrow = window.matchMedia("(max-width: 560px)");
  const widePoster = video.poster;
  const pickPoster = () => {
    video.poster = narrow.matches ? video.dataset.narrowPoster : widePoster;
  };
  pickPoster();
  narrow.addEventListener("change", () => {
    pickPoster();
    video.load();
    render();
  });

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  // Plays only while visible, and only if the visitor has not paused it or asked
  // for reduced motion; then it waits for the Play button.
  let wanted = !reducedMotion.matches;
  let visible = false;

  const render = () => {
    const playing = wanted && visible;
    if (playing) video.play().catch(() => {});
    else video.pause();
    toggle.textContent = wanted ? "Pause" : "Play";
    toggle.setAttribute("aria-label", wanted ? "Pause recording" : "Play recording");
  };

  reducedMotion.addEventListener("change", () => {
    wanted = !reducedMotion.matches;
    render();
  });
  toggle.hidden = false;
  toggle.addEventListener("click", () => {
    wanted = !wanted;
    render();
  });
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    render();
  }).observe(video);
  render();
}
