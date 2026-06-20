import { defineCommand } from 'citty';
import { fetchPricing, formatPrice, logger } from '@mcpmake/core';

/** Canonical public pricing page (anchor section on the landing page). */
const PRICING_PAGE = 'https://mcpmake.dev/#pricing';

export default defineCommand({
  meta: {
    name: 'pricing',
    description: 'Show current mcpmake plans (fetched live from mcpmake.dev)',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'Print the raw pricing JSON instead of a table',
      default: false,
    },
    server: {
      type: 'string',
      description: 'Pricing server base URL (overrides $MCPMAKE_SERVER and the default)',
    },
  },
  async run({ args }) {
    // Precedence inside fetchPricing: --server > $MCPMAKE_SERVER > mcpmake.dev.
    const { pricing, source } = await fetchPricing(args.server);

    if (args.json) {
      console.log(JSON.stringify(pricing, null, 2));
      return;
    }

    const tiers = Object.values(pricing);
    const labelWidth = tiers.reduce((max, t) => Math.max(max, t.name.length), 0);

    logger.info('mcpmake plans:');
    console.log('');
    for (const tier of tiers) {
      console.log(`  ${tier.name.padEnd(labelWidth)}  ${formatPrice(tier)}`);
      console.log(`  ${' '.repeat(labelWidth)}  ${tier.summary}`);
      console.log('');
    }

    if (source === 'bundled') {
      logger.warn('Could not reach mcpmake.dev — showing the prices bundled with this CLI.');
    }
    logger.info(`Prices are subject to change. Latest: ${PRICING_PAGE}`);
  },
});
