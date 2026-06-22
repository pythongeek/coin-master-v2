'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  COIN 3D — থ্রিডি কয়েন অ্যানিমেশন (React Three Fiber)
 * ═══════════════════════════════════════════════════════════════
 *
 *  Stake-গ্রেড পালিশড গোল্ড কয়েন — বাংলাদেশী সাংস্কৃতিক প্রতীক সহ:
 *  • HEADS → 🪷 শাপলা (জাতীয় ফুল) — সবুজ ফেস
 *  • TAILS → 🐯 রয়েল বেঙ্গল টাইগার (জাতীয় পশু) — মেরুন ফেস
 *  • প্রান্ত → পালিশড গোল্ড ধাতু
 *
 *  অ্যানিমেশনের ধাপ:
 *  ① IDLE     → কয়েন আস্তে আস্তে ভাসছে (floating)
 *  ② SPINNING → দ্রুত ঘুরছে, স্পিড বাড়ছে (টেনশন!)
 *  ③ RESULT   → ধীরে ধীরে থামছে, সঠিক ফেস দেখাচ্ছে
 * ═══════════════════════════════════════════════════════════════
 */

import { useRef, useEffect } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Text } from '@react-three/drei';
import * as THREE from 'three';

interface CoinProps {
  gameStatus: 'idle' | 'spinning' | 'result';
  result: 'heads' | 'tails' | null;
}

// ── কালার টোকেন (tailwind.config.js এর brand রঙের সাথে সামঞ্জস্যপূর্ণ) ──
const COLOR_GREEN  = '#00C566';
const COLOR_MAROON = '#A8395C';
const COLOR_GOLD   = '#E8A93D';
const COLOR_GOLD_DIM = '#9A6F1F';
const COLOR_VOID   = '#0B0E11';

// ── কয়েনের মূল মেশ ────────────────────────────────────────────
function CoinMesh({ gameStatus, result }: CoinProps) {
  const meshRef = useRef<THREE.Mesh>(null);
  const groupRef = useRef<THREE.Group>(null);

  const spinSpeed  = useRef(0);
  const targetRot  = useRef(0);
  const floatTimer = useRef(0);

  useEffect(() => {
    if (gameStatus === 'spinning') {
      spinSpeed.current = 0.15;
    }
    if (gameStatus === 'result' && result) {
      spinSpeed.current = 0;
      const rotations = Math.ceil(meshRef.current?.rotation.x ?? 0 / (Math.PI * 2)) * Math.PI * 2;
      targetRot.current = rotations + (result === 'heads' ? 0 : Math.PI);
    }
    if (gameStatus === 'idle') {
      spinSpeed.current = 0;
      targetRot.current = 0;
    }
  }, [gameStatus, result]);

  useFrame((_, delta) => {
    if (!meshRef.current || !groupRef.current) return;

    if (gameStatus === 'spinning') {
      spinSpeed.current = Math.min(spinSpeed.current + delta * 0.4, 0.35);
      meshRef.current.rotation.x += spinSpeed.current;
    } else if (gameStatus === 'result') {
      meshRef.current.rotation.x = THREE.MathUtils.lerp(
        meshRef.current.rotation.x,
        targetRot.current,
        delta * 5
      );
    } else {
      floatTimer.current += delta;
      groupRef.current.position.y = Math.sin(floatTimer.current * 1.5) * 0.08;
      meshRef.current.rotation.y += delta * 0.25;
    }
  });

  const headsColor = new THREE.Color(COLOR_GREEN);
  const tailsColor = new THREE.Color(COLOR_MAROON);
  const edgeColor  = new THREE.Color(COLOR_GOLD);

  return (
    <group ref={groupRef}>
      {/* মূল কয়েনের প্রান্ত — পালিশড গোল্ড ধাতু, উঁচু metalness কম roughness = ক্রিস্প রিফ্লেকশন */}
      <mesh ref={meshRef} castShadow receiveShadow>
        <cylinderGeometry args={[1.5, 1.5, 0.16, 64]} />
        <meshStandardMaterial color={edgeColor} metalness={0.95} roughness={0.18} />
      </mesh>

      {/* Heads ফেস — সবুজ, সূক্ষ্ম ধাতব ফিনিশ */}
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0.085, 0]}>
        <circleGeometry args={[1.42, 64]} />
        <meshStandardMaterial color={headsColor} metalness={0.4} roughness={0.35} />
      </mesh>

      {/* Tails ফেস — মেরুন, সূক্ষ্ম ধাতব ফিনিশ */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.085, 0]}>
        <circleGeometry args={[1.42, 64]} />
        <meshStandardMaterial color={tailsColor} metalness={0.4} roughness={0.35} />
      </mesh>

      {/* অন্তঃস্থ রিং বর্ডার — কয়েনের ভেতরে একটা পালিশড রিম (বাস্তব কয়েনের মতো ডিটেইল) */}
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0.086, 0]}>
        <ringGeometry args={[1.28, 1.34, 64]} />
        <meshStandardMaterial color={edgeColor} metalness={0.9} roughness={0.2} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.086, 0]}>
        <ringGeometry args={[1.28, 1.34, 64]} />
        <meshStandardMaterial color={edgeColor} metalness={0.9} roughness={0.2} />
      </mesh>

      {/* Heads — শাপলা (জাতীয় ফুল) */}
      <Text
        position={[0, 0.13, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        fontSize={0.5}
        color={COLOR_VOID}
        anchorX="center"
        anchorY="middle"
      >
        🪷
      </Text>

      {/* Tails — রয়েল বেঙ্গল টাইগার (জাতীয় পশু) */}
      <Text
        position={[0, -0.13, 0]}
        rotation={[Math.PI / 2, 0, 0]}
        fontSize={0.5}
        color={COLOR_VOID}
        anchorX="center"
        anchorY="middle"
      >
        🐯
      </Text>

      {/* আলো — ফলাফল অনুযায়ী রঙ বদলায়, কিন্তু সংযত তীব্রতা (নিয়ন-গ্লো নয়) */}
      <pointLight
        color={gameStatus === 'result'
          ? (result === 'heads' ? COLOR_GREEN : COLOR_MAROON)
          : COLOR_GOLD}
        intensity={gameStatus === 'spinning' ? 1.8 : 1.0}
        distance={6}
      />
    </group>
  );
}

// ── স্পিনিং রিং — সূক্ষ্ম গোল্ড accent, ক্রিস্প পাতলা রেখা ──────
function SpinRings({ spinning }: { spinning: boolean }) {
  const ring1 = useRef<THREE.Mesh>(null);
  const ring2 = useRef<THREE.Mesh>(null);

  useFrame((_, delta) => {
    if (!spinning) return;
    if (ring1.current) ring1.current.rotation.z += delta * 2;
    if (ring2.current) ring2.current.rotation.z -= delta * 1.5;
  });

  if (!spinning) return null;

  return (
    <>
      <mesh ref={ring1}>
        <torusGeometry args={[2.15, 0.012, 8, 64]} />
        <meshBasicMaterial color={COLOR_GOLD} transparent opacity={0.35} />
      </mesh>
      <mesh ref={ring2}>
        <torusGeometry args={[2.45, 0.012, 8, 64]} />
        <meshBasicMaterial color={COLOR_GOLD_DIM} transparent opacity={0.22} />
      </mesh>
    </>
  );
}

// ── মূল এক্সপোর্ট ──────────────────────────────────────────────
export default function Coin3D({ gameStatus, result }: CoinProps) {
  return (
    <div
      className="w-full h-full"
      role="img"
      aria-label={
        gameStatus === 'spinning'
          ? 'কয়েন ঘুরছে...'
          : gameStatus === 'result'
          ? `ফলাফল: ${result === 'heads' ? 'শাপলা (Heads)' : 'টাইগার (Tails)'}`
          : 'কয়েন — বেট ধরুন'
      }
    >
      <Canvas
        camera={{ position: [0, 3.5, 0], fov: 45 }}
        shadows
        gl={{ antialias: true, alpha: true }}
      >
        {/* আলো — পরিচ্ছন্ন, স্টুডিও-স্টাইল তিন-পয়েন্ট লাইটিং */}
        <ambientLight intensity={0.45} />
        <directionalLight position={[5, 10, 5]} intensity={1.3} castShadow />
        <pointLight position={[-5, 5, -5]} intensity={0.35} color={COLOR_GOLD} />

        <CoinMesh gameStatus={gameStatus} result={result} />
        <SpinRings spinning={gameStatus === 'spinning'} />
      </Canvas>
    </div>
  );
}
