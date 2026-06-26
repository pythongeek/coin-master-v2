'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  COIN 3D — থ্রিডি কয়েন অ্যানিমেশন (React Three Fiber)
 * ═══════════════════════════════════════════════════════════════
 *
 *  Stake-গ্রেড প্রিমিয়াম গোল্ড কয়েন — রিয়েলিস্টিক টেক্সচার ও মেটালনেস সহ:
 *  • HEADS → বাংলাদেশী জাতীয় প্রতীক খচিত গোল্ড কয়েন
 *  • TAILS → বাংলাদেশ লেখা খচিত গোল্ড কয়েন
 *  • প্রান্ত → প্রিমিয়াম পালিশড গোল্ড ধাতু
 *
 *  অ্যানিমেশনের ধাপ:
 *  ① IDLE     → কয়েন আস্তে আস্তে ভাসছে (floating)
 *  ② SPINNING → দ্রুত ঘুরছে, সাথে রিয়েলিস্টিক এয়ার ওয়াটবলিং (টেনশন!)
 *  ③ RESULT   → ধীরে ধীরে গতি কমিয়ে সঠিক ফেসে ল্যান্ড করে বাউন্স করছে
 * ═══════════════════════════════════════════════════════════════
 */

import { useRef, useEffect } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { useTexture } from '@react-three/drei';
import * as THREE from 'three';
import { useGameStore } from '@/lib/store';
import { useSound } from '@/hooks/useSound';

interface CoinProps {
  gameStatus: 'idle' | 'spinning' | 'result';
  result: 'heads' | 'tails' | null;
}

// ── কালার টোকেন ──
const COLOR_GREEN  = '#00C566';
const COLOR_MAROON = '#E8384F'; // প্রিমিয়াম নিয়ন-রেড
const COLOR_GOLD   = '#E8A93D';
const COLOR_GOLD_DIM = '#9A6F1F';

// ── কয়েনের মূল মেশ ────────────────────────────────────────────
function CoinMesh({ gameStatus, result }: CoinProps) {
  const meshRef = useRef<THREE.Mesh>(null);
  const groupRef = useRef<THREE.Group>(null);

  const spinSpeed  = useRef(0);
  const targetRot  = useRef(0);
  const floatTimer = useRef(0);
  const landedRef  = useRef(false);

  const { play } = useSound();
  const settings = useGameStore((s) => s.settings);
  const lastResult = useGameStore((s) => s.lastResult);

  // Load high fidelity coin textures
  const [headsTex, tailsTex] = useTexture([
    '/assets/coin-heads.png',
    '/assets/coin-tails.png',
  ]);

  // Adjust texture settings for maximum clarity
  useEffect(() => {
    if (headsTex && tailsTex) {
      headsTex.colorSpace = THREE.SRGBColorSpace;
      tailsTex.colorSpace = THREE.SRGBColorSpace;
      headsTex.anisotropy = 16;
      tailsTex.anisotropy = 16;
    }
  }, [headsTex, tailsTex]);

  useEffect(() => {
    if (gameStatus === 'spinning') {
      spinSpeed.current = settings.animationSpeed === 'fast' ? 0.45 : 0.25;
      landedRef.current = false;
      play('flip');
    }
    if (gameStatus === 'result' && result) {
      spinSpeed.current = 0;
      // Get current rotation, find the next nearest full rotation
      const currentRotX = meshRef.current?.rotation.x ?? 0;
      const base = Math.ceil(currentRotX / (Math.PI * 2)) * Math.PI * 2;
      // Add extra spins for dramatic effect
      const extraSpins = settings.animationSpeed === 'fast' ? Math.PI * 4 : Math.PI * 8;
      targetRot.current = base + extraSpins + (result === 'heads' ? 0 : Math.PI);
    }
    if (gameStatus === 'idle') {
      spinSpeed.current = 0;
      targetRot.current = 0;
      landedRef.current = false;
    }
  }, [gameStatus, result, settings.animationSpeed, play]);

  useFrame((_, delta) => {
    if (!meshRef.current || !groupRef.current) return;

    floatTimer.current += delta;

    if (gameStatus === 'spinning') {
      // Accelerate spin slightly
      const maxSpin = settings.animationSpeed === 'fast' ? 0.65 : 0.42;
      spinSpeed.current = Math.min(spinSpeed.current + delta * 0.6, maxSpin);
      meshRef.current.rotation.x += spinSpeed.current;

      // Realistic spin wobbles on Y and Z axes
      meshRef.current.rotation.y = Math.sin(floatTimer.current * 8) * 0.08;
      meshRef.current.rotation.z = Math.cos(floatTimer.current * 10) * 0.06;
      groupRef.current.position.y = Math.sin(floatTimer.current * 15) * 0.15;
    } else if (gameStatus === 'result') {
      // Lerp back to 0 tilt on Y and Z
      meshRef.current.rotation.y = THREE.MathUtils.lerp(meshRef.current.rotation.y, 0, delta * 6);
      meshRef.current.rotation.z = THREE.MathUtils.lerp(meshRef.current.rotation.z, 0, delta * 6);
      groupRef.current.position.y = THREE.MathUtils.lerp(groupRef.current.position.y, 0, delta * 6);

      // Decelerate and land on correct face
      const currentRotX = meshRef.current.rotation.x;
      const diff = targetRot.current - currentRotX;

      if (Math.abs(diff) < 0.005) {
        meshRef.current.rotation.x = targetRot.current;
        if (!landedRef.current) {
          landedRef.current = true;
          play('land');
        }
      } else {
        const speed = settings.animationSpeed === 'fast' ? 14 : 8;
        meshRef.current.rotation.x = THREE.MathUtils.lerp(currentRotX, targetRot.current, delta * speed);
      }
    } else {
      // Idle float & slow spin
      groupRef.current.position.y = Math.sin(floatTimer.current * 1.5) * 0.08;
      meshRef.current.rotation.y = THREE.MathUtils.lerp(meshRef.current.rotation.y, floatTimer.current * 0.2, delta * 2);
      meshRef.current.rotation.x = THREE.MathUtils.lerp(meshRef.current.rotation.x, 0.25, delta * 2);
      meshRef.current.rotation.z = THREE.MathUtils.lerp(meshRef.current.rotation.z, 0, delta * 2);
    }
  });

  const edgeColor = new THREE.Color(COLOR_GOLD);

  return (
    <group ref={groupRef}>
      {/* মূল কয়েনের প্রান্ত — পালিশড গোল্ড ধাতু, ক্রিস্প রিফ্লেকশন */}
      <mesh ref={meshRef} castShadow receiveShadow>
        <cylinderGeometry args={[1.5, 1.5, 0.16, 64]} />
        <meshStandardMaterial color={edgeColor} metalness={0.98} roughness={0.12} />
      </mesh>

      {/* Heads ফেস — রিয়েলিস্টিক টেক্সচার */}
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0.081, 0]}>
        <circleGeometry args={[1.45, 64]} />
        <meshStandardMaterial map={headsTex} metalness={0.88} roughness={0.18} />
      </mesh>

      {/* Tails ফেস — রিয়েলিস্টিক টেক্সচার */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.081, 0]}>
        <circleGeometry args={[1.45, 64]} />
        <meshStandardMaterial map={tailsTex} metalness={0.88} roughness={0.18} />
      </mesh>

      {/* অন্তঃস্থ রিং বর্ডার */}
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0.082, 0]}>
        <ringGeometry args={[1.35, 1.42, 64]} />
        <meshStandardMaterial color={edgeColor} metalness={0.95} roughness={0.15} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.082, 0]}>
        <ringGeometry args={[1.35, 1.42, 64]} />
        <meshStandardMaterial color={edgeColor} metalness={0.95} roughness={0.15} />
      </mesh>

      {/* আলো — ফলাফল অনুযায়ী রঙ বদলায় */}
      <pointLight
        color={
          gameStatus === 'result' && lastResult
            ? lastResult.won
              ? COLOR_GREEN
              : COLOR_MAROON
            : COLOR_GOLD
        }
        intensity={gameStatus === 'spinning' ? 2.8 : 1.4}
        distance={8}
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
    if (ring1.current) ring1.current.rotation.z += delta * 2.5;
    if (ring2.current) ring2.current.rotation.z -= delta * 1.8;
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
          ? `ফলাফল: ${result === 'heads' ? 'হেডস (Heads)' : 'টেইলস (Tails)'}`
          : 'কয়েন — বেট ধরুন'
      }
    >
      <Canvas
        camera={{ position: [0, 3.5, 0], fov: 45 }}
        shadows
        gl={{ antialias: true, alpha: true }}
      >
        {/* আলো — পরিচ্ছন্ন, স্টুডিও-স্টাইল তিন-পয়েন্ট লাইটিং */}
        <ambientLight intensity={0.5} />
        <directionalLight position={[5, 10, 5]} intensity={1.4} castShadow />
        <pointLight position={[-5, 5, -5]} intensity={0.4} color={COLOR_GOLD} />

        <CoinMesh gameStatus={gameStatus} result={result} />
        <SpinRings spinning={gameStatus === 'spinning'} />
      </Canvas>
    </div>
  );
}
