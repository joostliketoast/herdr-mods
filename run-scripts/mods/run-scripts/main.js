// run-scripts: an Android Studio–style run control for JavaScript projects, for any layout.
// As a block (a bar) it shows "▾ script ▶" while the focused terminal's folder, or one above
// it, has a package.json with scripts, and nothing otherwise. ▶ runs the chosen script in a
// new terminal tab beside the shown one; ▾ opens this mod as a popup listing every script.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, focused, theme, layout, props, closeOverlay, exec, notify, window } from "herdr";
import { MOD, findProject, control, selectedScript, recentScripts, select, runScript, commandFor, filterScripts, openMenu } from "./scripts.js";

const ICON = (name) => `mods/${MOD}/${name}.svg`;

function where() {
  const f = focused(), space = spaces().find((s) => s.active);
  let pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  if (pane && !pane.terminal) pane = panes().find((p) => p.tab === pane.tab && p.terminal && p.cwd) ?? null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd ?? f?.cwd ?? space?.folder ?? null, on };
}

// package.json in the system's default app (this machine only).
function openFile(path, on) {
  if (on) { notify({ title: "package.json is on another machine", body: path, level: "info", timeout: 3000 }); return; }
  const platform = window()?.platform;
  const [cmd, args] = platform === "macos" ? ["open", ["--", path]] : platform === "windows" ? ["explorer.exe", [path.replace(/\//g, "\\")]] : ["xdg-open", [path]];
  exec(cmd, args).catch(() => notify({ title: "Could not open package.json", body: path, level: "error", timeout: 3000 }));
}

// Corners follow the shown layout's pane frame: square in a flush layout, rounded in a card one.
function frameRadius() {
  let pane = null;
  const walk = (n) => { if (!n || pane) return; if (n.content?.tab && n.content.pane) pane = n.content.pane; for (const c of n.children ?? []) walk(c); };
  try { walk(layout()); } catch {}
  const r = Number(pane?.radius ?? 6);
  return Math.max(0, Math.min(6, Number.isFinite(r) ? r : 6));
}

export default class RunScripts extends View {
  init(_props, cx) {
    this.popup = props()?.popup ?? null;
    if (this.popup) {
      // The list is a search box over the project's scripts: typing filters, Enter runs the
      // highlighted one, Up/Down move the highlight, Esc closes. Mouse use is unchanged.
      this.query = "";
      // The highlight starts on the script the control already shows, so Enter runs what is lit.
      const list0 = filterScripts(this.popup.project.scripts, "");
      this.sel = Math.max(0, list0.findIndex((s) => s.name === selectedScript(this.popup.project).name));
      this.input = InputState.new({ placeholder: "Filter scripts…" });
      this.input.on("change", (_e, cx) => { this.query = this.input.value(); this.sel = 0; cx.notify(); });
      this.input.on("submit", (_e, cx) => this.runAt(cx));
      this.handle = cx.focus_handle();
      cx.timer.after(80, () => { this.input.focus(); cx.notify(); });
      return;
    }
    // `mod.open:run-scripts` (a key): a loader popup that finds the focused folder's project and
    // hands over to the real picker. The app's own mod.open is the delivery path, so this needs
    // neither a focusable copy nor a command channel.
    if (props()?.overlay) {
      this.searching = true;
      cx.spawn(async (cx) => {
        const { cwd, on } = where();
        const project = await findProject(cwd, on).catch(() => null);
        closeOverlay(props().overlay);
        if (project) openMenu(project);
        else notify({ title: "run-scripts: no package.json with scripts here", body: "Focus a terminal inside a JavaScript project.", level: "info", timeout: 3500 });
        cx.notify();
      });
      return;
    }
    this.project = null;
    cx.timer.every(15000, (cx) => this.detect(cx, true));
  }

  // The picker for the focused folder, detecting the project first: a key can be pressed
  // before the strip's 15 s poll or its first detect finished.
  async openSearch(cx) {
    if (!this.project) {
      const { cwd, on } = where();
      this.project = await findProject(cwd, on).catch(() => null);
      cx.notify();
    }
    if (!this.project) {
      notify({ title: "run-scripts: no package.json with scripts here", body: "Focus a terminal inside a JavaScript project.", level: "info", timeout: 3500 });
      return;
    }
    openMenu(this.project);
  }

  // Looks again when the focused folder changes, and every 15 s for edited scripts.
  detect(cx, force = false) {
    const { cwd, on } = where(), key = JSON.stringify([cwd, on]);
    if ((key === this.key && !force) || this.detecting) return;
    this.key = key; this.detecting = true;
    cx.spawn(async (cx) => {
      try { const p = await findProject(cwd, on); if (this.key === key) this.project = p; }
      catch { if (this.key === key) this.project = null; }
      finally { this.detecting = false; cx.notify(); }
    });
  }

  // The scripts matching what is typed (all of them while the box is empty).
  matches() {
    return filterScripts(this.popup.project.scripts, this.query);
  }

  recentMatches() {
    const p = this.popup.project;
    return filterScripts(recentScripts(p).map((n) => p.scripts.find((s) => s.name === n)).filter(Boolean), this.query);
  }

  // Enter: the highlighted script (the best match when none is highlighted), run beside the
  // focused pane. The popup's ▶ button still runs in a new tab and its split button in a
  // pane; only the keyboard path defaults to a pane.
  runAt(cx) {
    const list = this.matches(), s = list[Math.min(this.sel, Math.max(0, list.length - 1))];
    if (!s) return;
    closeOverlay(props().overlay);
    runScript(this.popup.project, s.name, cx, "split");
  }

  onKey(e, cx) {
    if (e.key === "escape") { closeOverlay(props().overlay); cx.stop_propagation(); return; }
    const list = this.matches();
    if (!list.length) return;
    if (e.key === "down") { this.sel = (this.sel + 1) % list.length; cx.notify(); cx.stop_propagation(); }
    else if (e.key === "up") { this.sel = (this.sel + list.length - 1) % list.length; cx.notify(); cx.stop_propagation(); }
  }

  renderPopup() {
    const t = theme(), R = frameRadius(), p = this.popup.project, close = () => closeOverlay(props().overlay);
    const chosen = selectedScript(p).name, all = this.matches(), recent = this.recentMatches();
    const rows = all.length + recent.length;
    const caption = (text) => div().px(10).pt(8).pb(3).text_size(10.5).font_semibold().text_color(t.dim).child(text);
    const row = (s, key, active) => h_flex().id(`rs-${key}-${s.name}`).h(30).flex_none().pl(10).pr(4).gap(8).items_center().rounded(R).cursor_pointer()
      .when(active || s.name === chosen, (el) => el.bg(t.selected)).when(!active && s.name !== chosen, (el) => el.hover((st) => st.bg(t.hover)))
      .on_click(() => { select(p, s.name); close(); })
      .child(div().flex_none().max_w(230).truncate().text_size(12.5).text_color(t.foreground).child(s.name))
      .child(div().flex_1().min_w(24).truncate().text_size(11).text_color(t.dim).tooltip(s.cmd).child(s.cmd))
      .child(div().id(`rs-run-${key}-${s.name}`).size(24).flex_none().flex().items_center().justify_center().rounded(R).tooltip("Run in a new tab")
        .hover((st) => st.bg(t.raised)).on_click((_e, cx) => { cx.stop_propagation(); close(); runScript(p, s.name, cx); })
        .child(svg(ICON("play")).size(13).text_color(t.ansi2)))
      .child(div().id(`rs-split-${key}-${s.name}`).size(24).flex_none().flex().items_center().justify_center().rounded(R).tooltip("Run beside the focused pane")
        .hover((st) => st.bg(t.raised)).on_click((_e, cx) => { cx.stop_propagation(); close(); runScript(p, s.name, cx, "split"); })
        .child(svg(ICON("columns-2")).size(13).text_color(t.dim)));
    return v_flex().id("rs-menu").size_full().p(5).bg(t.popover ?? t.surface).text_color(t.foreground)
      .track_focus(this.handle).on_key_down((e, cx) => this.onKey(e, cx))
      .child(h_flex().px(10).pt(4).pb(2).gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(12).font_medium().child(p.name))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(commandFor(p.pm, "…").slice(0, -1).join(" "))))
      .child(div().px(6).pb(4)
        .child(Input.new(this.input).h(30).px(8).rounded(R).border_1().border_color(t.input).bg(t.background).text_size(12.5).text_color(t.foreground)))
      // The popup sizes to its content, so the list states its own height (a flex_1 list
      // would get none); it scrolls past a dozen rows.
      .child(v_flex().id("rs-scroll").flex_none().h(Math.min(330, rows * 30 + (recent.length ? 2 : 1) * 25)).overflow_y_scrollbar()
        .when(recent.length > 0, (el) => el.child(caption("RECENT")).children(recent.map((s, i) => row(s, "recent", i === this.sel))))
        .when(recent.length === 0 && all.length === 0, (el) => el.child(div().px(10).py(12).text_size(12).text_color(t.dim).child("No script matches")))
        .when(all.length > 0, (el) => el.child(caption("ALL SCRIPTS")).children(all.map((s, i) => row(s, "all", recent.length + i === this.sel)))))
      .child(div().h(1).mx(6).my(4).flex_none().bg(t.border))
      .child(h_flex().id("rs-edit").h(28).flex_none().px(10).gap(8).items_center().rounded(R).cursor_pointer().text_size(12.5).hover((st) => st.bg(t.hover))
        .on_click(() => { close(); openFile(`${p.root}/package.json`, p.on); })
        .child(svg(ICON("file-json")).size(13).text_color(t.dim)).child("Open package.json"));
  }

  render(cx) {
    if (this.searching) {
      const t = theme();
      return v_flex().id(MOD + "-loading").size_full().p(12).gap(4).bg(t.popover ?? t.surface).text_color(t.foreground)
        .child(div().text_size(12.5).font_medium().child("run-scripts"))
        .child(div().text_size(11.5).text_color(t.dim).child("Looking for a package.json with scripts…"));
    }
    if (this.popup) return this.renderPopup();
    this.detect(cx);
    const t = theme();
    return h_flex().id(MOD).size_full().items_center().justify_center()
      .when(Boolean(this.project), (el) => el.child(control(t, frameRadius(), this.project)));
  }
}
