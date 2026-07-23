-- Migration 025: bilingual email templates
ALTER TABLE admin_email_templates
  ADD COLUMN IF NOT EXISTS subject_bn text,
  ADD COLUMN IF NOT EXISTS body_html_bn text,
  ADD COLUMN IF NOT EXISTS body_text_bn text;

-- Update existing templates to have bilingual structure (NULL body_*_bn = fall back to English)
-- We add a helper function to pick the right language at queue time.
