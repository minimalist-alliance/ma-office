// The data guard's words in the app (ma-platform ADR 0110, `docs/sub-status/s35-data-guard.md`). The platform sends the long
// words ready to show (`message`); the app shows them as given and adds only these. Never a dollar figure and never "absorbed".
// The billing-day line and the notice itself are in `chrome/dataGuardView.tsx`, a lazy chunk, to keep the initial JS in budget.

/** The one-minute notice's reason, when a stop is announced with `stopReason: "data_guard"`. */
export const DATA_GUARD_STOPPING = 'Your desks are stopping: your data use this month went past your plan.';
export const DATA_GUARD_STOP_REASON = 'data_guard';
