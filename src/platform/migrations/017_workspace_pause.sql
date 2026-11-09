-- Pause all: an emergency stop for one workspace. Nothing is deleted, and work carries on from where it stopped after Resume.
alter table workspace_settings
  add column paused_at timestamptz,
  add column paused_by text,
  add column pause_reason text;
