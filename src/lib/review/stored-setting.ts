/** Window-storage keys, each with the key the same setting used before the rename from MOKE. */
export const storedSettingKeys = {
  preferredReviewModel: {
    key: "second-set.preferredReviewModel",
    legacy: "moke.preferredReviewModel",
  },
  dismissedCloudReview: {
    key: "second-set.cloudReview.dismissed",
    legacy: "moke.cloudReview.dismissed",
  },
} as const;

type StoredSetting = (typeof storedSettingKeys)[keyof typeof storedSettingKeys];

/** Read a saved setting, moving a value saved under its MOKE-era key on first use. */
export function readStoredSetting(
  setting: StoredSetting,
  storage:
    Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined = globalThis.localStorage,
): string | null {
  if (storage === undefined) return null;
  const current = storage.getItem(setting.key);

  if (current !== null) return current;
  const legacy = storage.getItem(setting.legacy);

  if (legacy === null) return null;
  storage.setItem(setting.key, legacy);
  storage.removeItem(setting.legacy);

  return legacy;
}
