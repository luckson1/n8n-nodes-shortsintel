import type {
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	INodePropertyOptions,
	IWebhookFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError, sleep } from 'n8n-workflow';

import table from './operations.json';

export const CREDENTIAL = 'shortsIntelApi';

export interface ParamMap {
	name: string;
	api: string;
	in: 'path' | 'query' | 'body';
	type: 'string' | 'number' | 'boolean' | 'options' | 'multiOptions';
	list?: boolean;
	additional?: boolean;
}

export interface Operation {
	resource: string;
	operation: string;
	module: string;
	method?: IHttpRequestMethods;
	path?: string;
	params: ParamMap[];
	container?: string;
	cursor?: string;
	poll?: { statusField: string; while: string; delayMs: number; maxAttempts: number };
	universal?: boolean;
}

export const ops = table as unknown as {
	baseUrl: string;
	site: string;
	optionSources: Record<
		string,
		{
			method: IHttpRequestMethods;
			path: string;
			container: string;
			cursor: string;
			label: string;
			value: string;
			loadOptionsMethod: string;
		}
	>;
	trigger: {
		event: string;
		subscribe: { method: IHttpRequestMethods; path: string; idField: string };
		unsubscribe: { method: IHttpRequestMethods; path: string };
		list: { method: IHttpRequestMethods; path: string };
	};
	operations: Operation[];
};

type Context = IExecuteFunctions | ILoadOptionsFunctions | IHookFunctions | IWebhookFunctions;

const isBlank = (v: unknown) =>
	v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/** Turns a node value into what the API declares for that field. */
export function coerce(value: unknown, param: ParamMap): unknown {
	if (param.list) {
		const arr = Array.isArray(value)
			? value
			: String(value)
					.split(',')
					.map((s) => s.trim());
		return arr.filter((v) => !isBlank(v));
	}
	if (param.type === 'number') {
		const n = Number(value);
		if (Number.isNaN(n)) throw new Error(`${param.name} must be a number, got "${String(value)}"`);
		return n;
	}
	if (param.type === 'boolean') {
		if (typeof value === 'boolean') return value;
		return ['true', 'yes', '1', 'on'].includes(String(value).trim().toLowerCase());
	}
	return value;
}

function setPath(obj: IDataObject, dotted: string, value: unknown) {
	const parts = dotted.split('.');
	let o = obj;
	for (const p of parts.slice(0, -1)) {
		if (!o[p] || typeof o[p] !== 'object') o[p] = {};
		o = o[p] as IDataObject;
	}
	o[parts[parts.length - 1]] = value as IDataObject[keyof IDataObject];
}

/**
 * Builds the request for one operation from its values. `values` holds the
 * top-level parameters; `additional` holds the Additional Fields collection.
 */
export function buildRequest(
	op: Operation,
	values: IDataObject,
	additional: IDataObject = {},
): IHttpRequestOptions {
	let path = op.path!;
	const qs: IDataObject = {};
	const body: IDataObject = {};
	for (const p of op.params) {
		const value = p.additional ? additional[p.name] : values[p.name];
		if (p.in === 'path') {
			if (isBlank(value)) throw new Error(`${p.name} is required`);
			path = path.replace(`{${p.api}}`, encodeURIComponent(String(value).trim()));
			continue;
		}
		if (isBlank(value)) continue;
		const coerced = coerce(value, p);
		if (Array.isArray(coerced) && coerced.length === 0) continue;
		if (p.in === 'query') qs[p.api] = coerced as IDataObject[keyof IDataObject];
		else setPath(body, p.api, coerced);
	}
	const request: IHttpRequestOptions = {
		method: op.method!,
		url: `${ops.baseUrl}${path}`,
		qs,
		arrayFormat: 'repeat',
		json: true,
		headers: { Accept: 'application/json' },
	};
	if (['POST', 'PUT', 'PATCH'].includes(op.method!)) request.body = body;
	return request;
}

/**
 * One authenticated call. Problem bodies (RFC 9457) become NodeApiErrors with
 * the API's `detail`; 401 points at the key, 402 at billing.
 */
export async function apiRequest(
	this: Context,
	request: IHttpRequestOptions,
	allow404 = false,
): Promise<IDataObject | undefined> {
	const response = (await this.helpers.httpRequestWithAuthentication.call(this, CREDENTIAL, {
		...request,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
	})) as { statusCode: number; body: unknown; headers?: IDataObject };
	const status = response.statusCode;
	if (status < 400) return (response.body ?? {}) as IDataObject;
	if (status === 404 && allow404) return undefined;
	let problem: IDataObject = {};
	if (response.body && typeof response.body === 'object') problem = response.body as IDataObject;
	else if (typeof response.body === 'string') {
		try {
			problem = JSON.parse(response.body) as IDataObject;
		} catch {
			problem = { detail: response.body };
		}
	}
	const detail = String(problem.detail ?? problem.title ?? `HTTP ${status}`);
	let description = problem.code ? `Code: ${String(problem.code)}` : undefined;
	if (status === 401)
		description = `Check the API key on this credential, or create a new one at ${ops.site}/console/keys.`;
	if (status === 402) description = `Add Credits at ${ops.site}/console/billing.`;
	if (status === 429)
		description = `Rate limited. Retry after ${String(response.headers?.['retry-after'] ?? 60)} seconds.`;
	throw new NodeApiError(this.getNode(), problem as JsonObject, {
		message: detail,
		description,
		httpCode: String(status),
	});
}

/** Pages a list endpoint by its cursor until `limit` items (or every item when limit is 0). */
export async function apiRequestAllItems(
	this: Context,
	request: IHttpRequestOptions,
	container: string,
	cursorField: string,
	limit = 0,
): Promise<IDataObject[]> {
	const items: IDataObject[] = [];
	let cursor: string | undefined;
	for (;;) {
		const qs: IDataObject = { ...(request.qs ?? {}), limit: 100 };
		if (limit) qs.limit = Math.min(100, limit - items.length);
		if (cursor) qs.cursor = cursor;
		const data = (await apiRequest.call(this, { ...request, qs })) ?? {};
		items.push(...((data[container] as IDataObject[]) ?? []));
		cursor = (data[cursorField] as string | null | undefined) ?? undefined;
		if (!cursor || (limit && items.length >= limit)) break;
	}
	return limit ? items.slice(0, limit) : items;
}

/**
 * Wait for a Run: the free GET /runs/{id} every few seconds until the Run leaves
 * `running` or the attempts run out, then the latest state.
 */
export async function pollRun(
	this: IExecuteFunctions,
	op: Operation,
	request: IHttpRequestOptions,
): Promise<IDataObject> {
	const poll = op.poll!;
	const [outer, inner] = poll.statusField.split('.');
	let data: IDataObject = {};
	for (let attempt = 1; attempt <= poll.maxAttempts; attempt++) {
		data = (await apiRequest.call(this, request)) ?? {};
		const top = data[outer] as IDataObject | string | undefined;
		const status = inner ? (top as IDataObject | undefined)?.[inner] : top;
		if (status !== poll.while || attempt === poll.maxAttempts) break;
		await sleep(poll.delayMs);
	}
	return data;
}

/** Dropdown options for Trackers and Collections. */
export async function loadOptions(
	this: ILoadOptionsFunctions,
	source: string,
): Promise<INodePropertyOptions[]> {
	const src = ops.optionSources[source];
	const items = await apiRequestAllItems.call(
		this,
		{ method: src.method, url: `${ops.baseUrl}${src.path}`, json: true },
		src.container,
		src.cursor,
		500,
	);
	return items.map((item) => ({
		name: src.label.replace(/\{(\w+)\}/g, (_m, f: string) =>
			item[f] === undefined || item[f] === null ? '' : String(item[f]),
		),
		value: String(item[src.value]),
	}));
}

/** Make an API call: any /v1 path on the ShortsIntel host, never another host. */
export function universalRequest(
	this: IExecuteFunctions,
	itemIndex: number,
): IHttpRequestOptions {
	const method = this.getNodeParameter('method', itemIndex) as IHttpRequestMethods;
	let path = String(this.getNodeParameter('path', itemIndex)).trim();
	if (/^[a-z]+:/i.test(path) || path.startsWith('//'))
		throw new NodeOperationError(this.getNode(), 'Path must be a path such as /account/balance, not a URL', {
			itemIndex,
		});
	if (!path.startsWith('/')) path = `/${path}`;
	path = path.replace(/^\/v1(?=\/|$)/, '') || '/';
	const query = this.getNodeParameter('query', itemIndex, {}) as {
		parameter?: Array<{ name: string; value: string }>;
	};
	const qs: IDataObject = {};
	for (const p of query.parameter ?? []) if (p.name) qs[p.name] = p.value;
	const request: IHttpRequestOptions = {
		method,
		url: `${ops.baseUrl}${path}`,
		qs,
		json: true,
		headers: { Accept: 'application/json' },
	};
	if (['POST', 'PUT', 'PATCH'].includes(method)) {
		const raw = this.getNodeParameter('body', itemIndex, '{}');
		let body: unknown = raw;
		if (typeof raw === 'string') {
			try {
				body = raw.trim() ? JSON.parse(raw) : {};
			} catch {
				throw new NodeOperationError(this.getNode(), 'Body must be valid JSON', { itemIndex });
			}
		}
		request.body = body as IDataObject;
	}
	return request;
}
