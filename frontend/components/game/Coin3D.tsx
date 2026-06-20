'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  COIN 3D — থ্রিডি কয়েন অ্যানিমেশন (React Three Fiber)
 * ═══════════════════════════════════════════════════════════════
 *
 *  Three.js দিয়ে তৈরি একটি বাস্তবসম্মত থ্রিডি কয়েন।
 *
 *  অ্যানিমেশনের ধাপ:
 *  ① IDLE     → কয়েন আস্তে আস্তে ভাসছে (floating)
 *  ② SPINNING → দ্রুত ঘুরছে, স্পিড বাড়ছে (টেনশন!)
 *  ③ RESULT   → ধীরে ধীরে থামছে, সঠিক ফেস দেখাচ্ছে
 * ═══════════════════════════════════════════════════════════════
 */

import { useRef, useEffect, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Text, RoundedBox } from '@react-three/drei';
import * as THREE from 'three';

interface CoinProps {
  gameStatus: 'idle' | 'spinning' | 'result';
  result: 'heads' | 'tails' | null;
}

// ── কয়েনের মূল মেশ ────────────────────────────────────────────
function CoinMesh({ gameStatus, result }: CoinProps) {
  const meshRef = useRef<THREE.Mesh>(null);
  const groupRef = useRef<THREE.Group>(null);

  // অ্যানিমেশন স্টেট
  const spinSpeed  = useRef(0);
  const targetRot  = useRef(0);
  const floatTimer = useRef(0);

  // রেজাল্ট অনুযায়ী টার্গেট রোটেশন
  // Heads = 0°, Tails = 180°
  useEffect(() => {
    if (gameStatus === 'spinning') {
      spinSpeed.current = 0.15; // ঘোরা শুরু
    }
    if (gameStatus === 'result' && result) {
      spinSpeed.current = 0;
      // টানা অনেক বার ঘোরার পর নির্দিষ্ট পজিশনে থামবে
      const rotations = Math.ceil(meshRef.current?.rotation.x ?? 0 / (Math.PI * 2)) * Math.PI * 2;
      targetRot.current = rotations + (result === 'heads' ? 0 : Math.PI);
    }
    if (gameStatus === 'idle') {
      spinSpeed.current = 0;
      targetRot.current = 0;
    }
  }, [gameStatus, result]);

  // প্রতি ফ্রেমে চলে
  useFrame((_, delta) => {
    if (!meshRef.current || !groupRef.current) return;

    if (gameStatus === 'spinning') {
      // ঘোরার স্পিড ধীরে বাড়াও
      spinSpeed.current = Math.min(spinSpeed.current + delta * 0.4, 0.35);
      meshRef.current.rotation.x += spinSpeed.current;
    } else if (gameStatus === 'result') {
      // নির্দিষ্ট রোটেশনে স্মুথলি থামো
      meshRef.current.rotation.x = THREE.MathUtils.lerp(
        meshRef.current.rotation.x,
        targetRot.current,
        delta * 5
      );
    } else {
      // IDLE: ভাসমান অ্যানিমেশন
      floatTimer.current += delta;
      groupRef.current.position.y = Math.sin(floatTimer.current * 1.5) * 0.08;
      meshRef.current.rotation.y += delta * 0.3;
    }
  });

  // রেজাল্টের রঙ
  const headsColor = new THREE.Color('#00FF94');  // নিয়ন সবুজ (Heads)
  const tailsColor = new THREE.Color('#00D4FF');  // নিয়ন নীল (Tails)
  const edgeColor  = new THREE.Color('#FFD700');  // সোনালী প্রান্ত

  return (
    <group ref={groupRef}>
      {/* মূল কয়েনের ডিস্ক */}
      <mesh ref={meshRef} castShadow receiveShadow>
        <cylinderGeometry args={[1.5, 1.5, 0.15, 64]} />
        <meshStandardMaterial color={edgeColor} metalness={0.9} roughness={0.1} />
      </mesh>

      {/* Heads ফেস (সামনে) */}
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0.081, 0]}>
        <circleGeometry args={[1.45, 64]} />
        <meshStandardMaterial color={headsColor} metalness={0.6} roughness={0.2} />
      </mesh>

      {/* Tails ফেস (পেছনে) */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.081, 0]}>
        <circleGeometry args={[1.45, 64]} />
        <meshStandardMaterial color={tailsColor} metalness={0.6} roughness={0.2} />
      </mesh>

      {/* Heads লেখা */}
      <Text
        position={[0, 0.12, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        fontSize={0.45}
        color="#050508"
        font="/fonts/Orbitron-Bold.ttf"
        anchorX="center"
        anchorY="middle"
      >
        👑
      </Text>

      {/* Tails লেখা */}
      <Text
        position={[0, -0.12, 0]}
        rotation={[Math.PI / 2, 0, 0]}
        fontSize={0.45}
        color="#050508"
        anchorX="center"
        anchorY="middle"
      >
        🦅
      </Text>

      {/* গ্লো ইফেক্ট (পয়েন্ট লাইট) */}
      <pointLight
        color={gameStatus === 'result'
          ? (result === 'heads' ? '#00FF94' : '#00D4FF')
          : '#FFD700'}
        intensity={gameStatus === 'spinning' ? 3 : 1.5}
        distance={5}
      />
    </group>
  );
}

// ── রিং ডেকোরেশন ───────────────────────────────────────────────
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
        <torusGeometry args={[2.2, 0.02, 8, 64]} />
        <meshBasicMaterial color="#00FF94" transparent opacity={0.4} />
      </mesh>
      <mesh ref={ring2}>
        <torusGeometry args={[2.6, 0.02, 8, 64]} />
        <meshBasicMaterial color="#00D4FF" transparent opacity={0.3} />
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
          ? `ফলাফল: ${result === 'heads' ? 'হেডস 👑' : 'টেইলস 🦅'}`
          : 'কয়েন — বেট ধরুন'
      }
    >
      <Canvas
        camera={{ position: [0, 3.5, 0], fov: 45 }}
        shadows
        gl={{ antialias: true, alpha: true }}
      >
        {/* আলো */}
        <ambientLight intensity={0.4} />
        <directionalLight position={[5, 10, 5]} intensity={1.2} castShadow />
        <pointLight position={[-5, 5, -5]} intensity={0.5} color="#B44FFF" />

        {/* কয়েন */}
        <CoinMesh gameStatus={gameStatus} result={result} />

        {/* স্পিনিং রিং */}
        <SpinRings spinning={gameStatus === 'spinning'} />
      </Canvas>
    </div>
  );
}
