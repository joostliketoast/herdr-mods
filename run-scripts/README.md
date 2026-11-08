# run-scripts

![run-scripts](../docs/screenshots/run-scripts.png)

A run control for JavaScript projects: `▾ script ▶`. It shows while the focused terminal's
folder, or a folder up to 8 levels above it, has a `package.json` with scripts.

- **▶** runs the chosen script beside the focused pane, in a pane named after the script and
  opened in the project folder. The pane keeps its shell after the script ends, and Ctrl-C
  returns to that shell. (A row's own **▶** in the picker still opens a new tab.)
- **▾** opens a list: the project name and its command at the top, **Recent** (your last 3
  runs), then **All scripts** with their commands. Click a row to choose it; each row also
  has **▶** (run in a new tab) and a split button (run beside the focused pane).
  **Open package.json** opens the file in your default app.

The package manager comes from `packageManager` in `package.json`, else the lockfile
(`bun.lock`, `pnpm-lock.yaml`, `yarn.lock`), else npm. Each project remembers its own chosen
script; with none chosen it picks `dev`, then `start`, then the first one.

## Install

Tell your agent:

```text
Read ~/.config/herdr-app/AGENTS.md, then add this mod: herdr.dev/mods/cybertron288/run-scripts
```

Or by hand, from a clone of this repo:

```sh
cp -R run-scripts/mods/* ~/.config/herdr-app/mods/
herdr-app check ~/.config/herdr-app/mods/run-scripts
```

As a block, the mod draws the control itself (and nothing outside a JavaScript project):

```json
{ "id": "run", "type": "block", "size": { "px": 220 }, "content": { "mod": "run-scripts" } }
```

## In your own tab bar

`scripts.js` exports `findProject()` and `control()`, so a bar mod can draw the control
inline (the Nightfall tab bar does, left of its `+`). A Herdr mod can only import files from
its own folder, so copy `scripts.js` next to the bar's `main.js` and keep the two copies the
same. The dropdown is always this mod, opened as a popup.

## Limits

- One `package.json` at a time: workspaces in a monorepo aren't listed.
- The new tab is moved next to the current one 0.25 s after it opens.
