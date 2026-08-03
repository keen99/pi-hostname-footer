/**
 * Cached git status via `git status --porcelain=v2 --branch`.
 *
 * Shells out (with --no-optional-locks to avoid index contention) because
 * reimplementing git's diff/index/ignore logic from raw files is infeasible.
 * Result cached and refreshed on branch change, tool execution, and an interval.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export interface GitStatus {
	/** True when the worktree matches HEAD and index (no staged/unstaged/untracked changes). */
	clean: boolean;
	/** Number of changed entries (staged + unstaged + untracked). */
	dirtyCount: number;
	/** Commits on local branch not on upstream. 0 if none or no upstream. */
	ahead: number;
	/** Commits on upstream not on local branch. 0 if none or no upstream. */
	behind: number;
}

const EMPTY: GitStatus = { clean: true, dirtyCount: 0, ahead: 0, behind: 0 };

/**
 * Walk up from cwd to find the repo root (directory containing .git).
 * Mirrors pi-core FooterDataProvider.findGitPaths. Returns null if not in a repo.
 */
function findRepoDir(cwd: string): string | null {
	let dir = cwd;
	while (true) {
		const gitPath = join(dir, ".git");
		if (existsSync(gitPath)) {
			// For worktrees (.git is a file pointing at gitdir), dir is still the
			// worktree root that `git -C` should operate on.
			return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/**
 * Resolve git status synchronously. Runs `git status --porcelain=v2 --branch`
 * and parses branch line + entry lines.
 *
 * Returns EMPTY (clean) if not in a repo, git is unavailable, or the command
 * fails — the footer should never break on status lookup.
 */
export function resolveGitStatus(cwd: string): GitStatus {
	const repoDir = findRepoDir(cwd);
	if (!repoDir) return EMPTY;

	let result: ReturnType<typeof spawnSync>;
	try {
		result = spawnSync(
			"git",
			["--no-optional-locks", "status", "--porcelain=v2", "--branch"],
			{
				cwd: repoDir,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				maxBuffer: 4 * 1024 * 1024,
			},
		);
	} catch {
		return EMPTY;
	}

	if (result.error || result.status !== 0) return EMPTY;

	const stdout = typeof result.stdout === "string" ? result.stdout : "";
	return parsePorcelainV2(stdout);
}

/**
 * Parse `git status --porcelain=v2 --branch` output.
 *
 * Branch header lines start with `#`:
 *   # branch.head main
 *   # branch.upstream origin/main
 *   # branch.ab +2 -0       (ahead/behind)
 *
 * Entry lines start with a change kind:
 *   1 <octal-mode> <octal-mode> <sha> <sha> <status><path>   (ordinary)
 *   2 ...                                                    (renamed/copied)
 *   u ...                                                    (unmerged)
 *   ? <path>                                                 (untracked)
 */
function parsePorcelainV2(output: string): GitStatus {
	let ahead = 0;
	let behind = 0;
	let dirtyCount = 0;

	for (const line of output.split("\n")) {
		if (!line) continue;

		if (line.startsWith("# branch.ab")) {
			// "# branch.ab +2 -0"
			const m = line.match(/^# branch\.ab \+(\d+) -(\d+)/);
			if (m) {
				ahead = Number.parseInt(m[1], 10) || 0;
				behind = Number.parseInt(m[2], 10) || 0;
			}
			continue;
		}

		// Other branch headers (# branch.head, .upstream, .oid) — ignore.
		if (line.startsWith("#")) continue;

		// Entry line. Each line = one changed path. Untracked `?` counted once;
		// ordinary/renamed/unmerged counted once regardless of staged+unstaged combo.
		const kind = line[0];
		if (kind === "?" || kind === "1" || kind === "2" || kind === "u") {
			dirtyCount++;
		}
	}

	return {
		clean: dirtyCount === 0 && ahead === 0 && behind === 0,
		dirtyCount,
		ahead,
		behind,
	};
}
