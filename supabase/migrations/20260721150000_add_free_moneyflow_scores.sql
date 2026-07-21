create table if not exists public.quant_moneyflow_latest (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  stock_id uuid not null references public.quant_stocks(id) on delete cascade,
  trade_date date not null,
  latest_price numeric,
  today_pct_change numeric,
  today_main_net numeric,
  today_main_pct numeric,
  today_super_net numeric,
  today_super_pct numeric,
  today_large_net numeric,
  today_large_pct numeric,
  d5_pct_change numeric,
  d5_main_net numeric,
  d5_main_pct numeric,
  d10_pct_change numeric,
  d10_main_net numeric,
  d10_main_pct numeric,
  fund_score smallint not null check (fund_score between 0 and 100),
  fund_signal text not null,
  source text not null default 'eastmoney-free',
  fetched_at timestamptz not null default now(),
  unique (user_id, stock_id)
);
create index if not exists quant_moneyflow_latest_user_score_idx on public.quant_moneyflow_latest(user_id, fund_score desc);
create index if not exists quant_moneyflow_latest_stock_idx on public.quant_moneyflow_latest(stock_id);
alter table public.quant_moneyflow_latest enable row level security;
create policy "quant moneyflow select own" on public.quant_moneyflow_latest for select to authenticated using ((select auth.uid()) = user_id);
create policy "quant moneyflow insert own" on public.quant_moneyflow_latest for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "quant moneyflow update own" on public.quant_moneyflow_latest for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "quant moneyflow delete own" on public.quant_moneyflow_latest for delete to authenticated using ((select auth.uid()) = user_id);
grant select, insert, update, delete on public.quant_moneyflow_latest to authenticated;
