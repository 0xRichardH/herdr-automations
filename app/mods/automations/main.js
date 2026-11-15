// Everything goes through the herdr-automations CLI (`… --json`): this mod
// never reads or writes automations.yaml or history.jsonl itself. The files
// are watched only to know when to ask again.

import * as fs from "fs/promises";
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { exec, hc, home, theme, settings, terminals, spaces, run, notify, pickFolder, watchFolder, knownAgents, props, closeOverlay, nextCommand } from "herdr";

const PRESETS = [
  ["Hourly", "0 * * * *"],
  ["Every morning", "0 9 * * *"],
  ["Weekdays 9:00", "0 9 * * 1-5"],
  ["Mondays 9:00", "0 9 * * 1"],
  ["Fridays 17:00", "0 17 * * 5"],
];
// The agents hc can hand a prompt to and watch to the end (config.KindTakesPromptArg).
// The form offers the ones installed here.
const AGENTS = ["claude", "codex", "pi", "copilot", "grok"];
const MODEL_LOADERS = {
  grok: async () => {
    const r = await exec("grok", ["models"]);
    if (r.code !== 0) return [];
    const defaultId = r.stdout.match(/^Default model:\s*(\S+)/m)?.[1];
    return r.stdout.split("\n").flatMap((line) => {
      const match = line.match(/^\s+[-*]\s+(\S+)(?:\s+\(default\))?\s*$/);
      return match ? [{ id: match[1], detail: match[1] === defaultId || line.includes("(default)") ? "Default" : "" }] : [];
    });
  },
  codex: async () => {
    const config = await fs.readFile(`${home()}/.codex/config.toml`, "utf8");
    const match = config.match(/^\s*model_catalog_json\s*=\s*(?:"([^"\n]+)"|'([^'\n]+)'|([^#\s]+))/m);
    if (!match) return [];
    let path = match[1] ?? match[2] ?? match[3];
    if (path.startsWith("~/")) path = home() + path.slice(1);
    const catalog = JSON.parse(await fs.readFile(path, "utf8"));
    return (catalog.models ?? []).map((m) => ({
      id: m.id ?? m.slug,
      detail: [m.display_name ?? m.name, (m.supported_reasoning_levels ?? []).map((level) => level.effort).join(", ")].filter(Boolean).join(" · "),
    })).filter((m) => typeof m.id === "string" && m.id.length > 0);
  },
  pi: async () => {
    const catalog = JSON.parse(await fs.readFile(`${home()}/.pi/agent/models.json`, "utf8"));
    return Object.entries(catalog.providers ?? {}).flatMap(([provider, data]) =>
      (data.models ?? []).filter((m) => typeof m.id === "string" && m.id.length > 0)
        .map((m) => ({ id: `${provider}/${m.id}`, detail: m.name ?? "" })));
  },
  claude: async () => ["sonnet", "opus", "haiku"].map((id) => ({ id, detail: "" })),
};
const WORKSPACES = [["worktree", "New worktree"], ["root", "Repo root"], ["existing", "Existing space"]];
const FINISHED = new Set(["done", "failed", "cancelled"]);

const human = (cron) => PRESETS.find(([, c]) => c === cron)?.[0] ?? cron;
const tilde = (p) => (p && p.startsWith(home()) ? "~" + p.slice(home().length) : p ?? "");
function ago(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
function until(iso) {
  const s = (Date.parse(iso) - Date.now()) / 1000;
  if (s < 3600) return `in ${Math.max(1, Math.round(s / 60))}m`;
  const d = new Date(iso), hm = d.toTimeString().slice(0, 5);
  if (s < 86400 && d.getDate() === new Date().getDate()) return `today ${hm}`;
  // Spelled out: the mod runtime ignores toLocaleDateString's options.
  return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]} ${hm}`;
}
function duration(sec) {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h${String(Math.round((sec % 3600) / 60)).padStart(2, "0")}`;
}

export default class Automations extends View {
  init(_props, cx) {
    this.list = null; // `ls --json`
    this.runs = []; // `history --json`
    this.view = { kind: "list" }; // list | detail {name} | form {original}
    this.error = null; this.note = null;
    this.known = null; // run ids already seen by this copy, to toast only new failures
    this.handle = cx.focus_handle();
    if (props()?.overlay) this.handle.focus();
    cx.spawn(async (cx) => { for (;;) { if ((await nextCommand())?.name === "focus") this.handle.focus(); } });
    cx.spawn(async (cx) => {
      this.bin = await this.locate();
      await this.refresh(cx);
      this.watch(cx);
    });
    cx.timer.every(30000, (cx) => this.refresh(cx)); // next-run times and the scheduler's pid
  }

  // The CLI on PATH, else where install.sh and the dev symlink put it.
  async locate() {
    try { if ((await exec("herdr-automations", ["version"])).code === 0) return "herdr-automations"; } catch {}
    return `${home()}/.local/bin/herdr-automations`;
  }

  async cli(args) {
    const r = await exec(this.bin, args);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().replace(/^error: /, ""));
    return r.stdout;
  }

  async refresh(cx) {
    if (!this.bin) return;
    try {
      this.list = JSON.parse(await this.cli(["ls", "--json"]));
      this.runs = JSON.parse(await this.cli(["history", "--json"]));
      this.error = null;
      this.announce();
    } catch (e) { this.error = String(e.message ?? e); }
    cx.notify();
  }

  // Config and state folders: a change there is a change to show.
  watch(cx) {
    const dirs = [this.list?.config?.replace(/\/[^/]+$/, ""), this.list?.state].filter(Boolean);
    for (const dir of dirs) cx.spawn(async (cx) => {
      for (;;) { try { await watchFolder(dir); } catch { return; } await this.refresh(cx); }
    });
  }

  // A failure finds you (ADR 0007): toast runs that failed or were missed
  // since this copy started. The first read only learns what is there.
  announce() {
    const ids = new Set(this.runs.map((r) => r.run_id));
    if (this.known) for (const r of this.runs) {
      if (this.known.has(r.run_id) || !(r.status === "failed" || r.status === "missed")) continue;
      notify({
        title: `${r.automation} ${r.status === "failed" ? "failed" : "missed a run"}`,
        body: r.error ?? "", level: r.status === "failed" ? "error" : "warning",
        ...(r.terminal && this.live(r.terminal) ? { action: { name: "pane.focus", args: { terminal: r.terminal } } } : {}),
      });
    }
    this.known = ids;
  }

  live(address) { return terminals().find((t) => t.address === address && t.state === "live"); }
  liveFor(name) { return terminals().find((t) => t.labels?.automation === name && t.state === "live"); }

  act(cx, args, then) {
    this.note = null;
    cx.spawn(async (cx) => {
      try { await this.cli(args); then?.(); } catch (e) { this.note = String(e.message ?? e); }
      await this.refresh(cx);
    });
  }

  open(run_, cx) {
    if (!run_.seen && FINISHED.has(run_.status)) this.act(cx, ["seen", run_.run_id]);
    if (run_.terminal && this.live(run_.terminal)) run("pane.focus", { terminal: run_.terminal });
    else { this.view = { kind: "detail", name: run_.automation }; cx.notify(); }
  }

  // ---- form ----

  edit(original, cx) {
    const a = this.list?.automations.find((x) => x.name === original) ?? {
      name: "", cron: "0 9 * * 1-5", repo: "", workspace: "worktree", agent: "claude", prompt: "", timeout_minutes: 60,
    };
    const field = (value, placeholder) => {
      const s = InputState.new({ placeholder, value: value ?? "" });
      s.on("change", (_e, cx) => this.preview(cx));
      return s;
    };
    this.form = {
      original, workspace: a.workspace ?? "worktree", workspace_id: a.workspace_id ?? "",
      agent: a.template ? "" : a.agent ?? "claude", template: a.template ?? "",
      name: field(a.name, "issue-triage"), cron: field(a.cron, "0 9 * * 1-5"), repo: field(tilde(a.repo), "~/Projects/myapp"),
      model: field(a.model, "agent default"), timeout: field(String(a.timeout_minutes ?? 60), "60"),
      mcp: field(tilde(a.mcp_config), "optional: path to an MCP servers JSON"),
      prompt: TextareaState.new({ placeholder: "What should the agent do each time?", value: a.prompt ?? "" }),
      result: null, seq: 0, models: new Map(), modelPicker: false,
      modelFilter: InputState.new({ placeholder: "Type to filter" }),
    };
    this.form.prompt.set_auto_grow(4, 12);
    this.form.modelFilter.on("change", (_e, cx) => cx.notify());
    this.form.modelFilter.on("submit", (_e, cx) => this.pickModel(cx));
    this.form.prompt.on("change", (_e, cx) => this.preview(cx));
    this.view = { kind: "form" };
    cx.spawn(async (cx) => {
      try { this.templates = JSON.parse((await hc(["templates", "--json"])).stdout).templates ?? []; } catch { this.templates = []; }
      try { this.installed = (await knownAgents()).filter((a) => a.installed).map((a) => a.key); } catch { this.installed = null; }
      cx.notify();
    });
    this.loadModels(cx);
    this.preview(cx);
  }

  modelMatches(f) {
    const query = f.modelFilter.value().trim().toLowerCase();
    return (f.models.get(f.agent) ?? [])
      .filter((m) => `${m.id} ${m.detail}`.toLowerCase().includes(query)).slice(0, 200);
  }

  pickModel(cx) {
    const f = this.form;
    if (!f?.modelPicker) return;
    const pick = this.modelMatches(f)[0];
    if (!pick) return;
    f.model.set_value(pick.id); f.modelPicker = false; f.model.focus(); this.preview(cx); cx.notify();
  }

  loadModels(cx) {
    const f = this.form, agent = f.agent;
    if (f.models.has(agent)) return;
    const loader = MODEL_LOADERS[agent];
    if (!loader) { f.models.set(agent, []); return; }
    f.models.set(agent, null);
    cx.spawn(async (cx) => {
      let models;
      try { models = await loader(); } catch { models = []; }
      f.models.set(agent, models);
      if (this.form === f) cx.notify();
    });
  }

  entry() {
    const f = this.form, num = parseInt(f.timeout.value(), 10);
    const expand = (p) => (p.startsWith("~/") ? home() + p.slice(1) : p);
    return {
      name: f.name.value().trim(), cron: f.cron.value().trim(), repo: expand(f.repo.value().trim()),
      workspace: f.workspace, workspace_id: f.workspace === "existing" ? f.workspace_id : "",
      agent: f.template ? "" : f.agent, template: f.template, model: f.template ? "" : f.model.value().trim(),
      prompt: f.prompt.value(), mcp_config: expand(f.mcp.value().trim()), timeout_minutes: Number.isFinite(num) ? num : 0,
    };
  }

  async put(dryRun) {
    const f = this.form, args = ["put", ...(f.original ? ["--original", f.original] : []), ...(dryRun ? ["--dry-run"] : [])];
    // exec has no stdin: hand the JSON over through the shell.
    const r = await exec("sh", ["-c", 'bin=$1 json=$2; shift 2; printf %s "$json" | "$bin" "$@"', "sh", this.bin, JSON.stringify(this.entry()), ...args]);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
    return JSON.parse(r.stdout);
  }

  preview(cx) {
    const f = this.form, seq = ++f.seq;
    cx.spawn(async (cx) => {
      let result;
      try { result = await this.put(true); } catch (e) { result = { problem: String(e.message ?? e) }; }
      if (this.form === f && seq === f.seq) { f.result = result; cx.notify(); }
    });
  }

  save(cx) {
    const f = this.form;
    cx.spawn(async (cx) => {
      try {
        const res = await this.put(false);
        if (res.problem) f.result = res;
        else { this.view = { kind: "detail", name: this.entry().name }; this.form = null; }
      } catch (e) { f.result = { problem: String(e.message ?? e) }; }
      await this.refresh(cx);
    });
  }

  // ---- render ----

  render(cx) {
    const t = { ...theme(), ...(settings().dark ? { blocked: "#e8ad68", working: "#86b6f2", done: "#98c798" } : { blocked: "#92551a", working: "#285fa0", done: "#376d36" }) };
    const body = this.view.kind === "form" && this.form ? this.renderForm(t, cx)
      : this.view.kind === "detail" ? this.renderDetail(t, cx) : this.renderList(t, cx);
    const count = this.list ? this.list.automations.length + this.list.invalid.length : 0;
    return v_flex().id("automations").size_full().min_h(0).overflow_hidden().bg(t.canvas)
      .text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        const f = this.view.kind === "form" ? this.form : null;
        if (f?.modelPicker) {
          if (e.key === "escape") { f.modelPicker = false; f.model.focus(); cx.notify(); cx.stop_propagation(); return; }
          if (e.key === "enter") { this.pickModel(cx); cx.stop_propagation(); return; }
          return;
        }
        if (e.key !== "escape") return;
        const overlay = props()?.overlay;
        if (overlay) closeOverlay(overlay);
        else if (this.view.kind !== "list") { this.view = { kind: "list" }; this.form = null; cx.notify(); }
        cx.stop_propagation();
      })
      .child(this.header(t, cx))
      .when(Boolean(this.error || this.note), (el) => el.child(div().flex_none().px(30).py(6).text_size(12).text_color(t.ansi1).child(this.error || this.note)))
      .child(v_flex().id("automations-body").flex_1().min_h(0).overflow_y_scrollbar().px(30).py(24)
        .child(h_flex().w_full().min_w(0).justify_center().child(body)))
      .child(h_flex().flex_none().h(34).px(30).gap(8).items_center().border_t(1).border_color(t.border).text_size(11).text_color(t.dim)
        .child(div().flex_1().child(`${count} ${count === 1 ? "automation" : "automations"} · ${this.runs.length} ${this.runs.length === 1 ? "run" : "runs"}`))
        .child(div().child("Click a card to open it · Esc to close")));
  }

  button(id, label, t, onClick, opts = {}) {
    return h_flex().id(id).h(opts.h ?? 28).px(opts.px ?? 9).flex_none().items_center().justify_center().rounded(16).text_size(12)
      .bg(opts.solid ? t.solid : t.raised).text_color(opts.solid ? t.solid_foreground : opts.danger ? t.ansi1 : t.foreground)
      .border_1().border_color(opts.solid ? t.solid : t.border).cursor_pointer().hover((s) => s.opacity(0.85))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => onClick(cx)).child(label);
  }

  pills(id, options, value, t, pick) {
    return h_flex().min_w(0).flex_wrap().gap(7).children(options.map(([v, label]) =>
      h_flex().id(`${id}-${v}`).h(28).px(9).max_w_full().min_w(0).items_center().rounded(7).text_size(12).cursor_pointer()
        .bg(v === value ? t.selected : t.raised).text_color(v === value ? t.foreground : t.muted)
        .border_1().border_color(v === value ? t.accent : t.border).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => pick(v, cx)).child(div().min_w(0).truncate().child(label))));
  }

  switch_(id, on, t, toggle) {
    return h_flex().id(id).w(30).h(17).flex_none().rounded(9).p(2).cursor_pointer().bg(on ? t.accent : t.input)
      .when(on, (el) => el.justify_end()).on_click((_e, cx) => toggle(cx))
      .child(div().size(13).rounded(7).bg(t.background));
  }

  header(t, cx) {
    const paused = Boolean(this.list?.paused);
    const back = this.view.kind !== "list";
    const count = this.list ? this.list.automations.length + this.list.invalid.length : 0;
    const waiting = this.runs.filter((r) => FINISHED.has(r.status) && !r.seen).length;
    const subtitle = !this.list ? "Loading automations…" : count
      ? `${count} ${count === 1 ? "automation" : "automations"} · ${waiting ? `${waiting} finished ${waiting === 1 ? "run" : "runs"} waiting for review` : "nothing waiting for review"}`
      : "No automations yet. + creates one.";
    return v_flex().flex_none().px(30).pt(24).pb(18).gap(16).bg(t.chrome).border_b(1).border_color(t.border)
      .child(h_flex().gap(12).items_center()
        .when(back, (el) => el.child(this.button("back", "‹", t, (cx) => { this.view = { kind: "list" }; this.form = null; cx.notify(); }, { px: 11, h: 32 })))
        .child(div().flex_1().min_w(0).truncate().text_size(26).font_semibold().child("Automations"))
        .when(Boolean(this.list), (el) => el.child(h_flex().h(32).px(12).gap(10).items_center().rounded(16).bg(t.raised).border_1().border_color(t.border)
          .child(div().text_size(12).text_color(paused ? t.blocked : t.muted).child(paused ? "All paused" : "Active"))
          .child(this.switch_("pause-all", !paused, t, (cx) => this.act(cx, [paused ? "resume" : "pause", "--all"])))))
        .when(!back, (el) => el.child(this.button("new", "+", t, (cx) => this.edit(null, cx), { px: 12, h: 32 }))))
      .child(div().text_size(13).text_color(t.muted).child(subtitle))
      .when(Boolean(this.list && !this.list.scheduler), (el) => el.child(this.banner(t, cx)));
  }

  banner(t, cx) {
    return h_flex().gap(12).items_center().text_color(t.muted)
      .child(div().flex_1().text_size(13).child("Scheduler stopped: nothing will run on time."))
      .child(this.button("start", "Start", t, (cx) => this.act(cx, ["service", "install"]), { solid: true, h: 32, px: 14 }));
  }

  dot(a, t) {
    const live = this.liveFor(a.name);
    const color = live ? (live.status === "blocked" ? t.blocked : t.working)
      : a.disabled || this.list.paused ? t.dim : a.last?.status === "failed" || a.last?.status === "missed" ? t.ansi1 : t.ansi2;
    return div().size(8).rounded(4).flex_none().bg(color);
  }

  renderList(t, cx) {
    if (!this.list) return div().p(14).text_color(t.dim).child(this.error ? "" : "Loading…");
    const inbox = this.runs.filter((r) => FINISHED.has(r.status) && !r.seen).slice(0, 20);
    const section = (label, n, color, hint, unread = false) => v_flex().gap(7).pb(10).border_b(2).border_color(color)
      .child(h_flex().gap(8).items_center()
        .child(div().size(7).rounded(4).flex_none().bg(color))
        .child(div().flex_1().min_w(0).text_size(16).font_medium().child(label))
        .when(unread, (el) => el.child(this.button("seen-all", "Mark all read", t, (cx) => this.act(cx, ["seen", "--all"]), { px: 7, h: 26 })))
        .child(div().px(6).rounded(7).bg(t.raised).text_size(12).text_color(n > 0 ? color : t.muted).child(String(n))))
      .child(div().text_size(12).text_color(t.muted).truncate().child(hint));
    const empty = (glyph, text) => v_flex().p(16).gap(10).rounded(11).bg(t.surface).border_1().border_color(t.border)
      .child(div().text_size(18).text_color(t.dim).child(glyph))
      .child(div().whitespace_normal().text_size(12).text_color(t.muted).child(text));
    const inboxLane = v_flex().flex_1().min_w(0).gap(16)
      .child(section("INBOX", inbox.length, t.blocked, "Finished runs waiting for your review.", inbox.length > 0));
    if (!inbox.length) inboxLane.child(empty("✓", "Nothing new."));
    for (const r of inbox) inboxLane.child(this.inboxRow(r, t));
    const automationLane = v_flex().flex_1().min_w(0).gap(16)
      .child(section("AUTOMATIONS", this.list.automations.length + this.list.invalid.length, t.working, "Scheduled prompts for your agents."));
    if (!this.list.automations.length && !this.list.invalid.length)
      automationLane.child(empty("+", "None yet. + creates one."));
    for (const a of this.list.automations) automationLane.child(this.row(a, t));
    for (const d of this.list.invalid) automationLane.child(v_flex().min_w(0).p(16).gap(8).rounded(11).bg(t.ansi1 + (settings().dark ? "18" : "0c")).border_1().border_color(t.ansi1)
      .child(div().text_size(16).font_medium().child(d.name || `line ${d.line}`))
      .child(div().whitespace_normal().text_size(12).text_color(t.ansi1).child(d.message)));
    const col = h_flex().w_full().min_w(0).gap(22).items_start().child(inboxLane).child(automationLane);
    return col;
  }

  inboxRow(r, t) {
    const ok = r.status === "done", color = ok ? t.ansi2 : r.status === "failed" ? t.ansi1 : t.dim;
    return v_flex().id(`inbox-${r.run_id}`).min_w(0).p(16).gap(9).rounded(11).bg(t.surface).border_1().border_color(r.status === "failed" ? t.ansi1 : t.border).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.open(r, cx))
      .child(h_flex().gap(6).items_center()
        .child(div().size(7).rounded(4).flex_none().bg(color))
        .child(div().flex_1().min_w(0).truncate().text_size(16).font_medium().child(r.automation))
        .child(div().text_size(12).text_color(color).child(r.status))
        .child(div().text_size(12).text_color(t.muted).child(ago(r.at))))
      .child(div().pl(13).text_size(12).text_color(t.muted).truncate()
        .child(r.error || `${duration(r.seconds)}${r.terminal && this.live(r.terminal) ? " · open" : ""}`));
  }

  row(a, t) {
    const live = this.liveFor(a.name);
    const sub = live ? `running · ${live.status ?? "starting"}` : a.disabled ? "paused"
      : `${human(a.cron)} · ${this.list.paused ? "held" : until(a.next)}`;
    const attention = live?.status === "blocked" ? t.blocked : a.last?.status === "failed" || a.last?.status === "missed" ? t.ansi1 : t.border;
    return v_flex().id(`auto-${a.name}`).min_w(0).p(16).gap(9).rounded(11).bg(t.surface).border_1().border_color(attention).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.view = { kind: "detail", name: a.name }; cx.notify(); })
      .child(h_flex().gap(7).items_center().child(this.dot(a, t)).child(div().flex_1().min_w(0).truncate().text_size(16).font_medium().child(a.name))
        .child(this.button(`run-${a.name}`, "Run", t, (cx) => this.act(cx, ["run", a.name, "--bg"]), { px: 9, h: 28 })))
      .child(div().pl(15).text_size(12).text_color(t.muted).truncate().child(sub))
      .child(div().pl(15).text_size(12).text_color(t.muted).truncate().child(`${a.template ? "template " + a.template : a.agent + (a.model ? " · " + a.model : "")} · ${a.workspace}`));
  }

  renderDetail(t, cx) {
    const a = this.list?.automations.find((x) => x.name === this.view.name);
    if (!a) return div().p(14).text_color(t.dim).child("This automation is gone.");
    const runs = this.runs.filter((r) => r.automation === a.name && r.status !== "scheduled").slice(0, 30);
    const kv = (k, v) => h_flex().gap(8).text_size(12).child(div().w(78).flex_none().text_color(t.dim).child(k)).child(div().flex_1().min_w(0).truncate().child(v || "—"));
    const deleting = this.deleting === a.name;
    return v_flex().w_full().max_w(640).min_w(0).gap(12)
      .child(h_flex().gap(8).items_center().child(this.dot(a, t)).child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().child(a.name)))
      .child(h_flex().gap(6).flex_wrap()
        .child(this.button("d-run", "Run now", t, (cx) => this.act(cx, ["run", a.name, "--bg"]), { solid: true }))
        .child(this.button("d-pause", a.disabled ? "Resume" : "Pause", t, (cx) => this.act(cx, [a.disabled ? "resume" : "pause", a.name])))
        .child(this.button("d-edit", "Edit", t, (cx) => this.edit(a.name, cx)))
        .child(this.button("d-rm", deleting ? "Confirm delete" : "Delete", t, (cx) => {
          if (!deleting) { this.deleting = a.name; cx.notify(); return; }
          this.deleting = null;
          this.act(cx, ["rm", a.name], () => { this.view = { kind: "list" }; });
        }, { danger: true })))
      .child(v_flex().min_w(0).p(13).gap(9).rounded(11).bg(t.surface).border_1().border_color(t.border)
        .child(kv("Schedule", `${human(a.cron)}${human(a.cron) !== a.cron ? ` (${a.cron})` : ""}`))
        .child(kv("Next", a.disabled ? "paused" : this.list.paused ? "held: all paused" : until(a.next)))
        .child(kv("Repo", tilde(a.repo)))
        .child(kv("Runs in", WORKSPACES.find(([w]) => w === a.workspace)?.[1] ?? a.workspace))
        .child(kv(a.template ? "Template" : "Agent", a.template || `${a.agent}${a.model ? " · " + a.model : ""}`)))
      .child(div().p(13).rounded(11).bg(t.surface).border_1().border_color(t.border).whitespace_normal().text_size(12).text_color(t.muted).child(a.prompt || a.workflow || ""))
      .child(div().pt(4).text_size(11).font_semibold().text_color(t.dim).child("HISTORY"))
      .children(runs.length ? runs.map((r) => h_flex().id(`h-${r.run_id}`).min_w(0).gap(8).p(12).rounded(11).bg(t.surface).border_1().border_color(t.border).items_center().cursor_pointer()
        .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.open(r, cx))
        .child(div().w(66).flex_none().text_size(11).text_color(r.status === "done" ? t.ansi2 : r.status === "failed" || r.status === "missed" ? t.ansi1 : t.muted).child(r.status))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child(r.error || (r.seconds ? duration(r.seconds) : "")))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(ago(r.at))))
        : [div().p(13).rounded(11).bg(t.surface).border_1().border_color(t.border).text_size(12).text_color(t.muted).child("No runs yet.")]);
  }

  renderForm(t, cx) {
    const f = this.form;
    const label = (s) => div().text_size(11).line_height("12px").font_semibold().text_color(t.dim).child(s);
    const input = (id, state) => div().id(id).min_w(0).h(26).px(10).flex().items_center().rounded(7).border_1().border_color(t.input).bg(t.background)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(state).h_full().w_full().text_size(12));
    const field = (name, control) => v_flex().min_w(0).gap(2).child(label(name)).child(control);
    const cron = f.cron.value().trim();
    const presets = [...PRESETS.map(([l, c]) => [c, l]), ["custom", "Custom"]];
    const preset = PRESETS.some(([, c]) => c === cron) ? cron : "custom";
    // Installed ones, and the entry's own agent even if it is not (any more).
    const offered = AGENTS.filter((a) => !this.installed || this.installed.includes(a) || a === f.agent);
    const agents = [...offered.map((a) => [a, a]), ...(this.templates ?? []).map((tp) => [`template:${tp.name}`, `${tp.name} (template)`])];
    const agentValue = f.template ? `template:${f.template}` : f.agent;
    const res = f.result;
    const models = f.models.get(f.agent) ?? [];
    const matches = this.modelMatches(f);
    const left = v_flex().flex_1().min_w(0).flex_basis(320).gap(4)
      .child(field("NAME", input("f-name", f.name)))
      .child(field("SCHEDULE", v_flex().min_w(0).gap(2)
        .child(this.pills("f-preset", presets, preset, t, (v, cx) => { if (v !== "custom") f.cron.set_value(v); this.preview(cx); cx.notify(); }))
        .child(input("f-cron", f.cron))))
      .child(field("REPO", h_flex().gap(6).child(div().flex_1().min_w(0).child(input("f-repo", f.repo)))
        .child(this.button("f-pick", "Choose…", t, (cx) => cx.spawn(async (cx) => {
          const dir = await pickFolder({ prompt: "Repository for this automation" });
          if (dir) { f.repo.set_value(tilde(dir)); this.preview(cx); }
          cx.notify();
        }), { h: 30 }))))
      .child(field("RUNS IN", this.pills("f-ws", WORKSPACES, f.workspace, t, (v, cx) => { f.workspace = v; this.preview(cx); cx.notify(); })))
      .when(f.workspace === "existing", (el) => el.child(this.pills("f-space",
        spaces().filter((s) => !s.machine).map((s) => [s.id, s.name]), f.workspace_id, t,
        (v, cx) => { f.workspace_id = v; this.preview(cx); cx.notify(); })))
      .child(field("AGENT", this.pills("f-agent", agents, agentValue, t, (v, cx) => {
        if (v.startsWith("template:")) { f.template = v.slice(9); f.agent = ""; } else { f.template = ""; f.agent = v; }
        f.modelPicker = false; this.loadModels(cx); this.preview(cx); cx.notify();
      })))
      .when(!f.template, (el) => el.child(field("MODEL", v_flex().min_w(0).gap(4)
        .child(h_flex().min_w(0).gap(6).items_center()
          .child(div().flex_1().min_w(0).child(input("f-model", f.model)))
          .when(models === null, (el) => el.child(div().text_size(11).text_color(t.muted).child("Loading models…")))
          .when(Boolean(models?.length), (el) => el.child(this.button("f-model-choose", "Choose…", t, (cx) => {
            f.modelPicker = !f.modelPicker;
            if (f.modelPicker) {
              f.modelFilter.set_value("");
              for (const ms of [0, 250, 600]) cx.timer.after(ms, () => { if (this.form === f && f.modelPicker) f.modelFilter.focus(); });
            } else f.model.focus();
            cx.notify();
          }, { h: 30 }))))
        .when(f.modelPicker && Boolean(models?.length), (el) => el.child(v_flex().id("f-model-picker").absolute().left(0).right(0).bottom(30).h(300).min_w(0).p(8).gap(6).rounded(9).border_1().border_color(t.border).bg(t.canvas).shadow_2xl()
          .child(h_flex().gap(6).items_center().text_size(11).text_color(t.dim)
            .child(div().flex_1().child(`${f.agent} models`))
            .child(div().child(`${matches.length} of ${models.length} · Enter picks the first`))
            .child(this.button("f-model-done", "Close", t, (cx) => { f.modelPicker = false; f.model.focus(); cx.notify(); }, { h: 24 })))
          .child(input("f-model-filter", f.modelFilter))
          .child(v_flex().id("f-model-options").flex_1().min_h(0).min_w(0).overflow_y_scrollbar()
            .children(matches.map((m) => v_flex().id(`f-model-option-${m.id}`).flex_none().min_w(0).px(8).py(6).gap(2).rounded(5).cursor_pointer().hover((s) => s.bg(t.hover))
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .on_click((_e, cx) => { f.model.set_value(m.id); f.modelPicker = false; f.model.focus(); this.preview(cx); cx.notify(); })
              .child(div().text_size(12).truncate().child(m.id))
              .when(Boolean(m.detail), (el) => el.child(div().text_size(11).text_color(t.muted).truncate().child(m.detail)))))
            .when(matches.length === 0, (el) => el.child(div().p(8).text_size(12).text_color(t.muted).child("No matching models.")))))))))
      .child(field("TIMEOUT (MINUTES)", input("f-timeout", f.timeout)))
      .child(field("MCP CONFIG", input("f-mcp", f.mcp)));
    const right = v_flex().flex_1().min_w(0).flex_basis(320).gap(4)
      .child(field("PROMPT", div().id("f-prompt").min_w(0).h(340).p(10).rounded(7).bg(t.background).border_1().border_color(t.input)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Textarea.new(f.prompt).w_full().h_full().text_size(12))))
      .child(div().pt(8).whitespace_normal().text_size(12)
        .when(Boolean(res?.problem), (el) => el.text_color(t.ansi1).child(res.problem))
        .when(Boolean(res && !res.problem && res.next), (el) => el.text_color(t.muted)
          .child(`Next: ${res.next.map((n) => until(n)).join(", ")}`)))
      .child(h_flex().pt(8).gap(8).justify_end()
        .child(this.button("f-cancel", "Cancel", t, (cx) => { this.view = f.original ? { kind: "detail", name: f.original } : { kind: "list" }; this.form = null; cx.notify(); }))
        .child(this.button("f-save", "Save", t, (cx) => this.save(cx), { solid: true })));
    return v_flex().w_full().max_w(940).min_w(0).p(18).gap(16).rounded(11).bg(t.surface).border_1().border_color(t.border)
      .child(div().text_size(17).line_height("20px").font_medium().child(f.original ? `Edit ${f.original}` : "New automation"))
      .child(h_flex().w_full().min_w(0).flex_wrap().gap(24).items_start().child(left).child(right));
  }
}
