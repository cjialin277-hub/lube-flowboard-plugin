import { useEffect, useRef, type RefObject } from "react";
import gsap from "gsap";

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * GSAP Preset #3 (UI/UX Pro Max): Magnetic cursor-follow micro-interaction
 * with `gsap.quickTo` and `elastic.out(1, 0.4)` return spring.
 */
export function useGsapMagnetic<T extends HTMLElement = HTMLButtonElement>(
  strength = 0.24,
): RefObject<T> {
  const ref = useRef<T>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion()) return;

    const xTo = gsap.quickTo(el, "x", {
      duration: 0.35,
      ease: "power3.out",
    });
    const yTo = gsap.quickTo(el, "y", {
      duration: 0.35,
      ease: "power3.out",
    });

    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const dx = (e.clientX - (r.left + r.width / 2)) * strength;
      const dy = (e.clientY - (r.top + r.height / 2)) * strength;
      xTo(Math.max(-10, Math.min(10, dx)));
      yTo(Math.max(-6, Math.min(6, dy)));
    };

    const onLeave = () => {
      gsap.to(el, {
        x: 0,
        y: 0,
        duration: 0.5,
        ease: "elastic.out(1, 0.4)",
        overwrite: "auto",
      });
    };

    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerleave", onLeave);
    return () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
      gsap.killTweensOf(el);
    };
  }, [strength]);

  return ref;
}

/**
 * GSAP Cursor-Following Radial Spotlight for glass surfaces, toolbars, and modals.
 * Smoothly interpolates `--spot-x` and `--spot-y` CSS variables via `gsap.quickTo`.
 */
export function useGsapSpotlight<T extends HTMLElement = HTMLDivElement>(): RefObject<T> {
  const ref = useRef<T>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion()) return;

    const pos = { x: el.clientWidth / 2, y: el.clientHeight / 2 };
    const xTo = gsap.quickTo(pos, "x", {
      duration: 0.28,
      ease: "power3.out",
      onUpdate: () => {
        el.style.setProperty("--spot-x", `${pos.x.toFixed(1)}px`);
      },
    });
    const yTo = gsap.quickTo(pos, "y", {
      duration: 0.28,
      ease: "power3.out",
      onUpdate: () => {
        el.style.setProperty("--spot-y", `${pos.y.toFixed(1)}px`);
      },
    });

    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      xTo(e.clientX - r.left);
      yTo(e.clientY - r.top);
      el.style.setProperty("--spot-opacity", "1");
    };

    const onLeave = () => {
      el.style.setProperty("--spot-opacity", "0");
    };

    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerleave", onLeave);
    return () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  return ref;
}

/**
 * GSAP Preset #2 & #3: 3D Hover Tilt + Lift handlers for cards in a grid.
 */
export function attachGsapCardTilt(
  el: HTMLElement,
  e: React.PointerEvent<HTMLElement>,
  maxDeg = 4.5,
) {
  if (prefersReducedMotion()) return;
  const r = el.getBoundingClientRect();
  const nx = (e.clientX - r.left) / Math.max(r.width, 1) - 0.5;
  const ny = (e.clientY - r.top) / Math.max(r.height, 1) - 0.5;
  gsap.to(el, {
    y: -4,
    scale: 1.016,
    rotateY: nx * maxDeg * 2,
    rotateX: -ny * maxDeg * 2,
    transformPerspective: 800,
    duration: 0.24,
    ease: "power2.out",
    overwrite: "auto",
  });
}

export function resetGsapCardTilt(el: HTMLElement) {
  if (prefersReducedMotion()) return;
  gsap.to(el, {
    y: 0,
    scale: 1,
    rotateX: 0,
    rotateY: 0,
    duration: 0.38,
    ease: "power3.out",
    overwrite: "auto",
  });
}

/**
 * GSAP Preset #8 & #9: Staggered Bento / Asset Grid Entrance + Headline Reveal.
 */
export function runModalEntranceChoreography(rootEl: HTMLElement | null) {
  if (!rootEl || prefersReducedMotion()) return;

  const ctx = gsap.context(() => {
    const words = rootEl.querySelectorAll(".gsap-split-word");
    const engineCards = rootEl.querySelectorAll(".gsap-bento-card");
    const pipelinePanel = rootEl.querySelectorAll(".gsap-pipeline-panel");
    const svgFlows = rootEl.querySelectorAll(".gsap-svg-flow-line");
    const svgPulses = rootEl.querySelectorAll(".gsap-svg-node-pulse");

    gsap.fromTo(
      rootEl,
      { opacity: 0, scale: 0.96, y: 14 },
      { opacity: 1, scale: 1, y: 0, duration: 0.36, ease: "expo.out" },
    );

    if (words.length > 0) {
      gsap.fromTo(
        words,
        { opacity: 0, y: 14, rotateX: -35 },
        {
          opacity: 1,
          y: 0,
          rotateX: 0,
          duration: 0.5,
          stagger: 0.025,
          ease: "expo.out",
        },
      );
    }

    if (engineCards.length > 0) {
      gsap.fromTo(
        engineCards,
        { opacity: 0, y: 18, scale: 0.95 },
        {
          opacity: 1,
          y: 0,
          scale: 1,
          duration: 0.42,
          stagger: 0.06,
          delay: 0.06,
          ease: "back.out(1.35)",
        },
      );
    }

    if (pipelinePanel.length > 0) {
      gsap.fromTo(
        pipelinePanel,
        { opacity: 0, y: 14 },
        { opacity: 1, y: 0, duration: 0.38, delay: 0.14, ease: "power2.out" },
      );
    }

    if (svgFlows.length > 0) {
      gsap.to(svgFlows, {
        strokeDashoffset: -72,
        duration: 2.2,
        ease: "none",
        repeat: -1,
      });
    }

    if (svgPulses.length > 0) {
      gsap.to(svgPulses, {
        scale: 1.18,
        opacity: 0.45,
        transformOrigin: "50% 50%",
        duration: 1.35,
        stagger: 0.25,
        yoyo: true,
        repeat: -1,
        ease: "sine.inOut",
      });
    }
  }, rootEl);

  return () => ctx.revert();
}

/**
 * GSAP Preset #8: Wave-stagger reveal when Midjourney asset cards finish loading.
 */
export function runAssetGridStagger(gridEl: HTMLElement | null) {
  if (!gridEl || prefersReducedMotion()) return;
  const items = gridEl.querySelectorAll(".gsap-mj-card");
  if (items.length === 0) return;

  gsap.fromTo(
    items,
    { opacity: 0, y: 16, scale: 0.94 },
    {
      opacity: 1,
      y: 0,
      scale: 1,
      duration: 0.36,
      stagger: { each: 0.022, from: "start" },
      ease: "power2.out",
      overwrite: "auto",
    },
  );
}
