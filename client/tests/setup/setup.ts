import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// jsdom does not implement the browser APIs Radix primitives (and the theme
// provider) rely on, so provide the minimum behaviour they need.
if (typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
}

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

if (typeof Element.prototype.scrollIntoView !== "function") {
  Element.prototype.scrollIntoView = vi.fn();
}

if (typeof Element.prototype.hasPointerCapture !== "function") {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}

if (typeof globalThis.PointerEvent === "undefined") {
  globalThis.PointerEvent = class extends MouseEvent {
    pointerId = 1;
    pointerType = "mouse";
    isPrimary = true;
  } as unknown as typeof PointerEvent;
}

// Node 22+ installs a `localStorage` global that resolves to undefined unless
// the process is started with --localstorage-file. That global replaces
// jsdom's own Storage instance, so every test that touches storage fails
// with "Cannot read properties of undefined". Restore jsdom's instances when
// the Node global is the one in effect.
if (typeof globalThis.localStorage === "undefined") {
  const jsdomWindow = window as unknown as {
    _localStorage?: Storage;
    _sessionStorage?: Storage;
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: jsdomWindow._localStorage,
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    writable: true,
    value: jsdomWindow._sessionStorage,
  });
}

afterEach(() => {
  cleanup();
});
