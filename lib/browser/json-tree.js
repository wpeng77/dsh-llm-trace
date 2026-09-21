/**
 * Shared JSON-tree logic for both dsh-llm-trace browser faces.
 *
 * The viewer document (`lib/page.html`, plain DOM) and the Conversation View
 * bundle (`lib/client.js`, React) render differently but must agree on what a
 * tree row is, how big a node is, and what a node previews as. That agreement
 * lives here as one ES module the host serves and both faces `import()`, so
 * neither duplicates the other.
 *
 * Nothing here touches the DOM: `flatten` turns a parsed value plus an expansion
 * set into a flat row list, and each face maps those rows to its own elements.
 * Flattening only walks expanded nodes, which is what keeps a multi-megabyte
 * request body from materializing tens of thousands of rows at once.
 *
 * @module dsh-llm-trace/json-tree
 */

/** Path of the root node; also the key that expands it. */
export const ROOT_PATH = ''

/** Children rendered for one container before a `more` row takes over. */
export const DEFAULT_CHILD_LIMIT = 500

/** Longest preview text kept for one leaf. */
const PREVIEW_CHARS = 72

/** Longest value shown as a container's field hint. */
const HINT_CHARS = 40

/** UTF-8 byte length of a string, counted without allocating an encoded copy. */
export function utf8Length(text) {
  let total = 0
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code < 0x80) total += 1
    else if (code < 0x800) total += 2
    else if (code >= 0xd800 && code <= 0xdbff) {
      total += 4
      index++
    } else total += 3
  }
  return total
}

/** Whether a parsed value has children to expand. */
export function isContainer(value) {
  return value !== null && typeof value === 'object'
}

/** Number of children a container holds; 0 for a leaf. */
export function childCount(value) {
  if (Array.isArray(value)) return value.length
  if (isContainer(value)) return Object.keys(value).length
  return 0
}

/** The kind tag a row carries, used to pick styling and whether it expands. */
export function kindOf(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  const type = typeof value
  if (type === 'object') return 'object'
  if (type === 'string') return 'string'
  if (type === 'number') return 'number'
  if (type === 'boolean') return 'boolean'
  return 'unknown'
}

/** Append one path segment, escaping the JSON-Pointer metacharacters. */
export function joinPath(parent, segment) {
  return `${parent}/${String(segment).replace(/~/g, '~0').replace(/\//g, '~1')}`
}

/**
 * Serialized byte size of every container in a parsed value.
 *
 * One bottom-up pass, memoized by node identity: the parsed tree's containers are
 * unique objects, so each is measured once. Sizes are the compact form, which is
 * what a provider receives; the root's size therefore equals the request body's
 * byte length for a body this viewer captured from `JSON.stringify`.
 *
 * @param root - the parsed JSON value.
 * @returns sizes for containers, plus the root's own size under {@link ROOT_PATH}.
 */
export function measure(root) {
  const sizes = new Map()
  sizes.set(ROOT_PATH, measureNode(root, ROOT_PATH, sizes))
  return sizes
}

function measureNode(value, path, sizes) {
  if (!isContainer(value)) {
    if (value === undefined) return 0
    return utf8Length(JSON.stringify(value) ?? 'null')
  }
  if (sizes.has(path) && path !== ROOT_PATH) return sizes.get(path)
  let total = 2
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (index > 0) total += 1
      total += measureNode(value[index], joinPath(path, index), sizes)
    }
  } else {
    const keys = Object.keys(value)
    for (let index = 0; index < keys.length; index++) {
      if (index > 0) total += 1
      const key = keys[index]
      total += utf8Length(JSON.stringify(key)) + 1
      total += measureNode(value[key], joinPath(path, key), sizes)
    }
  }
  sizes.set(path, total)
  return total
}

/** Serialized size of one node, whether or not {@link measure} retained it. */
function sizeAt(value, path, sizes) {
  const known = sizes.get(path)
  if (known !== undefined) return known
  if (!isContainer(value)) return value === undefined ? 0 : utf8Length(JSON.stringify(value) ?? 'null')
  return measureNode(value, path, sizes)
}

/** Cut a preview to its budget, marking that text was dropped. */
function clip(text, budget) {
  return text.length > budget ? `${text.slice(0, budget - 1)}…` : text
}

/**
 * One generic line describing a node.
 *
 * Containers get their child count; an object also gets a hint naming its first
 * short string field, which is what makes a collapsed message read as
 * `Object(2) · role: "system"` rather than an opaque size. The hint is chosen by
 * position, not by key name, so it stays honest for shapes this plugin has never
 * seen.
 */
export function previewOf(value) {
  const kind = kindOf(value)
  if (kind === 'array') return `Array(${value.length})`
  if (kind === 'object') {
    const keys = Object.keys(value)
    const hint = firstStringHint(value, keys)
    return hint === undefined ? `Object(${keys.length})` : `Object(${keys.length}) · ${hint}`
  }
  if (kind === 'string') return clip(JSON.stringify(value), PREVIEW_CHARS)
  if (kind === 'null') return 'null'
  return String(value)
}

/** `key: "value"` for the first short string field, or undefined when there is none. */
function firstStringHint(value, keys) {
  for (const key of keys) {
    const field = value[key]
    if (typeof field !== 'string' || field.length === 0 || field.length > HINT_CHARS) continue
    return `${key}: ${clip(JSON.stringify(field), HINT_CHARS + 2)}`
  }
  return undefined
}

/** The label a row shows: an object key, or a bracketed array index. */
function labelFor(parent, key) {
  return Array.isArray(parent) ? `[${key}]` : String(key)
}

/**
 * Flatten the visible tree into rows.
 *
 * Only expanded containers contribute their children, so a collapsed
 * multi-megabyte subtree costs one row. A container with more children than its
 * limit emits a trailing `more` row instead of the rest, which bounds what one
 * expansion can materialize.
 *
 * @param root - the parsed JSON value.
 * @param expanded - paths whose children are rendered.
 * @param sizes - the map {@link measure} returned.
 * @param limits - per-path child limits; absent paths use `defaultLimit`.
 * @param defaultLimit - child limit applied to a path absent from `limits`.
 * @returns the visible rows, in render order.
 */
export function flatten(root, expanded, sizes, limits = new Map(), defaultLimit = DEFAULT_CHILD_LIMIT) {
  const rows = []
  walk(root, ROOT_PATH, 'root', 0, rows, expanded, sizes, limits, defaultLimit)
  return rows
}

function walk(value, path, label, depth, rows, expandedSet, sizes, limits, defaultLimit) {
  const container = isContainer(value)
  const total = childCount(value)
  rows.push({
    path,
    depth,
    kind: kindOf(value),
    label,
    preview: previewOf(value),
    bytes: sizeAt(value, path, sizes),
    childCount: total,
    expandable: total > 0,
    expanded: container && expandedSet.has(path),
  })
  if (!container || !expandedSet.has(path)) return
  const shown = Math.min(total, limits.get(path) ?? defaultLimit)
  const keys = Array.isArray(value) ? undefined : Object.keys(value)
  for (let index = 0; index < shown; index++) {
    const key = keys === undefined ? index : keys[index]
    walk(value[key], joinPath(path, key), labelFor(value, key), depth + 1, rows, expandedSet, sizes, limits, defaultLimit)
  }
  if (total > shown) {
    rows.push({
      path: `${path}\u0000more`,
      depth: depth + 1,
      kind: 'more',
      label: '',
      preview: `${total - shown} more`,
      bytes: 0,
      childCount: total - shown,
      expandable: false,
      expanded: false,
      owner: path,
      hidden: total - shown,
    })
  }
}
