-- migrate:up
-- Relax the transactions.type CHECK constraint to include legacy 'payout'
-- and new types: 'affiliate_reward', 'jackpot'

ALTER TABLE transactions
  DROP CONSTRAINT IF EXISTS transactions_type_check;

ALTER TABLE transactions
  ADD CONSTRAINT transactions_type_check
  CHECK (type IN ('deposit', 'withdrawal', 'bet', 'win', 'payout', 'rakeback', 'rain', 'bonus', 'fee', 'affiliate_reward', 'jackpot'));

-- migrate:down
ALTER TABLE transactions
  DROP CONSTRAINT IF EXISTS transactions_type_check;

ALTER TABLE transactions
  ADD CONSTRAINT transactions_type_check
  CHECK (type IN ('deposit', 'withdrawal', 'bet', 'win', 'rakeback', 'rain', 'bonus', 'fee'));
