/**
 * Custom Footer with Hostname Extension
 *
 * Two-line footer with colored hostname, path + branch, and blended stats.
 * Combines pi-hostname-footer layout with pi-statusline-style segments.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import os from "node:os";
import { resolveGitStatus, type GitStatus } from "./git-status.js";

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

type ThemeColor = "success" | "warning" | "error" | "accent" | "dim";

/**
 * Build a compact git status suffix for the branch segment.
 *   clean       → " ✓"
 *   dirty       → " ●{N}"     (staged + unstaged + untracked)
 *   ahead/behind→ " ↑{N}" / " ↓{N}"
 * Color chosen by most severe state: dirty=warning, ahead/behind=accent, clean=success.
 */
function formatStatusIndicator(status: GitStatus): { text: string; color: ThemeColor } {
  const parts: string[] = [];
  if (status.dirtyCount > 0) parts.push(`\u25cf${status.dirtyCount}`); // ●
  if (status.ahead > 0) parts.push(`\u2191${status.ahead}`);          // ↑
  if (status.behind > 0) parts.push(`\u2193${status.behind}`);        // ↓

  if (parts.length === 0) return { text: " \u2713", color: "success" }; // ✓

  let color: ThemeColor;
  if (status.dirtyCount > 0) color = "warning";
  else color = "accent"; // diverged but clean tree

  return { text: ` ${parts.join(" ")}`, color };
}

/**
 * Word-wrap a single status string to terminal width. Used when one injected
 * status is wider than the footer (e.g. usage-status quota line) so it wraps
 * instead of truncating. Splits on whitespace; ANSI escape codes contain no
 * spaces so raw splitting is safe. A single word wider than width is
 * hard-chunked only when ANSI-free; colored oversized words fall back to
 * truncation to avoid splitting escape sequences mid-stream.
 */
function wrapStatusToWidth(s: string, width: number): string[] {
  if (visibleWidth(s) <= width) return [s];
  const out: string[] = [];
  let line = "";
  let lineW = 0;
  for (const word of s.split(/\s+/).filter(Boolean)) {
    const wW = visibleWidth(word);
    if (wW > width) {
      if (line) {
        out.push(line);
        line = "";
        lineW = 0;
      }
      if (/\x1b\[/.test(word)) {
        out.push(truncateToWidth(word, width, "…"));
        continue;
      }
      let chunk = "";
      let chunkW = 0;
      for (const ch of Array.from(word)) {
        const cw = visibleWidth(ch);
        if (chunkW + cw > width) {
          out.push(chunk);
          chunk = ch;
          chunkW = cw;
        } else {
          chunk += ch;
          chunkW += cw;
        }
      }
      line = chunk;
      lineW = chunkW;
      continue;
    }
    const sepW = line ? 1 : 0;
    if (line && lineW + sepW + wW > width) {
      out.push(line);
      line = word;
      lineW = wW;
    } else {
      line += (line ? " " : "") + word;
      lineW += sepW + wW;
    }
  }
  if (line) out.push(line);
  return out;
}

export default function (pi: ExtensionAPI) {
  // Runtime state for tool activity tracking
  const activeTools = new Map<string, number>();
  let lastCompletedTool: string | undefined;

  // Cached git status. Refreshed on branch change, tool end, and interval.
  let cachedStatus: { cwd: string; status: GitStatus } | undefined;
  const STATUS_TTL_MS = 5_000;
  let statusTimer: NodeJS.Timeout | undefined;

  function refreshStatus(cwd: string): GitStatus {
    if (cachedStatus && cachedStatus.cwd === cwd) return cachedStatus.status;
    const status = resolveGitStatus(cwd);
    cachedStatus = { cwd, status };
    return status;
  }

  function startStatusPoll(requestRender: () => void) {
    if (statusTimer) return;
    statusTimer = setInterval(() => {
      cachedStatus = undefined;
      requestRender();
    }, STATUS_TTL_MS);
  }

  function stopStatusPoll() {
    if (statusTimer) {
      clearInterval(statusTimer);
      statusTimer = undefined;
    }
  }

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
    // Tools may mutate the worktree (edit/write/bash) — invalidate cached status.
    cachedStatus = undefined;
  });

  pi.on("session_start", async (_event, ctx) => {
    const hostname = os.hostname().split(".")[0] || "unknown";
    const colorIndex = hashString(hostname) % HOSTNAME_COLORS.length;
    const hostnameColor = HOSTNAME_COLORS[colorIndex];

    ctx.ui.setFooter((tui, theme, footerData) => {
      const requestRender = () => tui.requestRender();
      const unsub = footerData.onBranchChange(() => {
        cachedStatus = undefined;
        requestRender();
      });
      startStatusPoll(requestRender);

      return {
        dispose: () => {
          unsub();
          stopStatusPoll();
        },
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
                const m = entry.message as { usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number; cost: { total: number } } };
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
              const status = refreshStatus(ctx.sessionManager.getCwd());
              const indicator = formatStatusIndicator(status);
              const branchStr = `🌿 ${branch}${indicator.text}`;
              pathParts.push(theme.fg(indicator.color, branchStr));
            }

            const sessionName = ctx.sessionManager.getSessionName();
            if (sessionName) {
              pathParts.push(theme.fg("dim", `• ${sessionName}`));
            }

            // Line 1 segments wrap: hostname, path, branch, session name each
            // a segment; spill to a new line at terminal width. Session ID
            // stays right-aligned on the last of these lines.
            const L1_SEP = "  ";
            const l1Segs = pathParts.map((s) =>
              visibleWidth(s) > width ? truncateToWidth(s, width, theme.fg("dim", "…")) : s,
            );
            const l1Lines: string[] = [];
            let l1Seg = "";
            let l1W = 0;
            for (const s of l1Segs) {
              const sw = visibleWidth(s);
              const sepW = l1Seg ? visibleWidth(L1_SEP) : 0;
              if (l1Seg && l1W + sepW + sw > width) {
                l1Lines.push(l1Seg);
                l1Seg = s;
                l1W = sw;
              } else {
                l1Seg += (l1Seg ? L1_SEP : "") + s;
                l1W += sepW + sw;
              }
            }
            if (l1Seg) l1Lines.push(l1Seg);

            // Session ID, right-aligned at end of last line-1 line (short form)
            const sessionId = ctx.sessionManager.getSessionId();
            const shortSessionId = sessionId ? sessionId.slice(0, 8) : undefined;
            const sessionRight = shortSessionId ? theme.fg("dim", `⌗ ${shortSessionId}`) : "";
            const srWidth = visibleWidth(sessionRight);
            if (sessionRight) {
              const lastIdx = l1Lines.length - 1;
              const lastW = lastIdx >= 0 ? visibleWidth(l1Lines[lastIdx]) : -1;
              if (lastIdx >= 0 && lastW + 2 + srWidth <= width) {
                const pad1 = " ".repeat(Math.max(0, width - lastW - srWidth));
                l1Lines[lastIdx] = l1Lines[lastIdx] + pad1 + sessionRight;
              } else if (srWidth <= width) {
                l1Lines.push(" ".repeat(Math.max(0, width - srWidth)) + sessionRight);
              }
            }

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
              const cacheHitRate = totalInput > 0
                ? Math.round((totalCacheRead / (totalCacheRead + totalInput)) * 100)
                : 0;
              const cacheColor = cacheHitRate >= 90
                ? "success"
                : cacheHitRate >= 50
                  ? "warning"
                  : "error";
              statsParts.push(
                theme.fg(cacheColor, `💾 R${formatTokens(totalCacheRead)}/${cacheHitRate}%`),
              );
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

            // Model: try last stats line first (right-aligned), else own line
            const rWidth = visibleWidth(rightSide);
            const lastIdx = lines2.length - 1;
            const lastW = lastIdx >= 0 ? visibleWidth(lines2[lastIdx]) : -1;
            const minPad = 2;

            if (lastIdx >= 0 && lastW + minPad + rWidth <= width) {
              const pad = " ".repeat(width - lastW - rWidth);
              lines2[lastIdx] = lines2[lastIdx] + pad + rightSide;
            } else if (lastIdx < 0 && rWidth <= width) {
              // No stats, model alone
              const pad = " ".repeat(Math.max(0, width - rWidth));
              lines2.push(pad + rightSide);
            } else if (rWidth <= width) {
              lines2.push(" ".repeat(Math.max(0, width - rWidth)) + rightSide);
            } else {
              lines2.push(truncateToWidth(rightSide, width, theme.fg("dim", "…")));
            }

            const lines = [...l1Lines, ...lines2];

            // Extension statuses (line 3+): segment wrap. Each injected status is
            // a segment; segments fill left-to-right and spill to a new line when
            // they hit terminal width, so nothing is truncated off the right edge.
            const extensionStatuses = footerData.getExtensionStatuses();
            if (extensionStatuses.size > 0) {
              const STATUS_SEP = "  ";
              const sortedStatuses = Array.from(extensionStatuses.entries())
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([, text]) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim())
                .filter((s) => s.length > 0)
                .flatMap((s) => wrapStatusToWidth(s, width));
              let statusSeg = "";
              let segWidth = 0;
              for (const s of sortedStatuses) {
                const sw = visibleWidth(s);
                const sepW = statusSeg ? visibleWidth(STATUS_SEP) : 0;
                if (statusSeg && segWidth + sepW + sw > width) {
                  lines.push(statusSeg);
                  statusSeg = s;
                  segWidth = sw;
                } else {
                  statusSeg += (statusSeg ? STATUS_SEP : "") + s;
                  segWidth += sepW + sw;
                }
              }
              if (statusSeg) lines.push(statusSeg);
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
