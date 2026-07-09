/**
 * The real-world spec corpus: 11 public API definitions the generator must
 * handle end-to-end. Chosen for diversity, not size: 4× Swagger 2.0 (the
 * converter path), 5× OpenAPI 3.0, 2× OpenAPI 3.1; JSON + YAML; apiKey /
 * bearer / basic / oauth2 auth; 58 to 1106 operations.
 *
 * Every URL is pinned to a commit SHA (immutable) and double-checked against
 * a SHA-256, so the corpus cannot drift under the tests. The expected values
 * (`serverName`, `toolCount`, `sampleTools`) are the generator's verified
 * output for that exact file — a change in any of them is a generator
 * behavior change and must be reviewed, not auto-accepted.
 *
 * Files are downloaded on demand into `node_modules/.cache/mcpmake-corpus/`
 * (~21 MB total) by `helpers/corpus-cache.ts` — they are NOT vendored.
 */

export interface CorpusEntry {
  /** Short id: cache filename stem and generated-project dir name. */
  name: string;
  /** Raw URL pinned to a commit SHA — immutable content. */
  url: string;
  /** SHA-256 of the pinned file (defense against manifest typos / MITM). */
  sha256: string;
  ext: 'yaml' | 'json';
  /** Spec flavor, documenting converter-path coverage. */
  specVersion: '2.0' | '3.0' | '3.1';
  /** The generated package.json `name` / MCP serverInfo.name. */
  serverName: string;
  /** EXACT number of tools the generator must register (index.ts excluded). */
  toolCount: number;
  /** Known tool names that must exist (sorted sample: first two + last). */
  sampleTools: string[];
  /**
   * False = KNOWN LIMITATION: `tsc` cannot check this project; the boot test
   * then runs via `tsx` (the generated project's own `dev` script path)
   * instead of `dist/`. Currently every entry typechecks — the flag stays so
   * a future regression can be pinned instead of hidden.
   */
  typecheck: boolean;
}

export const CORPUS: CorpusEntry[] = [
  {
    name: 'twilio-messaging',
    url: 'https://raw.githubusercontent.com/twilio/twilio-oai/1a9189c79a73781ddf45afcd0afd1f210742d68c/spec/yaml/twilio_messaging_v1.yaml',
    sha256: 'eba4e9dcc28ca4e2c4561517afe79395949807bb0f7557b813a1a560a186740a',
    ext: 'yaml',
    specVersion: '3.0',
    serverName: 'twilio-messaging',
    toolCount: 58,
    sampleTools: [
      'create_alpha_sender',
      'create_brand_registration_otp',
      'update_us_app_to_person',
    ],
    typecheck: true,
  },
  {
    name: 'netlify',
    url: 'https://raw.githubusercontent.com/netlify/open-api/110e6c20e2cc6f6554998e7aae3b8c82b38492e1/swagger.yml',
    sha256: '71540d1b5d9d757cf929d9894a784e20d9599ee2e0f65683f82227cec4db0cab',
    ext: 'yaml',
    specVersion: '2.0',
    serverName: 'netlify-s-api-documentation',
    toolCount: 177,
    sampleTools: ['add_member_to_account', 'agent_runner_commit_to_branch', 'update_split_test'],
    typecheck: true,
  },
  {
    name: 'spotify',
    url: 'https://raw.githubusercontent.com/sonallux/spotify-web-api/3b3d29be557de9f4c007f6644a9831c0a2e98720/fixed-spotify-open-api.yml',
    sha256: 'ddeb078a50208d94c4538bd891bec0c9e67c9f3406617a2d887f0a482a4501f4',
    ext: 'yaml',
    specVersion: '3.0',
    serverName: 'spotify-web-api-with-fixes-and-improvements-from-sonallux',
    toolCount: 96,
    sampleTools: ['add_items_to_playlist', 'add_to_queue', 'unfollow_playlist'],
    typecheck: true,
  },
  {
    name: 'slack',
    url: 'https://raw.githubusercontent.com/slackapi/slack-api-specs/bc08db49625630e3585bf2f1322128ea04f2a7f3/web-api/slack_web_openapi_v2.json',
    sha256: '742a5c977180a829df8767cf57bc417d99b3713583aee83741efb9c08ca731e7',
    ext: 'json',
    specVersion: '2.0',
    serverName: 'slack-web-api',
    toolCount: 174,
    sampleTools: ['admin_apps_approve', 'admin_apps_approved_list', 'workflows_update_step'],
    typecheck: true,
  },
  {
    name: 'discord',
    url: 'https://raw.githubusercontent.com/discord/discord-api-spec/d6f2c42086937f4a1cd46f6981493b378f65909f/specs/openapi.json',
    sha256: '8057fc7ac2194d5f6a599e7facc716a06c8fdd5e07be885a84e5340a6b7277c7',
    ext: 'json',
    specVersion: '3.1',
    serverName: 'discord-http-api-preview',
    toolCount: 242,
    sampleTools: [
      'action_guild_join_request',
      'add_group_dm_user',
      'upload_application_attachment',
    ],
    typecheck: true,
  },
  {
    name: 'openai',
    url: 'https://raw.githubusercontent.com/openai/openai-openapi/5162af98d3147432c14680df789e8e12d4891e6b/openapi.yaml',
    sha256: '74cbcf73838f4cd7e209b2d3f2e9ddc9fa155f21a44360b6fac7646a6d4f5f8b',
    ext: 'yaml',
    specVersion: '3.1',
    serverName: 'openai-api',
    toolCount: 242,
    sampleTools: ['accept_realtime_call', 'activate_organization_certificates', 'validate_grader'],
    typecheck: true,
  },
  {
    name: 'asana',
    url: 'https://raw.githubusercontent.com/Asana/openapi/c13afb76dd53e5f6313b0f60b6efd9a81f270265/defs/asana_oas.yaml',
    sha256: '2f541dc34c71323d476b788b06d8f5b2b59eb0b84d1d05373c8e1b1b0cbb5659',
    ext: 'yaml',
    specVersion: '3.0',
    serverName: 'asana',
    toolCount: 249,
    sampleTools: [
      'add_custom_field_setting_for_goal',
      'add_custom_field_setting_for_portfolio',
      'update_workspace',
    ],
    typecheck: true,
  },
  {
    name: 'plaid',
    url: 'https://raw.githubusercontent.com/plaid/plaid-openapi/6abd747c8370679d03a94465412836eb6226720f/2020-09-14.yml',
    sha256: '80d23bfdc2e5bad5c715517fe3c55a7621d12484296622b7d325d124e091fac2',
    ext: 'yaml',
    specVersion: '3.0',
    serverName: 'the-plaid-api',
    toolCount: 331,
    sampleTools: ['accounts_balance_get', 'accounts_get', 'webhook_verification_key_get'],
    typecheck: true,
  },
  {
    name: 'docker',
    url: 'https://raw.githubusercontent.com/moby/moby/15a2763030f8b436bd4356f7a72253b932a27e3f/api/swagger.yaml',
    sha256: '10617b2a7c57362f083d69ad24c0545b878d22dee447f300622dc9830fe9a82c',
    ext: 'yaml',
    specVersion: '2.0',
    serverName: 'docker-engine-api',
    toolCount: 103,
    sampleTools: ['build_prune', 'config_create', 'volume_update'],
    typecheck: true,
  },
  {
    name: 'kubernetes',
    url: 'https://raw.githubusercontent.com/kubernetes/kubernetes/eca217f5daf1963e85f0997d9069e0636b740e9f/api/openapi-spec/swagger.json',
    sha256: '7c23bf29f58e779dede1571ff60af89d1d16d8ff0b58548fde4281022c2d1a5e',
    ext: 'json',
    specVersion: '2.0',
    serverName: 'kubernetes',
    toolCount: 1106,
    sampleTools: [
      'connect_core_v1_delete_namespaced_pod_proxy',
      'connect_core_v1_delete_namespaced_pod_proxy_with_path',
      'watch_storagemigration_v1beta1_storage_version_migration_list',
    ],
    typecheck: true,
  },
  {
    name: 'stripe',
    url: 'https://raw.githubusercontent.com/stripe/openapi/1b1305f06ca561be6a085a948b717efa15d97336/openapi/spec3.json',
    sha256: 'e24a26de4188fd64dec4c043d5d3726277fdcb07556a493ea481c305b0a223d8',
    ext: 'json',
    specVersion: '3.0',
    serverName: 'stripe-api',
    toolCount: 587,
    sampleTools: [
      'delete_accounts_account',
      'delete_accounts_account_bank_accounts_id',
      'post_webhook_endpoints_webhook_endpoint',
    ],
    typecheck: true,
  },
];
