import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	Icon,
	INodeProperties,
} from 'n8n-workflow';

export class ShortsIntelApi implements ICredentialType {
	name = 'shortsIntelApi';

	displayName = 'ShortsIntel API';

	icon: Icon = { light: 'file:../icons/shortsintel.svg', dark: 'file:../icons/shortsintel.svg' };

	documentationUrl = 'https://www.shortsintel.com/docs';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description:
				'Create a key at https://www.shortsintel.com/console/keys. It starts with sk_live_ and is shown once. The ShortsIntel Trigger node needs a key from an owner or admin of the workspace.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	// Free: proves the key works without spending Credits.
	test: ICredentialTestRequest = {
		request: {
			baseURL: 'https://www.shortsintel.com/v1',
			url: '/account/balance',
			method: 'GET',
		},
	};
}
