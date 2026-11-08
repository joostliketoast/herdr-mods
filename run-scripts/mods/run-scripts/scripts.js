// Shared by the run-scripts mod and any bar that embeds its control (a mod can only import
// from its own folder, so a bar keeps an identical copy of this file next to its main.js).
// Finds the nearest package.json above a folder, its scripts and package manager, runs a
// script in a new terminal tab beside the shown one, and draws the "▾ script  ▶" control.
import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { readTextFile, exec, spaces, focused, run, shared, setShared, home, openOverlay, closeOverlay, window } from "herdr";

export const MOD = "run-scripts";
const ICON = (name) => `mods/${MOD}/${name}.svg`;
const STATE = "run-scripts";
const UP = 8;

// The picker's measured parts. The dialog height and the content it holds are computed from
// these, so adding a row cannot clip the footer again.
export const PICKER = { row: 30, caption: 25, search: 34, header: 34, footer: 34, maxList: 330, maxHeight: 560 };

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
  // A terminal closes when its program exits, so a pane running the script directly would vanish
  // the moment a short script ends. The pane runs the script from a shell that stays and hands
  // over to an interactive login shell afterwards, the way tab.new keeps its shell. The trap
  // matters: a shell running -c exits on Ctrl-C, which is how a dev server is stopped, and the
  // pane would go with it. $SHELL is resolved on the machine the pane runs on, so a remote
  // project gets that machine's shell and its PATH.
  const one = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
  const line = [...commandFor(project.pm, name).slice(0, -1), one(name)].join(" ");
  const inner = "trap : INT; " + line + '; exec "$SHELL" -l -i';
  const launcher = 'SHELL="${SHELL:-/bin/sh}"; export SHELL; exec "$SHELL" -l -i -c "$1"';
  const splitArgv = !project.on && window()?.platform === "windows"
    ? ["powershell.exe", "-NoExit", "-Command", line]
    : ["/bin/sh", "-c", launcher, "sh", inner];
  if (where === "split") { run("terminal.open", { place: "right", folder: project.root, name, argv: splitArgv }); return; }
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
  const q = String(query ?? "").replace(/\s+/g, "");
  if (!q) return scripts;
  return scripts
    .map((s) => ({ s, score: fuzzyScore(q, s.name) }))
    .filter((x) => x.score > -Infinity)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.s);
}

// ── the control: [pm icon  script ▾ │ ▶] ───────────────────────────────────────────────
let pickerId = null;
export const pickerOpen = () => Boolean(pickerId);
/** The picker closed itself: forget its id so the next open is not treated as a toggle. */
export const forgetPicker = () => { pickerId = null; };

export function openMenu(project) {
  // The key and the ▾ button both land here; a second open closes the picker instead of
  // stacking another one on top of it.
  if (pickerId) { closeOverlay(pickerId); pickerId = null; return; }
  const recent = recentScripts(project);
  const total = new Set([...recent, ...project.scripts.map((s) => s.name)]).size;
  const captions = (recent.length ? 1 : 0) + (project.scripts.some((s) => !recent.includes(s.name)) ? 1 : 0);
  const list = Math.min(PICKER.maxList, total * PICKER.row + captions * PICKER.caption);
  // dialog, not popup: a popup lands at the pointer, so a key-opened picker could appear
  // anywhere on screen; a dialog is centered.
  pickerId = openOverlay({
    mod: MOD,
    kind: "dialog",
    width: 420,
    height: Math.min(PICKER.maxHeight, PICKER.header + PICKER.search + list + PICKER.footer),
    props: { popup: { project } },
  });
}

/** `stop` keeps a press on the control from reaching a window-drag bar under it. */
export function control(t, project, { height = 26, stop } = {}) {
  const s = selectedScript(project);
  const half = (id) => h_flex().id(id).h_full().gap(5).items_center().cursor_pointer().hover((st) => st.bg(t.hover))
    .when(Boolean(stop), (el) => el.on_mouse_down("left", stop));
  // Styled as a bar toolbar button (better-tabs' actionButton): 26 high, px 8, gap 5, radius 6,
  // 12px text, the bar's own chrome behind it, a muted label, a 14px icon, hover on the halves,
  // and the 1px group separator the bar uses between groups.
  return h_flex().id("run-scripts").h(height).flex_none().items_center().rounded(6).text_color(t.muted).overflow_hidden().text_size(12)
    .child(half("run-pick").pl(8).pr(6).max_w(120).tooltip(`${project.name} · choose a script`)
      .on_click(() => openMenu(project))
      .child(svg(`icons/${project.pm}.svg`).size(14).flex_none())
      .child(div().min_w(0).truncate().child(s.name))
      .child(svg(ICON("chevron-down")).size(14).flex_none()))
    .child(div().w(1).h(16).mx(4).flex_none().bg(t.border))
    .child(half("run-go").px(8).tooltip(`Run ${commandFor(project.pm, s.name).join(" ")} beside this pane`)
      .on_click((_e, cx) => runScript(project, s.name, cx, "split"))
      .child(svg(ICON("play")).size(14)));
}
