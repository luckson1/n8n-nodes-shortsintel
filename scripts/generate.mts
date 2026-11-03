/**
 * Generates the n8n node's operation table and UI properties from the shared
 * module list:
 *
 *   integrations/modules.json  +  apps/web/public/openapi.v1.json
 *     -> integrations/n8n/nodes/ShortsIntel/operations.json      (request mapping, read at run time)
 *     -> integrations/n8n/nodes/ShortsIntel/OperationsDescription.ts (node properties, linted by n8n-node lint)
 *
 * Fields come from each OpenAPI operation; the n8n-only choices (resource names,
 * operation names) live in N8N below. Do not hand-edit the generated files; change
 * modules.json or this script and regenerate.
 *
 * Run from the repo root:
 *   pnpm dlx tsx integrations/n8n/scripts/generate.mts           # write both files
 *   pnpm dlx tsx integrations/n8n/scripts/generate.mts --check   # exit 1 if either is stale
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
interface ParamOverride {
  label?: string;
  help?: string;
  options?: string;
  multiple?: boolean;
}
interface ModuleDef {
  key: string;
  kind: "action" | "search" | "instant_trigger" | "universal";
  method?: Method;
  path?: string;
  label: string;
  description: string;
  params?: Record<string, ParamOverride>;
  container?: string;
  cursor?: string;
  poll?: {
    statusField: string;
    while: string;
    delayMs: number;
    maxAttempts: number;
  };
  event?: string;
  attach?: { method: Method; path: string; idField: string };
  detach?: { method: Method; path: string };
  filters?: Record<string, ParamOverride>;
}
interface OptionSource {
  method: Method;
  path: string;
  container: string;
  cursor: string;
  label: string;
  value: string;
}
interface ModulesFile {
  baseUrl: string;
  openapi: string;
  connection: {
    header: string;
    scheme: string;
    test: { method: Method; path: string };
  };
  optionSources: Record<string, OptionSource>;
  groups: { label: string; modules: string[] }[];
  modules: ModuleDef[];
}
type Schema = Record<string, any>;

/** modules.json group label -> n8n resource. */
const RESOURCES: Record<string, { value: string; name: string }> = {
  Research: { value: "research", name: "Research" },
  Videos: { value: "video", name: "Video" },
  Lookups: { value: "lookup", name: "Lookup" },
  Ads: { value: "ad", name: "Ad" },
  Trackers: { value: "tracker", name: "Tracker" },
  Collections: { value: "collection", name: "Collection" },
  Runs: { value: "run", name: "Run" },
  Account: { value: "account", name: "Account" },
  Other: { value: "apiCall", name: "API Call" },
};

/**
 * n8n-only decisions per module: the operation name shown in the picker (title
 * case, n8n verbs). The action text is the module label from modules.json. The
 * instant trigger is built as its own trigger node.
 */
const N8N: Record<
  string,
  { type: "operation"; name: string } | { type: "trigger" }
> = {
  createResearch: { type: "operation", name: "Research a Niche" },
  searchVideos: { type: "operation", name: "Search" },
  lookupVideo: { type: "operation", name: "Look Up" },
  analyzeVideo: { type: "operation", name: "Analyse" },
  getCreator: { type: "operation", name: "Get Creator" },
  getHashtag: { type: "operation", name: "Get Hashtag" },
  getSound: { type: "operation", name: "Get Sound" },
  getKeyword: { type: "operation", name: "Get Keyword" },
  searchAds: { type: "operation", name: "Search" },
  getMetaAd: { type: "operation", name: "Get Meta Ad" },
  getTikTokAd: { type: "operation", name: "Get TikTok Ad" },
  watchTrackerChanges: { type: "trigger" },
  createTracker: { type: "operation", name: "Create" },
  listTrackers: { type: "operation", name: "Get Many" },
  getTracker: { type: "operation", name: "Get" },
  listTrackerChanges: { type: "operation", name: "Get Changes" },
  updateTracker: { type: "operation", name: "Update" },
  createCollection: { type: "operation", name: "Create" },
  addCollectionMember: { type: "operation", name: "Add Tracker" },
  listCollections: { type: "operation", name: "Get Many" },
  getRun: { type: "operation", name: "Get" },
  waitForRun: { type: "operation", name: "Wait" },
  getBalance: { type: "operation", name: "Get Balance" },
  makeApiCall: { type: "operation", name: "Make" },
};

/** Option source -> loadOptions method on both nodes. */
const loadMethod = (source: string) =>
  `get${source.charAt(0).toUpperCase()}${source.slice(1)}`;

/** Default for `wait` on Run-starting operations. n8n has no step time limit. */
const DEFAULT_WAIT_SECONDS = 20;

const DYNAMIC_ONE =
  'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>';
const DYNAMIC_MANY =
  'Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>';

const here = dirname(fileURLToPath(import.meta.url));
const n8nDir = resolve(here, "..");
const nodeDir = join(n8nDir, "nodes", "ShortsIntel");
const opsFile = join(nodeDir, "operations.json");
const propsFile = join(nodeDir, "OperationsDescription.ts");
const repoRoot = resolve(n8nDir, "..", "..");

const spec = JSON.parse(
  readFileSync(join(repoRoot, "integrations", "modules.json"), "utf8"),
) as ModulesFile;
const openapi = JSON.parse(
  readFileSync(join(repoRoot, spec.openapi), "utf8"),
) as Schema;
const SITE = new URL(spec.baseUrl).origin;

// ---------------------------------------------------------------- schema helpers

function deref(s: Schema | undefined, seen = 0): Schema {
  if (!s) return {};
  if (s.$ref && seen < 20) {
    let o: any = openapi;
    for (const p of (s.$ref as string).replace(/^#\//, "").split("/")) o = o[p];
    return deref(o, seen + 1);
  }
  return s;
}

/** Collapses oneOf/anyOf/allOf and nullable type arrays into one schema. */
function flatten(input: Schema | undefined): Schema {
  const s = deref(input);
  const members = (s.oneOf ?? s.anyOf ?? s.allOf) as Schema[] | undefined;
  if (members) {
    const flat = members.map(flatten).filter((m) => m.type !== "null");
    if (flat.length === 1)
      return { ...flat[0], description: s.description ?? flat[0]!.description };
    if (flat.every((m) => m.type === "object" || m.properties)) {
      const properties: Record<string, Schema> = {};
      for (const m of flat) Object.assign(properties, m.properties ?? {});
      return {
        type: "object",
        properties,
        required: s.allOf ? flat.flatMap((m) => m.required ?? []) : [],
        description: s.description,
      };
    }
    return { ...flat[0], description: s.description ?? flat[0]?.description };
  }
  if (Array.isArray(s.type)) {
    const t = (s.type as string[]).filter((x) => x !== "null");
    return { ...s, type: t[0] };
  }
  return s;
}

const WORDS: Record<string, string> = {
  id: "ID",
  ids: "IDs",
  url: "URL",
  urls: "URLs",
  tiktok: "TikTok",
  youtube: "YouTube",
  instagram: "Instagram",
  facebook: "Facebook",
  meta: "Meta",
  intelligence: "Analysis",
  analyze: "Analysis",
};

/** Title Case, as n8n's linter wants for display names. */
const SMALL = new Set(["a", "an", "and", "by", "for", "in", "of", "on", "or", "the", "to"]);
function titleCase(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w, i) => {
      const known = WORDS[w.toLowerCase()];
      if (known) return known;
      if (i > 0 && SMALL.has(w.toLowerCase())) return w.toLowerCase();
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
}

function camel(name: string): string {
  const parts = name.split(/[_.\s-]+/).filter(Boolean);
  return parts
    .map((p, i) => (i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join("");
}

/** Customer-facing copy rules: no em dashes, analysis not Intelligence. */
function cleanText(text: string | undefined): string | undefined {
  if (!text) return undefined;
  return text
    .replace(/\s*—\s*/g, ", ")
    .replace(/\s*–\s*/g, " to ")
    .replace(/`intelligence`/g, "analysis")
    .replace(/\bIntelligence\b/g, "Analysis")
    .replace(/\bintelligence\b/g, "analysis")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .trim();
}

/** n8n's linter: one sentence has no final period, several end with one. */
function sentences(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const t = text.trim();
  const multi = /[.!?]\s+\S/.test(t.replace(/\b(e\.g|i\.e|etc)\./g, "$1"));
  if (multi) return /[.!?]$/.test(t) ? t : `${t}.`;
  return t.replace(/\.$/, "");
}

function operation(method: Method, path: string): Schema {
  const op = openapi.paths?.[path]?.[method.toLowerCase()];
  if (!op)
    throw new Error(
      `${method} ${path} is not in ${spec.openapi}. Run integrations/scripts/check-modules.ts.`,
    );
  return op as Schema;
}

// ---------------------------------------------------------------- fields

type Prop = Record<string, unknown>;
/** How the node puts a value on the request. `api` is dotted for nested body fields. */
interface ParamMap {
  name: string;
  api: string;
  in: "path" | "query" | "body";
  type: "string" | "number" | "boolean" | "options" | "multiOptions";
  list?: boolean;
  additional?: boolean;
}

/** Never shown: paging is the node's job, idempotency keys are per call. */
const HIDDEN = new Set(["cursor", "Idempotency-Key"]);

const BOOLEAN_HELP: Record<string, string> = {
  estimate:
    "Whether to return a price quote instead of doing the work. Spends no Credits.",
  refresh: "Whether to recompute even when a current version is stored",
};

function lowerFirst(s: string) {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function optionList(values: unknown[]) {
  return values
    .map((v) => ({ name: WORDS[String(v)] ?? titleCase(String(v)), value: String(v) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function field(
  name: string,
  apiName: string,
  raw: Schema,
  required: boolean,
  show: Prop | undefined,
  override: ParamOverride = {},
): { prop: Prop; map: Omit<ParamMap, "in" | "api"> } {
  const s = flatten(raw);
  let displayName = override.label
    ? override.label.replace(/(^|\s)(\S)(\S*)/g, (_m, sp: string, c: string, rest: string) =>
        sp && SMALL.has(`${c}${rest}`.toLowerCase()) ? `${sp}${c}${rest}` : `${sp}${c.toUpperCase()}${rest}`,
      )
    : titleCase(apiName);
  let description = cleanText(override.help ?? s.description);
  const prop: Prop = { displayName, name };
  let type: ParamMap["type"];
  let list = false;
  if (override.options) {
    const multi = Boolean(override.multiple) || s.type === "array";
    type = multi ? "multiOptions" : "options";
    displayName = `${displayName.replace(/ IDs?$/, "")} ${multi ? "Names or IDs" : "Name or ID"}`;
    prop.displayName = displayName;
    prop.type = type;
    prop.typeOptions = { loadOptionsMethod: loadMethod(override.options) };
    prop.default = multi ? [] : "";
    description = multi ? DYNAMIC_MANY : DYNAMIC_ONE;
  } else if (s.type === "array") {
    const items = flatten(s.items);
    if (items.enum) {
      type = "multiOptions";
      prop.type = type;
      prop.options = optionList(items.enum);
      prop.default = [];
    } else {
      type = "string";
      list = true;
      prop.type = "string";
      prop.default = "";
      description = description
        ? `Comma-separated. ${description}`
        : "Comma-separated list";
    }
  } else if (s.enum) {
    type = "options";
    prop.type = type;
    prop.options = optionList(s.enum);
    prop.default =
      s.default !== undefined && s.enum.includes(s.default)
        ? String(s.default)
        : s.enum.includes("false")
          ? "false"
          : String(s.enum[0]);
  } else if (s.type === "integer" || s.type === "number") {
    type = "number";
    prop.type = "number";
    const typeOptions: Prop = {};
    if (typeof s.minimum === "number") typeOptions.minValue = s.minimum;
    if (typeof s.maximum === "number") typeOptions.maxValue = s.maximum;
    if (s.type === "integer") typeOptions.numberPrecision = 0;
    if (Object.keys(typeOptions).length) prop.typeOptions = typeOptions;
    prop.default =
      apiName === "wait"
        ? Math.min(DEFAULT_WAIT_SECONDS, s.maximum ?? DEFAULT_WAIT_SECONDS)
        : typeof s.default === "number"
          ? s.default
          : /\bdefault (\d+)/i.test(String(s.description ?? ""))
            ? Number(/\bdefault (\d+)/i.exec(String(s.description))![1])
            : typeof s.minimum === "number"
            ? s.minimum
            : 0;
  } else if (s.type === "boolean") {
    type = "boolean";
    prop.type = "boolean";
    prop.default = typeof s.default === "boolean" && apiName !== "estimate" ? s.default : false;
    const lead =
      BOOLEAN_HELP[apiName] ??
      `Whether to ${lowerFirst(override.label ?? titleCase(apiName))}`;
    description =
      description && !BOOLEAN_HELP[apiName] ? `${lead}. ${description}` : lead;
  } else {
    type = "string";
    prop.type = "string";
    prop.default = typeof s.default === "string" ? s.default : "";
    if ((s.maxLength ?? 0) > 300) prop.typeOptions = { rows: 3 };
  }
  if (apiName === "wait")
    description = `Seconds to wait for the result before the step returns the Run. If the Run is still running, follow with Run > Wait.${description ? ` ${description}` : ""}`;
  description = sentences(description);
  if (
    description &&
    description.toLowerCase() !== displayName.toLowerCase()
  )
    prop.description = description;
  if (required) prop.required = true;
  if (show) prop.displayOptions = { show };
  return { prop, map: { name, type, ...(list ? { list: true } : {}) } };
}

/** Inputs for one operation: required fields first, the rest in Additional Fields. */
function operationInputs(
  op: Schema,
  path: string,
  overrides: Record<string, ParamOverride>,
  drop: string[],
  show: Prop,
) {
  const item = openapi.paths[path] as Schema;
  const declared = [...(item.parameters ?? []), ...(op.parameters ?? [])].map(
    deref,
  ) as Schema[];
  const body = flatten(
    deref(op.requestBody).content?.["application/json"]?.schema,
  );
  const skip = new Set([...HIDDEN, ...drop]);
  const bodyNames = Object.keys(body.properties ?? {}).filter(
    (n) => !skip.has(n),
  );
  const top: Prop[] = [];
  const extra: Prop[] = [];
  const params: ParamMap[] = [];
  const add = (
    apiName: string,
    where: ParamMap["in"],
    raw: Schema,
    required: boolean,
    o?: ParamOverride,
  ) => {
    const leaf = apiName.split(".").pop()!;
    // A body `limit` on a non-list operation is not n8n's Return All / Limit pair.
    let name = camel(apiName);
    if (name === "limit") name = "maxResults";
    const isTop = required || where === "path";
    const label =
      o?.label ??
      (apiName.includes(".")
        ? `${titleCase(apiName.split(".")[0]!)} ${titleCase(leaf)}`
        : name === "maxResults"
          ? "Max Results"
          : undefined);
    const r = field(name, leaf, raw, isTop, isTop ? show : undefined, {
      ...o,
      ...(label ? { label } : {}),
    });
    (isTop ? top : extra).push(r.prop);
    params.push({
      ...r.map,
      api: apiName,
      in: where,
      ...(isTop ? {} : { additional: true }),
    });
  };

  for (const p of declared.filter((p) => p.in === "path"))
    add(p.name, "path", { ...deref(p.schema), description: p.description }, true, overrides[p.name]);
  // A query parameter the body also accepts (`wait`, `estimate`) is sent once, in the body.
  for (const p of declared.filter(
    (p) => p.in === "query" && !bodyNames.includes(p.name) && !skip.has(p.name),
  ))
    add(p.name, "query", { ...deref(p.schema), description: p.description }, Boolean(p.required), overrides[p.name]);

  const required = new Set<string>(body.required ?? []);
  const queryTwin = (n: string) =>
    declared.find((p) => p.in === "query" && p.name === n);
  for (const n of bodyNames) {
    const ps = flatten(body.properties[n]);
    if ((ps.type === "object" || ps.properties) && ps.properties) {
      const childRequired = new Set<string>(ps.required ?? []);
      for (const [c, cs] of Object.entries(ps.properties as Record<string, Schema>)) {
        add(`${n}.${c}`, "body", cs, required.has(n) && childRequired.has(c), {
          help: c === "text" ? (overrides[n]?.help ?? ps.description) : undefined,
        });
      }
      continue;
    }
    const twin = queryTwin(n);
    const raw =
      !deref(body.properties[n]).description && twin?.description
        ? { ...deref(body.properties[n]), description: twin.description }
        : body.properties[n];
    add(n, "body", raw, required.has(n), overrides[n]);
  }

  const properties = [...top];
  if (extra.length)
    properties.push({
      displayName: "Additional Fields",
      name: "additionalFields",
      type: "collection",
      placeholder: "Add Field",
      default: {},
      displayOptions: { show },
      options: extra.sort((a, b) =>
        String(a.displayName).localeCompare(String(b.displayName)),
      ),
    });
  return { properties, params };
}

// ---------------------------------------------------------------- build

const moduleGroup = new Map<string, string>();
for (const g of spec.groups) for (const k of g.modules) moduleGroup.set(k, g.label);

const operations: Record<string, unknown>[] = [];
const fieldProps: Prop[] = [];
const byResource = new Map<string, { name: string; value: string; action: string; description: string }[]>();
let trigger: Record<string, unknown> | undefined;

for (const m of spec.modules) {
  const n = N8N[m.key];
  if (!n)
    throw new Error(`module ${m.key} has no n8n mapping in integrations/n8n/scripts/generate.mts`);
  if (n.type === "trigger") {
    trigger = {
      module: m.key,
      event: m.event,
      subscribe: { method: m.attach!.method, path: m.attach!.path, idField: m.attach!.idField },
      unsubscribe: { method: m.detach!.method, path: m.detach!.path },
      list: { method: "GET", path: "/trackers/{id}/changes" },
      label: m.label,
      description: m.description,
      filters: Object.entries(m.filters ?? {}).map(([name, o]) => ({
        name,
        label: o.label ?? titleCase(name),
        help: cleanText(o.help),
        options: o.options,
      })),
    };
    continue;
  }
  const group = moduleGroup.get(m.key);
  const resource = group ? RESOURCES[group] : undefined;
  if (!resource) throw new Error(`module ${m.key}: group ${group} has no n8n resource`);
  const list = byResource.get(resource.value) ?? [];
  list.push({
    name: n.name,
    value: m.key,
    action: m.label,
    description: sentences(cleanText(m.description))!,
  });
  byResource.set(resource.value, list);
  const show = { resource: [resource.value], operation: [m.key] };

  if (m.kind === "universal") {
    operations.push({ resource: resource.value, operation: m.key, module: m.key, universal: true, params: [] });
    fieldProps.push(
      {
        displayName: "Method",
        name: "method",
        type: "options",
        options: ["DELETE", "GET", "PATCH", "POST", "PUT"].map((v) => ({ name: v, value: v })),
        default: "GET",
        displayOptions: { show },
      },
      {
        displayName: "Path",
        name: "path",
        type: "string",
        required: true,
        default: "",
        placeholder: (m as Schema).examplePath ?? "/v1/account/balance",
        description: `Path under ${spec.baseUrl}, with or without the leading /v1. See ${SITE}/docs/reference.`,
        displayOptions: { show },
      },
      {
        displayName: "Query Parameters",
        name: "query",
        type: "fixedCollection",
        typeOptions: { multipleValues: true },
        placeholder: "Add Parameter",
        default: {},
        displayOptions: { show },
        options: [
          {
            displayName: "Parameter",
            name: "parameter",
            values: [
              { displayName: "Name", name: "name", type: "string", default: "" },
              { displayName: "Value", name: "value", type: "string", default: "" },
            ],
          },
        ],
      },
      {
        displayName: "Body",
        name: "body",
        type: "json",
        required: true,
        default: "{}",
        description: "JSON body for POST, PUT and PATCH",
        displayOptions: { show: { ...show, method: ["PATCH", "POST", "PUT"] } },
      },
    );
    continue;
  }

  const op = operation(m.method!, m.path!);
  const isList = Boolean(m.container);
  const { properties, params } = operationInputs(op, m.path!, m.params ?? {}, isList ? ["limit"] : [], show);
  if (isList)
    properties.push(
      {
        displayName: "Return All",
        name: "returnAll",
        type: "boolean",
        default: false,
        description: "Whether to return all results or only up to a given limit",
        displayOptions: { show },
      },
      {
        displayName: "Limit",
        name: "limit",
        type: "number",
        typeOptions: { minValue: 1 },
        default: 50,
        description: "Max number of results to return",
        displayOptions: { show: { ...show, returnAll: [false] } },
      },
    );
  fieldProps.push(...properties);
  const entry: Record<string, unknown> = {
    resource: resource.value,
    operation: m.key,
    module: m.key,
    method: m.method,
    path: m.path,
    params,
  };
  if (m.container) {
    entry.container = m.container;
    entry.cursor = m.cursor;
  }
  if (m.poll) entry.poll = m.poll;
  operations.push(entry);
}

for (const k of Object.keys(N8N))
  if (!spec.modules.some((m) => m.key === k))
    throw new Error(`N8N maps ${k}, which is not in modules.json`);
if (!trigger) throw new Error("modules.json has no instant trigger for the n8n trigger node");

const resources = [...new Set(operations.map((o) => o.resource as string))].map(
  (v) => Object.values(RESOURCES).find((r) => r.value === v)!,
);
const resourceProp: Prop = {
  displayName: "Resource",
  name: "resource",
  type: "options",
  noDataExpression: true,
  options: [...resources].sort((a, b) => a.name.localeCompare(b.name)),
  default: resources[0]!.value,
};
const operationProps: Prop[] = resources.map((r) => {
  const opts = [...byResource.get(r.value)!].sort((a, b) => a.name.localeCompare(b.name));
  return {
    displayName: "Operation",
    name: "operation",
    type: "options",
    noDataExpression: true,
    displayOptions: { show: { resource: [r.value] } },
    options: opts,
    default: opts[0]!.value,
  };
});

const optionSources = Object.fromEntries(
  Object.entries(spec.optionSources).map(([name, src]) => [
    name,
    { ...src, method: src.method, loadOptionsMethod: loadMethod(name) },
  ]),
);

const table = {
  $comment:
    "Generated by integrations/n8n/scripts/generate.mts from integrations/modules.json and apps/web/public/openapi.v1.json. Do not edit by hand.",
  baseUrl: spec.baseUrl,
  site: SITE,
  connection: spec.connection,
  optionSources,
  trigger,
  operations,
  excluded: [] as { module: string; reason: string }[],
};

const properties = [resourceProp, ...operationProps, ...fieldProps];
const opsText = JSON.stringify(table, null, "\t") + "\n";
const propsText = `// Generated by integrations/n8n/scripts/generate.mts from integrations/modules.json and
// apps/web/public/openapi.v1.json. Do not edit by hand.
import type { INodeProperties } from 'n8n-workflow';

export const operationProperties: INodeProperties[] = ${JSON.stringify(properties, null, "\t")};
`;

const outputs: [string, string][] = [
  [opsFile, opsText],
  [propsFile, propsText],
];
if (process.argv.includes("--check")) {
  let stale = false;
  for (const [file, text] of outputs) {
    const current = existsSync(file) ? readFileSync(file, "utf8") : undefined;
    if (current !== text) {
      console.error(`${relative(repoRoot, file)} is stale. Run integrations/n8n/scripts/generate.mts.`);
      stale = true;
    }
  }
  if (stale) process.exit(1);
  console.log("integrations/n8n generated files are up to date.");
} else {
  for (const [file, text] of outputs) writeFileSync(file, text);
  console.log(
    `Wrote ${relative(repoRoot, opsFile)} and ${relative(repoRoot, propsFile)}: ${operations.length} operations in ${resources.length} resources, 1 trigger.`,
  );
}
