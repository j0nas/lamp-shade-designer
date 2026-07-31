// UI wiring, source level: every interactive element index.html ships must be referenced by
// main.ts, and every id main.ts queries must exist in index.html. Deliberately a grep over the
// sources rather than a DOM test — the app only runs in a browser, but a dead control (the
// section-cut checkbox once shipped as a checkbox that did nothing) or a typo'd $() id is visible
// in the text alone, and this is the cheapest test that makes either a build failure.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const main = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

describe("index.html ↔ main.ts", () => {
  test("every interactive element is wired", () => {
    const ids = [...html.matchAll(/<(?:button|select|input|canvas)\b[^>]*\bid="([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(ids.length).toBeGreaterThan(10); // the regex still finds the controls at all
    const dead = ids.filter((id) => !main.includes(`"${id}"`));
    expect(dead).toEqual([]);
  });

  test("every id main.ts queries exists", () => {
    const queried = [...main.matchAll(/\$(?:<[^>]+>)?\("([^"]+)"\)/g)].map((m) => m[1]);
    expect(queried.length).toBeGreaterThan(10);
    const missing = queried.filter((id) => !html.includes(`id="${id}"`));
    expect(missing).toEqual([]);
  });
});
