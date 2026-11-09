-- 毎朝の通知・テスト送信の記録（送れたか、送れなかった理由）。管理用：画面からは読めない
create table if not exists public.kj_notify_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  user_id uuid references auth.users (id) on delete cascade,
  kind text not null check (kind in ('cron', 'test')),
  sent boolean not null,
  reason text
);
alter table public.kj_notify_log enable row level security;
revoke all on public.kj_notify_log from anon, authenticated;
