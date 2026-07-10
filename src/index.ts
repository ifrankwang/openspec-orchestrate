import { type Plugin, tool } from "@opencode-ai/plugin"
import { loadSkillBody } from "./skills/tool.js"
import { injectSkills } from "./skills/loader.js"
import { injectAgents } from "./agents/loader.js"

import {
  init,
  set_worktree,
  status,
  complete_task_group,
  arch_submit,
  arch_exempt_review,
  dev_submit,
  reviewer_submit,
  resolve_review,
} from "./tools/orchestrate.js"

export const OpenspecOrchestratePlugin: Plugin = async () => {
  return {
    config: async (config) => {
      injectAgents(config)
      injectSkills(config)
    },
    tool: {
      opx_orch_init: init,
      opx_orch_set_worktree: set_worktree,
      opx_status: status,
      opx_orch_complete_task_group: complete_task_group,
      opx_arch_submit: arch_submit,
      opx_arch_exempt_review: arch_exempt_review,
      opx_dev_submit: dev_submit,
      opx_reviewer_submit: reviewer_submit,
      opx_orch_resolve_review: resolve_review,
      opx_skill: tool({
        description: "Load a bundled orchestration skill by name",
        args: {
          name: tool.schema.string().describe("Skill name (directory under assets/skills/)"),
        },
        async execute(args) {
          const body = loadSkillBody(args.name)
          return `## Skill: ${args.name}\n\n${body}`
        },
      }),
    },
  }
}
