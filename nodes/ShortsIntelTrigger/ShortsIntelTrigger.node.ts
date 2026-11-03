import { createHmac, timingSafeEqual } from 'crypto';
import type {
	IDataObject,
	IHookFunctions,
	ILoadOptionsFunctions,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { CREDENTIAL, apiRequest, loadOptions, ops } from '../ShortsIntel/GenericFunctions';

/** Signatures older or newer than this are refused as replays. */
const TOLERANCE_SECONDS = 300;

/**
 * Checks `X-ShortsIntel-Signature: t=<unix>,v1=<hex>[,v1=<hex>]`: HMAC-SHA256 with the
 * endpoint secret over "<t>.<raw body>". Any v1 may match (two during a rotation).
 */
export function verifySignature(
	header: string | undefined,
	rawBody: string,
	secret: string,
	nowSeconds: number,
): boolean {
	if (!header) return false;
	let t: string | undefined;
	const v1: string[] = [];
	for (const part of header.split(',')) {
		const [k, v] = part.trim().split('=');
		if (k === 't') t = v;
		else if (k === 'v1' && v) v1.push(v);
	}
	if (!t || v1.length === 0 || Math.abs(nowSeconds - Number(t)) > TOLERANCE_SECONDS) return false;
	const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
	return v1.some((sig) => {
		const given = Buffer.from(sig, 'hex');
		return given.length === expected.length && timingSafeEqual(given, expected);
	});
}

function webhookPath(path: string, id: string) {
	return `${ops.baseUrl}${path.replace('{id}', encodeURIComponent(id))}`;
}

export class ShortsIntelTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'ShortsIntel Trigger',
		name: 'shortsIntelTrigger',
		icon: { light: 'file:../../icons/shortsintel.svg', dark: 'file:../../icons/shortsintel.svg' },
		group: ['trigger'],
		version: [1],
		subtitle: 'Tracker changes',
		description: 'Starts the workflow when a Tracker cycle produces a Change Report',
		defaults: {
			name: 'ShortsIntel Trigger',
		},
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: CREDENTIAL, required: true }],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'webhook',
			},
		],
		properties: [
			{
				displayName:
					'Registers a ShortsIntel webhook endpoint for this workflow. n8n must be reachable over public HTTPS, the key must belong to an owner or admin, and a workspace can have at most 5 endpoints.',
				name: 'notice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Tracker Name or ID',
				name: 'trackerId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getTrackers' },
				default: '',
				description:
					'Only trigger for this Tracker. Leave empty to trigger for every Tracker. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
		],
	};

	methods = {
		loadOptions: {
			async getTrackers(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				return [{ name: 'Any Tracker', value: '' }, ...(await loadOptions.call(this, 'trackers'))];
			},
		},
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const data = this.getWorkflowStaticData('node');
				if (!data.webhookId) return false;
				const found = await apiRequest.call(
					this,
					{ method: 'GET', url: webhookPath('/webhooks/{id}', String(data.webhookId)), json: true },
					true,
				);
				const webhook = (found?.webhook ?? found) as IDataObject | undefined;
				if (
					!webhook ||
					webhook.status !== 'active' ||
					webhook.url !== this.getNodeWebhookUrl('default')
				) {
					delete data.webhookId;
					delete data.webhookSecret;
					return false;
				}
				return true;
			},

			// Registration sends a signed `webhook.test` and activates the endpoint only
			// when this workflow's URL answers 2xx.
			async create(this: IHookFunctions): Promise<boolean> {
				const url = this.getNodeWebhookUrl('default');
				const response =
					(await apiRequest.call(this, {
						method: ops.trigger.subscribe.method,
						url: `${ops.baseUrl}${ops.trigger.subscribe.path}`,
						body: { url, description: `n8n: ${this.getWorkflow().name ?? 'workflow'}` },
						json: true,
					})) ?? {};
				const webhook = (response.webhook ?? {}) as IDataObject;
				if (webhook.status !== 'active') {
					if (webhook.id)
						await apiRequest.call(
							this,
							{
								method: ops.trigger.unsubscribe.method,
								url: webhookPath(ops.trigger.unsubscribe.path, String(webhook.id)),
								json: true,
							},
							true,
						);
					throw new NodeOperationError(
						this.getNode(),
						`ShortsIntel could not deliver its test event to ${url} (endpoint status ${String(webhook.status ?? 'unknown')})`,
						{
							description:
								'ShortsIntel only delivers to public HTTPS URLs. Set WEBHOOK_URL on your n8n instance to its public HTTPS address and activate the workflow again.',
						},
					);
				}
				const data = this.getWorkflowStaticData('node');
				data.webhookId = webhook.id;
				data.webhookSecret = response.secret;
				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				const data = this.getWorkflowStaticData('node');
				if (data.webhookId) {
					await apiRequest.call(
						this,
						{
							method: ops.trigger.unsubscribe.method,
							url: webhookPath(ops.trigger.unsubscribe.path, String(data.webhookId)),
							json: true,
						},
						true,
					);
				}
				delete data.webhookId;
				delete data.webhookSecret;
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const req = this.getRequestObject();
		const event = this.getBodyData();
		const secret = this.getWorkflowStaticData('node').webhookSecret as string | undefined;

		// The secret arrives in the registration response, after the `webhook.test`
		// delivery it proves the URL with, so that one event is acknowledged unverified.
		if (event.type === 'webhook.test') return { webhookResponse: { ok: true } };

		const raw = (req as unknown as { rawBody?: Buffer | string }).rawBody;
		const rawBody = raw === undefined ? JSON.stringify(event) : raw.toString();
		const header = this.getHeaderData()['x-shortsintel-signature'] as string | undefined;
		if (!secret || !verifySignature(header, rawBody, secret, Math.floor(Date.now() / 1000))) {
			const res = this.getResponseObject();
			res.status(401).json({ error: 'invalid signature' });
			return { noWebhookResponse: true };
		}

		// Every endpoint receives every event type; only tracker.changed (for the chosen
		// Tracker, when one is set) starts the workflow.
		if (event.type !== ops.trigger.event) return { webhookResponse: { ok: true } };
		const only = this.getNodeParameter('trackerId', '') as string;
		if (only && event.tracker_id !== only) return { webhookResponse: { ok: true } };

		// The payload is thin: add the Change Report's summary and triggers (free).
		let change: IDataObject | undefined;
		if (event.tracker_id && event.change_report_id) {
			const list = await apiRequest.call(
				this,
				{
					method: ops.trigger.list.method,
					url: webhookPath(ops.trigger.list.path, String(event.tracker_id)),
					qs: { limit: 20 },
					json: true,
				},
				true,
			);
			change = ((list?.items as IDataObject[] | undefined) ?? []).find(
				(c) => c.id === event.change_report_id,
			);
		}

		return {
			workflowData: [
				this.helpers.returnJsonArray([
					{
						...event,
						summary: change?.summary ?? null,
						triggers: change?.triggers ?? [],
					},
				]),
			],
		};
	}
}
