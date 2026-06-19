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
  notion: {
    name: 'notion',
    description: 'Notion API',
    specUrl: 'https://bump.sh/notion-hq/doc/notion/specification',
    baseUrl: 'https://api.notion.com/v1',
    auth: { type: 'bearer', envVar: 'NOTION_API_KEY', headerName: 'Authorization' },
  },
  linear: {
    name: 'linear',
    description: 'Linear project management',
    specUrl: 'https://studio.apollographql.com/public/Linear-API/variant/current/home',
    baseUrl: 'https://api.linear.app',
    auth: { type: 'bearer', envVar: 'LINEAR_API_KEY' },
  },
  shopify: {
    name: 'shopify',
    description: 'Shopify Admin API',
    specUrl: 'https://shopify.dev/docs/admin-api/rest/reference',
    baseUrl: 'https://{store}.myshopify.com/admin/api/2024-01',
    auth: { type: 'bearer', envVar: 'SHOPIFY_ACCESS_TOKEN' },
  },
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
