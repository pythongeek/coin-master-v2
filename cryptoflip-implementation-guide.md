# 🚀 CryptoFlip Production Implementation Guide
## Stake.com-Style Crypto Casino — Step-by-Step Build Instructions

---

## PART 1: FRONTEND UI/UX OVERHAUL

### 1.1 Design System Architecture

Create a comprehensive design system before touching any game logic:

```
frontend/
├── design-system/
│   ├── tokens/
│   │   ├── colors.ts          # Dark casino palette
│   │   ├── typography.ts      # Inter + Mono font scales
│   │   ├── spacing.ts         # 4px grid system
│   │   ├── shadows.ts         # Neon glow effects
│   │   └── animations.ts      # Timing functions
│   ├── components/
│   │   ├── Button/            # Primary, Secondary, Ghost, Danger
│   │   ├── Input/             # Bet amount, search
│   │   ├── Card/              # Game cards, stat cards
│   │   ├── Modal/             # Deposit, withdraw, settings
│   │   ├── Tooltip/           # Info tooltips
│   │   ├── Badge/             # VIP tiers, statuses
│   │   ├── Progress/          # Loading, multipliers
│   │   ├── Table/             # Bet history, leaderboard
│   │   ├── Tabs/              # Game variants
│   │   ├── Slider/            # Risk multiplier
│   │   └── Toast/             # Notifications
│   └── hooks/
│       ├── useTheme.ts
│       ├── useAnimation.ts
│       └── useSound.ts
```

### 1.2 Color Palette (Stake-Inspired Dark Casino)

```typescript
// design-system/tokens/colors.ts
export const colors = {
  // Backgrounds
  bg: {
    primary: '#0F1923',      // Deep navy-black
    secondary: '#1A2C38',    // Card backgrounds
    tertiary: '#213743',     // Elevated surfaces
    hover: '#2A3F4D',        // Hover states
    game: '#0A0E13',         // Game area
  },
  // Text
  text: {
    primary: '#FFFFFF',
    secondary: '#B1B1B1',
    muted: '#557086',
    accent: '#00E701',       // Win green
    danger: '#FF4444',       // Loss red
  },
  // Brand
  brand: {
    primary: '#00E701',      // Stake green
    secondary: '#1FFF20',    // Bright green
    gradient: 'linear-gradient(135deg, #00E701 0%, #1FFF20 100%)',
  },
  // Game specific
  coin: {
    heads: '#FFD700',        // Gold
    tails: '#C0C0C0',        // Silver
    edge: '#FF6B00',         // Edge case (rare)
  },
  // Multipliers
  multiplier: {
    low: '#00E701',          // 1x-2x
    medium: '#FFC107',       // 2x-10x
    high: '#FF5722',         // 10x-100x
    extreme: '#E91E63',      // 100x+
  }
};
```

### 1.3 Game Page Layout (Stake-Style)

```typescript
// app/game/page.tsx — Main Game Layout
export default function GamePage() {
  return (
    <div className="min-h-screen bg-[#0F1923] flex">
      {/* Left Sidebar — Bet Controls */}
      <aside className="w-[380px] min-w-[380px] bg-[#1A2C38] border-r border-[#2A3F4D]">
        <BetControlPanel />
      </aside>

      {/* Center — Game Area */}
      <main className="flex-1 flex flex-col">
        <GameHeader />
        <div className="flex-1 relative flex items-center justify-center bg-[#0A0E13]">
          <CoinFlipScene />  {/* 3D Canvas */}
          <WinOverlay />     {/* Big win animation */}
        </div>
        <GameFooter />
      </main>

      {/* Right Sidebar — Stats & Chat */}
      <aside className="w-[320px] min-w-[320px] bg-[#1A2C38] border-l border-[#2A3F4D]">
        <LiveStats />
        <LiveChat />
      </aside>
    </div>
  );
}
```

### 1.4 Bet Control Panel Component

```typescript
// components/game/BetControlPanel.tsx
'use client';
import { useState } from 'react';
import { useGameStore } from '@/lib/store/game';
import { useWallet } from '@/lib/hooks/useWallet';
import { Button } from '@/design-system/components/Button';
import { Slider } from '@/design-system/components/Slider';
import { BetAmountInput } from './BetAmountInput';
import { MultiplierDisplay } from './MultiplierDisplay';
import { AutoPlaySettings } from './AutoPlaySettings';

export function BetControlPanel() {
  const { balance, selectedToken } = useWallet();
  const { 
    betAmount, 
    setBetAmount, 
    selectedSide, 
    setSelectedSide,
    multiplier,
    isAutoPlay,
    setIsAutoPlay,
    placeBet,
    isFlipping 
  } = useGameStore();

  const [activeTab, setActiveTab] = useState<'manual' | 'auto'>('manual');

  return (
    <div className="p-4 space-y-4">
      {/* Token Selector */}
      <TokenSelector />

      {/* Balance Display */}
      <div className="bg-[#213743] rounded-lg p-3 flex justify-between items-center">
        <span className="text-[#557086] text-sm">Balance</span>
        <span className="text-white font-mono text-lg">
          {balance.toFixed(8)} {selectedToken.symbol}
        </span>
      </div>

      {/* Bet Amount */}
      <div className="space-y-2">
        <label className="text-[#557086] text-sm font-medium">Bet Amount</label>
        <BetAmountInput 
          value={betAmount}
          onChange={setBetAmount}
          max={balance}
          currency={selectedToken.symbol}
        />
        <div className="flex gap-2">
          {['½', '2x', 'Max'].map((label) => (
            <Button 
              key={label}
              variant="ghost"
              size="sm"
              onClick={() => handleQuickBet(label)}
              className="flex-1 bg-[#213743] hover:bg-[#2A3F4D] text-[#B1B1B1]"
            >
              {label}
            </Button>
          ))}
        </div>
      </div>

      {/* Side Selection */}
      <div className="grid grid-cols-2 gap-3">
        <SideButton 
          side="heads"
          selected={selectedSide === 'heads'}
          onClick={() => setSelectedSide('heads')}
          icon={<CoinIcon type="heads" />}
          color="#FFD700"
        />
        <SideButton 
          side="tails"
          selected={selectedSide === 'tails'}
          onClick={() => setSelectedSide('tails')}
          icon={<CoinIcon type="tails" />}
          color="#C0C0C0"
        />
      </div>

      {/* Multiplier Slider */}
      <div className="space-y-2">
        <div className="flex justify-between">
          <label className="text-[#557086] text-sm">Target Multiplier</label>
          <span className="text-[#00E701] font-mono font-bold">
            {multiplier.toFixed(2)}x
          </span>
        </div>
        <Slider 
          min={1.01}
          max={1000}
          step={0.01}
          value={multiplier}
          onChange={setMultiplier}
          trackColor="#00E701"
        />
        <div className="flex justify-between text-xs text-[#557086]">
          <span>Win Chance: {(50/multiplier).toFixed(2)}%</span>
          <span>House Edge: 2%</span>
        </div>
      </div>

      {/* Manual/Auto Tabs */}
      <div className="flex bg-[#213743] rounded-lg p-1">
        <button
          className={`flex-1 py-2 rounded-md text-sm font-medium transition-all
            ${activeTab === 'manual' ? 'bg-[#2A3F4D] text-white' : 'text-[#557086]'}`}
          onClick={() => setActiveTab('manual')}
        >
          Manual
        </button>
        <button
          className={`flex-1 py-2 rounded-md text-sm font-medium transition-all
            ${activeTab === 'auto' ? 'bg-[#2A3F4D] text-white' : 'text-[#557086]'}`}
          onClick={() => setActiveTab('auto')}
        >
          Auto
        </button>
      </div>

      {activeTab === 'auto' && <AutoPlaySettings />}

      {/* Bet Button */}
      <Button
        onClick={placeBet}
        disabled={isFlipping || betAmount > balance || betAmount <= 0}
        className="w-full h-14 text-lg font-bold bg-gradient-to-r from-[#00E701] to-[#1FFF20] 
                   text-[#0F1923] hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed
                   rounded-xl shadow-[0_0_20px_rgba(0,231,1,0.3)] transition-all"
      >
        {isFlipping ? (
          <span className="flex items-center gap-2">
            <Spinner size="sm" />
            Flipping...
          </span>
        ) : (
          `Flip for ${(betAmount * multiplier).toFixed(8)} ${selectedToken.symbol}`
        )}
      </Button>

      {/* Provably Fair Link */}
      <button className="w-full text-center text-xs text-[#557086] hover:text-[#00E701] transition-colors">
        🔐 Provably Fair — Verify this game
      </button>
    </div>
  );
}
```

### 1.5 3D Coin Scene (React Three Fiber Upgrade)

```typescript
// components/game/CoinFlipScene.tsx
'use client';
import { Canvas, useFrame } from '@react-three/fiber';
import { Environment, ContactShadows, Float } from '@react-three/drei';
import { useRef, useState } from 'react';
import * as THREE from 'three';
import { useGameStore } from '@/lib/store/game';

function Coin({ isFlipping, result }: { isFlipping: boolean; result: 'heads' | 'tails' | null }) {
  const meshRef = useRef<THREE.Mesh>(null);
  const [rotation, setRotation] = useState(0);
  const targetRotation = result === 'heads' ? Math.PI * 20 : Math.PI * 21;

  useFrame((state, delta) => {
    if (!meshRef.current) return;

    if (isFlipping) {
      meshRef.current.rotation.y += delta * 15;
      meshRef.current.rotation.x = Math.sin(state.clock.elapsedTime * 10) * 0.2;
      meshRef.current.position.y = Math.abs(Math.sin(state.clock.elapsedTime * 5)) * 2;
    } else if (result) {
      // Smooth landing animation
      meshRef.current.rotation.y = THREE.MathUtils.lerp(
        meshRef.current.rotation.y, 
        targetRotation, 
        delta * 5
      );
      meshRef.current.position.y = THREE.MathUtils.lerp(
        meshRef.current.position.y, 
        0, 
        delta * 5
      );
    } else {
      // Idle floating
      meshRef.current.rotation.y = Math.sin(state.clock.elapsedTime * 0.5) * 0.3;
      meshRef.current.position.y = Math.sin(state.clock.elapsedTime) * 0.2;
    }
  });

  return (
    <Float speed={2} rotationIntensity={0.5} floatIntensity={0.5}>
      <mesh ref={meshRef} castShadow receiveShadow>
        <cylinderGeometry args={[2, 2, 0.3, 64]} />
        <meshStandardMaterial 
          color={result === 'heads' ? '#FFD700' : result === 'tails' ? '#C0C0C0' : '#FFD700'}
          metalness={0.9}
          roughness={0.1}
          envMapIntensity={1}
        />
        {/* Heads Face */}
        <mesh position={[0, 0.16, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <circleGeometry args={[1.8, 64]} />
          <meshStandardMaterial 
            color="#FFD700"
            metalness={1}
            roughness={0.05}
            map={headsTexture}
          />
        </mesh>
        {/* Tails Face */}
        <mesh position={[0, -0.16, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <circleGeometry args={[1.8, 64]} />
          <meshStandardMaterial 
            color="#C0C0C0"
            metalness={1}
            roughness={0.05}
            map={tailsTexture}
          />
        </mesh>
        {/* Edge detail */}
        <mesh rotation={[0, 0, Math.PI / 2]}>
          <torusGeometry args={[2, 0.05, 16, 100]} />
          <meshStandardMaterial color="#B8860B" metalness={1} />
        </mesh>
      </mesh>
    </Float>
  );
}

export function CoinFlipScene() {
  const { isFlipping, lastResult } = useGameStore();

  return (
    <div className="w-full h-full">
      <Canvas 
        shadows 
        camera={{ position: [0, 5, 8], fov: 45 }}
        gl={{ antialias: true, alpha: true }}
      >
        <ambientLight intensity={0.3} />
        <spotLight 
          position={[10, 10, 10]} 
          angle={0.3} 
          penumbra={1} 
          intensity={2}
          castShadow
        />
        <pointLight position={[-10, -10, -10]} intensity={0.5} color="#00E701" />

        <Coin isFlipping={isFlipping} result={lastResult} />

        <ContactShadows 
          position={[0, -2, 0]} 
          opacity={0.5} 
          scale={10} 
          blur={2} 
          far={4} 
        />
        <Environment preset="city" />

        {/* Particle effects on win */}
        {lastResult && !isFlipping && <WinParticles result={lastResult} />}
      </Canvas>
    </div>
  );
}
```

### 1.6 Live Stats Panel

```typescript
// components/game/LiveStats.tsx
export function LiveStats() {
  const { recentBets, hotStreak, myStats } = useGameStore();

  return (
    <div className="h-1/2 border-b border-[#2A3F4D] flex flex-col">
      <div className="p-3 border-b border-[#2A3F4D]">
        <h3 className="text-white font-semibold text-sm">Live Stats</h3>
      </div>

      {/* Streak Indicator */}
      <div className="p-3 bg-[#213743] m-2 rounded-lg">
        <div className="flex justify-between items-center mb-2">
          <span className="text-[#557086] text-xs">Current Streak</span>
          <span className={`font-bold ${hotStreak.type === 'heads' ? 'text-[#FFD700]' : 'text-[#C0C0C0]'}`}>
            {hotStreak.count} {hotStreak.type === 'heads' ? 'Heads' : 'Tails'}
          </span>
        </div>
        <div className="flex gap-1">
          {recentBets.slice(0, 20).map((bet, i) => (
            <div 
              key={i}
              className={`w-3 h-3 rounded-full ${
                bet.result === 'heads' ? 'bg-[#FFD700]' : 'bg-[#C0C0C0]'
              }`}
              title={`${bet.result} — ${bet.multiplier}x`}
            />
          ))}
        </div>
      </div>

      {/* Recent Bets Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-xs">
          <thead className="text-[#557086] sticky top-0 bg-[#1A2C38]">
            <tr>
              <th className="text-left p-2">User</th>
              <th className="text-right p-2">Bet</th>
              <th className="text-right p-2">Multiplier</th>
              <th className="text-right p-2">Profit</th>
            </tr>
          </thead>
          <tbody>
            {recentBets.map((bet) => (
              <tr key={bet.id} className="border-b border-[#213743] hover:bg-[#213743]">
                <td className="p-2 text-[#B1B1B1]">{bet.username}</td>
                <td className="p-2 text-right text-white">{bet.amount}</td>
                <td className="p-2 text-right">
                  <span className={`font-mono ${
                    bet.multiplier > 10 ? 'text-[#FF5722]' : 
                    bet.multiplier > 2 ? 'text-[#FFC107]' : 'text-[#00E701]'
                  }`}>
                    {bet.multiplier}x
                  </span>
                </td>
                <td className={`p-2 text-right font-mono ${
                  bet.profit > 0 ? 'text-[#00E701]' : 'text-[#FF4444]'
                }`}>
                  {bet.profit > 0 ? '+' : ''}{bet.profit}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

### 1.7 Win Overlay Animation

```typescript
// components/game/WinOverlay.tsx
'use client';
import { motion, AnimatePresence } from 'framer-motion';
import { useGameStore } from '@/lib/store/game';
import { useEffect, useState } from 'react';

export function WinOverlay() {
  const { lastWin, isFlipping } = useGameStore();
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (lastWin && lastWin.amount > 0 && !isFlipping) {
      setShow(true);
      const timer = setTimeout(() => setShow(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [lastWin, isFlipping]);

  return (
    <AnimatePresence>
      {show && lastWin && (
        <motion.div
          initial={{ opacity: 0, scale: 0.5 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.5 }}
          className="absolute inset-0 flex items-center justify-center pointer-events-none z-50"
        >
          <div className="text-center">
            <motion.div
              initial={{ y: 50 }}
              animate={{ y: 0 }}
              transition={{ type: 'spring', damping: 10 }}
            >
              <span className="text-6xl font-bold text-[#00E701] drop-shadow-[0_0_30px_rgba(0,231,1,0.5)]">
                +{lastWin.amount.toFixed(8)}
              </span>
            </motion.div>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.3 }}
              className="mt-2 text-[#B1B1B1] text-lg"
            >
              {lastWin.multiplier}x Multiplier!
            </motion.div>

            {/* Particle burst effect */}
            <div className="absolute inset-0 overflow-hidden">
              {[...Array(20)].map((_, i) => (
                <motion.div
                  key={i}
                  className="absolute w-2 h-2 bg-[#00E701] rounded-full"
                  initial={{ 
                    x: 0, 
                    y: 0, 
                    opacity: 1 
                  }}
                  animate={{ 
                    x: (Math.random() - 0.5) * 400,
                    y: (Math.random() - 0.5) * 400,
                    opacity: 0
                  }}
                  transition={{ duration: 1.5, ease: 'easeOut' }}
                />
              ))}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
```

---

## PART 2: BACKEND ARCHITECTURE UPGRADE

### 2.1 Project Structure (Microservices-Ready)

```
backend/
├── services/
│   ├── api-gateway/           # Nginx/Express entry point
│   ├── auth-service/          # JWT, Web3, 2FA, KYC
│   ├── game-engine/           # Provably fair, bet processing
│   ├── wallet-service/        # Deposits, withdrawals, balances
│   ├── chat-service/          # Socket.io chat + rain
│   ├── admin-service/         # Admin panel, reports
│   └── notification-service/  # Email, SMS, push
├── shared/
│   ├── database/              # PostgreSQL connection pool
│   ├── redis/                 # Redis client + pub/sub
│   ├── queue/                 # BullMQ setup
│   ├── events/                # Event bus (EventEmitter + Redis)
│   ├── logger/                # Pino structured logging
│   ├── errors/                # Custom error classes
│   └── middleware/            # Auth, rate limit, validation
├── workers/
│   ├── payout-worker.ts
│   ├── rain-worker.ts
│   └── email-worker.ts
└── scripts/
    ├── db-migrate.ts
    ├── seed-admin.ts
    └── backup.ts
```

### 2.2 Database Schema (Production-Ready)

```sql
-- migrations/001_initial_schema.sql

-- Users with KYC status
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE,
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(255), -- NULL for Web3-only users
    wallet_address VARCHAR(255) UNIQUE,
    chain VARCHAR(50),
    kyc_status VARCHAR(20) DEFAULT 'pending' 
        CHECK (kyc_status IN ('pending', 'verified', 'rejected', 'required')),
    kyc_verified_at TIMESTAMP,
    kyc_provider VARCHAR(50),
    kyc_reference VARCHAR(255),
    vip_tier VARCHAR(20) DEFAULT 'bronze' 
        CHECK (vip_tier IN ('bronze', 'silver', 'gold', 'platinum', 'diamond')),
    rakeback_percentage DECIMAL(5,2) DEFAULT 0,
    self_excluded_until TIMESTAMP,
    deposit_limit_daily DECIMAL(18,8),
    deposit_limit_weekly DECIMAL(18,8),
    deposit_limit_monthly DECIMAL(18,8),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    last_login_at TIMESTAMP,
    is_active BOOLEAN DEFAULT true,
    is_admin BOOLEAN DEFAULT false,
    two_factor_secret VARCHAR(255),
    two_factor_enabled BOOLEAN DEFAULT false
);

-- Wallets (multi-chain, multi-currency)
CREATE TABLE wallets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    chain VARCHAR(50) NOT NULL, -- 'ethereum', 'bitcoin', 'solana'
    token_address VARCHAR(255), -- NULL for native
    token_symbol VARCHAR(20) NOT NULL,
    token_decimals INTEGER DEFAULT 18,
    balance DECIMAL(36,18) DEFAULT 0,
    locked_balance DECIMAL(36,18) DEFAULT 0, -- In play
    deposit_address VARCHAR(255) UNIQUE,
    deposit_address_index INTEGER, -- For HD wallets
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, chain, token_address)
);

-- Transactions (double-entry ledger)
CREATE TABLE transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    wallet_id UUID REFERENCES wallets(id),
    type VARCHAR(20) NOT NULL 
        CHECK (type IN ('deposit', 'withdrawal', 'bet', 'win', 'rakeback', 'rain', 'bonus', 'fee')),
    amount DECIMAL(36,18) NOT NULL,
    fee DECIMAL(36,18) DEFAULT 0,
    status VARCHAR(20) DEFAULT 'pending' 
        CHECK (status IN ('pending', 'confirming', 'completed', 'failed', 'cancelled')),

    -- For blockchain tx
    tx_hash VARCHAR(255),
    block_number BIGINT,
    confirmations INTEGER DEFAULT 0,
    required_confirmations INTEGER DEFAULT 6,

    -- For internal tx
    reference_id UUID, -- Links to bets, etc.
    reference_type VARCHAR(50),

    -- Metadata
    ip_address INET,
    user_agent TEXT,
    metadata JSONB DEFAULT '{}',

    created_at TIMESTAMP DEFAULT NOW(),
    completed_at TIMESTAMP,

    CONSTRAINT positive_amount CHECK (amount > 0)
);

-- Games (provably fair)
CREATE TABLE games (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    wallet_id UUID REFERENCES wallets(id),

    -- Provably fair data
    server_seed_hash VARCHAR(255) NOT NULL,
    server_seed VARCHAR(255), -- Revealed after game
    client_seed VARCHAR(255) NOT NULL,
    nonce BIGINT NOT NULL,

    -- Game data
    bet_amount DECIMAL(36,18) NOT NULL,
    selected_side VARCHAR(10) NOT NULL CHECK (selected_side IN ('heads', 'tails')),
    target_multiplier DECIMAL(10,2) NOT NULL DEFAULT 2.00,
    win_chance DECIMAL(5,2) NOT NULL DEFAULT 50.00,
    house_edge DECIMAL(5,2) NOT NULL DEFAULT 2.00,

    -- Result
    result VARCHAR(10) CHECK (result IN ('heads', 'tails')),
    outcome VARCHAR(20) CHECK (outcome IN ('win', 'loss', 'pending')),
    payout DECIMAL(36,18) DEFAULT 0,
    profit DECIMAL(36,18) DEFAULT 0,
    actual_multiplier DECIMAL(10,2),

    -- Verification
    verification_hash VARCHAR(255),
    is_verified BOOLEAN DEFAULT false,

    created_at TIMESTAMP DEFAULT NOW(),
    completed_at TIMESTAMP,

    UNIQUE(user_id, client_seed, nonce)
);

-- Audit log (immutable)
CREATE TABLE audit_logs (
    id BIGSERIAL PRIMARY KEY,
    table_name VARCHAR(50) NOT NULL,
    record_id UUID NOT NULL,
    action VARCHAR(20) NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),
    old_data JSONB,
    new_data JSONB,
    changed_by UUID REFERENCES users(id),
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_games_user_id ON games(user_id);
CREATE INDEX idx_games_created_at ON games(created_at DESC);
CREATE INDEX idx_transactions_user_id ON transactions(user_id);
CREATE INDEX idx_transactions_status ON transactions(status);
CREATE INDEX idx_transactions_type ON transactions(type);
CREATE INDEX idx_audit_logs_table_record ON audit_logs(table_name, record_id);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at DESC);

-- Trigger for audit logging
CREATE OR REPLACE FUNCTION audit_trigger()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        INSERT INTO audit_logs (table_name, record_id, action, old_data)
        VALUES (TG_TABLE_NAME, OLD.id, 'DELETE', row_to_json(OLD));
        RETURN OLD;
    ELSIF TG_OP = 'UPDATE' THEN
        INSERT INTO audit_logs (table_name, record_id, action, old_data, new_data)
        VALUES (TG_TABLE_NAME, NEW.id, 'UPDATE', row_to_json(OLD), row_to_json(NEW));
        RETURN NEW;
    ELSIF TG_OP = 'INSERT' THEN
        INSERT INTO audit_logs (table_name, record_id, action, new_data)
        VALUES (TG_TABLE_NAME, NEW.id, 'INSERT', row_to_json(NEW));
        RETURN NEW;
    END IF;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_audit AFTER INSERT OR UPDATE OR DELETE ON users
    FOR EACH ROW EXECUTE FUNCTION audit_trigger();
CREATE TRIGGER wallets_audit AFTER INSERT OR UPDATE OR DELETE ON wallets
    FOR EACH ROW EXECUTE FUNCTION audit_trigger();
CREATE TRIGGER games_audit AFTER INSERT OR UPDATE OR DELETE ON games
    FOR EACH ROW EXECUTE FUNCTION audit_trigger();
CREATE TRIGGER transactions_audit AFTER INSERT OR UPDATE OR DELETE ON transactions
    FOR EACH ROW EXECUTE FUNCTION audit_trigger();
```

### 2.3 Game Engine Service (Provably Fair + Multiplier)

```typescript
// services/game-engine/src/engine.ts
import crypto from 'crypto';
import { Pool } from 'pg';
import Redis from 'ioredis';

interface GameConfig {
  betAmount: bigint; // In smallest unit (wei, satoshi)
  selectedSide: 'heads' | 'tails';
  targetMultiplier: number;
  clientSeed: string;
  nonce: number;
}

interface GameResult {
  result: 'heads' | 'tails';
  outcome: 'win' | 'loss';
  actualMultiplier: number;
  payout: bigint;
  profit: bigint;
  serverSeed: string;
  serverSeedHash: string;
  verificationHash: string;
}

export class GameEngine {
  private db: Pool;
  private redis: Redis;
  private readonly HOUSE_EDGE = 0.02; // 2%
  private readonly MAX_MULTIPLIER = 1027604.48;

  constructor(db: Pool, redis: Redis) {
    this.db = db;
    this.redis = redis;
  }

  /**
   * Generate cryptographically secure server seed
   */
  async generateServerSeed(userId: string): Promise<{ seed: string; hash: string }> {
    const seed = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(seed).digest('hex');

    // Store hash in Redis with TTL (revealed after game)
    await this.redis.setex(`seed:${userId}:hash`, 3600, hash);
    await this.redis.setex(`seed:${userId}:seed`, 3600, seed);

    return { seed, hash };
  }

  /**
   * Calculate result using provably fair algorithm
   * HMAC-SHA256(serverSeed, clientSeed:nonce)
   */
  calculateResult(
    serverSeed: string, 
    clientSeed: string, 
    nonce: number
  ): { result: 'heads' | 'tails'; roll: number } {
    const message = `${clientSeed}:${nonce}`;
    const hmac = crypto.createHmac('sha256', serverSeed).update(message).digest('hex');

    // Take first 8 hex chars (32 bits)
    const rollHex = hmac.substring(0, 8);
    const roll = parseInt(rollHex, 16);

    // Convert to 0-99.99 range for multiplier calculation
    const floatRoll = (roll / 0xFFFFFFFF) * 100;

    // 0-49.99 = heads, 50-99.99 = tails (50/50)
    const result = floatRoll < 50 ? 'heads' : 'tails';

    return { result, roll: floatRoll };
  }

  /**
   * Calculate multiplier based on target and house edge
   * Formula: multiplier = (100 - houseEdge) / winChance
   * For 50% chance: multiplier = 98 / 50 = 1.96x (Stake uses 1.98x for 2% edge)
   */
  calculateMultiplier(targetMultiplier: number): {
    winChance: number;
    actualMultiplier: number;
  } {
    const winChance = (100 - (this.HOUSE_EDGE * 100)) / targetMultiplier;
    const actualMultiplier = (100 - (this.HOUSE_EDGE * 100)) / winChance;

    return {
      winChance: Math.max(0.01, Math.min(99, winChance)),
      actualMultiplier: Math.min(this.MAX_MULTIPLIER, actualMultiplier)
    };
  }

  /**
   * Execute a game with full transaction safety
   */
  async playGame(
    userId: string,
    walletId: string,
    config: GameConfig
  ): Promise<GameResult> {
    const client = await this.db.connect();

    try {
      await client.query('BEGIN');

      // 1. Lock wallet row to prevent race conditions
      const walletResult = await client.query(
        'SELECT balance, locked_balance FROM wallets WHERE id = $1 FOR UPDATE',
        [walletId]
      );

      if (walletResult.rows.length === 0) {
        throw new Error('Wallet not found');
      }

      const wallet = walletResult.rows[0];
      const availableBalance = BigInt(wallet.balance) - BigInt(wallet.locked_balance);

      if (availableBalance < config.betAmount) {
        throw new Error('Insufficient balance');
      }

      // 2. Get server seed (from Redis or generate new)
      let serverSeed = await this.redis.get(`seed:${userId}:seed`);
      if (!serverSeed) {
        const newSeed = await this.generateServerSeed(userId);
        serverSeed = newSeed.seed;
      }

      const serverSeedHash = crypto.createHash('sha256').update(serverSeed).digest('hex');

      // 3. Calculate result
      const { result, roll } = this.calculateResult(
        serverSeed, 
        config.clientSeed, 
        config.nonce
      );

      const { winChance, actualMultiplier } = this.calculateMultiplier(config.targetMultiplier);

      // 4. Determine win/loss
      const won = result === config.selectedSide;
      const outcome = won ? 'win' : 'loss';

      // 5. Calculate payout (only if win)
      let payout = BigInt(0);
      let profit = BigInt(0);

      if (won) {
        payout = (config.betAmount * BigInt(Math.floor(actualMultiplier * 100))) / BigInt(100);
        profit = payout - config.betAmount;
      } else {
        profit = -config.betAmount;
      }

      // 6. Update wallet balance atomically
      await client.query(
        `UPDATE wallets 
         SET balance = balance + $1, 
             updated_at = NOW()
         WHERE id = $2`,
        [profit.toString(), walletId]
      );

      // 7. Create game record
      const gameResult = await client.query(
        `INSERT INTO games (
          user_id, wallet_id, server_seed_hash, server_seed, client_seed, nonce,
          bet_amount, selected_side, target_multiplier, win_chance, house_edge,
          result, outcome, payout, profit, actual_multiplier, verification_hash, completed_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW())
        RETURNING id`,
        [
          userId, walletId, serverSeedHash, serverSeed, config.clientSeed, config.nonce,
          config.betAmount.toString(), config.selectedSide, config.targetMultiplier,
          winChance, this.HOUSE_EDGE * 100, result, outcome,
          payout.toString(), profit.toString(), actualMultiplier,
          crypto.createHash('sha256').update(`${serverSeed}:${config.clientSeed}:${config.nonce}`).digest('hex')
        ]
      );

      // 8. Record transaction
      await client.query(
        `INSERT INTO transactions (
          user_id, wallet_id, type, amount, status, reference_id, reference_type, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
        [
          userId, walletId, won ? 'win' : 'bet',
          won ? payout.toString() : config.betAmount.toString(),
          'completed', gameResult.rows[0].id, 'game'
        ]
      );

      // 9. Update user stats
      await client.query(
        `UPDATE users 
         SET updated_at = NOW()
         WHERE id = $1`,
        [userId]
      );

      await client.query('COMMIT');

      // 10. Invalidate cache
      await this.redis.del(`balance:${userId}`);
      await this.redis.del(`stats:${userId}`);

      // 11. Publish to real-time feed
      await this.redis.publish('game:results', JSON.stringify({
        userId,
        result,
        outcome,
        multiplier: actualMultiplier,
        profit: profit.toString(),
        timestamp: new Date().toISOString()
      }));

      return {
        result,
        outcome,
        actualMultiplier,
        payout,
        profit,
        serverSeed,
        serverSeedHash,
        verificationHash: crypto.createHash('sha256').update(`${serverSeed}:${config.clientSeed}:${config.nonce}`).digest('hex')
      };

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Verify a past game
   */
  async verifyGame(gameId: string): Promise<{
    isValid: boolean;
    details: any;
  }> {
    const result = await this.db.query(
      'SELECT * FROM games WHERE id = $1',
      [gameId]
    );

    if (result.rows.length === 0) {
      return { isValid: false, details: null };
    }

    const game = result.rows[0];

    // Recalculate
    const calc = this.calculateResult(game.server_seed, game.client_seed, game.nonce);
    const expectedHash = crypto.createHash('sha256').update(game.server_seed).digest('hex');

    return {
      isValid: 
        calc.result === game.result && 
        expectedHash === game.server_seed_hash,
      details: {
        serverSeedHash: game.server_seed_hash,
        serverSeed: game.server_seed,
        clientSeed: game.client_seed,
        nonce: game.nonce,
        calculatedResult: calc.result,
        storedResult: game.result,
        hashMatch: expectedHash === game.server_seed_hash
      }
    };
  }
}
```

### 2.4 Wallet Service (Hot/Cold Architecture)

```typescript
// services/wallet-service/src/wallet.ts
import { ethers } from 'ethers';
import { Connection, PublicKey } from '@solana/web3.js';
import { Pool } from 'pg';
import Redis from 'ioredis';
import Bull from 'bull';

interface WalletConfig {
  hotWalletPrivateKey: string;
  coldWalletAddress: string;
  chains: {
    ethereum: { rpc: string; minConfirmations: number };
    bitcoin: { rpc: string; minConfirmations: number };
    solana: { rpc: string; minConfirmations: number };
  };
}

export class WalletService {
  private db: Pool;
  private redis: Redis;
  private payoutQueue: Bull;
  private config: WalletConfig;

  // Hot wallet provider
  private ethProvider: ethers.JsonRpcProvider;
  private ethWallet: ethers.Wallet;

  constructor(db: Pool, redis: Redis, config: WalletConfig) {
    this.db = db;
    this.redis = redis;
    this.config = config;

    // Initialize hot wallet
    this.ethProvider = new ethers.JsonRpcProvider(config.chains.ethereum.rpc);
    this.ethWallet = new ethers.Wallet(config.hotWalletPrivateKey, this.ethProvider);

    // Initialize payout queue
    this.payoutQueue = new Bull('payouts', {
      redis: { host: 'redis', port: 6379 }
    });

    this.setupQueueProcessors();
  }

  /**
   * Generate deposit address for user (HD Wallet derivation)
   */
  async generateDepositAddress(userId: string, chain: string): Promise<string> {
    const index = await this.redis.incr(`address_index:${chain}`);

    // Derive address from master key using BIP44
    // For Ethereum
    if (chain === 'ethereum') {
      const path = `m/44'/60'/0'/0/${index}`;
      const wallet = ethers.HDNodeWallet.fromPhrase(
        process.env.MNEMONIC!,
        undefined,
        path
      );

      await this.db.query(
        `INSERT INTO wallets (user_id, chain, token_symbol, deposit_address, deposit_address_index)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, chain, token_address) DO UPDATE
         SET deposit_address = $4, deposit_address_index = $5`,
        [userId, chain, 'ETH', wallet.address, index]
      );

      return wallet.address;
    }

    // For Solana
    if (chain === 'solana') {
      // Use Solana web3.js for derivation
      // ... implementation
    }

    throw new Error(`Chain ${chain} not supported`);
  }

  /**
   * Process deposit (called by webhook or block listener)
   */
  async processDeposit(
    txHash: string,
    fromAddress: string,
    toAddress: string,
    amount: bigint,
    chain: string,
    tokenAddress?: string
  ): Promise<void> {
    const client = await this.db.connect();

    try {
      await client.query('BEGIN');

      // Find wallet by deposit address
      const walletResult = await client.query(
        'SELECT id, user_id, balance FROM wallets WHERE deposit_address = $1 FOR UPDATE',
        [toAddress]
      );

      if (walletResult.rows.length === 0) {
        throw new Error('Deposit address not found');
      }

      const wallet = walletResult.rows[0];

      // Check for duplicate deposit
      const existingTx = await client.query(
        'SELECT id FROM transactions WHERE tx_hash = $1 AND type = $2',
        [txHash, 'deposit']
      );

      if (existingTx.rows.length > 0) {
        throw new Error('Deposit already processed');
      }

      // Update balance
      await client.query(
        'UPDATE wallets SET balance = balance + $1, updated_at = NOW() WHERE id = $2',
        [amount.toString(), wallet.id]
      );

      // Create transaction record
      await client.query(
        `INSERT INTO transactions (
          user_id, wallet_id, type, amount, status, tx_hash, chain, 
          from_address, to_address, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
        [wallet.user_id, wallet.id, 'deposit', amount.toString(), 'completed', txHash, chain, fromAddress, toAddress]
      );

      await client.query('COMMIT');

      // Notify user via WebSocket
      await this.redis.publish(`user:${wallet.user_id}:deposits`, JSON.stringify({
        amount: amount.toString(),
        txHash,
        chain,
        timestamp: new Date().toISOString()
      }));

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Request withdrawal (queued for security)
   */
  async requestWithdrawal(
    userId: string,
    walletId: string,
    toAddress: string,
    amount: bigint
  ): Promise<{ requestId: string; status: string }> {
    const client = await this.db.connect();

    try {
      await client.query('BEGIN');

      // Check KYC status
      const userResult = await client.query(
        'SELECT kyc_status, self_excluded_until FROM users WHERE id = $1',
        [userId]
      );

      if (userResult.rows[0].kyc_status !== 'verified') {
        throw new Error('KYC verification required for withdrawals');
      }

      if (userResult.rows[0].self_excluded_until && 
          new Date(userResult.rows[0].self_excluded_until) > new Date()) {
        throw new Error('Account is self-excluded');
      }

      // Check balance
      const walletResult = await client.query(
        'SELECT balance, chain, token_symbol FROM wallets WHERE id = $1 AND user_id = $2 FOR UPDATE',
        [walletId, userId]
      );

      if (walletResult.rows.length === 0) {
        throw new Error('Wallet not found');
      }

      const wallet = walletResult.rows[0];
      if (BigInt(wallet.balance) < amount) {
        throw new Error('Insufficient balance');
      }

      // Check withdrawal limits
      const limitCheck = await this.checkWithdrawalLimits(userId, amount, wallet.token_symbol);
      if (!limitCheck.allowed) {
        throw new Error(`Withdrawal limit exceeded: ${limitCheck.reason}`);
      }

      // Deduct balance immediately (hold funds)
      await client.query(
        'UPDATE wallets SET balance = balance - $1, locked_balance = locked_balance + $1 WHERE id = $2',
        [amount.toString(), walletId]
      );

      // Create pending withdrawal record
      const txResult = await client.query(
        `INSERT INTO transactions (
          user_id, wallet_id, type, amount, status, to_address, metadata, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        RETURNING id`,
        [userId, walletId, 'withdrawal', amount.toString(), 'pending', toAddress, JSON.stringify({ chain: wallet.chain })]
      );

      await client.query('COMMIT');

      // Add to queue for processing (security delay + batching)
      const job = await this.payoutQueue.add({
        txId: txResult.rows[0].id,
        userId,
        walletId,
        toAddress,
        amount: amount.toString(),
        chain: wallet.chain,
        tokenSymbol: wallet.token_symbol
      }, {
        delay: 300000, // 5-minute security delay
        attempts: 3,
        backoff: { type: 'exponential', delay: 60000 }
      });

      return { requestId: txResult.rows[0].id, status: 'pending' };

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Process payout from queue
   */
  private setupQueueProcessors() {
    this.payoutQueue.process(async (job) => {
      const { txId, toAddress, amount, chain, tokenSymbol } = job.data;

      try {
        let txHash: string;

        if (chain === 'ethereum') {
          // Send ETH or ERC-20
          if (tokenSymbol === 'ETH') {
            const tx = await this.ethWallet.sendTransaction({
              to: toAddress,
              value: amount
            });
            txHash = tx.hash;
            await tx.wait(2); // Wait for 2 confirmations
          } else {
            // ERC-20 transfer
            const tokenContract = new ethers.Contract(
              process.env[`${tokenSymbol}_CONTRACT`]!,
              ['function transfer(address to, uint256 amount) returns (bool)'],
              this.ethWallet
            );
            const tx = await tokenContract.transfer(toAddress, amount);
            txHash = tx.hash;
            await tx.wait(2);
          }
        }

        // Update transaction as completed
        await this.db.query(
          `UPDATE transactions 
           SET status = 'completed', tx_hash = $1, completed_at = NOW()
           WHERE id = $2`,
          [txHash, txId]
        );

        // Release locked balance
        await this.db.query(
          'UPDATE wallets SET locked_balance = locked_balance - $1 WHERE id = $2',
          [amount, job.data.walletId]
        );

        return { success: true, txHash };

      } catch (error) {
        // Mark as failed, funds remain locked for manual review
        await this.db.query(
          `UPDATE transactions SET status = 'failed', metadata = metadata || $1 WHERE id = $2`,
          [JSON.stringify({ error: (error as Error).message }), txId]
        );
        throw error;
      }
    });
  }

  /**
   * Check withdrawal limits
   */
  private async checkWithdrawalLimits(
    userId: string, 
    amount: bigint, 
    currency: string
  ): Promise<{ allowed: boolean; reason?: string }> {
    // Daily limit check
    const dailyResult = await this.db.query(
      `SELECT COALESCE(SUM(amount), 0) as total 
       FROM transactions 
       WHERE user_id = $1 
         AND type = 'withdrawal' 
         AND status = 'completed'
         AND created_at >= NOW() - INTERVAL '24 hours'`,
      [userId]
    );

    const dailyTotal = BigInt(dailyResult.rows[0].total);
    const dailyLimit = BigInt('1000000000000000000'); // 1 ETH in wei

    if (dailyTotal + amount > dailyLimit) {
      return { allowed: false, reason: 'Daily withdrawal limit exceeded' };
    }

    // Add more limits (weekly, monthly, per-tx)

    return { allowed: true };
  }

  /**
   * Sweep funds to cold wallet (run periodically)
   */
  async sweepToColdWallet(chain: string): Promise<void> {
    if (chain === 'ethereum') {
      const hotBalance = await this.ethProvider.getBalance(this.ethWallet.address);
      const threshold = ethers.parseEther('5.0'); // Keep 5 ETH hot

      if (hotBalance > threshold) {
        const sweepAmount = hotBalance - threshold;
        const tx = await this.ethWallet.sendTransaction({
          to: this.config.coldWalletAddress,
          value: sweepAmount
        });
        await tx.wait();

        console.log(`Swept ${ethers.formatEther(sweepAmount)} ETH to cold wallet`);
      }
    }
  }
}
```

### 2.5 Rate Limiting & Security Middleware

```typescript
// shared/middleware/security.ts
import rateLimit from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import helmet from 'helmet';
import cors from 'cors';
import { z } from 'zod';
import { Request, Response, NextFunction } from 'express';
import Redis from 'ioredis';

const redis = new Redis({ host: 'redis', port: 6379 });

// Rate limiters
export const apiLimiter = rateLimit({
  store: new RedisStore({ sendCommand: (...args) => redis.call(...args) }),
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per window
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

export const betLimiter = rateLimit({
  store: new RedisStore({ sendCommand: (...args) => redis.call(...args) }),
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 bets per minute
  message: { error: 'Bet rate limit exceeded. Slow down.' },
  keyGenerator: (req: Request) => req.user?.id || req.ip,
});

export const authLimiter = rateLimit({
  store: new RedisStore({ sendCommand: (...args) => redis.call(...args) }),
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // 10 login attempts per hour
  skipSuccessfulRequests: true,
});

// Security headers
export const securityHeaders = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "wss:", "https://api.yourgame.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
});

// CORS
export const corsConfig = cors({
  origin: (origin, callback) => {
    const allowedOrigins = [
      'https://yourgame.com',
      'https://app.yourgame.com',
      process.env.NODE_ENV === 'development' ? 'http://localhost:3000' : null,
    ].filter(Boolean);

    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Client-Seed'],
});

// Input validation middleware factory
export function validateBody(schema: z.ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: result.error.errors.map(e => ({
          field: e.path.join('.'),
          message: e.message
        }))
      });
    }
    req.body = result.data;
    next();
  };
}

// Bet validation schema
export const placeBetSchema = z.object({
  walletId: z.string().uuid(),
  amount: z.string().regex(/^\d+$/).transform(BigInt),
  selectedSide: z.enum(['heads', 'tails']),
  targetMultiplier: z.number().min(1.01).max(1027604.48),
  clientSeed: z.string().min(1).max(128),
  nonce: z.number().int().min(0),
});

// WebSocket auth middleware
export function wsAuthMiddleware(socket: any, next: NextFunction) {
  const token = socket.handshake.auth.token || socket.handshake.query.token;

  if (!token) {
    return next(new Error('Authentication required'));
  }

  try {
    // Verify JWT
    const decoded = jwt.verify(token, process.env.JWT_SECRET!);
    socket.user = decoded;
    next();
  } catch (error) {
    next(new Error('Invalid token'));
  }
}
```

### 2.6 KYC Integration (Sumsub Example)

```typescript
// services/auth-service/src/kyc.ts
import axios from 'axios';
import crypto from 'crypto';

export class KYCService {
  private apiUrl = 'https://api.sumsub.com';
  private appToken: string;
  private secretKey: string;

  constructor() {
    this.appToken = process.env.SUMSUB_APP_TOKEN!;
    this.secretKey = process.env.SUMSUB_SECRET_KEY!;
  }

  private generateSignature(ts: number, method: string, url: string, body?: string): string {
    const data = ts + method.toUpperCase() + url + (body || '');
    return crypto.createHmac('sha256', this.secretKey).update(data).digest('hex');
  }

  async createApplicant(userId: string, email: string): Promise<{ applicantId: string; inspectionId: string }> {
    const ts = Math.floor(Date.now() / 1000);
    const url = `/resources/applicants?levelName=basic-kyc-level`;
    const body = JSON.stringify({
      externalUserId: userId,
      email,
      fixedInfo: {
        country: 'BGD' // Default, user can change
      }
    });

    const response = await axios.post(`${this.apiUrl}${url}`, body, {
      headers: {
        'X-App-Token': this.appToken,
        'X-App-Access-Sig': this.generateSignature(ts, 'POST', url, body),
        'X-App-Access-Ts': ts.toString(),
        'Content-Type': 'application/json',
      },
    });

    return {
      applicantId: response.data.id,
      inspectionId: response.data.inspectionId,
    };
  }

  async getAccessToken(applicantId: string): Promise<string> {
    const ts = Math.floor(Date.now() / 1000);
    const url = `/resources/accessTokens?userId=${applicantId}&ttlInSecs=600`;

    const response = await axios.post(`${this.apiUrl}${url}`, null, {
      headers: {
        'X-App-Token': this.appToken,
        'X-App-Access-Sig': this.generateSignature(ts, 'POST', url),
        'X-App-Access-Ts': ts.toString(),
      },
    });

    return response.data.token;
  }

  async checkStatus(applicantId: string): Promise<{
    status: 'pending' | 'completed' | 'rejected';
    reviewResult?: any;
  }> {
    const ts = Math.floor(Date.now() / 1000);
    const url = `/resources/applicants/${applicantId}/requiredIdDocsStatus`;

    const response = await axios.get(`${this.apiUrl}${url}`, {
      headers: {
        'X-App-Token': this.appToken,
        'X-App-Access-Sig': this.generateSignature(ts, 'GET', url),
        'X-App-Access-Ts': ts.toString(),
      },
    });

    const status = response.data.review?.reviewResult?.reviewAnswer;
    return {
      status: status === 'GREEN' ? 'completed' : status === 'RED' ? 'rejected' : 'pending',
      reviewResult: response.data.review,
    };
  }

  // Webhook handler for status updates
  async handleWebhook(payload: any, signature: string): Promise<void> {
    // Verify webhook signature
    const expectedSig = crypto.createHmac('sha256', this.secretKey)
      .update(JSON.stringify(payload))
      .digest('hex');

    if (signature !== expectedSig) {
      throw new Error('Invalid webhook signature');
    }

    const { applicantId, reviewStatus, externalUserId } = payload;

    if (reviewStatus === 'completed') {
      // Update user KYC status in database
      await db.query(
        'UPDATE users SET kyc_status = $1, kyc_verified_at = NOW() WHERE id = $2',
        ['verified', externalUserId]
      );
    } else if (reviewStatus === 'rejected') {
      await db.query(
        'UPDATE users SET kyc_status = $1 WHERE id = $2',
        ['rejected', externalUserId]
      );
    }
  }
}
```

---

## PART 3: INFRASTRUCTURE & DEVOPS

### 3.1 Kubernetes Deployment

```yaml
# k8s/frontend-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cryptoflip-frontend
  namespace: production
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  selector:
    matchLabels:
      app: cryptoflip-frontend
  template:
    metadata:
      labels:
        app: cryptoflip-frontend
    spec:
      containers:
      - name: frontend
        image: your-registry/cryptoflip-frontend:latest
        ports:
        - containerPort: 3000
        env:
        - name: NODE_ENV
          value: "production"
        - name: NEXT_PUBLIC_API_URL
          value: "https://api.yourgame.com"
        resources:
          requests:
            memory: "256Mi"
            cpu: "250m"
          limits:
            memory: "512Mi"
            cpu: "500m"
        livenessProbe:
          httpGet:
            path: /api/health
            port: 3000
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /api/ready
            port: 3000
          initialDelaySeconds: 5
          periodSeconds: 5
---
# k8s/backend-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cryptoflip-api
  namespace: production
spec:
  replicas: 5
  selector:
    matchLabels:
      app: cryptoflip-api
  template:
    metadata:
      labels:
        app: cryptoflip-api
    spec:
      containers:
      - name: api
        image: your-registry/cryptoflip-api:latest
        ports:
        - containerPort: 4000
        envFrom:
        - secretRef:
            name: cryptoflip-secrets
        - configMapRef:
            name: cryptoflip-config
        resources:
          requests:
            memory: "512Mi"
            cpu: "500m"
          limits:
            memory: "1Gi"
            cpu: "1000m"
        livenessProbe:
          httpGet:
            path: /health
            port: 4000
          initialDelaySeconds: 30
          periodSeconds: 10
---
# k8s/hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: cryptoflip-api-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: cryptoflip-api
  minReplicas: 5
  maxReplicas: 50
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 80
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 60
      policies:
      - type: Percent
        value: 100
        periodSeconds: 60
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
      - type: Percent
        value: 10
        periodSeconds: 60
```

### 3.2 GitHub Actions CI/CD

```yaml
# .github/workflows/deploy.yml
name: Production Deploy

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: postgres
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
        ports:
          - 5432:5432
      redis:
        image: redis:7
        ports:
          - 6379:6379

    steps:
    - uses: actions/checkout@v4

    - name: Setup Node.js
      uses: actions/setup-node@v4
      with:
        node-version: '20'
        cache: 'npm'

    - name: Install dependencies
      run: |
        cd frontend && npm ci
        cd ../backend && npm ci

    - name: Run lint
      run: |
        cd frontend && npm run lint
        cd ../backend && npm run lint

    - name: Run unit tests
      run: |
        cd frontend && npm run test:ci
        cd ../backend && npm run test:ci
      env:
        DATABASE_URL: postgresql://postgres:postgres@localhost:5432/test
        REDIS_URL: redis://localhost:6379

    - name: Run integration tests
      run: cd backend && npm run test:integration
      env:
        DATABASE_URL: postgresql://postgres:postgres@localhost:5432/test

    - name: Upload coverage
      uses: codecov/codecov-action@v3

  build:
    needs: test
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'

    steps:
    - uses: actions/checkout@v4

    - name: Setup Docker Buildx
      uses: docker/setup-buildx-action@v3

    - name: Login to Registry
      uses: docker/login-action@v3
      with:
        registry: your-registry.com
        username: ${{ secrets.REGISTRY_USERNAME }}
        password: ${{ secrets.REGISTRY_PASSWORD }}

    - name: Build and push frontend
      uses: docker/build-push-action@v5
      with:
        context: ./frontend
        push: true
        tags: |
          your-registry.com/cryptoflip-frontend:${{ github.sha }}
          your-registry.com/cryptoflip-frontend:latest
        cache-from: type=gha
        cache-to: type=gha,mode=max

    - name: Build and push backend
      uses: docker/build-push-action@v5
      with:
        context: ./backend
        push: true
        tags: |
          your-registry.com/cryptoflip-api:${{ github.sha }}
          your-registry.com/cryptoflip-api:latest
        cache-from: type=gha
        cache-to: type=gha,mode=max

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment: production

    steps:
    - name: Setup kubectl
      uses: azure/setup-kubectl@v3

    - name: Setup Helm
      uses: azure/setup-helm@v3

    - name: Deploy to Kubernetes
      run: |
        echo "${{ secrets.KUBECONFIG }}" | base64 -d > kubeconfig
        export KUBECONFIG=kubeconfig

        # Update image tags
        kubectl set image deployment/cryptoflip-frontend           frontend=your-registry.com/cryptoflip-frontend:${{ github.sha }}           -n production
        kubectl set image deployment/cryptoflip-api           api=your-registry.com/cryptoflip-api:${{ github.sha }}           -n production

        # Wait for rollout
        kubectl rollout status deployment/cryptoflip-frontend -n production
        kubectl rollout status deployment/cryptoflip-api -n production

    - name: Run smoke tests
      run: |
        curl -f https://yourgame.com/api/health
        curl -f https://api.yourgame.com/health
```

---

## PART 4: MONITORING & ALERTING

### 4.1 Grafana Dashboard Config

```json
{
  "dashboard": {
    "title": "CryptoFlip Production",
    "panels": [
      {
        "title": "Active Users",
        "targets": [
          {
            "expr": "sum(rate(socket_connections_total[5m]))"
          }
        ]
      },
      {
        "title": "Bet Throughput",
        "targets": [
          {
            "expr": "sum(rate(games_completed_total[1m]))"
          }
        ]
      },
      {
        "title": "House Profit (24h)",
        "targets": [
          {
            "expr": "sum(increase(house_profit_total[24h]))"
          }
        ]
      },
      {
        "title": "API Response Time",
        "targets": [
          {
            "expr": "histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m]))"
          }
        ]
      },
      {
        "title": "Database Connections",
        "targets": [
          {
            "expr": "pg_stat_activity_count{state="active"}"
          }
        ]
      },
      {
        "title": "Failed Transactions",
        "targets": [
          {
            "expr": "sum(increase(transactions_failed_total[1h]))"
          }
        ]
      }
    ]
  }
}
```

### 4.2 Alert Rules (Prometheus)

```yaml
# monitoring/alerts.yml
groups:
  - name: cryptoflip
    rules:
      - alert: HighErrorRate
        expr: rate(http_requests_total{status=~"5.."}[5m]) > 0.1
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "High error rate detected"

      - alert: DatabaseConnectionExhausted
        expr: pg_stat_activity_count / pg_settings_max_connections > 0.8
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Database connections near limit"

      - alert: SuspiciousBettingPattern
        expr: rate(unusual_betting_patterns_total[1h]) > 10
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Potential fraud detected"

      - alert: HotWalletLowBalance
        expr: hot_wallet_balance / hot_wallet_threshold < 1.5
        for: 1m
        labels:
          severity: warning
        annotations:
          summary: "Hot wallet balance is low"

      - alert: KYCQueueBacklog
        expr: kyc_pending_count > 100
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "KYC verification backlog"
```

---

## PART 5: TESTING STRATEGY

### 5.1 Load Testing (k6)

```javascript
// tests/load/bet-load.js
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '2m', target: 100 },   // Ramp up
    { duration: '5m', target: 100 },   // Steady state
    { duration: '2m', target: 400 },   // Spike
    { duration: '5m', target: 400 },   // Sustained load
    { duration: '2m', target: 0 },     // Ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<200'],
    http_req_failed: ['rate<0.01'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'https://api.yourgame.com';

export default function () {
  // Login and get token
  const loginRes = http.post(`${BASE_URL}/auth/login`, {
    email: `user${__VU}@test.com`,
    password: 'testpassword123',
  });

  const token = loginRes.json('token');

  // Place bet
  const betRes = http.post(`${BASE_URL}/game/bet`, JSON.stringify({
    walletId: 'test-wallet-id',
    amount: '1000000000000000', // 0.001 ETH
    selectedSide: Math.random() > 0.5 ? 'heads' : 'tails',
    targetMultiplier: 2.0,
    clientSeed: `seed-${__VU}-${__ITER}`,
    nonce: __ITER,
  }), {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
  });

  check(betRes, {
    'bet status is 200': (r) => r.status === 200,
    'bet completed quickly': (r) => r.timings.duration < 500,
  });

  sleep(Math.random() * 2 + 1); // 1-3s between bets
}
```

### 5.2 E2E Tests (Playwright)

```typescript
// tests/e2e/game.spec.ts
import { test, expect } from '@playwright/test';

test.describe('Coin Flip Game', () => {
  test.beforeEach(async ({ page }) => {
    // Login with test user
    await page.goto('/login');
    await page.fill('[data-testid="email"]', 'test@example.com');
    await page.fill('[data-testid="password"]', 'password123');
    await page.click('[data-testid="login-button"]');
    await page.waitForURL('/game');
  });

  test('should place a bet and show result', async ({ page }) => {
    // Enter bet amount
    await page.fill('[data-testid="bet-amount"]', '0.01');

    // Select heads
    await page.click('[data-testid="side-heads"]');

    // Click flip
    await page.click('[data-testid="flip-button"]');

    // Wait for animation
    await page.waitForSelector('[data-testid="result-display"]');

    // Verify result is shown
    const result = await page.textContent('[data-testid="result-display"]');
    expect(result).toMatch(/Heads|Tails/);

    // Verify balance updated
    const balance = await page.textContent('[data-testid="balance"]');
    expect(balance).toBeTruthy();
  });

  test('should show insufficient balance error', async ({ page }) => {
    await page.fill('[data-testid="bet-amount"]', '999999');
    await page.click('[data-testid="side-heads"]');
    await page.click('[data-testid="flip-button"]');

    await expect(page.locator('[data-testid="error-message"]'))
      .toContainText('Insufficient balance');
  });

  test('should verify provably fair', async ({ page }) => {
    // Place a bet first
    await page.fill('[data-testid="bet-amount"]', '0.01');
    await page.click('[data-testid="side-heads"]');
    await page.click('[data-testid="flip-button"]');
    await page.waitForSelector('[data-testid="result-display"]');

    // Open verifier
    await page.click('[data-testid="verify-link"]');

    // Fill in seeds
    await page.fill('[data-testid="server-seed"]', 'test-server-seed');
    await page.fill('[data-testid="client-seed"]', 'test-client-seed');
    await page.fill('[data-testid="nonce"]', '0');

    await page.click('[data-testid="verify-button"]');

    await expect(page.locator('[data-testid="verification-result"]'))
      .toContainText('Verified');
  });
});
```

---

## PART 6: SECURITY CHECKLIST (Pre-Launch)

- [ ] All secrets in HashiCorp Vault / AWS Secrets Manager (no .env files in repo)
- [ ] Rate limiting on ALL endpoints (auth, game, wallet, chat)
- [ ] Input validation with Zod on ALL endpoints
- [ ] SQL injection prevention (parameterized queries only)
- [ ] XSS protection (helmet, CSP, output encoding)
- [ ] CSRF tokens for non-API routes
- [ ] 2FA/MFA for admin panel + optional for users
- [ ] Admin RBAC (4+ roles with different permissions)
- [ ] Audit logging for all sensitive operations
- [ ] Database encryption at rest (AWS RDS)
- [ ] TLS 1.3 for all connections
- [ ] Security headers (HSTS, CSP, X-Frame-Options)
- [ ] CORS strictly configured
- [ ] Penetration test completed by third party
- [ ] Dependency audit (npm audit, Snyk)
- [ ] DDoS protection (Cloudflare)
- [ ] WAF rules configured
- [ ] Hot/cold wallet architecture implemented
- [ ] Multi-sig for cold wallet
- [ ] Withdrawal security delays (5 min +)
- [ ] Transaction monitoring (Chainalysis/Elliptic)
- [ ] KYC integration live and tested
- [ ] Geo-blocking active for prohibited jurisdictions
- [ ] Responsible gaming features (self-exclusion, limits)
- [ ] Terms, privacy, responsible gaming pages live
- [ ] Bug bounty program launched
- [ ] Incident response plan documented
- [ ] Backup strategy tested (restore from backup)
- [ ] Disaster recovery plan tested
- [ ] Log retention policy (5+ years)
- [ ] GDPR/CCPA compliance review

---

*This guide provides the complete technical blueprint to transform CryptoFlip from an MVP into a production-ready, Stake.com-tier crypto casino. Follow each phase sequentially and do not skip security or compliance steps.*
