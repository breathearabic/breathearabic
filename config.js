/* Arabic Vocab settings. Everything in this file is public: it is sent to every visitor.
   NEVER put the service_role key, the Polar access token or the webhook secret here.
   Those live only in Supabase > Edge Functions > Secrets. */
window.ARVOCAB_CONFIG = {
  // Supabase > Project Settings > Data API (or API) > Project URL, e.g. "https://abcdefgh.supabase.co"
  supabaseUrl: "https://wrkwdalnpofixhkintrp.supabase.co",
  // Supabase > Project Settings > API Keys > the "publishable" key (sb_publishable_...)
  // or, on older projects, the "anon public" key. Both are safe to publish.
  supabaseKey: "sb_publishable_zdbphVhm6ajB3aVsHyKIQg_ubWcUWX9",
  // Turn on once Polar is set up (milestone 3). While false, Subscribe buttons say "coming soon".
  paymentsEnabled: true,
  // Shown next to Subscribe buttons, e.g. "£4.99 a month". Leave empty to show no price.
  priceLabel: "$5 a month"
};
