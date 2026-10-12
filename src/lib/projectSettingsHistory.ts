import { createSettingsHistory } from "./settingsHistory.ts";

/** Project Settings never use the global Settings page namespace. */
export const projectSettingsHistory = createSettingsHistory("saurons-eye:project-settings");
