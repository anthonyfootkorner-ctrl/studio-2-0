// Configuration Supabase — projet « Team planner » (auth partagée avec le tracker merch).
const SUPABASE_URL = "https://yeusqubxgxchigssobma.supabase.co";
const SUPABASE_KEY = "sb_publishable_FkwKSPbHO3CPHdRvt35img__s3HSY5R";
const GENERATE_FN_URL = SUPABASE_URL + "/functions/v1/generate-model";

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
