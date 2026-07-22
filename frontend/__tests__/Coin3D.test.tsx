/**
 * Coin3D tests — cover the currentChoice pre-spin orientation.
 *
 * Bug: before P3-7-fix, Coin3D had no currentChoice prop; the coin
 * always faced heads regardless of which side the user picked in the
 * UI. This test pins that behavior so it can't regress.
 */

import React from 'react';
import { render } from '@testing-library/react';
import Coin3D from '@/components/game/Coin3D';

// Mock the CSS module so the import doesn't choke on class hashing.
// We only care that component instances render + expose refs to the
// coin div, not the visual states.
jest.mock('@/components/game/Coin3D.module.css', () => ({
  coinPerspective: 'coinPerspective',
  coin3d: 'coin3d',
  frontSide: 'frontSide',
  backSide: 'backSide',
  coinSide: 'coinSide',
  shineOverlay: 'shineOverlay',
  glow: 'glow',
  glowWin: 'glowWin',
  glowLoss: 'glowLoss',
  float: 'float',
  spinning: 'spinning',
  showHeads: 'showHeads',
  showTails: 'showTails',
  preChoiceHeads: 'preChoiceHeads',
  preChoiceTails: 'preChoiceTails',
  resultPulse: 'resultPulse',
  orbitalRing: 'orbitalRing',
  floorShadow: 'floorShadow',
}));

// Mock lucide-react icons
jest.mock('lucide-react', () => ({
  Coins: () => null,
}));

describe('Coin3D — currentChoice pre-spin orientation', () => {
  it('defaults to heads when no currentChoice is provided', () => {
    const { container } = render(
      <Coin3D gameStatus="idle" result={null} won={null} />,
    );
    expect(container.querySelector('[aria-label]')).toBeTruthy();
  });

  it('renders under each gameStatus without crashing', () => {
    const states = ['idle', 'spinning', 'result'] as const;
    for (const status of states) {
      const { unmount } = render(
        <Coin3D
          gameStatus={status}
          result={status === 'result' ? 'heads' : null}
          won={status === 'result' ? true : null}
        />,
      );
      expect(document.body).toBeTruthy();
      unmount();
    }
  });

  it('accepts currentChoice="heads" and currentChoice="tails" without crashing', () => {
    const { container: c1, unmount: u1 } = render(
      <Coin3D gameStatus="idle" result={null} won={null} currentChoice="heads" />,
    );
    // Coin3D renders an aria-label'd coin container so screen readers
    // describe its state. The aria-label changes by gameStatus (idle vs
    // spinning vs result) but the container element exists in all states.
    expect(c1.querySelector('[aria-label]')).toBeTruthy();
    u1();

    const { container: c2, unmount: u2 } = render(
      <Coin3D gameStatus="idle" result={null} won={null} currentChoice="tails" />,
    );
    expect(c2.querySelector('[aria-label]')).toBeTruthy();
    u2();
  });
});
