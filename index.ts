/**
 * Custom Footer with Hostname Extension
 *
 * Built with pi (glm-4.7) on 2026-04-24
 *
 * Just adds hostname (shortname) to the front of the default footer.
 * No other changes to the footer format.
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

// Simple string hash to get consistent color for each hostname
function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash);
}

// Apply a hex color to text
function colorize(text: string, color: string): string {
  return `\x1b[38;2;${parseInt(color.slice(1, 3), 16)};${parseInt(color.slice(3, 5), 16)};${parseInt(color.slice(5, 7), 16)}m${text}\x1b[0m`;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    // Get short hostname
    const hostname = os.hostname().split(".")[0] || "unknown";

    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsub = footerData.onBranchChange(() => tui.requestRender());

      return {
        dispose: unsub,
        invalidate() {},
        render(width: number): string[] {
          try {
            // Calculate cumulative usage from ALL session entries
            let totalInput = 0;
            let totalOutput = 0;
            let totalCacheRead = 0;
            let totalCacheWrite = 0;
            let totalCost = 0;
            for (const entry of ctx.sessionManager.getBranch()) {
              if (entry.type === "message" && entry.message.role === "assistant") {
                const m = entry.message as AssistantMessage;
                totalInput += m.usage.input;
                totalOutput += m.usage.output;
                totalCacheRead += m.usage.cacheRead;
                totalCacheWrite += m.usage.cacheWrite;
                totalCost += m.usage.cost.total;
              }
            }

            // Calculate context usage from session
            const contextUsage = ctx.session?.getContextUsage();
            const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
            const contextPercentValue = contextUsage?.percent ?? 0;
            const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

            // Format token counts
            const formatTokens = (count: number) => {
              if (count < 1000) return count.toString();
              if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
              if (count < 1000000) return `${Math.round(count / 1000)}k`;
              if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
              return `${Math.round(count / 1000000)}M`;
            };

            // Replace home directory with ~
            let pwd = ctx.sessionManager.getCwd();
            const home = process.env.HOME || process.env.USERPROFILE;
            if (home && pwd.startsWith(home)) {
              pwd = `~${pwd.slice(home.length)}`;
            }

            // Add git branch if available
            const branch = footerData.getGitBranch();
            if (branch) {
              pwd = `${pwd} (${branch})`;
            }

            // Add session name if set
            const sessionName = ctx.sessionManager.getSessionName();
            if (sessionName) {
              pwd = `${pwd} • ${sessionName}`;
            }

            // Prepend hostname to pwd with a unique color for this hostname
            const colorIndex = hashString(hostname) % HOSTNAME_COLORS.length;
            const coloredHostname = colorize(hostname + "@", HOSTNAME_COLORS[colorIndex]);
            pwd = `${coloredHostname} ${pwd}`;

            // Build stats line
            const statsParts: string[] = [];
            if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
            if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
            if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
            if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);

            // Show cost
            statsParts.push(`$${totalCost.toFixed(3)}`);

            // Colorize context percentage based on usage
            let contextPercentStr: string;
            const contextPercentDisplay = contextPercent === "?"
              ? `?/${formatTokens(contextWindow)} (auto)`
              : `${contextPercent}%/${formatTokens(contextWindow)} (auto)`;

            if (contextPercentValue > 90) {
              contextPercentStr = theme.fg("error", contextPercentDisplay);
            } else if (contextPercentValue > 70) {
              contextPercentStr = theme.fg("warning", contextPercentDisplay);
            } else {
              contextPercentStr = contextPercentDisplay;
            }
            statsParts.push(contextPercentStr);

            let statsLeft = statsParts.join(" ");
            let statsLeftWidth = visibleWidth(statsLeft);

            // If statsLeft is too wide, truncate it
            if (statsLeftWidth > width) {
              statsLeft = truncateToWidth(statsLeft, width, "...");
              statsLeftWidth = visibleWidth(statsLeft);
            }

            // Add model name on the right side, plus thinking level if model supports it
            const modelName = ctx.model?.id || "no-model";
            let rightSideWithoutProvider = modelName;
            if (ctx.model?.reasoning) {
              const thinkingLevel = pi.getThinkingLevel() || "off";
              rightSideWithoutProvider = thinkingLevel === "off"
                ? `${modelName} • thinking off`
                : `${modelName} • ${thinkingLevel}`;
            }

            // Prepend the provider in parentheses if there are multiple providers
            let rightSide = rightSideWithoutProvider;
            if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
              rightSide = `(${ctx.model.provider}) ${rightSideWithoutProvider}`;
              if (statsLeftWidth + 2 + visibleWidth(rightSide) > width) {
                rightSide = rightSideWithoutProvider;
              }
            }

            const rightSideWidth = visibleWidth(rightSide);
            const minPadding = 2;
            const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;
            let statsLine: string;

            if (totalNeeded <= width) {
              const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
              statsLine = statsLeft + padding + rightSide;
            } else {
              const availableForRight = width - statsLeftWidth - minPadding;
              if (availableForRight > 0) {
                const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
                const truncatedRightWidth = visibleWidth(truncatedRight);
                const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth));
                statsLine = statsLeft + padding + truncatedRight;
              } else {
                statsLine = statsLeft;
              }
            }

            const dimStatsLeft = theme.fg("dim", statsLeft);
            const remainder = statsLine.slice(statsLeft.length);
            const dimRemainder = theme.fg("dim", remainder);

            const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
            const lines = [pwdLine, dimStatsLeft + dimRemainder];

            // Add extension statuses
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
            // Session is stale (exiting/reloading), return minimal footer
            const colorIndex = hashString(hostname) % HOSTNAME_COLORS.length;
            const coloredHostname = colorize(hostname + "@", HOSTNAME_COLORS[colorIndex]);
            const pwdLine = truncateToWidth(theme.fg("dim", `${coloredHostname} Session ending...`), width, theme.fg("dim", "..."));
            return [pwdLine];
          }
        },
      };
    });
  });
}
