import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

type Ctx = any;

function harness(options: {
	branch?: string;
	sessionName?: string;
	sessionId?: string;
	statuses?: Record<string, string>;
	gitRepo?: boolean;
	contextWindow?: number;
}) {
	const cwd = options.gitRepo ? makeGitRepo() : mkdtempSync(join(tmpdir(), "footer-nogit-"));
	const notices: string[] = [];
	let footerFactory: ((tui: any, theme: any, footerData: any) => any) | undefined;
	let activeTools = new Map<string, number>();
	const ctx: Ctx = {
		model: { id: "glm-5.3-flash", provider: "zai", contextWindow: options.contextWindow ?? 272000, reasoning: true },
		getContextUsage: () => ({ percent: 12, contextWindow: options.contextWindow ?? 272000 }),
		ui: {
			notify: (t: string) => notices.push(t),
			setFooter: (factory: any) => {
				footerFactory = factory;
			},
		},
		sessionManager: {
			getCwd: () => cwd,
			getSessionName: () => options.sessionName,
			getSessionId: () => options.sessionId ?? "01a0fed2-1111-2222-3333-444444444444",
			getBranch: () => [],
		},
	};
	const pi: any = {
		appendEntry: () => undefined,
		registerCommand: () => undefined,
		on: (event: string, handler: (e: any) => any) => {
			if (event === "session_start") handlers.start = () => handler({}, ctx);
			if (event === "tool_execution_start") handlers.toolStart = (e: any) => handler(e);
			if (event === "tool_execution_end") handlers.toolEnd = (e: any) => handler(e);
		},
		getThinkingLevel: () => "high",
	};
	const handlers: Record<string, (e?: any) => any> = {};
	ext(pi);
	const theme = { fg: (_c: string, t: string) => t };
	const tui = { requestRender() {} };
	const footerData = {
		getGitBranch: () => options.branch,
		getExtensionStatuses: () => new Map(Object.entries(options.statuses ?? {})),
		onBranchChange: () => () => undefined,
	};
	function render(width: number): string[] {
		const component = footerFactory!(tui, theme, footerData);
		try {
			return component.render(width) as string[];
		} finally {
			component.dispose?.(); // stops the status poll interval
		}
	}
	return {
		cwd,
		notices,
		start: () => handlers.start(),
		toolStart: (name: string) => handlers.toolStart({ toolName: name }),
		toolEnd: (name: string) => handlers.toolEnd({ toolName: name }),
		render,
		cleanup: () => rmSync(cwd, { recursive: true, force: true }),
	};
}

function makeGitRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "footer-git-"));
	const run = (cmd: string) => execSync(cmd, { cwd: dir, stdio: "ignore" });
	run("git init -q");
	run("git config user.email t@t");
	run("git config user.name t");
	writeFileSync(join(dir, "a.txt"), "x\n");
	run("git add a.txt");
	run("git commit -qm init");
	return dir;
}

const ext = (await import("../index.js")).default;

test("session_start installs footer factory; render fits width and shows hostname/path/session id", async () => {
	const app = harness({ branch: "main", sessionName: "demo", sessionId: "01a0fed2-1111-2222-3333-444444444444" });
	try {
		await app.start();
		const lines = app.render(100);
		assert.ok(lines.length >= 2);
		for (const line of lines) assert.ok(visibleWidth(line) <= 100, `line too wide: ${visibleWidth(line)}: ${line}`);
		assert.ok(lines[0].includes("@"), "hostname prefix present");
		assert.ok(lines.join("\n").includes("demo"));
		const idLine = lines.find((l) => /\u2317 01a0fed2/.test(l));
		assert.ok(idLine, `short session id rendered; lines=${JSON.stringify(lines)}`);
		assert.equal(visibleWidth(idLine), 100, `session id line right-aligned; line=${JSON.stringify(idLine)}`);
		assert.ok(lines.join("\n").includes("glm-5.3-flash"));
	} finally {
		app.cleanup();
	}
});

test("git repo: clean shows checkmark; dirty shows count", async () => {
	const app = harness({ branch: "main", gitRepo: true });
	try {
		await app.start();
		assert.match(app.render(100).join("\n"), /\u2713/);
		writeFileSync(join(app.cwd, "b.txt"), "dirty\n");
		await app.toolEnd("edit"); // invalidates cache like a real tool run
		assert.match(app.render(100).join("\n"), /\u25cf1/);
	} finally {
		app.cleanup();
	}
});

test("overwide extension status wraps instead of truncating", async () => {
	const long = "usage | " + "word ".repeat(40);
	const app = harness({ statuses: { "usage-status": long } });
	try {
		await app.start();
		const lines = app.render(80);
		for (const line of lines) assert.ok(visibleWidth(line) <= 80, `line too wide: ${visibleWidth(line)}`);
		assert.ok(lines.length >= 4, "wrapped to multiple lines");
		assert.ok(lines.join(" ").includes("word"), "content preserved");
	} finally {
		app.cleanup();
	}
});

test("tool activity markers appear and clear", async () => {
	const app = harness({});
	try {
		await app.start();
		app.toolStart("bash");
		assert.match(app.render(100).join("\n"), /\u2699 bash/);
		app.toolEnd("bash");
		assert.match(app.render(100).join("\n"), /\u2705 bash/);
	} finally {
		app.cleanup();
	}
});

test("narrow terminal: segments wrap, nothing throws", async () => {
	const app = harness({ branch: "main", sessionName: "s", statuses: { glm: "GLM Pro-L | 5h 5%" } });
	try {
		await app.start();
		for (const width of [40, 60]) {
			const lines = app.render(width);
			assert.ok(lines.length >= 2);
			for (const line of lines) assert.ok(visibleWidth(line) <= width, `line too wide at ${width}: ${visibleWidth(line)}`);
		}
	} finally {
		app.cleanup();
	}
});
