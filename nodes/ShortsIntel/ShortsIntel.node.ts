import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	CREDENTIAL,
	apiRequest,
	apiRequestAllItems,
	buildRequest,
	loadOptions,
	ops,
	pollRun,
	universalRequest,
} from './GenericFunctions';
import { operationProperties } from './OperationsDescription';

/**
 * ShortsIntel (#709). Every operation is built from operations.json, which
 * integrations/n8n/scripts/generate.ts writes from the shared module list
 * (integrations/modules.json) and the public OpenAPI document. Behaviour lives
 * here; fields live in OperationsDescription.ts.
 */
export class ShortsIntel implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'ShortsIntel',
		name: 'shortsIntel',
		icon: { light: 'file:../../icons/shortsintel.svg', dark: 'file:../../icons/shortsintel.svg' },
		group: ['transform'],
		version: [1],
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description:
			'Research niches, search and analyse short-form videos and Ads, and track creators, hashtags, sounds, keywords and advertisers',
		defaults: {
			name: 'ShortsIntel',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [{ name: CREDENTIAL, required: true }],
		properties: operationProperties,
	};

	methods = {
		loadOptions: {
			async getTrackers(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				return await loadOptions.call(this, 'trackers');
			},
			async getCollections(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				return await loadOptions.call(this, 'collections');
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const resource = this.getNodeParameter('resource', i) as string;
				const operation = this.getNodeParameter('operation', i) as string;
				const op = ops.operations.find(
					(o) => o.resource === resource && o.operation === operation,
				);
				if (!op)
					throw new NodeOperationError(
						this.getNode(),
						`Unknown operation ${resource}: ${operation}`,
						{ itemIndex: i },
					);

				let results: IDataObject[];
				if (op.universal) {
					results = [(await apiRequest.call(this, universalRequest.call(this, i))) ?? {}];
				} else {
					const values: IDataObject = {};
					for (const p of op.params)
						if (!p.additional) values[p.name] = this.getNodeParameter(p.name, i) as IDataObject;
					const additional = op.params.some((p) => p.additional)
						? (this.getNodeParameter('additionalFields', i, {}) as IDataObject)
						: {};
					let request;
					try {
						request = buildRequest(op, values, additional);
					} catch (error) {
						throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
					}
					if (op.container) {
						const returnAll = this.getNodeParameter('returnAll', i, false) as boolean;
						const limit = returnAll ? 0 : (this.getNodeParameter('limit', i, 50) as number);
						results = await apiRequestAllItems.call(
							this,
							request,
							op.container,
							op.cursor!,
							limit,
						);
					} else if (op.poll) {
						results = [await pollRun.call(this, op, request)];
					} else {
						results = [(await apiRequest.call(this, request)) ?? {}];
					}
				}

				for (const json of results) returnData.push({ json, pairedItem: { item: i } });
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: { item: i },
					});
					continue;
				}
				if (error instanceof NodeApiError) {
					throw new NodeApiError(this.getNode(), (error.cause as unknown as JsonObject) ?? {}, {
						message: error.message,
						description: error.description ?? undefined,
						httpCode: error.httpCode ?? undefined,
						itemIndex: i,
					});
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}

		return [returnData];
	}
}
