// Shared by the run-scripts mod and any bar that embeds its control (a mod can only import
// from its own folder, so a bar keeps an identical copy of this file next to its main.js).
// Finds the nearest package.json above a folder, its scripts and package manager, runs a
// script in a new terminal tab beside the shown one, and draws the "▾ script  ▶" control.
import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { readTextFile, exec, spaces, focused, run, shared, setShared, home, openOverlay } from "herdr";

export const MOD = "run-scripts";
const ICON = (name) => `mods/${MOD}/${name}.svg`;
const STATE = "run-scripts";
const UP = 8;

// ── finding the project ────────────────────────────────────────────────────────────────
const parent = (dir) => dir.replace(/[\\/][^\\/]+[\\/]?$/, "") || "/";

async function packageManager(root, pkg, on) {
  const declared = /^(npm|pnpm|yarn|bun)@/.exec(String(pkg.packageManager ?? ""))?.[1];
  if (declared) return declared;
  const r = await exec("sh", ["-c", 'for f in bun.lock bun.lockb pnpm-lock.yaml yarn.lock; do [ -e "$1/$f" ] && { echo "$f"; exit 0; }; done', MOD, root], { on }).catch(() => null);
  const lock = r?.stdout.trim() ?? "";
  return lock.startsWith("bun") ? "bun" : lock.startsWith("pnpm") ? "pnpm" : lock.startsWith("yarn") ? "yarn" : "npm";
}

/** The nearest package.json with scripts at or above `cwd`, or null. */
export async function findProject(cwd, on) {
  if (!cwd) return null;
  const stop = on ? "/" : home();
  for (let dir = cwd.replace(/[\\/]+$/, ""), i = 0; dir && i < UP; dir = parent(dir), i++) {
    const text = await readTextFile(`${dir}/package.json`, { on }).catch(() => null);
    if (text) {
      let pkg;
      try { pkg = JSON.parse(text); } catch { return null; }
      const scripts = Object.entries(pkg.scripts ?? {}).filter(([, v]) => typeof v === "string").map(([name, cmd]) => ({ name, cmd }));
      if (!scripts.length) return null;
      return { root: dir, on, name: pkg.name || dir.split(/[\\/]/).pop(), scripts, pm: await packageManager(dir, pkg, on) };
    }
    if (dir === stop || dir === "/" || dir === parent(dir)) break;
  }
  return null;
}

// ── what was picked and run, per project root (shared, so every copy agrees) ───────────
const state = () => shared(STATE) ?? { selected: {}, recent: {} };
export function selectedScript(project) {
  const name = state().selected?.[project.root];
  return project.scripts.find((s) => s.name === name) ?? project.scripts.find((s) => s.name === "dev") ?? project.scripts.find((s) => s.name === "start") ?? project.scripts[0];
}
export const recentScripts = (project) => (state().recent?.[project.root] ?? []).filter((n) => project.scripts.some((s) => s.name === n));
export function select(project, name) {
  const s = state();
  setShared(STATE, { ...s, selected: { ...s.selected, [project.root]: name } });
}
function remember(project, name) {
  const s = state(), recent = [name, ...(s.recent?.[project.root] ?? []).filter((n) => n !== name)].slice(0, 3);
  setShared(STATE, { selected: { ...s.selected, [project.root]: name }, recent: { ...s.recent, [project.root]: recent } });
}

// ── running ────────────────────────────────────────────────────────────────────────────
export const commandFor = (pm, name) => (pm === "yarn" ? ["yarn", "run", name] : [pm, "run", name]);

/** Runs a script in a new terminal tab placed right after the shown tab, or in a split. */
export function runScript(project, name, cx, where = "tab") {
  const argv = commandFor(project.pm, name);
  remember(project, name);
  if (where === "split") { run("pane.split", { direction: "right", argv }); return; }
  const f = focused(), space = spaces().find((s) => s.id === f?.space) ?? spaces().find((s) => s.active);
  if (!space) return;
  const before = new Set(space.tabs.map((t) => t.id)), shown = space.tabs.find((t) => t.active);
  run("tab.new", { name, folder: project.root, argv, space: space.id });
  // tab.new adds the tab at the end; move it next to the tab it was started from.
  if (shown) cx.timer.after(250, () => {
    const fresh = spaces().find((s) => s.id === space.id)?.tabs.find((t) => !before.has(t.id));
    if (fresh && fresh.index !== shown.index + 1) run("tab.move", { id: fresh.id, index: shown.index + 1 });
  });
}

// ── the popup's search box ────────────────────────────────────────────────────────────
// Subsequence match, biased toward what people type: a contiguous run scores higher, a
// match that starts a word (after ":" "-" "_" or ".") higher still, and a shorter script
// name wins a tie. Returns a score, or -Infinity when the query is not a subsequence.
export function fuzzyScore(query, text) {
  const q = String(query).toLowerCase(), s = String(text).toLowerCase();
  if (!q) return 0;
  let qi = 0, score = 0, run = 0;
  for (let i = 0; i < s.length && qi < q.length; i++) {
    if (s[i] !== q[qi]) { run = 0; continue; }
    const wordStart = i === 0 || ":-_.".includes(s[i - 1]);
    score += 1 + (wordStart ? 4 : 0) + run * 2;
    run++; qi++;
  }
  if (qi < q.length) return -Infinity;
  return score - s.length * 0.01;
}

/** The given scripts that match `query`, best first; everything, in order, for an empty query. */
export function filterScripts(scripts, query) {
  const q = String(query ?? "").trim();
  if (!q) return scripts;
  return scripts
    .map((s) => ({ s, score: fuzzyScore(q, s.name) }))
    .filter((x) => x.score > -Infinity)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.s);
}

// ── the control: [pm icon  script ▾ │ ▶] ───────────────────────────────────────────────
const PM_COLOR = { npm: "ansi1", pnpm: "ansi3", yarn: "ansi4", bun: "foreground" };

export function openMenu(project) {
  const rows = recentScripts(project).length + project.scripts.length;
  openOverlay({ mod: MOD, kind: "popup", width: 340, height: Math.min(460, 96 + rows * 30 + (recentScripts(project).length ? 26 : 0)), props: { popup: { project } } });
}

/** `stop` keeps a press on the control from reaching a window-drag bar under it. */
export function control(t, R, project, { height = 28, stop } = {}) {
  const s = selectedScript(project);
  const half = (id) => h_flex().id(id).h_full().gap(6).items_center().cursor_pointer().hover((st) => st.bg(t.hover))
    .when(Boolean(stop), (el) => el.on_mouse_down("left", stop));
  return h_flex().id("run-scripts").h(height).flex_none().items_center().rounded(R).border_1().border_color(t.border).bg(t.background).overflow_hidden().text_size(12.5)
    .child(half("run-pick").pl(8).pr(6).max_w(200).tooltip(`${project.name} · choose a script`)
      .on_click(() => openMenu(project))
      .child(svg(`icons/${project.pm}.svg`).size(13).flex_none().text_color(t[PM_COLOR[project.pm]] ?? t.foreground))
      .child(div().min_w(0).truncate().text_color(t.foreground).child(s.name))
      .child(svg(ICON("chevron-down")).size(12).flex_none().text_color(t.dim)))
    .child(div().w(1).h(16).flex_none().bg(t.border))
    .child(half("run-go").px(8).tooltip(`Run ${commandFor(project.pm, s.name).join(" ")} in a new tab`)
      .on_click((_e, cx) => runScript(project, s.name, cx))
      .child(svg(ICON("play")).size(13).text_color(t.ansi2)));
}
