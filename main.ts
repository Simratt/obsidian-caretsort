import {
	MarkdownPostProcessorContext,
	MarkdownView,
	Notice,
	Plugin,
	TFile,
} from "obsidian";

type SortDir = "asc" | "desc";

interface SortHistoryEntry {
	path: string;
	before: string;
	after: string;
}

const MAX_HISTORY = 20;

export default class CaretsortPlugin extends Plugin {
	// Tracks which header button opened the currently-visible dropdown so
	// clicking the same button again closes it (toggle behaviour).
	private activeAnchor: HTMLElement | null = null;

	// Last N sorts across all files. Each entry records the file content
	// before and after the sort so an undo can safely restore the
	// previous state (provided the file hasn't been modified since).
	private sortHistory: SortHistoryEntry[] = [];

	onload() {
		this.registerMarkdownPostProcessor((el, ctx) =>
			this.processTables(el, ctx)
		);

		// Close any open dropdown on escape
		this.registerDomEvent(document, "keydown", (e: KeyboardEvent) => {
			if (e.key === "Escape") this.closeDropdowns();
		});

		// Register an Obsidian command for undoing the last sort. The
		// checkCallback gates it so the hotkey only fires in reading
		// view, where native Cmd/Ctrl+Z does nothing anyway.
		this.addCommand({
			id: "undo-last-sort",
			name: "Undo last table sort",
			checkCallback: (checking: boolean) => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				const inReading = view?.getMode?.() === "preview";
				const hasHistory = this.sortHistory.length > 0;
				if (!inReading || !hasHistory) return false;
				if (!checking) void this.undoLastSort();
				return true;
			},
		});
	}

	onunload() {
		this.closeDropdowns();
		this.sortHistory = [];
	}

	processTables(el: HTMLElement, ctx: MarkdownPostProcessorContext) {
		const tables = el.querySelectorAll("table");
		tables.forEach((table) => this.enhanceTable(table, ctx));
	}

	enhanceTable(
		table: HTMLTableElement,
		ctx: MarkdownPostProcessorContext
	) {
		const headers = table.querySelectorAll("thead th");
		headers.forEach((th, idx) => {
			// Avoid double-injection if post processor re-runs
			if (th.querySelector(".caretsort-btn")) return;

			const btn = document.createElement("button");
			btn.className = "caretsort-btn";
			btn.setAttr("aria-label", "Sort column");
			btn.textContent = "▾";
			btn.onclick = (e) => {
				e.stopPropagation();
				this.showDropdown(
					e,
					idx,
					table,
					ctx
				);
			};
			th.appendChild(btn);
		});
	}

	closeDropdowns() {
		document
			.querySelectorAll(".caretsort-dropdown")
			.forEach((d) => d.remove());
		this.activeAnchor = null;
	}

	showDropdown(
		e: MouseEvent,
		colIdx: number,
		table: HTMLTableElement,
		ctx: MarkdownPostProcessorContext
	) {
		const target = e.target as HTMLElement;

		// Toggle: if same button reopened, just close and bail.
		if (this.activeAnchor === target) {
			this.closeDropdowns();
			return;
		}

		this.closeDropdowns();
		this.activeAnchor = target;

		const dropdown = document.createElement("div");
		dropdown.className = "caretsort-dropdown";

		const rect = target.getBoundingClientRect();
		dropdown.style.top = `${rect.bottom + window.scrollY + 2}px`;
		dropdown.style.left = `${rect.left + window.scrollX}px`;

		const makeItem = (label: string, dir: SortDir) => {
			const item = document.createElement("button");
			item.className = "caretsort-item";
			item.textContent = label;
			item.onclick = async (ev) => {
				ev.stopPropagation();
				this.closeDropdowns();
				await this.sortTable(colIdx, dir, table, ctx);
			};
			return item;
		};

		// Swap labels depending on column content
		const labels = this.isNumeric(table, colIdx)
			? { asc: "↑ Ascending", desc: "↓ Descending" }
			: { asc: "↑ A → Z", desc: "↓ Z → A" };

		dropdown.appendChild(makeItem(labels.asc, "asc"));
		dropdown.appendChild(makeItem(labels.desc, "desc"));

		document.body.appendChild(dropdown);

		// Click-outside to close
		setTimeout(() => {
			const handler = (ev: MouseEvent) => {
				if (!dropdown.contains(ev.target as Node)) {
					this.closeDropdowns();
					document.removeEventListener("click", handler);
				}
			};
			document.addEventListener("click", handler);
		}, 0);
	}

	/**
	 * Detects whether a column contains only numeric values.
	 *
	 * Reads the rendered <td> text for the given column index directly from
	 * the DOM (sync, no file read). A column counts as numeric only if:
	 *   1. At least one non-empty cell exists
	 *   2. No cell contains link syntax ([[...]] or [text](url))
	 *   3. Every non-empty cell passes parseFloat roundtrip (e.g. "5"
	 *      parses to 5 and stringifies back to "5"; "5abc" would parse to
	 *      5 but stringify back to "5" !== "5abc", so it fails the check)
	 */
	isNumeric(table: HTMLTableElement, colIdx: number): boolean {
		const rows = Array.from(table.querySelectorAll("tbody tr"));
		if (rows.length === 0) return false;

		const values: string[] = [];
		for (const tr of rows) {
			const cells = tr.querySelectorAll("td");
			const cell = cells[colIdx];
			if (!cell) continue;
			const text = (cell.textContent ?? "").trim();
			if (text !== "") values.push(text);
		}
		if (values.length === 0) return false;

		return values.every((v) => {
			// Force text if any link syntax slipped through (rendered DOM
			// usually strips wiki-links to their display text, but guard
			// anyway for edge cases)
			if (/\[\[|\]\(/.test(v)) return false;
			const n = parseFloat(v);
			return !isNaN(n) && `${n}` === v;
		});
	}

	async sortTable(
		colIdx: number,
		dir: SortDir,
		table: HTMLTableElement,
		ctx: MarkdownPostProcessorContext
	) {
		const info = ctx.getSectionInfo(table);
		if (!info) return;

		const file =
			this.app.vault.getAbstractFileByPath(ctx.sourcePath);
		if (!(file instanceof TFile)) return;

		const content = await this.app.vault.read(file);
		const lines = content.split("\n");

		const tableLines = lines.slice(
			info.lineStart,
			info.lineEnd + 1
		);

		// Find the actual table boundary within the section (section may
		// include surrounding blank lines / other content in rare cases)
		let tStart = -1;
		let tEnd = -1;
		for (let i = 0; i < tableLines.length; i++) {
			if (this.isTableRow(tableLines[i])) {
				if (tStart === -1) tStart = i;
				tEnd = i;
			} else if (tStart !== -1) {
				break;
			}
		}
		if (tStart === -1 || tEnd - tStart < 2) return;

		const header = tableLines[tStart];
		const separator = tableLines[tStart + 1];
		const dataRows = tableLines.slice(tStart + 2, tEnd + 1);

		const sorted = this.sortRows(dataRows, colIdx, dir);

		const rebuilt = [
			...tableLines.slice(0, tStart),
			header,
			separator,
			...sorted,
			...tableLines.slice(tEnd + 1),
		];

		const newLines = [
			...lines.slice(0, info.lineStart),
			...rebuilt,
			...lines.slice(info.lineEnd + 1),
		];

		const newContent = newLines.join("\n");

		// Record history before writing so undo can restore this state.
		this.pushHistory({
			path: file.path,
			before: content,
			after: newContent,
		});

		await this.app.vault.modify(file, newContent);
	}

	pushHistory(entry: SortHistoryEntry) {
		this.sortHistory.push(entry);
		if (this.sortHistory.length > MAX_HISTORY) {
			this.sortHistory.shift();
		}
	}

	async undoLastSort() {
		const entry = this.sortHistory.pop();
		if (!entry) return;

		const file = this.app.vault.getAbstractFileByPath(entry.path);
		if (!(file instanceof TFile)) {
			new Notice("Caretsort: file no longer exists");
			return;
		}

		const current = await this.app.vault.read(file);

		// Safety check: if the file was edited after the sort, the current
		// content won't match what we wrote. Bail rather than risk wiping
		// the user's manual edits.
		if (current !== entry.after) {
			new Notice(
				"Caretsort: file was modified, undo skipped"
			);
			return;
		}

		await this.app.vault.modify(file, entry.before);
		new Notice("Caretsort: sort undone");
	}

	isTableRow(line: string): boolean {
		return line.trim().startsWith("|");
	}

	sortRows(rows: string[], colIdx: number, dir: SortDir): string[] {
		const getCell = (row: string): string => {
			// Replace [[file|alias]] wiki-links so their internal pipe
			// doesn't break column splitting.
			const placeholders = new Map<string, string>();
			let i = 0;
			const sanitized = row.replace(
				/\[\[[^\]]*\|[^\]]*\]\]/g,
				(m) => {
					const key = `__STP${i++}__`;
					placeholders.set(key, m);
					return key;
				}
			);

			const parts = sanitized.split("|").map((c) => c.trim());
			// Leading and trailing pipes produce empty first/last cells
			const cells =
				parts[0] === "" ? parts.slice(1) : parts;
			if (cells[cells.length - 1] === "") cells.pop();

			const cell = cells[colIdx] ?? "";
			return cell.replace(
				/__STP\d+__/g,
				(k) => placeholders.get(k) ?? k
			);
		};

		const sortKey = (row: string): string => {
			const raw = getCell(row).toLowerCase();
			// Strip markdown link/wiki-link wrapping for cleaner sort
			const linkText = raw.match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/);
			if (linkText) return (linkText[2] || linkText[1]).trim();
			const mdLink = raw.match(/\[([^\]]+)\]\([^)]+\)/);
			if (mdLink) return mdLink[1].trim();
			return raw;
		};

		const sorted = [...rows].sort((a, b) => {
			const ka = sortKey(a);
			const kb = sortKey(b);
			// Try numeric sort when both cells look numeric
			const na = parseFloat(ka);
			const nb = parseFloat(kb);
			if (!isNaN(na) && !isNaN(nb) && `${na}` === ka && `${nb}` === kb) {
				return dir === "asc" ? na - nb : nb - na;
			}
			return dir === "asc"
				? ka.localeCompare(kb)
				: kb.localeCompare(ka);
		});

		return sorted;
	}
}
