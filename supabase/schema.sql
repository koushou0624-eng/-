-- カイタイ事務：データを保存する表
-- 1行＝「会社・単価設定」1つ、または「案件」1件。中身は画面のデータをそのまま JSON で持つ
create table if not exists public.kj_docs (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind text not null check (kind in ('settings', 'case')),
  id text not null,
  data jsonb not null,
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, kind, id)
);

create index if not exists kj_docs_user_updated on public.kj_docs (user_id, updated_at);

-- 更新したら updated_at を今の時刻にする（端末間の同期に使う）
create or replace function public.kj_touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists kj_docs_touch on public.kj_docs;
create trigger kj_docs_touch before insert or update on public.kj_docs
  for each row execute function public.kj_touch();

-- 本人の行しか読めない・書けない
alter table public.kj_docs enable row level security;
drop policy if exists "own docs" on public.kj_docs;
create policy "own docs" on public.kj_docs
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all on public.kj_docs from anon;
grant select, insert, update, delete on public.kj_docs to authenticated;

-- 通知の設定（LINE の宛先など）。画面のデータとは分け、端末には保存しない
create table if not exists public.kj_notify (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  line_token text,
  line_user_id text,
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table public.kj_notify enable row level security;
drop policy if exists "own notify" on public.kj_notify;
create policy "own notify" on public.kj_notify
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all on public.kj_notify from anon;
grant select, insert, update, delete on public.kj_notify to authenticated;
