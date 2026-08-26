-- Meu Financeiro v2.2.1 - sincronização estável
-- Execute UMA VEZ no SQL Editor do Supabase.
-- Não apaga nem altera os dados financeiros existentes.

alter table public.finance_states
  add column if not exists revision bigint not null default 0;

create or replace function public.mf_sync_finance_state(
  p_state jsonb,
  p_expected_revision bigint
)
returns table (
  applied boolean,
  state jsonb,
  updated_at timestamptz,
  revision bigint
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.finance_states%rowtype;
begin
  if v_uid is null then
    raise exception 'Usuário não autenticado';
  end if;

  -- Bloqueia somente a linha do usuário durante esta operação.
  select fs.*
    into v_row
    from public.finance_states as fs
   where fs.user_id = v_uid
   for update;

  -- Conta sem estado ainda: cria a primeira versão.
  if not found then
    insert into public.finance_states (user_id, state, revision)
    values (v_uid, p_state, 0)
    returning * into v_row;

    return query
      select true, v_row.state, v_row.updated_at, v_row.revision;
    return;
  end if;

  -- Outro dispositivo já gravou depois da versão esperada.
  -- Não sobrescreve: devolve o estado atual para o cliente fazer merge e tentar novamente.
  if v_row.revision <> coalesce(p_expected_revision, -1) then
    return query
      select false, v_row.state, v_row.updated_at, v_row.revision;
    return;
  end if;

  update public.finance_states as fs
     set state = p_state,
         revision = fs.revision + 1
   where fs.user_id = v_uid
  returning fs.* into v_row;

  return query
    select true, v_row.state, v_row.updated_at, v_row.revision;
end;
$$;

revoke all on function public.mf_sync_finance_state(jsonb, bigint) from public;
revoke all on function public.mf_sync_finance_state(jsonb, bigint) from anon;
grant execute on function public.mf_sync_finance_state(jsonb, bigint) to authenticated;

-- Conferência opcional: deve mostrar a coluna revision.
select column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name = 'finance_states'
  and column_name in ('user_id', 'state', 'updated_at', 'revision')
order by ordinal_position;
