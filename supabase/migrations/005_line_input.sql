-- LINE からの入力：LINE のアカウントと会社を結びつける
-- ・kj_line_users：連携済みの LINE アカウント（社員＝member はカイタイ事務のアカウントあり、運転手＝driver はなくてもよい）
-- ・kj_line_codes：連携番号（6桁・30分有効）。代表は運転手用、メンバーは自分用を発行できる
create table if not exists public.kj_line_users (
  line_user_id text primary key,
  company_id uuid not null references public.kj_companies (id) on delete cascade,
  user_id uuid references auth.users (id) on delete set null,
  role text not null default 'driver' check (role in ('member', 'driver')),
  display_name text,
  pending jsonb,
  linked_at timestamptz not null default now()
);
create index if not exists kj_line_users_company on public.kj_line_users (company_id);

create table if not exists public.kj_line_codes (
  code text primary key,
  company_id uuid not null references public.kj_companies (id) on delete cascade,
  user_id uuid references auth.users (id) on delete cascade,
  role text not null check (role in ('member', 'driver')),
  label text,
  created_by uuid references auth.users (id) on delete set null,
  expires_at timestamptz not null default now() + interval '30 minutes'
);

alter table public.kj_line_users enable row level security;
drop policy if exists "member reads line users" on public.kj_line_users;
create policy "member reads line users" on public.kj_line_users
  for select to authenticated using (public.kj_is_member(company_id));
drop policy if exists "owner or self unlinks" on public.kj_line_users;
create policy "owner or self unlinks" on public.kj_line_users
  for delete to authenticated using (public.kj_is_owner(company_id) or user_id = auth.uid());
revoke all on public.kj_line_users from anon;
grant select, delete on public.kj_line_users to authenticated;

alter table public.kj_line_codes enable row level security; -- 画面からは直接読めない（発行は下の関数だけ）
revoke all on public.kj_line_codes from anon, authenticated;

create or replace function public.kj_create_line_code(p_company uuid, p_role text, p_label text default null) returns text
language plpgsql security definer set search_path = '' as $$
declare c text;
begin
  if p_role = 'driver' and not public.kj_is_owner(p_company) then raise exception 'not_owner'; end if;
  if p_role = 'member' and not public.kj_is_member(p_company) then raise exception 'not_member'; end if;
  if p_role not in ('member', 'driver') then raise exception 'bad_role'; end if;
  delete from public.kj_line_codes where expires_at < now();
  loop
    c := lpad((floor(random() * 1000000))::int::text, 6, '0');
    exit when not exists (select 1 from public.kj_line_codes where code = c);
  end loop;
  insert into public.kj_line_codes (code, company_id, user_id, role, label, created_by)
    values (c, p_company, case when p_role = 'member' then auth.uid() end, p_role, nullif(trim(coalesce(p_label, '')), ''), auth.uid());
  return c;
end $$;
revoke execute on function public.kj_create_line_code(uuid, text, text) from public, anon;
grant execute on function public.kj_create_line_code(uuid, text, text) to authenticated;
