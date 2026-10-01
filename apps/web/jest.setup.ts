// Brings in the DOM specific matchers (toBeInTheDocument, toBeVisible and the rest).
// TypeScript needs them referenced to know they exist at all, so this file is an import
// with a purpose rather than setup that only runs inside Jest.
import "@testing-library/jest-dom";

// jsdom does not implement matchMedia, and the theme hook calls it on mount. Without
// this the component under test throws before it has asserted anything, which reads
// as a failure of the component rather than of the environment.
if (typeof window !== "undefined" && !window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}