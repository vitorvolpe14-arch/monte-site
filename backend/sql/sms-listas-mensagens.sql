-- SMS: mensagens salvas e listas de números salvas (aba SMS do painel)
-- (aplicado no Supabase como a migração "monte_sms_templates_lists"). Vem depois de sms.sql.
--
-- sms_templates: textos de SMS guardados com um nome, para usar de novo. Salvar com um nome
--   que já existe atualiza o texto.
-- sms_lists e sms_list_members: listas de celulares com nome (por exemplo "Clientes
--   WhatsApp"), montadas com os números colados ou lidos de um arquivo. No painel, cada lista
--   vira uma opção em "Quem recebe". Quem está em sms_optouts continua de fora de qualquer envio.
-- Só o servidor (service_role) lê e grava estas tabelas.

create table public.sms_templates (
  id bigint generated always as identity primary key,
  name text not null unique check (char_length(name) between 1 and 80),
  text text not null check (char_length(text) between 1 and 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.sms_lists (
  id bigint generated always as identity primary key,
  name text not null unique check (char_length(name) between 1 and 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.sms_list_members (
  list_id bigint not null references public.sms_lists(id) on delete cascade,
  -- Celular brasileiro no formato internacional, sem o "+": 55 + DDD + 9 dígitos.
  phone text not null check (phone ~ '^55[1-9]{2}9[0-9]{8}$'),
  created_at timestamptz not null default now(),
  primary key (list_id, phone)
);

alter table public.sms_templates enable row level security;
alter table public.sms_lists enable row level security;
alter table public.sms_list_members enable row level security;
revoke all on public.sms_templates, public.sms_lists, public.sms_list_members from public, anon, authenticated;
grant all on public.sms_templates, public.sms_lists, public.sms_list_members to service_role;
