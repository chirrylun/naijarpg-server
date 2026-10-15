import { z } from 'zod';
import { APPROACHES } from './types';

const next = z.string().nullable(); // null = encounter ends here

export const scenarioSchema = z.object({
  id: z.string(),
  title: z.string(),
  tagline: z.string(),
  modes: z.array(z.enum(['rival', 'coop', 'team'])).min(1),
  start: z.string(),
  scenes: z.record(
    z.string(), // zod v4 needs the key type as the first argument
    z.object({
      title: z.string(),
      text: z.string(),
      choices: z
        .array(
          z.object({
            approach: z.enum(APPROACHES),
            label: z.string(),
            dc: z.number().int().min(5).max(25),
          }),
        )
        .min(2),
      next: z.object({ disaster: next, struggle: next, win: next, legendary: next }),
    }),
  ),
});

export type Scenario = z.infer<typeof scenarioSchema>;