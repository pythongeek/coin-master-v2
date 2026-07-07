-- migrate:up
-- Seed default jackpot admin settings

INSERT INTO admin_settings (key, value, description) VALUES
  ('jackpot_enabled', 'true', 'প্রোগ্রেসিভ জ্যাকপট চালু'),
  ('jackpot_min_bet', '1.00', 'জ্যাকপটের জন্য সর্বনিম্ন বেট পরিমাণ'),
  ('jackpot_contribution_percent', '1.00', 'বেটের শতকরা কত অংশ জ্যাকপট পুলে যোগ হবে'),
  ('jackpot_hit_chance', '10000', 'জ্যাকপট জয়ের সম্ভাবনা (১/X)'),
  ('jackpot_start_pool', '10.00', 'জ্যাকপট শুরুর পুলের পরিমাণ'),
  ('jackpot_pool', '10.00', 'জ্যাকপটের বর্তমান পুলে জমাকৃত অর্থ')
ON CONFLICT (key) DO NOTHING;

-- migrate:down
DELETE FROM admin_settings WHERE key LIKE 'jackpot_%';
