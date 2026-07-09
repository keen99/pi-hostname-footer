/**
 * Custom Footer with Hostname Extension
 *
 * Two-line footer with colored hostname, path + branch, and blended stats.
 * Combines pi-hostname-footer layout with pi-statusline-style segments.
 */

import type { AssistantMessage, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import os from "node:os";

// A curated palette of colors for hostnames - each hostname gets a consistent color
const HOSTNAME_COLORS = [
  "#e06c75", // red
  "#e5c07b", // yellow
  "#98c379", // green
  "#56b6c2", // cyan
  "#61afef", // blue
  "#c678dd", // purple
  "#d19a66", // orange
  "#f44747", // bright red
  "#50fa7b", // bright green
  "#8be9fd", // bright cyan
  "#ff79c6", // bright pink
  "#bd93f9", // bright purple
];

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash);
}

function colorize(text: string, color: string): string {
  return `\x1b[38;2;${parseInt(color.slice(1, 3), 16)};${parseInt(color.slice(3, 5), 16)};${parseInt(color.slice(5, 7), 16)}m${text}\x1b[0m`;
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

export default function (pi: ExtensionAPI) {
  // Runtime state for tool activity tracking
  const activeTools = new Map<string, number>();
  let lastCompletedTool: string | undefined;

  pi.on("tool_execution_start", (event) => {
    const name = event.toolName || "tool";
    activeTools.set(name, (activeTools.get(name) ?? 0) + 1);
  });

  pi.on("tool_execution_end", (event) => {
    const name = event.toolName || "tool";
    const count = activeTools.get(name) ?? 0;
    if (count <= 1) activeTools.delete(name);
    else activeTools.set(name, count - 1);
    lastCompletedTool = name;
  });

  pi.on("session_start", async (_event, ctx) => {
    const hostname = os.hostname().split(".")[0] || "unknown";
    const colorIndex = hashString(hostname) % HOSTNAME_COLORS.length;
    const hostnameColor = HOSTNAME_COLORS[colorIndex];

    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsub = footerData.onBranchChange(() => tui.requestRender());

      return {
        dispose: unsub,
        invalidate() {},
        render(width: number): string[] {
          try {
            // ── Cumulative usage from all session entries ──
            let totalInput = 0;
            let totalOutput = 0;
            let totalCacheRead = 0;
            let totalCacheWrite = 0;
            let totalCost = 0;
            let turnCount = 0;
            for (const entry of ctx.sessionManager.getBranch()) {
              if (entry.type === "message" && entry.message.role === "assistant") {
                const m = entry.message as AssistantMessage;
                totalInput += m.usage.input;
                totalOutput += m.usage.output;
                totalCacheRead += m.usage.cacheRead || 0;
                totalCacheWrite += m.usage.cacheWrite || 0;
                totalCost += m.usage.cost.total;
                turnCount++;
              }
            }

            // ── Context usage ──
            const contextUsage = ctx.getContextUsage();
            const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
            const contextPercentValue = contextUsage?.percent ?? 0;
            const hasPercent = contextUsage?.percent !== null && contextUsage?.percent !== undefined;
            const contextPercent = hasPercent ? contextPercentValue.toFixed(0) : "?";

            // ── LINE 1: hostname + path + branch ──
            let pwd = ctx.sessionManager.getCwd();
            const home = process.env.HOME || process.env.USERPROFILE;
            if (home && pwd.startsWith(home)) {
              pwd = `~${pwd.slice(home.length)}`;
            }

            let pathParts: string[] = [];
            pathParts.push(colorize(`${hostname}@`, hostnameColor));
            pathParts.push(`📁 ${pwd}`);

            const branch = footerData.getGitBranch();
            if (branch) {
              pathParts.push(theme.fg("success", `🌿 ${branch}`));
            }

            const sessionName = ctx.sessionManager.getSessionName();
            if (sessionName) {
              pathParts.push(theme.fg("dim", `• ${sessionName}`));
            }

            let line1 = pathParts.join("  ");

            // ── LINE 2: stats left, model right ──
            // Context segment — colorize by threshold
            const ctxMax = formatTokens(contextWindow);
            const ctxDisplay = hasPercent
              ? `ctx ${contextPercent}%/${ctxMax} (auto)`
              : `ctx ?/${ctxMax} (auto)`;
            let ctxStr: string;
            if (hasPercent && contextPercentValue > 90) {
              ctxStr = theme.fg("error", ctxDisplay);
            } else if (hasPercent && contextPercentValue > 70) {
              ctxStr = theme.fg("warning", ctxDisplay);
            } else {
              ctxStr = theme.fg("accent", ctxDisplay);
            }

            const statsParts: string[] = [ctxStr];
            if (totalInput || totalOutput) {
              statsParts.push(theme.fg("mdLink", `🔢 ↑${formatTokens(totalInput)} ↓${formatTokens(totalOutput)}`));
            }
            if (totalCacheRead || totalCacheWrite) {
              statsParts.push(theme.fg("success", `💾 R${formatTokens(totalCacheRead)}`));
            }
            statsParts.push(theme.fg("warning", `💸 $${totalCost.toFixed(3)}`));
            if (turnCount > 0) {
              statsParts.push(theme.fg("muted", `🔁 ${turnCount}`));
            }

            // Tool activity
            const active = [...activeTools.entries()];
            let toolStr: string;
            if (active.length > 0) {
              const [name, count] = active[0];
              const suffix = count > 1 ? `×${count}` : active.length > 1 ? `+${active.length - 1}` : "";
              toolStr = theme.fg("toolTitle", `⚙ ${name}${suffix}`);
            } else if (lastCompletedTool) {
              toolStr = theme.fg("dim", `✅ ${lastCompletedTool}`);
            } else {
              toolStr = "";
            }
            if (toolStr) statsParts.push(toolStr);

            let statsLeft = statsParts.join("  ");

            // Model right side
            const modelName = ctx.model?.id || "no-model";
            const provider = ctx.model?.provider;
            const thinkingLevel = pi.getThinkingLevel() || "off";
            const thinkingSuffix = ctx.model?.reasoning
              ? (thinkingLevel === "off" ? " • thinking off" : ` • 🧠 ${thinkingLevel}`)
              : "";
            const providerStr = provider ? theme.fg("muted", `(${provider}) `) : "";
            const modelStr = theme.fg("accent", `🤖 ${modelName}`);
            const thinkingStr = ctx.model?.reasoning
              ? (thinkingLevel === "off"
                ? theme.fg("dim", " • thinking off")
                : ` • ${theme.fg("accent", "🧠")} ${theme.fg("accent", thinkingLevel)}`)
              : "";
            const rightSide = `${providerStr}${modelStr}${thinkingStr}`;

            // Layout: wrap stats segments across lines, model on its own line if needed
            const SEP = "  ";
            const lines2: string[] = [];
            let currentLine = "";
            let currentWidth = 0;

            for (const part of statsParts) {
              const partWidth = visibleWidth(part);
              const sepWidth = currentLine ? visibleWidth(SEP) : 0;
              if (currentWidth + sepWidth + partWidth <= width) {
                currentLine += (currentLine ? SEP : "") + part;
                currentWidth += sepWidth + partWidth;
              } else {
                if (currentLine) lines2.push(currentLine);
                if (partWidth > width) {
                  lines2.push(truncateToWidth(part, width, theme.fg("dim", "…")));
                  currentLine = "";
                  currentWidth = 0;
                } else {
                  currentLine = part;
                  currentWidth = partWidth;
                }
              }
            }
            if (currentLine) lines2.push(currentLine);

            // Model always on its own line, right-justified
            const rWidth = visibleWidth(rightSide);
            if (rWidth <= width) {
              const pad = " ".repeat(Math.max(0, width - rWidth));
              lines2.push(pad + rightSide);
            } else {
              lines2.push(truncateToWidth(rightSide, width, theme.fg("dim", "…")));
            }

            // Truncate line 1 if needed
            line1 = truncateToWidth(line1, width, theme.fg("dim", "..."));

            const lines = [line1, ...lines2];

            // Extension statuses (line 3+)
            const extensionStatuses = footerData.getExtensionStatuses();
            if (extensionStatuses.size > 0) {
              const sortedStatuses = Array.from(extensionStatuses.entries())
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([, text]) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim());
              const statusLine = sortedStatuses.join(" ");
              lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
            }

            return lines;
          } catch (error) {
            const coloredHostname = colorize(`${hostname}@`, hostnameColor);
            const pwdLine = truncateToWidth(
              theme.fg("dim", `${coloredHostname} Session ending...`),
              width,
              theme.fg("dim", "..."),
            );
            return [pwdLine];
          }
        },
      };
    });
  });
}
