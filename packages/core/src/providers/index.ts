export interface ProviderConfig {
  name: string;
  description: string;
  specUrl: string;
  baseUrl: string;
  auth: {
    type: 'apiKey' | 'bearer' | 'basic' | 'oauth2';
    envVar: string;
    headerName?: string;
  };
  suggestedIncludes?: string[];
}

const providers: Record<string, ProviderConfig> = {
  stripe: {
    name: 'stripe',
    description: 'Stripe payment processing',
    specUrl: 'https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json',
    baseUrl: 'https://api.stripe.com',
    auth: { type: 'bearer', envVar: 'STRIPE_API_KEY' },
    suggestedIncludes: ['customers', 'charges', 'payments', 'invoices', 'subscriptions'],
  },
  github: {
    name: 'github',
    description: 'GitHub REST API',
    specUrl:
      'https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json',
    baseUrl: 'https://api.github.com',
    auth: { type: 'bearer', envVar: 'GITHUB_TOKEN' },
    suggestedIncludes: ['repos', 'issues', 'pulls', 'actions'],
  },
  slack: {
    name: 'slack',
    description: 'Slack Web API',
    specUrl:
      'https://raw.githubusercontent.com/slackapi/slack-api-specs/master/web-api/slack_web_openapi_v2.json',
    baseUrl: 'https://slack.com/api',
    auth: { type: 'bearer', envVar: 'SLACK_TOKEN' },
    suggestedIncludes: ['chat', 'channels', 'users', 'files'],
  },
  // NOTE: notion / linear / shopify shortcuts were removed — their `specUrl`s
  // pointed at HTML documentation or a GraphQL (Apollo) console, not a
  // machine-readable OpenAPI spec, so `mcpmake from <name>` always failed.
  // Linear is GraphQL-only (no OpenAPI surface); Notion publishes no official
  // OpenAPI spec; Shopify's REST reference is HTML. Re-add only with a verified
  // spec URL that `loadOpenApiSpec` can actually parse.
};

export function getProvider(name: string): ProviderConfig | undefined {
  return providers[name.toLowerCase()];
}

export function listProviders(): ProviderConfig[] {
  return Object.values(providers);
}

export function getProviderNames(): string[] {
  return Object.keys(providers);
}
