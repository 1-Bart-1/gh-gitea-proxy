import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "../..");

/** The names checked off in the README's support checklist. */
const checked = (): string[] =>
  [...readFileSync(join(root, "README.md"), "utf8").matchAll(/^- \[x\] `([^`]+)`/gm)].map((match) => match[1]);

/** The name of every end-to-end test. */
function tested(): string[] {
  const directory = join(root, "test/e2e");
  return readdirSync(directory).filter((file) => file.endsWith(".test.ts")).flatMap((file) =>
    [...readFileSync(join(directory, file), "utf8").matchAll(/^\s+test\("([^"]+)"/gm)].map((match) => match[1]));
}

test("every checked README item names an end-to-end test", () => {
  const names = new Set(tested());
  assert.deepEqual(checked().filter((name) => !names.has(name)), []);
});

test("every end-to-end test is checked in the README", () => {
  const names = new Set(checked());
  assert.deepEqual(tested().filter((name) => !names.has(name)), []);
});
