// Robot mascot: eyes follow the pointer, and it hops when clicked.
(() => {
  const robots = document.querySelectorAll(".robot");
  if (!robots.length) return;

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const MAX_LOOK = 4; // px the eyes can move inside the face screen

  let frame = null;
  let pointer = null;

  function updateEyes() {
    frame = null;
    for (const robot of robots) {
      const rect = robot.getBoundingClientRect();
      if (!rect.width) continue; // hidden (e.g. welcome screen during a chat)
      const dx = pointer.x - (rect.left + rect.width / 2);
      const dy = pointer.y - (rect.top + rect.height * 0.35);
      const dist = Math.hypot(dx, dy) || 1;
      const strength = Math.min(dist / 200, 1); // look harder the further away the pointer is
      robot.style.setProperty("--look-x", `${(dx / dist) * MAX_LOOK * strength}px`);
      robot.style.setProperty("--look-y", `${(dy / dist) * MAX_LOOK * 0.7 * strength}px`);
    }
  }

  if (!reducedMotion) {
    window.addEventListener("pointermove", (e) => {
      pointer = { x: e.clientX, y: e.clientY };
      if (!frame) frame = requestAnimationFrame(updateEyes);
    }, { passive: true });

    // Look back at the center when the pointer leaves the window
    document.addEventListener("pointerleave", () => {
      robots.forEach((r) => { r.style.setProperty("--look-x", "0px"); r.style.setProperty("--look-y", "0px"); });
    });
  }

  robots.forEach((robot) => {
    robot.addEventListener("click", () => {
      robot.classList.remove("hop");
      void robot.offsetWidth; // restart the animation if clicked again quickly
      robot.classList.add("hop");
    });
    robot.addEventListener("animationend", (e) => {
      if (e.animationName === "robotHop") robot.classList.remove("hop");
    });
  });
})();
