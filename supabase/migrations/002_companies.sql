-- カイタイ事務：会社ごとにデータを共有する
-- ・会社（kj_companies）と、所属する人（kj_members）、招待リンク（kj_invites）
-- ・案件と設定（kj_docs）は会社ごとに持ち、同じ会社の人だけが読み書きできる
-- ・LINE 通知の設定（kj_notify）は一人ずつのまま

create table if not exists public.kj_companies (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 100),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.kj_members (
  company_id uuid not null references public.kj_companies (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  email text,
  joined_at timestamptz not null default now(),
  primary key (company_id, user_id)
);
create index if not exists kj_members_user on public.kj_members (user_id);

create table if not exists public.kj_invites (
  code text primary key,
  company_id uuid not null references public.kj_companies (id) on delete cascade,
  created_by uuid references auth.users (id) on delete set null,
  expires_at timestamptz not null default now() + interval '7 days',
  created_at timestamptz not null default now()
);

-- 所属の確認（RLS の中で使う。kj_members 自身の RLS を通さないため security definer）
create or replace function public.kj_is_member(cid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.kj_members m where m.company_id = cid and m.user_id = auth.uid());
$$;
create or replace function public.kj_is_owner(cid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.kj_members m where m.company_id = cid and m.user_id = auth.uid() and m.role = 'owner');
$$;

-- ---------- 今あるデータを「会社」に引っ越す ----------
alter table public.kj_docs add column if not exists company_id uuid references public.kj_companies (id) on delete cascade;
alter table public.kj_docs add column if not exists updated_by uuid references auth.users (id) on delete set null;

do $$
declare r record; cid uuid;
begin
  for r in select distinct d.user_id, u.email from public.kj_docs d join auth.users u on u.id = d.user_id where d.company_id is null loop
    insert into public.kj_companies (name, created_by) values ('わたしの会社', r.user_id) returning id into cid;
    insert into public.kj_members (company_id, user_id, role, email) values (cid, r.user_id, 'owner', r.email);
    update public.kj_docs set company_id = cid where user_id = r.user_id and company_id is null;
  end loop;
end $$;

-- 主キーを「会社・種類・ID」に。user_id は最初に作った人として残す（人が消えても会社のデータは残す）
alter table public.kj_docs drop constraint if exists kj_docs_pkey;
alter table public.kj_docs drop constraint if exists kj_docs_user_id_fkey;
alter table public.kj_docs alter column company_id set not null;
alter table public.kj_docs alter column user_id drop not null;
alter table public.kj_docs add constraint kj_docs_user_id_fkey foreign key (user_id) references auth.users (id) on delete set null;
alter table public.kj_docs add primary key (company_id, kind, id);
drop index if exists public.kj_docs_user_updated;
create index if not exists kj_docs_company_updated on public.kj_docs (company_id, updated_at);

-- 書いた人と時刻を自動で記録
create or replace function public.kj_touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  if auth.uid() is not null then new.updated_by := auth.uid(); end if;
  return new;
end $$;

-- ---------- 読み書きできる範囲（RLS） ----------
drop policy if exists "own docs" on public.kj_docs;
drop policy if exists "company docs" on public.kj_docs;
create policy "company docs" on public.kj_docs
  for all to authenticated
  using (public.kj_is_member(company_id))
  with check (public.kj_is_member(company_id));

alter table public.kj_companies enable row level security;
drop policy if exists "member reads company" on public.kj_companies;
create policy "member reads company" on public.kj_companies
  for select to authenticated using (public.kj_is_member(id));
drop policy if exists "owner renames company" on public.kj_companies;
create policy "owner renames company" on public.kj_companies
  for update to authenticated using (public.kj_is_owner(id)) with check (public.kj_is_owner(id));

alter table public.kj_members enable row level security;
drop policy if exists "member reads members" on public.kj_members;
create policy "member reads members" on public.kj_members
  for select to authenticated using (public.kj_is_member(company_id));
drop policy if exists "owner removes member" on public.kj_members;
create policy "owner removes member" on public.kj_members
  for delete to authenticated using (public.kj_is_owner(company_id) and user_id <> auth.uid());

alter table public.kj_invites enable row level security;
drop policy if exists "owner manages invites" on public.kj_invites;
create policy "owner manages invites" on public.kj_invites
  for all to authenticated using (public.kj_is_owner(company_id)) with check (public.kj_is_owner(company_id));

revoke all on public.kj_companies, public.kj_members, public.kj_invites from anon;
grant select, update on public.kj_companies to authenticated;
grant select, delete on public.kj_members to authenticated;
grant select, insert, delete on public.kj_invites to authenticated;

-- ---------- 会社を作る・招待する・参加する ----------
create or replace function public.kj_create_company(p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); cid uuid;
begin
  if uid is null then raise exception 'not_signed_in'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'name_required'; end if;
  insert into public.kj_companies (name, created_by) values (trim(p_name), uid) returning id into cid;
  insert into public.kj_members (company_id, user_id, role, email)
    values (cid, uid, 'owner', (select email from auth.users where id = uid));
  return cid;
end $$;

create or replace function public.kj_create_invite(p_company uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare code text;
begin
  if not public.kj_is_owner(p_company) then raise exception 'not_owner'; end if;
  code := replace(gen_random_uuid()::text, '-', '');
  insert into public.kj_invites (code, company_id, created_by) values (code, p_company, auth.uid());
  return code;
end $$;

create or replace function public.kj_join_company(p_code text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); cid uuid;
begin
  if uid is null then raise exception 'not_signed_in'; end if;
  select company_id into cid from public.kj_invites where code = p_code and expires_at > now();
  if cid is null then raise exception 'invalid_invite'; end if;
  insert into public.kj_members (company_id, user_id, role, email)
    values (cid, uid, 'member', (select email from auth.users where id = uid))
    on conflict (company_id, user_id) do nothing;
  return cid;
end $$;

revoke execute on function public.kj_create_company(text), public.kj_create_invite(uuid), public.kj_join_company(text),
  public.kj_is_member(uuid), public.kj_is_owner(uuid) from public, anon;
grant execute on function public.kj_create_company(text), public.kj_create_invite(uuid), public.kj_join_company(text),
  public.kj_is_member(uuid), public.kj_is_owner(uuid) to authenticated;
