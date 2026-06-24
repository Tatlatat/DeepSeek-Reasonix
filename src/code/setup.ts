import { DeepSeekClient } from "../client.js";
import {
  type EditMode,
  loadEditMode,
  loadEndpoint,
  loadFilesystemOutlineThresholdBytes,
  loadGlobalShellAllowed,
  loadJavaSourceEnabled,
  loadProjectShellAllowed,
  loadResolvedSkillPaths,
  loadSubagentModels,
  loadToolRateLimit,
  readConfig,
  searchEnabled,
} from "../config.js";
import { bootstrapSemanticSearchInCodeMode } from "../index/semantic/tool.js";
import { ToolRegistry } from "../tools.js";
import { registerChoiceTool } from "../tools/choice.js";
import { registerCodeQueryTools } from "../tools/code-query.js";
import { registerFilesystemTools } from "../tools/filesystem.js";
import { registerJavaSourceTool } from "../tools/java-source.js";
import { JobRegistry } from "../tools/jobs.js";
import { registerMemoryTools } from "../tools/memory.js";
import { registerPlanTool } from "../tools/plan.js";
import { registerScaffoldTools } from "../tools/scaffold.js";
import { registerShellTools } from "../tools/shell.js";
import { type SkillInstalledHook, registerSkillTools } from "../tools/skills.js";
import { EXPLORE_SYSTEM } from "../tools/subagent-types.js";
import * as subagentMod from "../tools/subagent.js";
import {
  SHARED_SUBAGENT_SINK,
  type SubagentSink,
  formatSubagentResult,
} from "../tools/subagent.js";
import { registerTodoTool } from "../tools/todo.js";
import { registerWebTools } from "../tools/web.js";

export interface CodeToolsetOpts {
  rootDir: string;
  /** Override the default `~/.reasonix/config.json` lookup — primarily for tests that pin a tmp config. */
  configPath?: string;
  /** Fired after `install_skill` writes a new skill — desktop wires this to push a fresh `$skills` event so the sidebar updates without a tab reload. */
  onSkillInstalled?: SkillInstalledHook;
  /** Fired after `run_background` / `stop_job` mutate the JobRegistry — desktop pushes a fresh `$jobs` event so the popover updates without waiting for poll. */
  onJobsChanged?: () => void;
  /** Shared `{current: callback}` sink the TUI populates after mount. Setup forwards it into every `spawnSubagent` so live progress events reach the rich subagent row even though setup runs before the UI does. */
  subagentSink?: SubagentSink;
}

export interface CodeToolset {
  tools: ToolRegistry;
  jobs: JobRegistry;
  registerRooted: (root: string) => void;
  reBootstrapSemantic: (root: string) => Promise<{ enabled: boolean }>;
  semantic: { enabled: boolean };
}

/** Mirror `editMode === "plan"` into the registry's dispatch gate — keeps a single source of truth (the persisted EditMode) for the read-only mode. */
export function applyPlanMode(tools: ToolRegistry, editMode: EditMode): void {
  tools.setPlanMode(editMode === "plan");
}

export async function buildCodeToolset(opts: CodeToolsetOpts): Promise<CodeToolset> {
  const tools = new ToolRegistry({ rateLimit: loadToolRateLimit() });
  applyPlanMode(tools, loadEditMode(opts.configPath));
  const jobs = new JobRegistry();

  const outlineThresholdBytes = loadFilesystemOutlineThresholdBytes();
  const registerRooted = (root: string): void => {
    registerFilesystemTools(tools, {
      rootDir: root,
      outlineThresholdBytes,
      autoGitRollback: {},
    });
    const cfg = readConfig(opts.configPath);
    registerShellTools(tools, {
      rootDir: root,
      // Global allowlist applies everywhere; project list adds to it (#2059).
      extraAllowed: () => [
        ...new Set([
          ...loadGlobalShellAllowed(opts.configPath),
          ...loadProjectShellAllowed(root, opts.configPath),
        ]),
      ],
      allowAll: () => loadEditMode(opts.configPath) === "yolo",
      jobs,
      onJobsChanged: opts.onJobsChanged,
      sensitivePaths: cfg.sensitivePaths,
    });
    registerMemoryTools(tools, { projectRoot: root });
    registerCodeQueryTools(tools, { rootDir: root });
  };

  const reBootstrapSemantic = async (root: string): Promise<{ enabled: boolean }> => {
    const result = await bootstrapSemanticSearchInCodeMode(tools, root);
    if (!result.enabled) tools.unregister("semantic_search");
    return result;
  };

  registerRooted(opts.rootDir);
  registerPlanTool(tools);
  registerChoiceTool(tools);
  registerTodoTool(tools);
  registerScaffoldTools(tools, { projectRoot: opts.rootDir });
  if (searchEnabled()) {
    registerWebTools(tools);
  }
  if (loadJavaSourceEnabled()) {
    registerJavaSourceTool(tools, { projectRoot: opts.rootDir });
  }
  // Lazy: constructing DeepSeekClient throws when DEEPSEEK_API_KEY is unset,
  // which would kill `reasonix code` before the setup wizard can prompt for
  // one. Defer to first subagent dispatch — by then the user has either keyed
  // in or we error per-call instead of at boot.
  let subagentClient: DeepSeekClient | null = null;
  registerSkillTools(tools, {
    projectRoot: opts.rootDir,
    customSkillPaths: loadResolvedSkillPaths(opts.rootDir),
    subagentModels: loadSubagentModels(),
    onSkillInstalled: opts.onSkillInstalled,
    subagentRunner: async (skill, task, signal) => {
      if (!subagentClient) {
        const ep = loadEndpoint();
        subagentClient = new DeepSeekClient({ apiKey: ep.apiKey, baseUrl: ep.baseUrl });
      }
      const result = await subagentMod.spawnSubagent({
        client: subagentClient,
        parentRegistry: tools,
        parentSignal: signal,
        system: skill.body,
        task,
        model: skill.model,
        allowedTools: skill.allowedTools,
        skillName: skill.name,
        // Late-bound: the TUI's `useSubagent` writes the live callback into
        // SHARED_SUBAGENT_SINK after mount. Until then `.current` is null
        // and the events are silently dropped — that's fine for non-TUI
        // callers (`reasonix chat --transcript`, library use).
        sink: opts.subagentSink ?? SHARED_SUBAGENT_SINK,
      });
      return formatSubagentResult(result);
    },
  });

  // Lever B — sub-agent read-in-isolation (REASONIX_READ_ISOLATED=1, default
  // off). When off NOTHING below runs: no new tool spec, no read_file
  // description change → the immutable prefix is byte-identical to today, so
  // the prefix cache is undisturbed. When on, `read_file_isolated` spawns a
  // child loop (its own context) that reads the file and returns ONLY a ≤2K
  // summary; the parent never ingests the raw bytes (the Claude-Code pattern).
  if (readIsolatedEnabled()) {
    // Nudge the existing read_file toward isolation for large files. Mutating
    // the registered spec's description keeps this edit inside setup.ts.
    const readFileDef = tools.get("read_file");
    if (readFileDef && !readFileDef.description?.includes("read_file_isolated")) {
      tools.register({
        ...readFileDef,
        description: `${readFileDef.description ?? ""} For large files, prefer read_file_isolated — it reads in a separate context and returns only a short summary, keeping your context clean.`,
      });
    }
    const ensureSubagentClient = (): DeepSeekClient => {
      if (!subagentClient) {
        const ep = loadEndpoint();
        subagentClient = new DeepSeekClient({ apiKey: ep.apiKey, baseUrl: ep.baseUrl });
      }
      return subagentClient;
    };
    tools.register({
      name: "read_file_isolated",
      parallelSafe: true,
      readOnly: true,
      description:
        "Read a (typically large) file WITHOUT loading its raw contents into your context. Spawns a read-only child agent in a separate context that reads the file and returns only a concise ≤2K summary of what's relevant. Use this instead of read_file when you only need to UNDERSTAND a big file (its structure, where something is, whether it does X) rather than edit it — you keep your context clean and pay one cheap child loop instead of ingesting the whole file. For files you intend to edit, use read_file (the edit gate requires a direct read).",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to read (relative to rootDir or absolute).",
          },
          focus: {
            type: "string",
            description:
              "Optional: what to look for in the file (e.g. 'the auth flow', 'where TIMEOUT is set'). Sharpens the summary; omit for a general overview.",
          },
        },
        required: ["path"],
      },
      fn: async (args: { path?: unknown; focus?: unknown }, ctx) => {
        const path = typeof args.path === "string" ? args.path.trim() : "";
        if (!path) {
          return JSON.stringify({ error: "read_file_isolated requires a non-empty 'path'." });
        }
        const focus =
          typeof args.focus === "string" && args.focus.trim().length > 0
            ? args.focus.trim()
            : undefined;
        // Adoption trace (off by default): when REASONIX_READ_ISOLATED_TRACE is a
        // file path, append one line per call so the bench can count how often the
        // model actually CHOSE this tool — adoption is Lever B's make-or-break metric.
        const tracePath = (process.env.REASONIX_READ_ISOLATED_TRACE ?? "").trim();
        if (tracePath) {
          try {
            const { appendFileSync } = await import("node:fs");
            appendFileSync(tracePath, `${JSON.stringify({ ts: Date.now(), path })}\n`);
          } catch {
            // tracing must never break the tool dispatch
          }
        }
        const task = focus
          ? `Read the file at path "${path}" using read_file (chunk with range/head/tail if large) and return a ≤2000-character summary focused on: ${focus}. Lead with the conclusion; cite file:line ranges. Do NOT paste the raw file back.`
          : `Read the file at path "${path}" using read_file (chunk with range/head/tail if large) and return a ≤2000-character summary of its purpose, structure, and key contents. Lead with the conclusion; cite file:line ranges. Do NOT paste the raw file back.`;
        const result = await subagentMod.spawnSubagent({
          client: ensureSubagentClient(),
          parentRegistry: tools,
          system: EXPLORE_SYSTEM,
          task,
          // Read-only child: only the tools it needs to read + locate.
          allowedTools: [
            "read_file",
            "search_content",
            "search_files",
            "list_directory",
            "get_file_info",
          ],
          // Hard-cap the surfaced result so the parent never ingests bulk.
          maxResultChars: 2000,
          parentSignal: ctx?.signal,
          sink: opts.subagentSink ?? SHARED_SUBAGENT_SINK,
        });
        return formatSubagentResult(result);
      },
    });
  }

  const semantic = await reBootstrapSemantic(opts.rootDir);

  return { tools, jobs, registerRooted, reBootstrapSemantic, semantic };
}

/** REASONIX_READ_ISOLATED=1 turns on the read_file_isolated tool (Lever B). Default off → byte-stable prefix. */
function readIsolatedEnabled(): boolean {
  const v = (process.env.REASONIX_READ_ISOLATED ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}
