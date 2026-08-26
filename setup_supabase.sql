-- Meu Financeiro v2 - Supabase
-- Execute este arquivo no SQL Editor do projeto Supabase.

create table if not exists public.finance_states (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.finance_states enable row level security;

-- Privilégios mínimos: somente usuários autenticados podem usar a tabela.
revoke all on table public.finance_states from anon, authenticated;
grant select, insert, update, delete on table public.finance_states to authenticated;

drop policy if exists "finance_states_select_own" on public.finance_states;
drop policy if exists "finance_states_insert_own" on public.finance_states;
drop policy if exists "finance_states_update_own" on public.finance_states;
drop policy if exists "finance_states_delete_own" on public.finance_states;

create policy "finance_states_select_own"
on public.finance_states for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "finance_states_insert_own"
on public.finance_states for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy "finance_states_update_own"
on public.finance_states for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "finance_states_delete_own"
on public.finance_states for delete
to authenticated
using ((select auth.uid()) = user_id);

create or replace function public.mf_touch_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists finance_states_touch_updated_at on public.finance_states;
create trigger finance_states_touch_updated_at
before update on public.finance_states
for each row execute function public.mf_touch_updated_at();
