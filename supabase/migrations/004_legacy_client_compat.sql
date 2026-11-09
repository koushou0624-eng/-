-- 一時的な互換対応：会社のしくみより前の画面（cloud.js）でも保存できるようにする
-- ・会社を指定せずに書き込まれた行は、その人がいちばん先に入った会社に入れる
-- ・古い画面は (user_id, kind, id) を重複の判定に使うので、その組み合わせに一意の索引を付ける
create or replace function public.kj_default_company() returns uuid
language sql stable security definer set search_path = '' as $$
  select company_id from public.kj_members where user_id = auth.uid() order by joined_at limit 1;
$$;
revoke execute on function public.kj_default_company() from public, anon;
grant execute on function public.kj_default_company() to authenticated;
alter table public.kj_docs alter column company_id set default public.kj_default_company();
alter table public.kj_docs alter column user_id set default auth.uid();
create unique index if not exists kj_docs_user_kind_id on public.kj_docs (user_id, kind, id);
