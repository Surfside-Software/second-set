import { expect, test } from "bun:test";
import { join } from "node:path";
import { legacyUserData } from "../../desktop/data-directory.ts";

const appData = join("/", "home", "reviewer", ".config");
const userData = join(appData, "Second Set");
const legacy = join(appData, "moke-meta-hackathon");

const existing =
  (...paths: string[]) =>
  (path: string) =>
    paths.includes(path);

test("a workspace saved before the rename stays in its original folder", () => {
  expect(legacyUserData(appData, userData, existing(join(legacy, "app.sqlite")))).toBe(legacy);
});

test("the renamed folder is used once it holds a database, and for new installs", () => {
  expect(
    legacyUserData(
      appData,
      userData,
      existing(join(userData, "app.sqlite"), join(legacy, "app.sqlite")),
    ),
  ).toBeNull();
  expect(legacyUserData(appData, userData, existing())).toBeNull();
});

test("an old folder without a database is not adopted", () => {
  expect(legacyUserData(appData, userData, existing(join(legacy, "logs")))).toBeNull();
});
