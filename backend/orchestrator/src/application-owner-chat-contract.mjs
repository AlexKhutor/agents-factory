// The owner chat's place in the application contract: its operations stay declared (the frontend kit and
// its accepted delivery know them) while the Gateway no longer runs the Codex owner chat that implemented
// them (roadmap step 1, the Codex path out of the product): they are reported unavailable.

export const APPLICATION_OWNER_CHAT_VERSION = "v0.2.0";
export const APPLICATION_OWNER_CHAT_OPERATION_IDS = Object.freeze({
  resolve: "query.provider.owner-thread.resolve",
  start: "mutation.provider.owner-turn.start",
  steer: "mutation.provider.owner-turn.steer",
  receipt: "receipt.provider.owner-message.read",
});
