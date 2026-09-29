"use strict";

const {
  Plugin,
  Modal,
  Setting,
  PluginSettingTab,
  EditorSuggest,
  setIcon,
  Notice,
} = require("obsidian");

/* ------------------------------------------------------------------ */
/* Data                                                                */
/* ------------------------------------------------------------------ */

// Obsidian's built-in callout types (styling comes from Obsidian/the theme)
const NATIVE = [
  { id: "note", label: "Note", icon: "pencil" },
  { id: "abstract", label: "Abstract", icon: "clipboard-list" },
  { id: "info", label: "Info", icon: "info" },
  { id: "todo", label: "Todo", icon: "check-circle-2" },
  { id: "tip", label: "Tip", icon: "flame" },
  { id: "success", label: "Success", icon: "check" },
  { id: "question", label: "Question", icon: "help-circle" },
  { id: "warning", label: "Warning", icon: "alert-triangle" },
  { id: "failure", label: "Failure", icon: "x" },
  { id: "danger", label: "Danger", icon: "zap" },
  { id: "bug", label: "Bug", icon: "bug" },
  { id: "example", label: "Example", icon: "list" },
  { id: "quote", label: "Quote", icon: "quote" },
];

// Extra palette (styling is injected by this plugin)
const EXTRA = [
  { id: "red", label: "Red", color: "#ef4444", icon: "alert-octagon" },
  { id: "orange", label: "Orange", color: "#f97316", icon: "alert-triangle" },
  { id: "amber", label: "Amber", color: "#f59e0b", icon: "lightbulb" },
  { id: "yellow", label: "Yellow", color: "#eab308", icon: "star" },
  { id: "lime", label: "Lime", color: "#84cc16", icon: "leaf" },
  { id: "green", label: "Green", color: "#22c55e", icon: "check-circle-2" },
  { id: "emerald", label: "Emerald", color: "#10b981", icon: "gem" },
  { id: "teal", label: "Teal", color: "#14b8a6", icon: "droplet" },
  { id: "cyan", label: "Cyan", color: "#06b6d4", icon: "waves" },
  { id: "sky", label: "Sky", color: "#0ea5e9", icon: "cloud" },
  { id: "blue", label: "Blue", color: "#3b82f6", icon: "bookmark" },
  { id: "indigo", label: "Indigo", color: "#6366f1", icon: "brain" },
  { id: "violet", label: "Violet", color: "#8b5cf6", icon: "sparkles" },
  { id: "purple", label: "Purple", color: "#a855f7", icon: "crown" },
  { id: "fuchsia", label: "Fuchsia", color: "#d946ef", icon: "gift" },
  { id: "pink", label: "Pink", color: "#ec4899", icon: "heart" },
  { id: "rose", label: "Rose", color: "#f43f5e", icon: "bell" },
  { id: "brown", label: "Brown", color: "#a97142", icon: "coffee" },
  { id: "gray", label: "Gray", color: "#9ca3af", icon: "minus" },
  { id: "slate", label: "Slate", color: "#64748b", icon: "pin" },
];

const DEFAULT_SETTINGS = {
  enableSuggest: true,
  showNative: true,
  showExtra: true,
  custom: [],
};

// "> [!type]+ Title" (also matches nested blockquotes)
const HEADER_RE = /^((?:\s*>)+\s*)\[!([^\]\s]+)\]([+-]?)/;
// "> [!par" to the left of the cursor
const TRIGGER_RE = /^((?:\s*>)+\s*)\[!([^\]\s]*)$/;

/* ------------------------------------------------------------------ */
/* Utilities                                                           */
/* ------------------------------------------------------------------ */

function normalizeColor(hex) {
  let h = String(hex || "").trim();
  if (!h.startsWith("#")) h = "#" + h;
  const body = h.slice(1);
  if (/^[0-9a-fA-F]{3}$/.test(body) || /^[0-9a-fA-F]{6}$/.test(body)) {
    return h.toLowerCase();
  }
  return "#808080";
}

function sanitizeId(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "");
}

// Renders a miniature callout using Obsidian's real DOM structure, so the
// active theme and colors are respected in the preview.
function renderCard(parent, item) {
  const callout = parent.createDiv({
    cls: "callout cp-callout",
    attr: { "data-callout": item.id },
  });
  const title = callout.createDiv({ cls: "callout-title" });
  const icon = title.createDiv({ cls: "callout-icon" });
  setIcon(icon, item.icon || "pencil");
  title.createDiv({ cls: "callout-title-inner", text: item.label });
  title.createSpan({ cls: "cp-id", text: `[!${item.id}]` });
  return callout;
}

/* ------------------------------------------------------------------ */
/* Plugin                                                              */
/* ------------------------------------------------------------------ */

module.exports = class CalloutsPlusPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.styleEl = document.createElement("style");
    document.head.appendChild(this.styleEl);
    this.register(() => this.styleEl.remove());
    this.refreshStyles();

    this.registerEditorSuggest(new CalloutSuggest(this.app, this));

    this.addCommand({
      id: "insert-callout",
      name: "Insert callout…",
      editorCallback: (editor) => {
        new CalloutModal(this.app, this, editor, "insert").open();
      },
    });

    this.addCommand({
      id: "change-callout-type",
      name: "Change type of current callout…",
      editorCheckCallback: (checking, editor) => {
        const header = this.findHeader(editor);
        if (!header) return false;
        if (!checking) {
          new CalloutModal(this.app, this, editor, "change", header).open();
        }
        return true;
      },
    });

    this.addRibbonIcon("message-square-quote", "Insert callout", () => {
      const editor = this.app.workspace.activeEditor?.editor;
      if (!editor) {
        new Notice("Open a note in editing mode first.");
        return;
      }
      new CalloutModal(this.app, this, editor, "insert").open();
    });

    this.addSettingTab(new CalloutsPlusSettingTab(this.app, this));
  }

  async loadSettings() {
    const saved = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    if (!Array.isArray(this.settings.custom)) this.settings.custom = [];
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.refreshStyles();
  }

  // Groups shown in the picker
  getGroups() {
    const custom = this.settings.custom
      .map((c) => ({
        id: sanitizeId(c.id),
        label: c.label || sanitizeId(c.id),
        color: c.color,
        icon: c.icon || "pencil",
      }))
      .filter((c) => c.id);
    const customIds = new Set(custom.map((c) => c.id));

    const groups = [];
    if (this.settings.showNative) {
      groups.push({
        name: "Native",
        items: NATIVE.filter((c) => !customIds.has(c.id)),
      });
    }
    if (this.settings.showExtra) {
      groups.push({
        name: "More colors",
        items: EXTRA.filter((c) => !customIds.has(c.id)),
      });
    }
    if (custom.length) groups.push({ name: "Custom", items: custom });
    return groups;
  }

  getAllCallouts() {
    return this.getGroups().flatMap((g) => g.items);
  }

  // Injects the CSS for the extra and custom callouts
  refreshStyles() {
    const rules = [];
    const all = [];
    if (this.settings.showExtra) all.push(...EXTRA);
    all.push(
      ...this.settings.custom
        .map((c) => ({ ...c, id: sanitizeId(c.id) }))
        .filter((c) => c.id),
    );
    for (const c of all) {
      rules.push(
        `body .callout[data-callout="${c.id}"] { --callout-color: ${normalizeColor(
          c.color,
        )} !important; --callout-icon: lucide-${c.icon || "pencil"} !important; }`,
      );
    }
    this.styleEl.textContent = rules.join("\n");
  }

  // Finds the "> [!type]" header line for the callout the cursor is in
  findHeader(editor) {
    let line = editor.getCursor().line;
    while (line >= 0) {
      const text = editor.getLine(line);
      if (!/^\s*>/.test(text)) return null;
      const match = text.match(HEADER_RE);
      if (match) return { line, match };
      line--;
    }
    return null;
  }

  insertCallout(editor, id, title, fold) {
    const header = `> [!${id}]${fold}${title ? " " + title : ""}`;
    let text;
    let start;
    let end;

    if (editor.somethingSelected()) {
      const from = editor.getCursor("from");
      const to = editor.getCursor("to");
      let endLine = to.line;
      if (to.ch === 0 && to.line > from.line) endLine--;
      start = { line: from.line, ch: 0 };
      end = { line: endLine, ch: editor.getLine(endLine).length };
      const body = editor
        .getRange(start, end)
        .split("\n")
        .map((l) => (l ? "> " + l : ">"))
        .join("\n");
      text = header + "\n" + body;
    } else {
      const cur = editor.getCursor();
      const lineText = editor.getLine(cur.line);
      text = header + "\n> ";
      if (lineText.trim() === "") {
        start = { line: cur.line, ch: 0 };
        end = { line: cur.line, ch: lineText.length };
      } else {
        // Line has content: insert the callout below it
        start = { line: cur.line, ch: lineText.length };
        end = start;
        text = "\n" + text;
      }
    }

    const parts = text.split("\n");
    editor.replaceRange(text, start, end);
    editor.setCursor({
      line: start.line + parts.length - 1,
      ch: parts[parts.length - 1].length,
    });
  }

  changeType(editor, header, id) {
    const { line, match } = header;
    const from = { line, ch: match[1].length + 2 };
    const to = { line, ch: from.ch + match[2].length };
    editor.replaceRange(id, from, to);
  }
};

/* ------------------------------------------------------------------ */
/* Picker (modal)                                                      */
/* ------------------------------------------------------------------ */

class CalloutModal extends Modal {
  constructor(app, plugin, editor, mode, header) {
    super(app);
    this.plugin = plugin;
    this.editor = editor;
    this.mode = mode;
    this.header = header;
    this.visible = [];
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("cp-modal");
    this.titleEl.setText(
      this.mode === "insert" ? "Insert callout" : "Change callout type",
    );

    this.searchEl = contentEl.createEl("input", {
      type: "text",
      cls: "cp-search",
      attr: { placeholder: "Search… (Enter selects the first result)" },
    });

    if (this.mode === "insert") {
      const row = contentEl.createDiv({ cls: "cp-options" });
      this.titleInput = row.createEl("input", {
        type: "text",
        attr: { placeholder: "Title (optional)" },
      });
      this.foldSelect = row.createEl("select");
      [
        ["", "Not foldable"],
        ["+", "Foldable (expanded)"],
        ["-", "Foldable (collapsed)"],
      ].forEach(([value, label]) => {
        this.foldSelect.createEl("option", { value, text: label });
      });
    }

    this.groupsEl = contentEl.createDiv({ cls: "cp-groups" });
    this.render();

    this.searchEl.addEventListener("input", () => this.render());
    this.searchEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && this.visible.length) {
        e.preventDefault();
        this.choose(this.visible[0]);
      }
    });
    this.searchEl.focus();
  }

  onClose() {
    this.contentEl.empty();
  }

  render() {
    const q = this.searchEl.value.trim().toLowerCase();
    this.groupsEl.empty();
    this.visible = [];

    for (const group of this.plugin.getGroups()) {
      const items = group.items.filter(
        (c) => c.id.includes(q) || c.label.toLowerCase().includes(q),
      );
      if (!items.length) continue;
      this.groupsEl.createDiv({ cls: "cp-group-title", text: group.name });
      const grid = this.groupsEl.createDiv({ cls: "cp-grid" });
      for (const item of items) {
        this.visible.push(item);
        const card = renderCard(grid, item);
        card.addEventListener("click", () => this.choose(item));
      }
    }

    if (!this.visible.length) {
      this.groupsEl.createDiv({
        cls: "cp-empty",
        text: "No callouts found.",
      });
    }
  }

  choose(item) {
    const title = this.titleInput ? this.titleInput.value.trim() : "";
    const fold = this.foldSelect ? this.foldSelect.value : "";
    this.close();
    if (this.mode === "insert") {
      this.plugin.insertCallout(this.editor, item.id, title, fold);
    } else {
      this.plugin.changeType(this.editor, this.header, item.id);
    }
    this.editor.focus();
  }
}

/* ------------------------------------------------------------------ */
/* Suggestions when typing "> [!"                                      */
/* ------------------------------------------------------------------ */

class CalloutSuggest extends EditorSuggest {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  onTrigger(cursor, editor) {
    if (!this.plugin.settings.enableSuggest) return null;
    const before = editor.getLine(cursor.line).slice(0, cursor.ch);
    const match = before.match(TRIGGER_RE);
    if (!match) return null;
    return {
      start: { line: cursor.line, ch: match[1].length },
      end: cursor,
      query: match[2],
    };
  }

  getSuggestions(context) {
    const q = context.query.toLowerCase();
    return this.plugin
      .getAllCallouts()
      .filter((c) => c.id.includes(q) || c.label.toLowerCase().includes(q));
  }

  renderSuggestion(item, el) {
    el.addClass("cp-suggest");
    renderCard(el, item);
  }

  selectSuggestion(item) {
    const { editor, start, end } = this.context;
    const lineText = editor.getLine(end.line);

    // Auto-closing brackets may have already inserted the "]"
    let endPos = end;
    if (lineText.charAt(end.ch) === "]") {
      endPos = { line: end.line, ch: end.ch + 1 };
    }
    const next = lineText.charAt(endPos.ch);
    const suffix = next === " " ? "" : " ";

    editor.replaceRange(`[!${item.id}]${suffix}`, start, endPos);
    editor.setCursor({ line: start.line, ch: start.ch + item.id.length + 4 });
  }
}

/* ------------------------------------------------------------------ */
/* Settings                                                             */
/* ------------------------------------------------------------------ */

class CalloutsPlusSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    new Setting(containerEl)
      .setName("Suggest when typing [!")
      .setDesc(
        'Show the color/type picker as soon as you type "> [!" in a note.',
      )
      .addToggle((t) =>
        t.setValue(s.enableSuggest).onChange(async (v) => {
          s.enableSuggest = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Show native callouts")
      .setDesc("Note, tip, warning, danger, and the other built-in types.")
      .addToggle((t) =>
        t.setValue(s.showNative).onChange(async (v) => {
          s.showNative = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Enable extra color palette")
      .setDesc(
        "20 additional colors (red, orange, amber, …, slate). If disabled, notes that already use them will lose their color.",
      )
      .addToggle((t) =>
        t.setValue(s.showExtra).onChange(async (v) => {
          s.showExtra = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl).setName("Custom callouts").setHeading();

    const help = containerEl.createDiv({ cls: "setting-item-description" });
    help.appendText(
      "The icon is the name of a Lucide icon (e.g. rocket, heart, flame). Browse icons at ",
    );
    help.createEl("a", {
      text: "lucide.dev/icons",
      href: "https://lucide.dev/icons",
    });
    help.appendText(".");

    s.custom.forEach((c, index) => {
      const row = new Setting(containerEl).setClass("cp-custom-row");

      row.addText((t) =>
        t
          .setPlaceholder("id (e.g. idea)")
          .setValue(c.id)
          .onChange(async (v) => {
            c.id = sanitizeId(v);
            await this.plugin.saveSettings();
          }),
      );
      row.addText((t) =>
        t
          .setPlaceholder("Label")
          .setValue(c.label)
          .onChange(async (v) => {
            c.label = v;
            await this.plugin.saveSettings();
          }),
      );
      row.addColorPicker((p) =>
        p.setValue(c.color).onChange(async (v) => {
          c.color = v;
          await this.plugin.saveSettings();
        }),
      );
      row.addText((t) =>
        t
          .setPlaceholder("icon")
          .setValue(c.icon)
          .onChange(async (v) => {
            c.icon = v.trim();
            await this.plugin.saveSettings();
          }),
      );
      row.addExtraButton((b) =>
        b
          .setIcon("trash")
          .setTooltip("Remove")
          .onClick(async () => {
            s.custom.splice(index, 1);
            await this.plugin.saveSettings();
            this.display();
          }),
      );
    });

    new Setting(containerEl).addButton((b) =>
      b
        .setButtonText("Add callout")
        .setCta()
        .onClick(async () => {
          s.custom.push({
            id: `custom-${s.custom.length + 1}`,
            label: "My callout",
            color: "#ff6b6b",
            icon: "pencil",
          });
          await this.plugin.saveSettings();
          this.display();
        }),
    );
  }
}
