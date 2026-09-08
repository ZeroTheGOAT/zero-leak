import assert from "node:assert/strict";
import { it } from "node:test";
import { buildConversationContext } from "@nervekit/harness/conversation";
import type { AgentCustomModel } from "@nervekit/harness/models";
import type { AgentRecord } from "@nervekit/contracts/agents";
import { AutoCompactionRunner } from "../../../src/domains/agents/execution/auto-compaction-runner.js";

/**
 * Context windows for the local models these fixtures select. ZeroLeak ships no
 * public cloud catalogue, so a runner that needs a model's window reads it the
 * way the workbench does at runtime: from the configured model list.
 */
const localModels: AgentCustomModel[] = [
  {
    provider: "local-vllm",
    modelId: "qwen3-32b",
    name: "Qwen3 32B",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:8000/v1",
    reasoning: false,
    contextWindow: 256_000,
    maxTokens: 32_000,
  },
  {
    provider: "local-llama-cpp",
    modelId: "gemma3-27b-it",
    name: "Gemma 3 27B Instruct",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:8080/v1",
    reasoning: false,
    contextWindow: 400_000,
    maxTokens: 32_000,
  },
];

const configuredModels = (): Promise<AgentCustomModel[]> =>
  Promise.resolve(localModels);

it("uses the selected model context window for threshold compaction", async () => {
  const active = agentRecord(
    "agent_active_large_window",
    "local-llama-cpp",
    "gemma3-27b-it",
  );
  const selected = agentRecord(
    "agent_selected_small_window",
    "local-vllm",
    "qwen3-32b",
  );
  const timestamp = "2026-07-18T00:00:00.000Z";
  const branch = [
    {
      type: "message",
      id: "entry_context_usage",
      parentId: null,
      timestamp,
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Approaching the selected model limit." },
        ],
        api: "openai-completions",
        provider: "local-vllm",
        model: "qwen3-32b",
        usage: {
          input: 240_000,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 240_000,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "stop",
        timestamp: Date.parse(timestamp),
      },
    },
  ];
  const compactions: Array<Record<string, unknown>> = [];
  const agents = new Map([
    [active.id, active],
    [selected.id, selected],
  ]);
  const runner = new AutoCompactionRunner({
    state: {
      getConversation: () => ({
        id: selected.conversationId,
        projectId: selected.projectId,
        activeAgentId: active.id,
      }),
      getProject: () => ({ id: selected.projectId, dir: "/tmp/project" }),
      agents,
    },
    storage: {
      settings: {
        compaction: {
          auto: true,
          profile: "balanced",
          customTriggerPercent: 80,
          customKeepRecentPercent: 15,
        },
      },
    },
    harnessStorage: {
      openStorage: async () => ({
        getLeafId: async () => "entry_context_usage",
        getPathToRoot: async () => branch,
        getContextPath: async () => branch,
        buildContext: async () => buildConversationContext(branch as never),
      }),
    },
    compactionService: {
      compactConversation: async (
        _conversationId: string,
        _request: unknown,
        options: Record<string, unknown>,
      ) => {
        compactions.push(options);
      },
    },
    customModels: configuredModels,
    logger: { warn: async () => undefined },
  } as never);

  const activeConversation = {
    getBranch: async () => branch,
    getContextBranch: async () => branch,
    buildContext: async () => buildConversationContext(branch as never),
  };
  await runner.maybeCompactAtIteration({
    conversationId: selected.conversationId,
    agentId: selected.id,
    runId: "run_selected",
    conversation: activeConversation as never,
  });
  assert.equal(compactions.length, 1);
  assert.equal(compactions[0]?.agentId, selected.id);
  assert.equal(compactions[0]?.contextWindow, 256_000);
  assert.equal(compactions[0]?.thresholdTokens, 204_800);
  assert.equal(compactions[0]?.keepRecentTokens, 38_400);
  assert.equal(compactions[0]?.activeConversation, activeConversation);
});

it("compacts projected prompt usage before the first provider iteration", async () => {
  const agent = agentRecord("agent_preflight", "local-vllm", "qwen3-32b");
  const timestamp = "2026-07-18T00:00:00.000Z";
  const branch = [
    {
      type: "message",
      id: "entry_preflight_usage",
      parentId: null,
      timestamp,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Near the balanced threshold." }],
        api: "openai-completions",
        provider: "local-vllm",
        model: "qwen3-32b",
        usage: {
          input: 200_000,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 200_000,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "stop",
        timestamp: Date.parse(timestamp),
      },
    },
  ];
  const compactions: Array<Record<string, unknown>> = [];
  const runner = new AutoCompactionRunner({
    state: {
      getConversation: () => ({
        id: agent.conversationId,
        projectId: agent.projectId,
        activeAgentId: agent.id,
      }),
      getProject: () => ({ id: agent.projectId, dir: "/tmp/project" }),
      agents: new Map([[agent.id, agent]]),
    },
    storage: {
      settings: {
        compaction: {
          auto: true,
          profile: "balanced",
          customTriggerPercent: 80,
          customKeepRecentPercent: 15,
        },
      },
    },
    harnessStorage: {
      openStorage: async () => ({
        getLeafId: async () => "entry_preflight_usage",
        getPathToRoot: async () => branch,
        getContextPath: async () => branch,
        buildContext: async () => buildConversationContext(branch as never),
      }),
    },
    compactionService: {
      compactConversation: async (
        _conversationId: string,
        _request: unknown,
        options: Record<string, unknown>,
      ) => {
        compactions.push(options);
      },
    },
    customModels: configuredModels,
    logger: { warn: async () => undefined },
  } as never);

  assert.equal(
    await runner.maybeCompactBeforePrompt({
      conversationId: agent.conversationId,
      agentId: agent.id,
      runId: "run_preflight",
      text: "x".repeat(20_000),
      conversation: {
        getBranch: async () => branch,
        getContextBranch: async () => branch,
        buildContext: async () => buildConversationContext(branch as never),
      } as never,
    }),
    true,
  );
  assert.equal(compactions.length, 1);
  assert.equal(compactions[0]?.contextTokens, 205_000);
});

function agentRecord(
  id: string,
  provider: string,
  modelId: string,
): AgentRecord {
  return {
    id,
    conversationId: "conv_regression",
    projectId: "proj_regression",
    projectDir: "/tmp/project",
    status: "idle",
    mode: "coding",
    permissionLevel: "supervised",
    workspaceScope: "project",
    model: { provider, modelId },
    thinkingLevel: "off",
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
  } as AgentRecord;
}
