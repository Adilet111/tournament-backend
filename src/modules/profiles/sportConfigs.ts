import { z } from 'zod';

/**
 * Per-sport configuration. Adding a new sport = adding one entry here:
 *   - `questions`: metadata the frontend uses to render the form.
 *   - `answers`:   a zod schema that validates the submitted answers.
 *   - `seedRating`: turns validated answers into an initial rating.
 *
 * The answers are stored as-is in sport_profiles.attributes (jsonb); the
 * computed seed goes into sport_profiles.rating and is later refined by match
 * results (Elo).
 */

export type Question =
  | {
      key: string;
      label: string;
      type: 'number';
      min?: number;
      max?: number;
      required?: boolean;
    }
  | {
      key: string;
      label: string;
      type: 'select';
      options: { value: string; label: string }[];
      required?: boolean;
    };

export interface SportConfig {
  questions: Question[];
  answers: z.ZodTypeAny;
  seedRating: (answers: any) => number;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/* ---------------------------------------------------------------- football -- */

const footballAnswers = z.object({
  yearsPlaying: z.number().int().min(0).max(50),
  position: z.enum(['goalkeeper', 'defender', 'midfielder', 'forward']),
  highestLevel: z.enum([
    'recreational',
    'school',
    'amateur_league',
    'semi_pro',
    'professional',
  ]),
  selfSkill: z.number().int().min(1).max(10),
  matchesPerMonth: z.number().int().min(0).max(60),
  preferredFoot: z.enum(['left', 'right', 'both']).optional(),
});

type FootballAnswers = z.infer<typeof footballAnswers>;

// Highest level played dominates the rating; the rest fine-tunes it.
const FOOTBALL_LEVEL_POINTS: Record<FootballAnswers['highestLevel'], number> = {
  recreational: 0,
  school: 150,
  amateur_league: 350,
  semi_pro: 650,
  professional: 1000,
};

function footballSeedRating(a: FootballAnswers): number {
  const base = 1000; // everyone starts here
  const level = FOOTBALL_LEVEL_POINTS[a.highestLevel]; // 0..1000
  const experience = Math.min(a.yearsPlaying, 20) * 15; // 0..300
  const skill = (a.selfSkill - 1) * 25; // 0..225
  const activity = Math.min(a.matchesPerMonth, 20) * 5; // 0..100
  return clamp(Math.round(base + level + experience + skill + activity), 1000, 2500);
}

const football: SportConfig = {
  answers: footballAnswers,
  seedRating: footballSeedRating,
  questions: [
    { key: 'yearsPlaying', label: 'Years playing football', type: 'number', min: 0, max: 50, required: true },
    {
      key: 'position',
      label: 'Main position',
      type: 'select',
      required: true,
      options: [
        { value: 'goalkeeper', label: 'Goalkeeper' },
        { value: 'defender', label: 'Defender' },
        { value: 'midfielder', label: 'Midfielder' },
        { value: 'forward', label: 'Forward' },
      ],
    },
    {
      key: 'highestLevel',
      label: 'Highest level played',
      type: 'select',
      required: true,
      options: [
        { value: 'recreational', label: 'Recreational / pickup' },
        { value: 'school', label: 'School / university' },
        { value: 'amateur_league', label: 'Amateur league' },
        { value: 'semi_pro', label: 'Semi-professional' },
        { value: 'professional', label: 'Professional' },
      ],
    },
    { key: 'selfSkill', label: 'Self-rated skill (1-10)', type: 'number', min: 1, max: 10, required: true },
    { key: 'matchesPerMonth', label: 'Matches per month', type: 'number', min: 0, max: 60, required: true },
    {
      key: 'preferredFoot',
      label: 'Preferred foot',
      type: 'select',
      required: false,
      options: [
        { value: 'left', label: 'Left' },
        { value: 'right', label: 'Right' },
        { value: 'both', label: 'Both' },
      ],
    },
  ],
};

/* ---------------------------------------------------------------- registry -- */

// Keyed by the sport's `slug` (see the sports table).
export const sportConfigs: Record<string, SportConfig> = {
  football,
};

export function getSportConfig(slug: string): SportConfig | undefined {
  return sportConfigs[slug];
}
