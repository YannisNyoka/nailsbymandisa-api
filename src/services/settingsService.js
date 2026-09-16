import { getSettings as getSettingsDoc, settingsCollection, SETTINGS_DOC_ID } from '../models/settings.js';

export async function getSettings() {
  return getSettingsDoc();
}

// Partial update — merges provided fields into the single settings document. §2 requires
// these to be admin-editable without a code change, so every field booking/loyalty/etc.
// logic reads (deposit amount, cancellation window, hours, ...) must come from here, never
// be hardcoded in a service.
export async function updateSettings(partial) {
  await getSettingsDoc(); // ensures the doc exists before updating
  await settingsCollection().updateOne(
    { _id: SETTINGS_DOC_ID },
    { $set: { ...partial, updatedAt: new Date() } }
  );
  return getSettingsDoc();
}
