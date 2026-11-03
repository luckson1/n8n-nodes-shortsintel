'use strict';

/*
 * Offline tests against the built package (dist/, `pnpm test` builds first). Every
 * HTTP call goes to a fake httpRequestWithAuthentication; nothing reaches the API.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');

const { ShortsIntel } = require('../dist/nodes/ShortsIntel/ShortsIntel.node.js');
const { ShortsIntelTrigger, verifySignature } = require(
	'../dist/nodes/ShortsIntelTrigger/ShortsIntelTrigger.node.js',
);
const { ShortsIntelApi } = require('../dist/credentials/ShortsIntelApi.credentials.js');
const { buildRequest, ops } = require('../dist/nodes/ShortsIntel/GenericFunctions.js');
const { existsSync } = require('node:fs');
const { join } = require('node:path');

// The shared module list lives next to this package in the ShortsIntel repo only.
const modulesPath = join(__dirname, '..', '..', 'modules.json');
const modules = existsSync(modulesPath) ? require(modulesPath) : undefined;
const pkg = require('../package.json');

const BASE = 'https://www.shortsintel.com/v1';
const opFor = (key) => ops.operations.find((o) => o.module === key);

/** Answers requests from a list of [matcher, response] pairs, in order, and records them. */
function fakeHttp(answers) {
	const calls = [];
	const fn = async function (credential, request) {
		calls.push({ credential, ...request });
		const next = answers.shift();
		assert.ok(next, `unexpected request ${request.method} ${request.url}`);
		const [method, url, response] = next;
		assert.equal(request.method, method);
		assert.equal(request.url.split('?')[0], url);
		return { statusCode: response.status ?? 200, body: response.body, headers: response.headers ?? {} };
	};
	return { fn, calls, answers };
}

function executeContext({ params, items = [{ json: {} }], http, continueOnFail = false }) {
	const node = { name: 'ShortsIntel', type: 'n8n-nodes-shortsintel.shortsIntel', typeVersion: 1 };
	return {
		getInputData: () => items,
		getNodeParameter: (name, _i, fallback) => (name in params ? params[name] : fallback),
		getNode: () => node,
		continueOnFail: () => continueOnFail,
		helpers: { httpRequestWithAuthentication: http.fn },
	};
}

describe('package', () => {
	test('is a verified-style community package with no runtime dependencies', () => {
		assert.equal(pkg.name, 'n8n-nodes-shortsintel');
		assert.ok(pkg.keywords.includes('n8n-community-node-package'));
		assert.equal(pkg.license, 'MIT');
		assert.equal(pkg.dependencies, undefined);
		assert.equal(pkg.n8n.strict, true);
		assert.equal(pkg.homepage, 'https://www.shortsintel.com');
	});

	test('covers every module in modules.json', { skip: !modules && 'modules.json is not here' }, () => {
		const built = [
			...ops.operations.map((o) => o.module),
			ops.trigger.module,
			...ops.excluded.map((e) => e.module),
		].sort();
		assert.deepEqual(built, modules.modules.map((m) => m.key).sort());
	});

	test('credential sends the key as a Bearer token and tests on the free balance call', () => {
		const cred = new ShortsIntelApi();
		assert.equal(cred.authenticate.properties.headers.Authorization, '=Bearer {{$credentials.apiKey}}');
		assert.equal(cred.test.request.baseURL, ops.baseUrl);
		assert.equal(cred.test.request.url, ops.connection.test.path);
		assert.equal(cred.properties[0].typeOptions.password, true);
	});
});

describe('node description', () => {
	const node = new ShortsIntel();
	const props = node.description.properties;

	test('is usable as an AI Agent tool', () => {
		assert.equal(node.description.usableAsTool, true);
	});

	test('every operation is selectable and every parameter has a field', () => {
		for (const op of ops.operations) {
			const operationProp = props.find(
				(p) => p.name === 'operation' && p.displayOptions.show.resource.includes(op.resource),
			);
			assert.ok(
				operationProp.options.some((o) => o.value === op.operation),
				`${op.module} is not an option of resource ${op.resource}`,
			);
			const shown = props.filter(
				(p) =>
					p.displayOptions?.show?.resource?.includes(op.resource) &&
					p.displayOptions?.show?.operation?.includes(op.operation),
			);
			const additional = shown.find((p) => p.name === 'additionalFields');
			for (const param of op.params) {
				const where = param.additional ? additional?.options ?? [] : shown;
				assert.ok(
					where.some((p) => p.name === param.name),
					`${op.module}: no field for ${param.name}`,
				);
			}
			if (op.container) {
				assert.ok(shown.some((p) => p.name === 'returnAll'));
				assert.ok(shown.some((p) => p.name === 'limit'));
			}
		}
	});

	test('copy says analysis, never Intelligence, and has no em dashes', () => {
		const text = JSON.stringify(props);
		assert.doesNotMatch(text, /Intelligence/);
		assert.doesNotMatch(text, /—/);
	});

	test('the trigger node is a trigger, not a tool', () => {
		const t = new ShortsIntelTrigger().description;
		assert.deepEqual(t.inputs, []);
		assert.equal(t.usableAsTool, undefined);
		assert.match(t.displayName, /Trigger/);
	});
});

describe('buildRequest', () => {
	test('encodes path parameters and puts body fields, nested ones included, in the body', () => {
		const req = buildRequest(
			opFor('searchVideos'),
			{ query: 'protein bars' },
			{
				platforms: ['tiktok', 'instagram'],
				focusText: 'gym snacks',
				focusMustMention: 'protein, bar',
				intelligence: true,
				estimate: true,
				maxResults: 5,
			},
		);
		assert.equal(req.method, 'POST');
		assert.equal(req.url, `${BASE}/videos/search`);
		assert.deepEqual(req.body, {
			query: 'protein bars',
			platforms: ['tiktok', 'instagram'],
			focus: { text: 'gym snacks', must_mention: ['protein', 'bar'] },
			intelligence: true,
			estimate: true,
			limit: 5,
		});

		const get = buildRequest(opFor('getCreator'), { platform: 'tiktok', handle: '@khaby lame' }, {});
		assert.equal(get.url, `${BASE}/creators/tiktok/%40khaby%20lame`);
		assert.equal(get.body, undefined);
	});

	test('sends query parameters, repeating lists', () => {
		const req = buildRequest(
			opFor('getKeyword'),
			{ platform: 'tiktok', phrase: 'iphone case' },
			{ focus: 'Apple phones', mustMention: 'apple,iphone', estimate: true },
		);
		assert.equal(req.url, `${BASE}/keywords/tiktok`);
		assert.deepEqual(req.qs, {
			phrase: 'iphone case',
			focus: 'Apple phones',
			must_mention: ['apple', 'iphone'],
			estimate: true,
		});
		assert.equal(req.arrayFormat, 'repeat');
	});

	test('skips empty optional values and refuses an empty path parameter', () => {
		const req = buildRequest(opFor('createResearch'), { intent: 'gym snacks' }, { keywords: '', region: '' });
		assert.deepEqual(req.body, { intent: 'gym snacks' });
		assert.throws(() => buildRequest(opFor('getRun'), { id: '' }, {}), /id is required/);
	});
});

describe('execute', () => {
	test('creates a Tracker with the Bearer credential', async () => {
		const http = fakeHttp([
			['POST', `${BASE}/trackers`, { status: 201, body: { tracker: { id: 'trk_1' } } }],
		]);
		const ctx = executeContext({
			params: {
				resource: 'tracker',
				operation: 'createTracker',
				kind: 'creator',
				target: 'khaby.lame',
				additionalFields: { platform: 'tiktok', collectionIds: ['col_1'] },
			},
			http,
		});
		const [out] = await new ShortsIntel().execute.call(ctx);
		assert.deepEqual(out, [{ json: { tracker: { id: 'trk_1' } }, pairedItem: { item: 0 } }]);
		assert.equal(http.calls[0].credential, 'shortsIntelApi');
		assert.deepEqual(http.calls[0].body, {
			kind: 'creator',
			target: 'khaby.lame',
			platform: 'tiktok',
			collection_ids: ['col_1'],
		});
	});

	test('pages a list by next_cursor and stops at the limit', async () => {
		const http = fakeHttp([
			['GET', `${BASE}/trackers`, { body: { items: [{ id: 'a' }, { id: 'b' }], next_cursor: 'c2' } }],
			['GET', `${BASE}/trackers`, { body: { items: [{ id: 'c' }, { id: 'd' }], next_cursor: 'c3' } }],
		]);
		const ctx = executeContext({
			params: { resource: 'tracker', operation: 'listTrackers', returnAll: false, limit: 3, additionalFields: {} },
			http,
		});
		const [out] = await new ShortsIntel().execute.call(ctx);
		assert.deepEqual(
			out.map((o) => o.json.id),
			['a', 'b', 'c'],
		);
		assert.equal(http.calls[0].qs.limit, 3);
		assert.equal(http.calls[1].qs.cursor, 'c2');
		assert.equal(http.calls[1].qs.limit, 1);
	});

	test('Wait for a Run polls until the Run leaves running', async () => {
		const op = opFor('waitForRun');
		const delay = op.poll.delayMs;
		op.poll.delayMs = 1;
		try {
			const http = fakeHttp([
				['GET', `${BASE}/runs/run_1`, { body: { run: { status: 'running' } } }],
				['GET', `${BASE}/runs/run_1`, { body: { run: { status: 'succeeded' }, result: { ok: 1 } } }],
			]);
			const ctx = executeContext({ params: { resource: 'run', operation: 'waitForRun', id: 'run_1' }, http });
			const [out] = await new ShortsIntel().execute.call(ctx);
			assert.equal(out[0].json.run.status, 'succeeded');
			assert.equal(http.calls.length, 2);
		} finally {
			op.poll.delayMs = delay;
		}
	});

	test('a problem body becomes a NodeApiError with the API detail', async () => {
		const http = fakeHttp([
			[
				'GET',
				`${BASE}/account/balance`,
				{ status: 402, body: { title: 'Payment Required', detail: 'Not enough Credits.', code: 'insufficient_credits' } },
			],
		]);
		const ctx = executeContext({ params: { resource: 'account', operation: 'getBalance' }, http });
		await assert.rejects(new ShortsIntel().execute.call(ctx), (error) => {
			assert.equal(error.name, 'NodeApiError');
			assert.equal(error.message, 'Not enough Credits.');
			assert.equal(error.httpCode, '402');
			assert.match(error.description, /console\/billing/);
			return true;
		});
	});

	test('continueOnFail returns the error as an item', async () => {
		const http = fakeHttp([
			['GET', `${BASE}/runs/run_x`, { status: 404, body: { detail: 'Run not found.' } }],
		]);
		const ctx = executeContext({
			params: { resource: 'run', operation: 'getRun', id: 'run_x' },
			http,
			continueOnFail: true,
		});
		const [out] = await new ShortsIntel().execute.call(ctx);
		assert.deepEqual(out, [{ json: { error: 'Run not found.' }, pairedItem: { item: 0 } }]);
	});

	test('Make an API call stays on the ShortsIntel host', async () => {
		const http = fakeHttp([['POST', `${BASE}/research`, { body: { ok: true } }]]);
		const ctx = executeContext({
			params: {
				resource: 'apiCall',
				operation: 'makeApiCall',
				method: 'POST',
				path: '/v1/research',
				query: { parameter: [{ name: 'estimate', value: 'true' }] },
				body: '{"intent":"gym snacks"}',
			},
			http,
		});
		await new ShortsIntel().execute.call(ctx);
		assert.deepEqual(http.calls[0].qs, { estimate: 'true' });
		assert.deepEqual(http.calls[0].body, { intent: 'gym snacks' });

		const bad = executeContext({
			params: { resource: 'apiCall', operation: 'makeApiCall', method: 'GET', path: 'https://evil.example/x' },
			http: fakeHttp([]),
		});
		await assert.rejects(new ShortsIntel().execute.call(bad), /not a URL/);
	});

	test('dropdowns list Trackers with the option-source label', async () => {
		const http = fakeHttp([
			[
				'GET',
				`${BASE}/trackers`,
				{ body: { items: [{ id: 'trk_1', kind: 'creator', target: 'khaby.lame', platform: 'tiktok' }], next_cursor: null } },
			],
		]);
		const options = await new ShortsIntel().methods.loadOptions.getTrackers.call({
			getNode: () => ({}),
			helpers: { httpRequestWithAuthentication: http.fn },
		});
		assert.deepEqual(options, [{ name: 'creator khaby.lame (tiktok)', value: 'trk_1' }]);
	});
});

describe('trigger', () => {
	const SECRET = 'whsec_test';
	const sign = (body, t = Math.floor(Date.now() / 1000), secret = SECRET) =>
		`t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;

	test('verifySignature accepts any matching v1 and refuses stale or wrong ones', () => {
		const body = '{"a":1}';
		const now = 1_800_000_000;
		assert.equal(verifySignature(sign(body, now), body, SECRET, now), true);
		const two = `${sign(body, now, 'whsec_other')},v1=${sign(body, now).split('v1=')[1]}`;
		assert.equal(verifySignature(two, body, SECRET, now), true);
		assert.equal(verifySignature(sign(body, now - 301), body, SECRET, now), false);
		assert.equal(verifySignature(sign(body, now, 'whsec_other'), body, SECRET, now), false);
		assert.equal(verifySignature(undefined, body, SECRET, now), false);
	});

	function hookContext(http, staticData = {}) {
		return {
			getWorkflowStaticData: () => staticData,
			getNodeWebhookUrl: () => 'https://n8n.example.com/webhook/abc/webhook',
			getWorkflow: () => ({ name: 'Swipe file' }),
			getNode: () => ({ name: 'ShortsIntel Trigger' }),
			helpers: { httpRequestWithAuthentication: http.fn },
		};
	}

	test('create registers the endpoint and keeps its id and secret', async () => {
		const staticData = {};
		const http = fakeHttp([
			[
				'POST',
				`${BASE}/webhooks`,
				{ status: 201, body: { webhook: { id: 'wh_1', status: 'active' }, secret: SECRET } },
			],
		]);
		const ok = await new ShortsIntelTrigger().webhookMethods.default.create.call(hookContext(http, staticData));
		assert.equal(ok, true);
		assert.deepEqual(staticData, { webhookId: 'wh_1', webhookSecret: SECRET });
		assert.equal(http.calls[0].body.url, 'https://n8n.example.com/webhook/abc/webhook');
	});

	test('create deletes a failed endpoint and explains why', async () => {
		const http = fakeHttp([
			['POST', `${BASE}/webhooks`, { status: 201, body: { webhook: { id: 'wh_2', status: 'failed' }, secret: SECRET } }],
			['DELETE', `${BASE}/webhooks/wh_2`, { status: 204 }],
		]);
		await assert.rejects(
			new ShortsIntelTrigger().webhookMethods.default.create.call(hookContext(http, {})),
			/could not deliver its test event/,
		);
		assert.equal(http.answers.length, 0);
	});

	test('delete removes the endpoint, and a 404 is fine', async () => {
		const staticData = { webhookId: 'wh_1', webhookSecret: SECRET };
		const http = fakeHttp([['DELETE', `${BASE}/webhooks/wh_1`, { status: 404, body: { detail: 'gone' } }]]);
		assert.equal(
			await new ShortsIntelTrigger().webhookMethods.default.delete.call(hookContext(http, staticData)),
			true,
		);
		assert.deepEqual(staticData, {});
	});

	test('checkExists is false when the stored endpoint is gone', async () => {
		const staticData = { webhookId: 'wh_1', webhookSecret: SECRET };
		const http = fakeHttp([['GET', `${BASE}/webhooks/wh_1`, { status: 404, body: {} }]]);
		assert.equal(
			await new ShortsIntelTrigger().webhookMethods.default.checkExists.call(hookContext(http, staticData)),
			false,
		);
		assert.deepEqual(staticData, {});
	});

	function webhookContext({ event, header, trackerId = '', http = fakeHttp([]) }) {
		const raw = JSON.stringify(event);
		const sent = { status: undefined, body: undefined };
		return {
			sent,
			ctx: {
				getRequestObject: () => ({ rawBody: Buffer.from(raw) }),
				getBodyData: () => event,
				getHeaderData: () => ({ 'x-shortsintel-signature': header === undefined ? sign(raw) : header }),
				getResponseObject: () => ({
					status(code) {
						sent.status = code;
						return this;
					},
					json(body) {
						sent.body = body;
					},
				}),
				getWorkflowStaticData: () => ({ webhookId: 'wh_1', webhookSecret: SECRET }),
				getNodeParameter: () => trackerId,
				getNode: () => ({}),
				helpers: {
					httpRequestWithAuthentication: http.fn,
					returnJsonArray: (items) => items.map((json) => ({ json })),
				},
			},
		};
	}

	const changed = {
		id: 'evt_1',
		type: 'tracker.changed',
		tracker_id: 'trk_1',
		change_report_id: 'chg_1',
	};

	test('a tracker.changed event starts the workflow with summary and triggers', async () => {
		const http = fakeHttp([
			[
				'GET',
				`${BASE}/trackers/trk_1/changes`,
				{ body: { items: [{ id: 'chg_1', summary: '1 new video', triggers: ['new_videos'] }] } },
			],
		]);
		const { ctx } = webhookContext({ event: changed, http });
		const res = await new ShortsIntelTrigger().webhook.call(ctx);
		assert.deepEqual(res.workflowData, [
			[{ json: { ...changed, summary: '1 new video', triggers: ['new_videos'] } }],
		]);
	});

	test('a bad signature is refused with 401', async () => {
		const { ctx, sent } = webhookContext({ event: changed, header: 't=1,v1=00' });
		const res = await new ShortsIntelTrigger().webhook.call(ctx);
		assert.deepEqual(res, { noWebhookResponse: true });
		assert.equal(sent.status, 401);
	});

	test('webhook.test, other event types and other Trackers do not start the workflow', async () => {
		for (const [event, trackerId] of [
			[{ id: 'evt_t', type: 'webhook.test' }, ''],
			[{ id: 'evt_r', type: 'run.completed' }, ''],
			[changed, 'trk_other'],
		]) {
			const { ctx } = webhookContext({ event, trackerId });
			const res = await new ShortsIntelTrigger().webhook.call(ctx);
			assert.equal(res.workflowData, undefined);
		}
	});
});
