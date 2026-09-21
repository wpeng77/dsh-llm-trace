/**
 * dsh-llm-trace browser half: one Conversation View tab that reads the captures
 * the host half already serves over HTTP.
 *
 * The bundle is hand-written in the `window.__ModuleLoader__.load` envelope that
 * `dsh-client-modules` serves, so it needs no bundler: it requires only the
 * platform `react` seed and uses `React.createElement` instead of JSX. The host
 * scans Loader rows for packages declaring `dsh.client`, and this package's
 * absolute-path row resolves its own `package.json` through the nearest-ancestor
 * walk, so no `node_modules` install is involved.
 *
 * The view runs on the same origin as the Web host, so it reads the viewer's own
 * JSON endpoints rather than crossing a Remote API.
 */

window.__ModuleLoader__.load({
	id: "dsh-llm-trace",
	factory: (require) => {
		var module = { exports: {} };
		var react = require("react");

		/** Locale namespace and the viewer's mount path on the Web host. */
		var NS = "dsh-llm-trace";
		var BASE = "/llm-trace";

		/**
		 * Shared browser modules, loaded once for every view instance.
		 *
		 * The viewer document loads the same two files, so the tree logic and the
		 * SSE assembler have exactly one implementation. A failed load resolves to
		 * null and both features fall back to the raw view.
		 */
		var sharedPromise = Promise.all([
			import(BASE + "/assets/json-tree.js"),
			import(BASE + "/assets/sse.js"),
		]).then(
			function (modules) { return { tree: modules[0], sse: modules[1] } },
			function () { return null },
		);

		var DICT_EN = {
			"tab": "LLM Trace",
			"empty.list": "No model call captured for this session yet.",
			"empty.detail": "Select an exchange to inspect its wire payload.",
			"filter": "Filter by url, status, or method",
			"auto": "Auto",
			"refresh": "Refresh",
			"unreachable": "Host unreachable",
			"tab.reqbody": "Request body",
			"tab.resbody": "Response body",
			"tab.reqheaders": "Request headers",
			"tab.resheaders": "Response headers",
			"action.copy": "Copy",
			"action.copied": "Copied",
			"action.copyFailed": "Copy failed",
			"action.showRaw": "Show raw SSE",
			"action.showAssembled": "Show assembled",
			"action.showRawJson": "Show raw JSON",
			"action.showTree": "Show tree",
			"sec.reasoning": "Reasoning",
			"sec.content": "Content",
			"sec.toolCalls": "Tool calls",
			"sec.usage": "Usage",
			"note.empty": "(empty)",
			"note.none": "none",
			"note.truncated": "truncated at the capture limit",
			"note.broken": "incomplete trailing chunk(s) — the body was cut at the capture limit",
			"note.noDelta": "No delta content in this stream.",
			"note.notJson": "not parseable JSON — showing it raw",
			"note.captureError": "capture error",
			"note.secrets": "Secret headers are stored as <redacted>. Bodies are retained verbatim.",
			"note.finish": "finish_reason",
			"note.done": "stream closed with [DONE]",
			"note.headers": "headers",
		};
		var DICT_ZH = {
			"tab": "LLM 追踪",
			"empty.list": "本会话还没有捕获到模型调用。",
			"empty.detail": "选一条记录查看原始报文。",
			"filter": "按 URL / 状态码 / 方法过滤",
			"auto": "自动",
			"refresh": "刷新",
			"unreachable": "无法连接宿主",
			"tab.reqbody": "请求体",
			"tab.resbody": "响应体",
			"tab.reqheaders": "请求头",
			"tab.resheaders": "响应头",
			"action.copy": "复制",
			"action.copied": "已复制",
			"action.copyFailed": "复制失败",
			"action.showRaw": "查看原始 SSE",
			"action.showAssembled": "查看组装视图",
			"action.showRawJson": "查看原始 JSON",
			"action.showTree": "查看树",
			"sec.reasoning": "推理",
			"sec.content": "正文",
			"sec.toolCalls": "工具调用",
			"sec.usage": "用量",
			"note.empty": "（空）",
			"note.none": "无",
			"note.truncated": "已在捕获上限处截断",
			"note.broken": "末尾有未完成的 chunk —— 响应体在捕获上限处被切断",
			"note.noDelta": "这条流里没有增量内容。",
			"note.notJson": "不是可解析的 JSON —— 按原文显示",
			"note.captureError": "捕获错误",
			"note.secrets": "敏感请求头已存为 <redacted>，body 原样保留。",
			"note.finish": "结束原因",
			"note.done": "流以 [DONE] 正常关闭",
			"note.headers": "个头",
		};

		var COLOR = {
			panel: "var(--dsw-alias-bg-layer-1, #161b22)",
			raised: "var(--dsw-alias-bg-layer-2, #1c2128)",
			hover: "var(--dsw-alias-interactive-bg-hover, #1f2937)",
			line: "var(--dsw-alias-border-l1, #30363d)",
			fg: "var(--dsw-alias-label-primary, #e6edf3)",
			dim: "var(--dsw-alias-label-secondary, #8b949e)",
			dimmer: "var(--dsw-alias-label-dimmed, #6e7681)",
			accent: "var(--dsw-alias-label-accent, #58a6ff)",
			ok: "#3fb950",
			warn: "#d29922",
			err: "#f85149",
		};

		var MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

		/** Marker the seat rule keys on; carried by the view root. */
		var ROOT_ATTR = "data-llm-trace-root";

		/**
		 * Hide the resident composer while this view is mounted, the way the Context
		 * tab does.
		 *
		 * The composer seat is a sibling of the view area inside the conversation
		 * scroll container, so the shell offers no per-view control over it; a
		 * `:has()` rule keyed on this view's root is the supported lever. The
		 * `:not(:has(...))` guard keeps a pending approval, question, or plan review
		 * visible — those are answers the agent is blocked on, not a chat composer.
		 */
		var SEAT_CSS = [
			"[data-conversation-scroll]:has([" + ROOT_ATTR + "]) > [data-composer-seat]"
				+ ":not(:has([data-approval-key],[data-question-key],[data-plan-review-key])){display:none}",
			"[data-conversation-scroll]:has([" + ROOT_ATTR + "]) ~ [data-width-handle]{display:none}",
		].join("")

		/**
		 * Install the seat stylesheet for the lifetime of the plugin.
		 *
		 * @param ctx - the client plugin context that owns the effect.
		 */
		function installSeatCss(ctx) {
			ctx.effect(function () {
				var tag = document.createElement("style");
				tag.setAttribute("data-dsh-llm-trace", "seat");
				tag.textContent = SEAT_CSS;
				document.head.appendChild(tag);
				return function () {
					tag.remove();
				};
			});
		}

		function num(n) {
			return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
		}

		function bytes(n) {
			if (n === undefined || n === null) return "-";
			if (n < 1024) return n + " B";
			if (n < 1048576) return (n / 1024).toFixed(1) + " KiB";
			return (n / 1048576).toFixed(1) + " MiB";
		}

		function statusColor(status) {
			if (status >= 500) return COLOR.err;
			if (status >= 400) return COLOR.warn;
			if (status >= 200) return COLOR.ok;
			return COLOR.dim;
		}

		function hostPath(url) {
			try {
				var parsed = new URL(url);
				return parsed.host + parsed.pathname;
			} catch (error) {
				return url;
			}
		}

		function elapsed(entry) {
			if (entry.endedAt && entry.startedAt) return entry.endedAt - entry.startedAt + " ms";
			if (entry.headersAt && entry.startedAt) return entry.headersAt - entry.startedAt + " ms+";
			return "…";
		}

		function pretty(text) {
			try {
				return JSON.stringify(JSON.parse(text), null, 2);
			} catch (error) {
				return text;
			}
		}


		/** Read one JSON endpoint, resolving to undefined on any transport failure. */
		function readJson(path) {
			return fetch(path).then(
				function (response) {
					return response.json();
				},
				function () {
					return undefined;
				},
			);
		}

		function pill(text) {
			return react.createElement(
				"span",
				{
					style: {
						display: "inline-block",
						fontSize: 11,
						padding: "1px 7px",
						borderRadius: 999,
						border: "1px solid " + COLOR.line,
						color: COLOR.dim,
						marginRight: 6,
					},
				},
				text,
			);
		}

		function note(text) {
			return react.createElement("div", { style: { color: COLOR.dim, fontSize: 12, margin: "6px 0" } }, text);
		}

		function pre(text) {
			return react.createElement(
				"pre",
				{
					style: {
						background: COLOR.panel,
						border: "1px solid " + COLOR.line,
						borderRadius: 6,
						padding: 10,
						margin: 0,
						whiteSpace: "pre-wrap",
						wordBreak: "break-word",
						fontFamily: MONO,
						fontSize: 12,
						lineHeight: 1.55,
					},
				},
				text,
			);
		}

		function button(label, onClick) {
			return react.createElement(
				"button",
				{
					type: "button",
					onClick: onClick,
					style: {
						background: COLOR.panel,
						border: "1px solid " + COLOR.line,
						color: COLOR.fg,
						borderRadius: 6,
						padding: "3px 9px",
						cursor: "pointer",
						font: "inherit",
						fontSize: 12,
					},
				},
				label,
			);
		}

		function section(title, badge, body) {
			return react.createElement(
				"div",
				{ style: { margin: "0 0 14px" } },
				react.createElement(
					"div",
					{ style: { fontSize: 12, margin: "0 0 5px", color: COLOR.accent, fontWeight: 600 } },
					title,
					badge === undefined ? null : react.createElement("span", { style: { color: COLOR.dim, fontWeight: 400, marginLeft: 6 } }, badge),
				),
				body,
			);
		}

		function headersTable(pairs, t) {
			if (!pairs || !pairs.length) return note(t("note.none"));
			return react.createElement(
				"table",
				{ style: { borderCollapse: "collapse", width: "100%", fontFamily: MONO, fontSize: 12 } },
				react.createElement(
					"tbody",
					null,
					pairs.map(function (pair, index) {
						return react.createElement(
							"tr",
							{ key: index },
							react.createElement(
								"td",
								{ style: { padding: "2px 8px 2px 0", borderBottom: "1px solid " + COLOR.line, color: COLOR.dim, whiteSpace: "nowrap", verticalAlign: "top" } },
								pair[0],
							),
							react.createElement(
								"td",
								{ style: { padding: "2px 0", borderBottom: "1px solid " + COLOR.line, verticalAlign: "top", wordBreak: "break-all" } },
								pair[1],
							),
						);
					}),
				),
			);
		}

		/** One Conversation View tab over the host's captured wire exchanges. */
		function LlmTraceView(props) {
			var t = props.t;
			var sessionId = props.sessionId;

			var entriesState = react.useState([]);
			var entries = entriesState[0];
			var setEntries = entriesState[1];

			var statsState = react.useState(null);
			var stats = statsState[0];
			var setStats = statsState[1];

			var selectedState = react.useState(null);
			var selected = selectedState[0];
			var setSelected = selectedState[1];

			var detailState = react.useState(null);
			var detail = detailState[0];
			var setDetail = detailState[1];

			var tabState = react.useState("resbody");
			var tab = tabState[0];
			var setTab = tabState[1];

			var modeState = react.useState("assembled");
			var mode = modeState[0];
			var setMode = modeState[1];

			var reqModeState = react.useState("tree");
			var reqMode = reqModeState[0];
			var setReqMode = reqModeState[1];

			var sharedState = react.useState(null);
			var shared = sharedState[0];
			var setShared = sharedState[1];

			var expandedState = react.useState(function () { return new Set() });
			var expanded = expandedState[0];
			var setExpanded = expandedState[1];

			var limitsState = react.useState(function () { return new Map() });
			var limits = limitsState[0];
			var setLimits = limitsState[1];

			var queryState = react.useState("");
			var query = queryState[0];
			var setQuery = queryState[1];

			var autoState = react.useState(true);
			var auto = autoState[0];
			var setAuto = autoState[1];

			var copyState = react.useState("");
			var copyLabel = copyState[0];
			var setCopyLabel = copyState[1];

			// The list is session-scoped: the host attributes each captured fetch
			// through llm/stream, so another session's traffic never appears here.
			var listPath = BASE + "/api/list?session=" + encodeURIComponent(sessionId);

			react.useEffect(
				function () {
					var cancelled = false;
					function poll() {
						readJson(listPath).then(function (payload) {
							if (cancelled) return;
							if (payload === undefined) {
								setStats("unreachable");
								return;
							}
							setEntries(payload.entries || []);
							setStats(payload.stats || null);
						});
					}
					poll();
					if (!auto) return undefined;
					var timer = setInterval(poll, 2000);
					return function () {
						cancelled = true;
						clearInterval(timer);
					};
				},
				[listPath, auto],
			);

			// Re-fetch the detail only when the selection or its lifecycle state
			// changes: a captured response body can exceed half a megabyte.
			var selectedSummary = null;
			for (var i = 0; i < entries.length; i++) {
				if (entries[i].id === selected) selectedSummary = entries[i];
			}
			var selectedPhase = selectedSummary === null ? null : selectedSummary.state;

			react.useEffect(
				function () {
					if (selected === null) {
						setDetail(null);
						return undefined;
					}
					var cancelled = false;
					readJson(BASE + "/api/exchange?id=" + encodeURIComponent(selected)).then(function (payload) {
						if (cancelled || payload === undefined || payload.error) return;
						setDetail(payload);
					});
					return function () {
						cancelled = true;
					};
				},
				[selected, selectedPhase],
			);

			react.useEffect(
				function () {
					if (!copyLabel) return undefined;
					var timer = setTimeout(function () {
						setCopyLabel("");
					}, 1200);
					return function () {
						clearTimeout(timer);
					};
				},
				[copyLabel],
			);

			// The shared modules arrive after this plugin is applied; until then both
			// features fall back to the raw view.
			react.useEffect(
				function () {
					if (shared) return undefined;
					var alive = true;
					sharedPromise.then(function (modules) {
						if (alive && modules) setShared(modules);
					});
					return function () {
						alive = false;
					};
				},
				[shared],
			);

			// A different exchange means a different tree, so nothing carries over.
			react.useEffect(
				function () {
					setExpanded(new Set(shared ? [shared.tree.ROOT_PATH] : []));
					setLimits(new Map());
				},
				[selected, shared],
			);

			// Only the tree view pays for parsing and measuring, and only when the
			// body actually parses: a truncated capture is not JSON.
			var parsedBody = react.useMemo(
				function () {
					if (!shared || reqMode !== "tree" || detail === null) return null;
					try {
						return JSON.parse(detail.requestBody || "");
					} catch (error) {
						return null;
					}
				},
				[shared, reqMode, detail],
			);

			var bodySizes = react.useMemo(
				function () {
					return parsedBody === null ? null : shared.tree.measure(parsedBody);
				},
				[shared, parsedBody],
			);

			var treeRows = react.useMemo(
				function () {
					return bodySizes === null ? [] : shared.tree.flatten(parsedBody, expanded, bodySizes, limits);
				},
				[shared, parsedBody, bodySizes, expanded, limits],
			);

			var needle = query.trim().toLowerCase();
			var rows = entries.filter(function (entry) {
				if (!needle) return true;
				return (entry.url + " " + (entry.status === undefined ? "" : entry.status) + " " + entry.method).toLowerCase().indexOf(needle) >= 0;
			});

			function copyBody() {
				if (detail === null) return;
				var text =
					tab === "reqbody"
						? pretty(detail.requestBody || "")
						: tab === "resbody"
							? detail.responseBody || ""
							: JSON.stringify(tab === "reqheaders" ? detail.requestHeaders : detail.responseHeaders, null, 2);
				navigator.clipboard.writeText(text).then(
					function () {
						setCopyLabel(t("action.copied"));
					},
					function () {
						setCopyLabel(t("action.copyFailed"));
					},
				);
			}

			function renderTabs() {
				var defs = [
					["reqbody", t("tab.reqbody"), bytes(detail.requestBodyBytes)],
					["resbody", t("tab.resbody"), bytes(detail.responseBodyBytes)],
					["reqheaders", t("tab.reqheaders"), (detail.requestHeaders || []).length + " " + t("note.headers")],
					["resheaders", t("tab.resheaders"), (detail.responseHeaders || []).length + " " + t("note.headers")],
				];
				return react.createElement(
					"div",
					{ style: { display: "flex", gap: 2, borderBottom: "1px solid " + COLOR.line, padding: "0 6px", flex: "none" } },
					defs.map(function (def) {
						var on = tab === def[0];
						return react.createElement(
							"button",
							{
								key: def[0],
								type: "button",
								onClick: function () {
									setTab(def[0]);
								},
								style: {
									padding: "7px 11px",
									border: 0,
									background: "none",
									color: on ? COLOR.fg : COLOR.dim,
									borderBottom: "2px solid " + (on ? COLOR.accent : "transparent"),
									cursor: "pointer",
									font: "inherit",
									fontSize: 12,
									whiteSpace: "nowrap",
								},
							},
							def[1],
							react.createElement("span", { style: { fontSize: 11, opacity: 0.65, marginLeft: 5 } }, def[2]),
						);
					}),
				);
			}

			function barButton(key, label, onClick) {
				return react.createElement(
					"button",
					{
						key: key,
						type: "button",
						onClick: onClick,
						style: { background: COLOR.panel, border: "1px solid " + COLOR.line, color: COLOR.fg, borderRadius: 6, padding: "3px 9px", cursor: "pointer", font: "inherit", fontSize: 12 },
					},
					label,
				);
			}

			function paneBar(text, options) {
				var opts = options || {};
				var children = [react.createElement("span", { key: "n", style: { flex: 1, minWidth: 140, color: COLOR.dim, fontSize: 12 } }, text)];
				if (opts.tree) {
					children.push(barButton("t", reqMode === "tree" ? t("action.showRawJson") : t("action.showTree"), function () {
						setReqMode(reqMode === "tree" ? "raw" : "tree");
					}));
				}
				if (opts.sse) {
					children.push(barButton("m", mode === "assembled" ? t("action.showRaw") : t("action.showAssembled"), function () {
						setMode(mode === "assembled" ? "raw" : "assembled");
					}));
				}
				children.push(barButton("c", copyLabel || t("action.copy"), copyBody));
				return react.createElement("div", { style: { display: "flex", gap: 8, alignItems: "center", marginBottom: 9, flexWrap: "wrap" } }, children);
			}

			/**
			 * Render the flattened tree.
			 *
			 * Only expanded nodes contributed rows, so a collapsed multi-megabyte
			 * subtree is one element. A capped container emits a `more` row that
			 * raises that container's limit instead of materializing everything.
			 */
			function renderTree() {
				var tree = shared.tree;
				return react.createElement(
					"div",
					{ style: { background: COLOR.panel, border: "1px solid " + COLOR.line, borderRadius: 6, padding: "6px 0", fontSize: 12 } },
					treeRows.map(function (row) {
						var pad = row.depth * 14 + 10;
						if (row.kind === "more") {
							return react.createElement(
								"div",
								{
									key: row.path,
									onClick: function () {
										var next = new Map(limits);
										next.set(row.owner, (limits.get(row.owner) || tree.DEFAULT_CHILD_LIMIT) * 4);
										setLimits(next);
									},
									style: { padding: "1px 10px 1px " + pad + "px", color: COLOR.accent, cursor: "pointer" },
								},
								row.preview,
							);
						}
						var rowChildren = [
							react.createElement("span", { key: "c", style: { color: COLOR.dim, width: 10, flex: "none" } }, row.expandable ? (row.expanded ? "▾" : "▸") : "·"),
							react.createElement("span", { key: "k", style: { flex: "none", maxWidth: "32ch", overflow: "hidden", textOverflow: "ellipsis" } }, row.label),
							react.createElement(
								"span",
								{ key: "v", style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", color: row.kind === "string" ? COLOR.ok : row.kind === "number" ? COLOR.warn : row.kind === "boolean" ? COLOR.accent : COLOR.dim } },
								row.preview,
							),
							react.createElement("span", { key: "s", style: { flex: "none", fontSize: 11, opacity: 0.8, color: COLOR.dim } }, bytes(row.bytes)),
						];
						return react.createElement(
							"div",
							{
								key: row.path,
								"data-path": row.path,
								onClick: row.expandable
									? function () {
										var next = new Set(expanded);
										if (next.has(row.path)) next.delete(row.path);
										else next.add(row.path);
										setExpanded(next);
									}
									: undefined,
								style: { display: "flex", gap: 8, alignItems: "baseline", padding: "1px 10px 1px " + pad + "px", whiteSpace: "nowrap", cursor: row.expandable ? "pointer" : "default" },
							},
							rowChildren,
						);
					}),
				);
			}

			function renderPane() {
				var children = [];
				if (tab === "reqbody") {
					var requestText = detail.requestBody || "";
					children.push(paneBar(num(requestText.length) + " chars" + (detail.requestTruncated ? " · " + t("note.truncated") : ""), { tree: parsedBody !== null }));
					if (parsedBody !== null) {
						children.push(react.createElement("div", { key: "b" }, renderTree()));
					} else {
						if (reqMode === "tree") children.push(note(t("note.notJson")));
						children.push(react.createElement("div", { key: "b" }, pre(requestText ? pretty(requestText) : t("note.empty"))));
					}
					if (detail.requestCaptureError) children.push(note(t("note.captureError") + ": " + detail.requestCaptureError));
				} else if (tab === "resbody") {
					var raw = detail.responseBody || "";
					var isSse = shared.sse.isSseBody(detail.mimeType);
					if (isSse && mode === "assembled") {
						var acc = shared.sse.assembleSse(raw);
						var payloadBytes = acc.reasoning.length + acc.content.length;
						for (var i = 0; i < acc.tools.length; i++) {
							if (acc.tools[i]) payloadBytes += acc.tools[i].name.length + acc.tools[i].args.length;
						}
						var pct = raw.length ? Math.round((payloadBytes * 100) / raw.length * 10) / 10 : 0;
						children.push(paneBar(num(acc.chunks) + " chunks · " + bytes(raw.length) + " raw → " + bytes(payloadBytes) + " payload (" + pct + "%)", { sse: true }));
						if (acc.broken) children.push(note(acc.broken + " " + t("note.broken")));
						if (acc.reasoning) children.push(section(t("sec.reasoning"), bytes(acc.reasoning.length), pre(acc.reasoning)));
						if (acc.content) children.push(section(t("sec.content"), bytes(acc.content.length), pre(acc.content)));
						var toolNodes = [];
						for (var j = 0; j < acc.tools.length; j++) {
							var tool = acc.tools[j];
							if (!tool) continue;
							toolNodes.push(
								react.createElement(
									"div",
									{ key: j, style: { margin: "0 0 10px" } },
									react.createElement("div", { style: { margin: "0 0 4px", color: COLOR.dim, fontSize: 12 } }, pill("index " + j), tool.name || "(unnamed)", tool.id ? " · " + tool.id : ""),
									pre(pretty(tool.args || "")),
								),
							);
						}
						if (toolNodes.length) children.push(section(t("sec.toolCalls"), String(toolNodes.length), react.createElement("div", null, toolNodes)));
						if (acc.usage) children.push(section(t("sec.usage"), undefined, pre(JSON.stringify(acc.usage, null, 2))));
						if (acc.finish) children.push(note(t("note.finish") + ": " + acc.finish + (acc.done ? " · " + t("note.done") : "")));
						if (!acc.reasoning && !acc.content && !toolNodes.length && !acc.usage) children.push(note(t("note.noDelta")));
					} else {
						children.push(paneBar(num(raw.length) + " chars" + (detail.responseTruncated ? " · " + t("note.truncated") : ""), { sse: isSse }));
						children.push(react.createElement("div", { key: "b" }, pre(raw || t("note.empty"))));
					}
					if (detail.responseCaptureError) children.push(note(t("note.captureError") + ": " + detail.responseCaptureError));
				} else if (tab === "reqheaders") {
					children.push(paneBar((detail.requestHeaders || []).length + " " + t("note.headers"), {}));
					children.push(react.createElement("div", { key: "h" }, headersTable(detail.requestHeaders, t)));
				} else {
					children.push(paneBar((detail.responseHeaders || []).length + " " + t("note.headers"), {}));
					children.push(react.createElement("div", { key: "h" }, headersTable(detail.responseHeaders, t)));
				}
				children.push(note(t("note.secrets")));
				return react.createElement(
					"div",
					{ style: { flex: 1, minHeight: 0, overflow: "auto", padding: "11px 14px" } },
					children.map(function (child, index) {
						return react.cloneElement(child, { key: child.key === null ? "s" + index : child.key });
					}),
				);
			}

			function renderDetail() {
				if (detail === null) {
					return react.createElement(
						"div",
						{ style: { flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: COLOR.dim } },
						t("empty.detail"),
					);
				}
				return react.createElement(
					"div",
					{ style: { flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 } },
					react.createElement(
						"div",
						{ style: { flex: "none", padding: "9px 14px", borderBottom: "1px solid " + COLOR.line, fontSize: 12, color: COLOR.dim, wordBreak: "break-all" } },
						react.createElement("span", { style: { color: COLOR.fg, fontWeight: 600 } }, detail.method),
						" " + detail.url + " · ",
						react.createElement("span", { style: { color: statusColor(detail.status) } }, String(detail.status === undefined ? detail.state : detail.status)),
						" · " + elapsed(detail) + " · " + (detail.mimeType || "-"),
					),
					renderTabs(),
					renderPane(),
				);
			}

			var listChildren = [];
			if (!rows.length) {
				listChildren.push(
					react.createElement("div", { key: "e", style: { color: COLOR.dim, padding: 24, textAlign: "center" } }, t("empty.list")),
				);
			}
			for (var r = 0; r < rows.length; r++) {
				(function (entry) {
					var on = entry.id === selected;
					listChildren.push(
						react.createElement(
							"div",
							{
								key: entry.id,
								"data-exchange": entry.id,
								onClick: function () {
									setSelected(entry.id);
									setDetail(null);
								},
								style: {
									padding: on ? "8px 14px 8px 11px" : "8px 14px",
									borderBottom: "1px solid " + COLOR.line,
									borderLeft: "3px solid " + (on ? COLOR.accent : "transparent"),
									cursor: "pointer",
									background: on ? COLOR.hover : "transparent",
								},
							},
							react.createElement("div", { style: { wordBreak: "break-all" } }, hostPath(entry.url)),
							react.createElement(
								"div",
								{ style: { color: COLOR.dim, fontSize: 12, display: "flex", gap: 10, flexWrap: "wrap", marginTop: 2 } },
								react.createElement("span", null, entry.method),
								react.createElement("span", { style: { color: statusColor(entry.status) } }, String(entry.status === undefined ? entry.state : entry.status)),
								react.createElement("span", null, elapsed(entry)),
								react.createElement("span", null, "in " + bytes(entry.requestBodyBytes)),
								react.createElement("span", null, "out " + bytes(entry.responseBodyBytes)),
							),
						),
					);
				})(rows[r]);
			}

			return react.createElement(
				"div",
				{
					// The seat rule in SEAT_CSS keys on this attribute.
					[ROOT_ATTR]: "",
					style: {
						// Out of flow on purpose. The shell's view area carries
						// `min-height: auto`, so an in-flow view sizes to its content and
						// pushes the shell's own scroll body past the viewport — which
						// scrolls both panes together instead of letting each pane scroll
						// itself. Absolute positioning takes this view out of that
						// intrinsic-size chain and fills the nearest positioned ancestor.
						position: "absolute",
						inset: 0,
						display: "flex",
						flexDirection: "column",
						minHeight: 0,
						overflow: "hidden",
						color: COLOR.fg,
						fontFamily: MONO,
						fontSize: 13,
					},
				},
				react.createElement(
					"div",
					{ style: { flex: "none", display: "flex", gap: 10, alignItems: "center", padding: "8px 14px", borderBottom: "1px solid " + COLOR.line, flexWrap: "wrap" } },
					react.createElement("input", {
						type: "search",
						value: query,
						placeholder: t("filter"),
						onChange: function (event) {
							setQuery(event.target.value);
						},
						style: { background: COLOR.panel, border: "1px solid " + COLOR.line, color: COLOR.fg, borderRadius: 6, padding: "4px 9px", minWidth: 180, font: "inherit", fontSize: 12 },
					}),
					react.createElement(
						"label",
						{ style: { color: COLOR.dim, display: "flex", gap: 5, alignItems: "center", cursor: "pointer", fontSize: 12 } },
						react.createElement("input", {
							type: "checkbox",
							checked: auto,
							onChange: function (event) {
								setAuto(event.target.checked);
							},
						}),
						t("auto"),
					),
					button(t("refresh"), function () {
						readJson(listPath).then(function (payload) {
							if (payload === undefined) {
								setStats("unreachable");
								return;
							}
							setEntries(payload.entries || []);
							setStats(payload.stats || null);
						});
					}),
					react.createElement(
						"span",
						{ style: { color: COLOR.dim, fontSize: 12 } },
						stats === "unreachable" || stats === null
							? stats === "unreachable"
								? t("unreachable")
								: ""
							: stats.count + " / " + stats.maxRetained + " · " + bytes(stats.retainedBytes) + " / " + bytes(stats.maxJournalBytes),
					),
				),
				react.createElement(
					"div",
					{ style: { flex: 1, minHeight: 0, display: "flex" } },
					react.createElement("div", { style: { width: "34%", minWidth: 260, minHeight: 0, overflow: "auto", borderRight: "1px solid " + COLOR.line } }, listChildren),
					renderDetail(),
				),
			);
		}

		function apply(ctx) {
			ctx.effect(function () {
				return ctx.locale.register(NS, { en: DICT_EN, zh: DICT_ZH });
			});
			installSeatCss(ctx);
			var t = ctx.locale.bind(NS);
			ctx.slots.inject("conversation.view", function () {
				return ctx.slots.register(
					{
						name: "conversation.view",
						id: "llm-trace",
						order: 30,
						locale: NS,
						label: function () {
							return t("tab");
						},
					},
					LlmTraceView,
				);
			});
		}

		module.exports = { name: NS, inject: ["slots", "locale"], apply };
		return module.exports;
	},
});
