-- Index to speed up SELECT symbol FROM user_assets (used by asset-events fetch
-- to get distinct symbols tracked by any user).
CREATE INDEX IF NOT EXISTS idx_user_assets_symbol ON public.user_assets (symbol);
