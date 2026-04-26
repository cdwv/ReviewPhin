import type { ReviewContext, ReviewResult } from "./types.js";

export interface ReviewProvider {
  readonly name: string;
  review(context: ReviewContext): Promise<ReviewResult>;
}
