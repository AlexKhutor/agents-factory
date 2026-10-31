import { APPLICATION_CONTRACT_VERSION } from "./application-contract.mjs";
import { APPLICATION_AGENT_EVENTS_OPERATION, APPLICATION_AGENT_EVENTS_VERSION } from "./application-agent-events.mjs";
import { APPLICATION_AGENT_ARTIFACT_OPERATIONS, APPLICATION_AGENT_ARTIFACT_VERSION } from "./application-agent-artifacts.mjs";
import { APPLICATION_PROJECT_WORKSPACE_OPERATIONS, APPLICATION_PROJECT_WORKSPACE_VERSION } from "./application-project-workspace.mjs";
import { APPLICATION_PROJECT_WORKSPACE_SAVE_OPERATION,
  APPLICATION_PROJECT_WORKSPACE_SAVE_VERSION } from "./application-project-workspace-save.mjs";
import { APPLICATION_PROJECT_COPY_OPERATION,
  APPLICATION_PROJECT_COPY_VERSION } from "./application-project-copy.mjs";
import { APPLICATION_AGENT_CONVERSATION_OPERATIONS, APPLICATION_AGENT_CONVERSATION_VERSION } from "./application-agent-conversation.mjs";
import { APPLICATION_AGENT_CONTROL_OPERATIONS, APPLICATION_AGENT_CONTROL_VERSION } from "./application-agent-control.mjs";
import { APPLICATION_CHANGE_PROPOSAL_VERSION } from "./application-change-proposal.mjs";
import { APPLICATION_CHANGE_RECEIPT_VERSION } from "./application-change-receipt.mjs";
import { APPLICATION_KEEP_VERSION } from "./application-keep.mjs";
import { APPLICATION_CONVERSATION_ARCHIVE_OPERATION_IDS } from "./application-conversation-archive.mjs";
import { CONVERSATION_ARCHIVE_VERSION } from "./conversation-archive.mjs";
import {
  APPLICATION_OWNER_CHAT_OPERATION_IDS,
  APPLICATION_OWNER_CHAT_VERSION,
} from "./application-owner-chat-contract.mjs";
import {
  APPLICATION_PROVIDER_INTERACTION_OPERATION_IDS,
  APPLICATION_PROVIDER_INTERACTION_VERSION,
} from "./application-provider-interaction-bridge.mjs";
import {
  APPLICATION_PROJECT_MEMORY_OPERATION_IDS,
  APPLICATION_PROJECT_MEMORY_VERSION,
} from "./application-project-memory.mjs";
import { APPLICATION_REVIEW_ANCHOR_VERSION } from "./application-review-anchor.mjs";
import { APPLICATION_REVIEW_COMMENT_VERSION } from "./application-review-comment.mjs";
import {
  PROVIDER_EXECUTION_PROFILE_DECISION_VERSION,
} from "./provider-execution-profile-decision.mjs";

export const APPLICATION_DOMAIN_OPERATION_CATALOG_VERSION = "v0.10.0";

function definition(family, operationId, resourceKinds, contractId, contractVersion, action) {
  return Object.freeze({
    operation: Object.freeze({
      schemaVersion: 1,
      contractVersion: APPLICATION_CONTRACT_VERSION,
      family,
      operationId,
    }),
    resourceKinds: Object.freeze(resourceKinds),
    binding: Object.freeze({
      contractId,
      contractVersion,
      operationId: action,
      transportId: ["query", "receipt-lookup"].includes(family)
        ? "local-query-json" : "local-process-json",
    }),
  });
}

export const APPLICATION_DOMAIN_OPERATION_DEFINITIONS = Object.freeze([
  definition("query", APPLICATION_AGENT_EVENTS_OPERATION, ["provider-thread"],
    "application-agent-events", APPLICATION_AGENT_EVENTS_VERSION, "read"),
  ...Object.entries(APPLICATION_AGENT_ARTIFACT_OPERATIONS).map(([action, operationId]) =>
    definition("query", operationId, ["artifact"], "application-agent-artifacts", APPLICATION_AGENT_ARTIFACT_VERSION, action)),
  ...Object.entries(APPLICATION_PROJECT_WORKSPACE_OPERATIONS).map(([action, operationId]) =>
    definition("query", operationId, ["project-file", "project-directory"],
      "application-project-workspace", APPLICATION_PROJECT_WORKSPACE_VERSION, action)),
  definition("mutation", APPLICATION_PROJECT_WORKSPACE_SAVE_OPERATION,
    ["project-file", "receipt"], "application-project-workspace-save",
    APPLICATION_PROJECT_WORKSPACE_SAVE_VERSION, "save"),
  definition("mutation", APPLICATION_PROJECT_COPY_OPERATION,
    ["project-file", "receipt"], "application-project-copy",
    APPLICATION_PROJECT_COPY_VERSION, "copy"),
  ...Object.entries(APPLICATION_AGENT_CONVERSATION_OPERATIONS).map(([action, operationId]) =>
    definition("query", operationId, ["provider-thread"],
      "application-agent-conversation", APPLICATION_AGENT_CONVERSATION_VERSION, action)),
  ...Object.entries(APPLICATION_AGENT_CONTROL_OPERATIONS).map(([action, operationId]) =>
    definition(operationId.split(".")[0], operationId, ["provider-thread", "interaction", "receipt"],
      "application-agent-control", APPLICATION_AGENT_CONTROL_VERSION, action)),
  definition(
    "query", APPLICATION_PROJECT_MEMORY_OPERATION_IDS.listScopes,
    ["project-file"], "application-project-memory",
    APPLICATION_PROJECT_MEMORY_VERSION, "list-scopes",
  ),
  definition(
    "query", APPLICATION_PROJECT_MEMORY_OPERATION_IDS.readScope,
    ["project-file"], "application-project-memory",
    APPLICATION_PROJECT_MEMORY_VERSION, "read-scope",
  ),
  definition(
    "mutation", APPLICATION_PROJECT_MEMORY_OPERATION_IDS.createScope,
    ["project-file"], "application-project-memory",
    APPLICATION_PROJECT_MEMORY_VERSION, "create-scope",
  ),
  definition(
    "mutation", APPLICATION_PROJECT_MEMORY_OPERATION_IDS.write,
    ["project-file", "receipt"], "application-project-memory",
    APPLICATION_PROJECT_MEMORY_VERSION, "write-scope",
  ),
  definition(
    "query", APPLICATION_PROJECT_MEMORY_OPERATION_IDS.listAgents,
    ["provider-thread"], "application-project-memory",
    APPLICATION_PROJECT_MEMORY_VERSION, "list-agents",
  ),
  definition(
    "query", APPLICATION_PROJECT_MEMORY_OPERATION_IDS.readAgent,
    ["provider-thread"], "application-project-memory",
    APPLICATION_PROJECT_MEMORY_VERSION, "read-agent",
  ),
  definition(
    "query", APPLICATION_PROJECT_MEMORY_OPERATION_IDS.context,
    ["project-file", "provider-thread"], "application-project-memory",
    APPLICATION_PROJECT_MEMORY_VERSION, "read-context",
  ),
  definition(
    "mutation", APPLICATION_PROJECT_MEMORY_OPERATION_IDS.createAgent,
    ["provider-thread"], "application-project-memory",
    APPLICATION_PROJECT_MEMORY_VERSION, "create-agent",
  ),
  definition(
    "mutation", APPLICATION_PROJECT_MEMORY_OPERATION_IDS.closeAgent,
    ["provider-thread"], "application-project-memory",
    APPLICATION_PROJECT_MEMORY_VERSION, "close-agent",
  ),
  definition(
    "query", APPLICATION_PROJECT_MEMORY_OPERATION_IDS.readArchive,
    ["provider-thread"], "application-project-memory",
    APPLICATION_PROJECT_MEMORY_VERSION, "read-archive",
  ),
  definition(
    "mutation", APPLICATION_PROJECT_MEMORY_OPERATION_IDS.send,
    ["provider-thread", "provider-turn", "receipt"], "application-project-memory",
    APPLICATION_PROJECT_MEMORY_VERSION, "send",
  ),
  definition(
    "receipt-lookup", APPLICATION_PROJECT_MEMORY_OPERATION_IDS.receipt,
    ["provider-thread", "provider-turn", "receipt"], "application-project-memory",
    APPLICATION_PROJECT_MEMORY_VERSION, "read-send-receipt",
  ),
  definition(
    "mutation", APPLICATION_PROJECT_MEMORY_OPERATION_IDS.steer,
    ["provider-thread", "provider-turn", "receipt"], "application-project-memory",
    APPLICATION_PROJECT_MEMORY_VERSION, "steer",
  ),
  definition(
    "mutation", APPLICATION_PROJECT_MEMORY_OPERATION_IDS.unqueue,
    ["provider-thread", "provider-turn"], "application-project-memory",
    APPLICATION_PROJECT_MEMORY_VERSION, "unqueue",
  ),
  definition(
    "mutation", APPLICATION_PROJECT_MEMORY_OPERATION_IDS.setProfile,
    ["provider-thread"], "application-project-memory",
    APPLICATION_PROJECT_MEMORY_VERSION, "set-profile",
  ),
  definition(
    "query", APPLICATION_PROJECT_MEMORY_OPERATION_IDS.trace,
    ["provider-thread", "provider-turn"], "application-project-memory",
    APPLICATION_PROJECT_MEMORY_VERSION, "read-trace",
  ),
  definition(
    "query", APPLICATION_CONVERSATION_ARCHIVE_OPERATION_IDS.resolve,
    ["artifact"], "application-conversation-archive", CONVERSATION_ARCHIVE_VERSION, "resolve",
  ),
  definition(
    "query", APPLICATION_CONVERSATION_ARCHIVE_OPERATION_IDS.read,
    ["artifact"], "application-conversation-archive", CONVERSATION_ARCHIVE_VERSION, "read",
  ),
  definition(
    "query", APPLICATION_OWNER_CHAT_OPERATION_IDS.resolve,
    ["provider-thread", "provider-turn"], "application-owner-chat",
    APPLICATION_OWNER_CHAT_VERSION, "resolve",
  ),
  definition(
    "mutation", APPLICATION_OWNER_CHAT_OPERATION_IDS.start,
    ["provider-thread", "provider-turn", "receipt"], "application-owner-chat",
    APPLICATION_OWNER_CHAT_VERSION, "start",
  ),
  definition(
    "mutation", APPLICATION_OWNER_CHAT_OPERATION_IDS.steer,
    ["provider-thread", "provider-turn", "receipt"], "application-owner-chat",
    APPLICATION_OWNER_CHAT_VERSION, "steer",
  ),
  definition(
    "receipt-lookup", APPLICATION_OWNER_CHAT_OPERATION_IDS.receipt,
    ["provider-thread", "provider-turn", "receipt"], "application-owner-chat",
    APPLICATION_OWNER_CHAT_VERSION, "read",
  ),
  definition(
    "approval", "approval.application.execution-profile.bind",
    ["provider-item", "interaction"], "provider-execution-profile-decision",
    PROVIDER_EXECUTION_PROFILE_DECISION_VERSION, "bind-profile",
  ),
  definition(
    "query", "query.application.execution-profile.verify",
    ["provider-item", "provider-turn"], "provider-execution-profile-decision",
    PROVIDER_EXECUTION_PROFILE_DECISION_VERSION, "verify-start-profile",
  ),
  definition(
    "query", APPLICATION_PROVIDER_INTERACTION_OPERATION_IDS.read,
    ["provider-item", "provider-turn", "interaction"], "application-provider-interaction",
    APPLICATION_PROVIDER_INTERACTION_VERSION, "read",
  ),
  definition(
    "approval", APPLICATION_PROVIDER_INTERACTION_OPERATION_IDS.respond,
    ["provider-item", "provider-turn", "interaction"], "application-provider-interaction",
    APPLICATION_PROVIDER_INTERACTION_VERSION, "respond",
  ),
  definition(
    "query", "query.application.review-anchor.validate",
    ["review-operation", "artifact", "project-file"], "application-review-anchor",
    APPLICATION_REVIEW_ANCHOR_VERSION, "validate",
  ),
  definition(
    "mutation", "mutation.application.review-comment.record",
    ["review-operation"], "application-review-comment",
    APPLICATION_REVIEW_COMMENT_VERSION, "record",
  ),
  definition(
    "query", "query.application.change-proposal.verify",
    ["change-proposal"], "application-change-proposal",
    APPLICATION_CHANGE_PROPOSAL_VERSION, "verify",
  ),
  definition(
    "proposal", "proposal.application.inverse-proposal.prepare",
    ["change-proposal"], "application-change-proposal",
    APPLICATION_CHANGE_PROPOSAL_VERSION, "prepare-inverse",
  ),
  definition(
    "mutation", "mutation.change-proposal.keep",
    ["change-proposal", "receipt"], "application-keep",
    APPLICATION_KEEP_VERSION, "keep",
  ),
  definition(
    "receipt-lookup", "receipt.application.change.read",
    ["receipt"], "application-change-receipt",
    APPLICATION_CHANGE_RECEIPT_VERSION, "read",
  ),
]);

export const APPLICATION_DOMAIN_OPERATION_IDS = Object.freeze(
  APPLICATION_DOMAIN_OPERATION_DEFINITIONS.map(({ operation }) => operation.operationId),
);
