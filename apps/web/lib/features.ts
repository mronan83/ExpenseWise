'use client';

import { useEffect, useState } from 'react';
import { api } from './api';

/** A feature that ships switched off, and whether it is on for this organization (Q5). */
export interface Feature {
  key: string;
  name: string;
  description: string;
  enabled: boolean;
  source: 'default' | 'organization' | 'override';
  switchedAt: string | null;
}

export interface FeatureList {
  features: Feature[];
  canSwitch: boolean;
}

let cached: Promise<FeatureList> | undefined;

/** The organization's features, read once per page load. A failed read leaves them off. */
export function loadFeatures(fresh = false): Promise<FeatureList> {
  if (fresh || !cached) {
    cached = api<FeatureList>('/v1/features').catch(() => {
      cached = undefined;
      return { features: [], canSwitch: false };
    });
  }
  return cached;
}

/**
 * Which features are on, for hiding a screen's parts that are off. Until the list arrives,
 * and when it can't be read, every feature reads as off: dark code stays dark.
 */
export function useFeatures(): (key: string) => boolean {
  const [on, setOn] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    let live = true;
    void loadFeatures().then(({ features }) => {
      if (live) setOn(new Set(features.filter((f) => f.enabled).map((f) => f.key)));
    });
    return () => {
      live = false;
    };
  }, []);
  return (key) => on.has(key);
}
