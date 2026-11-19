-- 毎日の自動バックアップ（会社ごと・30日分）と、消した現場を30日間戻せるようにする
create table if not exists public.kj_backups (
  company_id uuid not null references public.kj_companies(id) on delete cascade,
  day date not null,
  data jsonb not null,
  created_at timestamptz not null default now(),
  primary key (company_id, day)
);
alter table public.kj_backups enable row level security;
drop policy if exists kj_backups_read on public.kj_backups;
create policy kj_backups_read on public.kj_backups for select using (public.kj_is_member(company_id));
-- 書き込みは下の関数だけ（画面からは読むだけ）

create or replace function public.kj_daily_backup() returns void
language plpgsql security definer set search_path = public as $$
declare d date := (now() at time zone 'Asia/Tokyo')::date;
begin
  insert into kj_backups (company_id, day, data)
  select c.company_id, d, jsonb_build_object(
      'settings', (select s.data from kj_docs s where s.company_id = c.company_id and s.kind = 'settings' and s.id = 'main' and not s.deleted limit 1),
      'cases', coalesce((select jsonb_agg(x.data order by x.updated_at) from kj_docs x where x.company_id = c.company_id and x.kind = 'case' and not x.deleted), '[]'::jsonb))
  from (select distinct company_id from kj_docs where company_id is not null) c
  on conflict (company_id, day) do update set data = excluded.data, created_at = now();
  delete from kj_backups where day < d - 30;
  -- 消してから30日たった現場は中身も消す
  update kj_docs set data = '{}'::jsonb where deleted and updated_at < now() - interval '30 days' and data <> '{}'::jsonb;
end $$;
revoke all on function public.kj_daily_backup() from public, anon, authenticated;

-- 毎日 3:00（日本時間）
select cron.unschedule('kj-daily-backup') where exists (select 1 from cron.job where jobname = 'kj-daily-backup');
select cron.schedule('kj-daily-backup', '0 18 * * *', $$select public.kj_daily_backup()$$);

-- バックアップの一覧（日付と現場の数だけ。中身は開くときに読む）
create or replace function public.kj_backup_list(p_company uuid) returns table(day date, n int)
language sql stable security invoker set search_path = public as $$
  select b.day, jsonb_array_length(coalesce(b.data->'cases', '[]'::jsonb)) from kj_backups b where b.company_id = p_company order by b.day desc;
$$;
grant execute on function public.kj_backup_list(uuid) to authenticated;
