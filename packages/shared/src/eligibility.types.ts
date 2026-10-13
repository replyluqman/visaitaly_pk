import { z } from 'zod';

export const eligibilityAnswersSchema = z.object({
  version: z.number().int().min(1).max(1_000_000),
  answers: z
    .record(z.string().min(1).max(64), z.string().min(1).max(64))
    .refine((o) => Object.keys(o).length >= 1 && Object.keys(o).length <= 6, {
      message: 'Between 1 and 6 answers are expected.',
    }),
});
export type EligibilityAnswersInput = z.infer<typeof eligibilityAnswersSchema>;

export interface EligibilityQuestion {
  id: string;
  text: string;
  options: Array<{ value: string; label: string }>;
}

export interface EligibilityQuestionSet {
  version: number;
  disclaimer: string;
  questions: EligibilityQuestion[];
}

/** Orientation only — never a verdict. All copy is CMS-owned and lawyer-reviewed. */
export interface EligibilityResult {
  summary: string;
  typicalItems: Array<{ title: string; why: string | null }>;
  lockedCount: number;
  disclaimer: string;
  whatsappUrl: string | null;
}
