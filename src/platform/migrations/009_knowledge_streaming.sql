-- replaces: 009_knowledge_streaming_channels.sql
create extension if not exists vector;

-- One searchable file. Passages are sealed; the search index holds their words, because keyword search needs them.
create table knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null references organization (id) on delete cascade,
  file_name text not null,
  status text not null default 'queued' check (status in ('queued', 'indexing', 'ready', 'failed')),
  chunks int not null default 0,
  error text,
  embedded boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, file_name)
);

create table knowledge_chunks (
  id bigint generated always as identity primary key,
  workspace_id text not null references organization (id) on delete cascade,
  document_id uuid not null references knowledge_documents (id) on delete cascade,
  position int not null,
  content jsonb not null,
  search tsvector not null,
  embedding vector,
  embedding_model text
);
create index knowledge_chunks_search on knowledge_chunks using gin (search);
create index knowledge_chunks_document on knowledge_chunks (document_id, position);

alter table agent_sessions
  add column channel_id uuid,
  add column contact jsonb,
  add column contact_hash text,
  add column notified_approval boolean not null default false;
create unique index agent_sessions_contact on agent_sessions (channel_id, contact_hash) where channel_id is not null;

do $$
declare
  name text;
begin
  foreach name in array array['knowledge_documents', 'knowledge_chunks']
  loop
    execute format('alter table %I enable row level security', name);
    execute format('alter table %I force row level security', name);
    execute format($p$create policy workspace_only on %I
      using (workspace_id = current_setting('app.workspace_id', true))
      with check (workspace_id = current_setting('app.workspace_id', true))$p$, name);
  end loop;
end $$;
